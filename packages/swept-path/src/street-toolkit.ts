import { add, headingRadFromUnit, leftNormal, normalize, scale, sub, truckFootprint } from './geometry.js';
import type { Point, Pose, TruckSpec } from './types.js';

export interface StreetAxisToolkitInput {
  /** BDTOPO axis polyline in stitched-image pixels. */
  readonly axisPolylinePx: readonly (readonly [number, number])[];
  /** Watchpoint / itinerary anchor in pixels (reference point on the street). */
  readonly anchorPx: readonly [number, number];
  /** Lateral shift of the mobile axis, meters perpendicular to the street axis. */
  readonly lateralOffsetM: number;
  readonly pxpm: number;
  readonly truck: TruckSpec;
}

export interface StreetAxisToolkitResult {
  readonly referenceAxisPx: Array<[number, number]>;
  readonly mobileAxisPx: Array<[number, number]>;
  readonly truckFootprintPx: Array<[number, number]>;
  readonly rearAxlePx: [number, number];
  readonly frontAxlePx: [number, number];
  readonly truckCenterPx: [number, number];
  readonly axisBearingDeg: number;
  readonly lateralOffsetM: number;
  /** Unit vector perpendicular to the axis in screen pixels (for drag projection). */
  readonly perpUnitPx: [number, number];
}

function asPoint(pair: readonly [number, number]): Point {
  return { x: pair[0], y: pair[1] };
}

function asTuple(point: Point): [number, number] {
  return [Number(point.x.toFixed(1)), Number(point.y.toFixed(1))];
}

/** Screen bearing: 0° = up, 90° = right (image y-down). */
export function screenBearingDeg(from: readonly [number, number], to: readonly [number, number]): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

export function closestPointOnAxisPolyline(
  axis: readonly (readonly [number, number])[],
  point: readonly [number, number],
): { point: [number, number]; segmentIndex: number; t: number } {
  if (axis.length === 0) {
    return { point: [point[0], point[1]], segmentIndex: 0, t: 0 };
  }
  if (axis.length === 1) {
    const only = axis[0]!;
    return { point: [only[0], only[1]], segmentIndex: 0, t: 0 };
  }

  let bestPoint: [number, number] = [axis[0]![0], axis[0]![1]];
  let bestDistSq = Number.POSITIVE_INFINITY;
  let bestSegment = 0;
  let bestT = 0;

  for (let i = 0; i < axis.length - 1; i += 1) {
    const a = axis[i]!;
    const b = axis[i + 1]!;
    const ab = sub(asPoint(b), asPoint(a));
    const denom = ab.x * ab.x + ab.y * ab.y;
    const t =
      denom < 1e-9 ? 0 : Math.max(0, Math.min(1, (sub(asPoint(point), asPoint(a)).x * ab.x + sub(asPoint(point), asPoint(a)).y * ab.y) / denom));
    const projected = add(asPoint(a), scale(ab, t));
    const distSq = (projected.x - point[0]) ** 2 + (projected.y - point[1]) ** 2;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestPoint = asTuple(projected);
      bestSegment = i;
      bestT = t;
    }
  }

  return { point: bestPoint, segmentIndex: bestSegment, t: bestT };
}

function axisBearingAtSegment(axis: readonly (readonly [number, number])[], segmentIndex: number): number {
  const a = axis[segmentIndex] ?? axis[0];
  const b = axis[segmentIndex + 1] ?? axis[axis.length - 1];
  if (!a || !b) return 0;
  return screenBearingDeg(a, b);
}

function translatePolyline(
  axis: readonly (readonly [number, number])[],
  deltaPx: Point,
): Array<[number, number]> {
  return axis.map(([x, y]) => [Number((x + deltaPx.x).toFixed(1)), Number((y + deltaPx.y).toFixed(1))]);
}

function truckSpecInPixels(truck: TruckSpec, pxpm: number): TruckSpec {
  return {
    ...truck,
    lengthM: truck.lengthM * pxpm,
    widthM: truck.widthM * pxpm,
    wheelbaseM: truck.wheelbaseM * pxpm,
    frontOverhangM: truck.frontOverhangM * pxpm,
    rearOverhangM: truck.rearOverhangM * pxpm,
    turnRadiusM: truck.turnRadiusM * pxpm,
  };
}

function rearAxlePoseForCenteredTruck(params: {
  readonly anchorPx: readonly [number, number];
  readonly headingRad: number;
  readonly truck: TruckSpec;
  readonly pxpm: number;
}): Pose {
  const truckPx = truckSpecInPixels(params.truck, params.pxpm);
  const forward = { x: Math.cos(params.headingRad), y: Math.sin(params.headingRad) };
  const frontM = truckPx.wheelbaseM + truckPx.frontOverhangM;
  const rearM = truckPx.rearOverhangM;
  const centerFromRearAxlePx = (frontM - rearM) / 2;
  const rearAxle = sub(asPoint(params.anchorPx), scale(forward, centerFromRearAxlePx));
  return { x: rearAxle.x, y: rearAxle.y, headingRad: params.headingRad };
}

/**
 * Build a mobile copy of the BDTOPO axis and a truck footprint centered on it.
 * Lateral motion is a pure translation perpendicular to the axis (parallel offset).
 */
export function buildStreetAxisToolkit(input: StreetAxisToolkitInput): StreetAxisToolkitResult | null {
  if (input.axisPolylinePx.length < 2 || input.pxpm <= 0) return null;

  const projection = closestPointOnAxisPolyline(input.axisPolylinePx, input.anchorPx);
  const axisBearingDeg = axisBearingAtSegment(input.axisPolylinePx, projection.segmentIndex);
  const headingRad = headingRadFromUnit({
    x: Math.sin((axisBearingDeg * Math.PI) / 180),
    y: -Math.cos((axisBearingDeg * Math.PI) / 180),
  });
  const forward = normalize({ x: Math.cos(headingRad), y: Math.sin(headingRad) });
  const perp = leftNormal(forward);
  const offsetPx = input.lateralOffsetM * input.pxpm;
  const deltaPx = scale(perp, offsetPx);

  const referenceAxisPx = input.axisPolylinePx.map(([x, y]) => [x, y] as [number, number]);
  const mobileAxisPx = translatePolyline(referenceAxisPx, deltaPx);
  const mobileAnchor = asTuple(add(asPoint(projection.point), deltaPx));

  const pose = rearAxlePoseForCenteredTruck({
    anchorPx: mobileAnchor,
    headingRad,
    truck: input.truck,
    pxpm: input.pxpm,
  });
  const truckPx = truckSpecInPixels(input.truck, input.pxpm);
  const footprint = truckFootprint(pose, truckPx);
  const frontAxle = add(pose, scale(forward, truckPx.wheelbaseM));
  const truckCenter = add(
    pose,
    scale(forward, (truckPx.wheelbaseM + truckPx.frontOverhangM - truckPx.rearOverhangM) / 2),
  );

  return {
    referenceAxisPx,
    mobileAxisPx,
    truckFootprintPx: footprint.map(asTuple),
    rearAxlePx: asTuple(pose),
    frontAxlePx: asTuple(frontAxle),
    truckCenterPx: asTuple(truckCenter),
    axisBearingDeg,
    lateralOffsetM: input.lateralOffsetM,
    perpUnitPx: asTuple(perp),
  };
}

export function lateralOffsetMFromPointerDelta(params: {
  readonly deltaPx: readonly [number, number];
  readonly perpUnitPx: readonly [number, number];
  readonly pxpm: number;
  readonly baseOffsetM: number;
}): number {
  const projectedPx =
    params.deltaPx[0] * params.perpUnitPx[0] + params.deltaPx[1] * params.perpUnitPx[1];
  return params.baseOffsetM + projectedPx / params.pxpm;
}
