export interface AxisSample {
  cx: number;
  cy: number;
  tangentX: number;
  tangentY: number;
  perpX: number;
  perpY: number;
}

export interface RoadAxis {
  anchor: { x: number; y: number };
  spanM: number;
  axisAt(tMeters: number): AxisSample;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface SurfacePolygonGeo {
  id: string;
  nature: string;
  rings: Array<Array<LatLng>>;
}

export interface TileGeoContext {
  latA: number;
  lngA: number;
  roadPolylines: Array<Array<LatLng>>;
  dx2Px: number;
  dy2Px: number;
  dx3Px: number;
  dy3Px: number;
  /** IGN BDTOPO building footprints (WGS84 rings). */
  buildingPolygons?: SurfacePolygonGeo[];
  /** IGN BDTOPO vegetation zones (WGS84 rings). */
  vegetationPolygons?: SurfacePolygonGeo[];
  /** IGN BDTOPO activity zones filtered to parking (WFS `zone_d_activite_ou_d_interet`). */
  parkingPolygons?: SurfacePolygonGeo[];
}

export const TILE_SIZE_PX = 512;

export function getStitchedCanvasMetrics(
  tile: Pick<TileGeoContext, 'dx2Px' | 'dy2Px' | 'dx3Px' | 'dy3Px'>,
) {
  const dx2 = Math.round(tile.dx2Px);
  const dy2 = Math.round(tile.dy2Px);
  const dx3 = Math.round(tile.dx3Px);
  const dy3 = Math.round(tile.dy3Px);
  const x1 = Math.min(0, dx2, dx3);
  const y1 = Math.min(0, dy2, dy3);
  const x2 = Math.max(TILE_SIZE_PX, dx2 + TILE_SIZE_PX, dx3 + TILE_SIZE_PX);
  const y2 = Math.max(TILE_SIZE_PX, dy2 + TILE_SIZE_PX, dy3 + TILE_SIZE_PX);
  return {
    width: x2 - x1,
    height: y2 - y1,
    tileACanvasX: -x1 + TILE_SIZE_PX / 2,
    tileACanvasY: -y1 + TILE_SIZE_PX / 2,
  };
}

export function getSingleTileMetrics(tile: TileGeoContext, tileIndex: 0 | 1 | 2) {
  const offsets = [
    { dx: 0, dy: 0 },
    { dx: Math.round(tile.dx2Px), dy: Math.round(tile.dy2Px) },
    { dx: Math.round(tile.dx3Px), dy: Math.round(tile.dy3Px) },
  ] as const;
  const { dx, dy } = offsets[tileIndex];
  const stitch = getStitchedCanvasMetrics(tile);
  return {
    width: TILE_SIZE_PX,
    height: TILE_SIZE_PX,
    tileACanvasX: stitch.tileACanvasX - dx,
    tileACanvasY: stitch.tileACanvasY - dy,
  };
}

export function latLngToCanvasPx(
  p: LatLng,
  tile: Pick<TileGeoContext, 'latA' | 'lngA'>,
  metrics: { tileACanvasX: number; tileACanvasY: number },
  pxPerM: number,
): { x: number; y: number } {
  const cosLat = Math.cos(tile.latA * Math.PI / 180);
  return {
    x: metrics.tileACanvasX + (p.lng - tile.lngA) * 111_320 * cosLat * pxPerM,
    y: metrics.tileACanvasY - (p.lat - tile.latA) * 111_320 * pxPerM,
  };
}

export function buildBearingFallbackAxis(
  W: number,
  H: number,
  pxPerM: number,
  bearingDeg: number,
): RoadAxis {
  const bearingRad = bearingDeg * Math.PI / 180;
  const fbTanX = Math.sin(bearingRad);
  const fbTanY = -Math.cos(bearingRad);
  const fbPerpX = -fbTanY;
  const fbPerpY = fbTanX;
  return {
    anchor: { x: W / 2, y: H / 2 },
    spanM: Math.hypot(W, H) / pxPerM / 2,
    axisAt: (t: number) => ({
      cx: W / 2 + t * pxPerM * fbTanX,
      cy: H / 2 + t * pxPerM * fbTanY,
      tangentX: fbTanX,
      tangentY: fbTanY,
      perpX: fbPerpX,
      perpY: fbPerpY,
    }),
  };
}

import type { SerializableRoadAxis } from './road-axis-serial.js';
export type { SerializableRoadAxis } from './road-axis-serial.js';
export { hydrateRoadAxis } from './road-axis-serial.js';

export interface BuiltRoadAxis {
  readonly axis: RoadAxis;
  readonly serial: SerializableRoadAxis;
}

type PxPoint = { x: number; y: number };

/** Max join turn (deg) to still treat two segments as one continuous road. */
const AXIS_MERGE_TURN_TOL_DEG = 55;

function joinTurnDeg(from: PxPoint, via: PxPoint, to: PxPoint): number {
  const ax = via.x - from.x;
  const ay = via.y - from.y;
  const bx = to.x - via.x;
  const by = to.y - via.y;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-6 || lb < 1e-6) return 0;
  const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Merge topologically-connected road polylines into continuous chains so the
 * reference axis can follow a bend across a BDTOPO segment junction instead of
 * stopping at a single coarse segment (rural curves are split as short 4-5 pt
 * segments; a single one is a straight chord over the bend). Two polylines are
 * joined when an endpoint of one coincides (within `tolPx`) with an endpoint of
 * the other AND the join stays directionally continuous (turn ≤
 * `AXIS_MERGE_TURN_TOL_DEG`) — this prevents merging onto a cross-street at a
 * Y/T junction. Uses only the input vertices; no invented geometry.
 */
function mergeConnectedAxisChains(
  polys: ReadonlyArray<ReadonlyArray<PxPoint>>,
  pxPerM: number,
): Array<Array<PxPoint>> {
  const tolPx = Math.max(3, pxPerM); // ~1 m endpoint coincidence
  const chains: Array<Array<PxPoint>> = polys.map((p) => p.map((q) => ({ x: q.x, y: q.y })));
  const near = (a: PxPoint, b: PxPoint) => Math.hypot(a.x - b.x, a.y - b.y) <= tolPx;
  const cont = (from: PxPoint, via: PxPoint, to: PxPoint) =>
    joinTurnDeg(from, via, to) <= AXIS_MERGE_TURN_TOL_DEG;

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < chains.length && !merged; i += 1) {
      for (let j = i + 1; j < chains.length && !merged; j += 1) {
        const A = chains[i]!;
        const B = chains[j]!;
        if (A.length < 2 || B.length < 2) continue;
        const aHead = A[0]!;
        const aTail = A[A.length - 1]!;
        const bHead = B[0]!;
        const bTail = B[B.length - 1]!;
        let joined: Array<PxPoint> | null = null;
        if (near(aTail, bHead) && cont(A[A.length - 2]!, aTail, B[1]!)) {
          joined = [...A, ...B.slice(1)];
        } else if (near(aTail, bTail) && cont(A[A.length - 2]!, aTail, B[B.length - 2]!)) {
          joined = [...A, ...[...B].reverse().slice(1)];
        } else if (near(aHead, bTail) && cont(B[B.length - 2]!, aHead, A[1]!)) {
          joined = [...B, ...A.slice(1)];
        } else if (near(aHead, bHead) && cont(B[1]!, aHead, A[1]!)) {
          joined = [...[...B].reverse(), ...A.slice(1)];
        }
        if (joined) {
          chains.splice(j, 1);
          chains[i] = joined;
          merged = true;
        }
      }
    }
  }
  return chains;
}

export function buildRoadAxisWithSerial(
  W: number,
  H: number,
  pxPerM: number,
  bearingDeg: number,
  tile: TileGeoContext,
  tileIndex?: 0 | 1 | 2,
): BuiltRoadAxis {
  const bearingRad = bearingDeg * Math.PI / 180;
  const fbTanX = Math.sin(bearingRad);
  const fbTanY = -Math.cos(bearingRad);
  const fbPerpX = -fbTanY;
  const fbPerpY = fbTanX;

  const makeFallback = (): BuiltRoadAxis => ({
    axis: buildBearingFallbackAxis(W, H, pxPerM, bearingDeg),
    serial: { kind: 'bearing-fallback', W, H, pxPerM, bearingDeg },
  });

  if (!tile.roadPolylines || tile.roadPolylines.length === 0) return makeFallback();

  const metrics =
    tileIndex === undefined
      ? getStitchedCanvasMetrics(tile)
      : getSingleTileMetrics(tile, tileIndex);
  const toPx = (p: LatLng) => latLngToCanvasPx(p, tile, metrics, pxPerM);

  const inCanvas = (v: { x: number; y: number }) =>
    v.x > -50 && v.x < W + 50 && v.y > -50 && v.y < H + 50;

  const rawPx = tile.roadPolylines
    .map(poly => poly.map(toPx))
    .filter(poly => poly.length >= 2 && poly.some(inCanvas));
  if (rawPx.length === 0) return makeFallback();
  // Merge connected+continuous BDTOPO segments so the axis follows bends across
  // junctions instead of using a single coarse segment (Option 1, curve fidelity).
  const allPx = mergeConnectedAxisChains(rawPx, pxPerM);

  const toBuilt = (
    anchorX: number,
    anchorY: number,
    spanM: number,
    anchorMeters: number,
    ordered: Array<{ x: number; y: number }>,
    cumLenM: Float64Array,
    segTanX: Float64Array,
    segTanY: Float64Array,
    segLenPx: Float64Array,
    axisAt: (tMeters: number) => AxisSample,
  ): BuiltRoadAxis => ({
    axis: { anchor: { x: anchorX, y: anchorY }, spanM, axisAt },
    serial: {
      kind: 'polyline',
      pxPerM,
      anchor: { x: anchorX, y: anchorY },
      spanM,
      anchorMeters,
      points: ordered.map((p) => ({ x: p.x, y: p.y })),
      cumLenM: Array.from(cumLenM),
      segTanX: Array.from(segTanX),
      segTanY: Array.from(segTanY),
      segLenPx: Array.from(segLenPx),
    },
  });

  const canvasCentre = { x: W / 2, y: H / 2 };
  let bestPoly: Array<{ x: number; y: number }> | null = null;
  let bestPerpDist = Infinity;
  for (const poly of allPx) {
    let perpDist = Infinity;
    for (let i = 0; i < poly.length - 1; i++) {
      const a = poly[i]!;
      const b = poly[i + 1]!;
      const sx = b.x - a.x;
      const sy = b.y - a.y;
      const lenSq = sx * sx + sy * sy;
      if (lenSq < 1e-9) continue;
      const u = Math.max(0, Math.min(1, ((canvasCentre.x - a.x) * sx + (canvasCentre.y - a.y) * sy) / lenSq));
      const projX = a.x + u * sx;
      const projY = a.y + u * sy;
      const d = Math.hypot(canvasCentre.x - projX, canvasCentre.y - projY);
      if (d < perpDist) perpDist = d;
    }
    if (perpDist < bestPerpDist) {
      bestPerpDist = perpDist;
      bestPoly = poly;
    }
  }
  if (!bestPoly) return makeFallback();

  const first = bestPoly[0]!;
  const last = bestPoly[bestPoly.length - 1]!;
  const dot = (last.x - first.x) * fbTanX + (last.y - first.y) * fbTanY;
  const ordered = dot < 0 ? [...bestPoly].reverse() : bestPoly;

  const N = ordered.length;
  const cumLenM = new Float64Array(N);
  const segTanX = new Float64Array(N - 1);
  const segTanY = new Float64Array(N - 1);
  const segLenPx = new Float64Array(N - 1);
  for (let i = 0; i < N - 1; i++) {
    const a = ordered[i]!;
    const b = ordered[i + 1]!;
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const len = Math.hypot(sx, sy) || 1e-9;
    segTanX[i] = sx / len;
    segTanY[i] = sy / len;
    segLenPx[i] = len;
    cumLenM[i + 1] = cumLenM[i]! + len / pxPerM;
  }

  let anchorSeg = 0;
  let anchorT = 0;
  let anchorDist = Infinity;
  let anchorX = ordered[0]!.x;
  let anchorY = ordered[0]!.y;
  for (let i = 0; i < N - 1; i++) {
    const a = ordered[i]!;
    const b = ordered[i + 1]!;
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const lenSq = sx * sx + sy * sy;
    if (lenSq < 1e-9) continue;
    const tProj = Math.max(0, Math.min(1, ((canvasCentre.x - a.x) * sx + (canvasCentre.y - a.y) * sy) / lenSq));
    const projX = a.x + tProj * sx;
    const projY = a.y + tProj * sy;
    const d = Math.hypot(canvasCentre.x - projX, canvasCentre.y - projY);
    if (d < anchorDist) {
      anchorDist = d;
      anchorSeg = i;
      anchorT = tProj;
      anchorX = projX;
      anchorY = projY;
    }
  }

  const anchorMeters = cumLenM[anchorSeg]! + anchorT * (segLenPx[anchorSeg]! / pxPerM);
  const totalM = cumLenM[N - 1]!;
  const spanM = Math.max(totalM - anchorMeters, anchorMeters);

  const axisAt = (tMeters: number): AxisSample => {
    const target = anchorMeters + tMeters;
    if (target <= 0) {
      const tx = segTanX[0]!;
      const ty = segTanY[0]!;
      const dPx = target * pxPerM;
      return {
        cx: ordered[0]!.x + dPx * tx,
        cy: ordered[0]!.y + dPx * ty,
        tangentX: tx,
        tangentY: ty,
        perpX: -ty,
        perpY: tx,
      };
    }
    if (target >= totalM) {
      const k = N - 2;
      const tx = segTanX[k]!;
      const ty = segTanY[k]!;
      const dPx = (target - totalM) * pxPerM;
      return {
        cx: ordered[N - 1]!.x + dPx * tx,
        cy: ordered[N - 1]!.y + dPx * ty,
        tangentX: tx,
        tangentY: ty,
        perpX: -ty,
        perpY: tx,
      };
    }
    let lo = 0;
    let hi = N - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cumLenM[mid]! <= target) lo = mid;
      else hi = mid;
    }
    const seg = lo;
    const u = (target - cumLenM[seg]!) * pxPerM / segLenPx[seg]!;
    const tx = segTanX[seg]!;
    const ty = segTanY[seg]!;
    const a = ordered[seg]!;
    const b = ordered[seg + 1]!;
    return {
      cx: a.x + u * (b.x - a.x),
      cy: a.y + u * (b.y - a.y),
      tangentX: tx,
      tangentY: ty,
      perpX: -ty,
      perpY: tx,
    };
  };

  return toBuilt(anchorX, anchorY, spanM, anchorMeters, ordered, cumLenM, segTanX, segTanY, segLenPx, axisAt);
}

export function buildRoadAxis(
  W: number,
  H: number,
  pxPerM: number,
  bearingDeg: number,
  tile: TileGeoContext,
  tileIndex?: 0 | 1 | 2,
): RoadAxis {
  return buildRoadAxisWithSerial(W, H, pxPerM, bearingDeg, tile, tileIndex).axis;
}

export function boundedScanHalfM(roadAxis: RoadAxis, defaultHalfM: number): number {
  if (roadAxis.spanM > 0 && Number.isFinite(roadAxis.spanM)) {
    return Math.min(defaultHalfM, roadAxis.spanM);
  }
  return defaultHalfM;
}

export interface BuildingCorridorBlendOptions {
  /** Weight for building-gap center vs BDTOPO axis (0 = BDTOPO only). */
  blend?: number;
  maxScanM?: number;
  minGapWidthM?: number;
  maxGapWidthM?: number;
  sampleStepM?: number;
}

interface OpenGapAlongPerp {
  centerM: number;
  widthM: number;
}

function findOpenGapAlongPerp(
  buildingData: Uint8Array,
  width: number,
  height: number,
  ax: AxisSample,
  pxPerM: number,
  maxScanM: number,
  sampleStepM: number,
  minGapWidthM: number,
  maxGapWidthM: number,
): OpenGapAlongPerp | null {
  const stepM = sampleStepM;
  const n = Math.max(3, Math.ceil((2 * maxScanM) / stepM) + 1);
  const samples: Array<{ sM: number; building: boolean }> = [];

  for (let i = 0; i < n; i++) {
    const sM = -maxScanM + i * stepM;
    const x = Math.round(ax.cx + sM * pxPerM * ax.perpX);
    const y = Math.round(ax.cy + sM * pxPerM * ax.perpY);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    samples.push({ sM, building: buildingData[y * width + x]! > 0 });
  }
  if (samples.length < 3) return null;

  const gaps: Array<{ startM: number; endM: number }> = [];
  let gapStart: number | null = null;
  for (const s of samples) {
    if (!s.building) {
      if (gapStart === null) gapStart = s.sM;
    } else if (gapStart !== null) {
      gaps.push({ startM: gapStart, endM: s.sM });
      gapStart = null;
    }
  }
  if (gapStart !== null) {
    gaps.push({ startM: gapStart, endM: samples[samples.length - 1]!.sM });
  }

  const valid = gaps.filter((g) => {
    const w = g.endM - g.startM;
    return w >= minGapWidthM && w <= maxGapWidthM;
  });
  if (valid.length === 0) return null;

  const containingZero = valid.find((g) => g.startM <= 0 && g.endM >= 0);
  const pick = containingZero ?? valid.reduce((best, g) => {
    const w = g.endM - g.startM;
    const bw = best.endM - best.startM;
    return w > bw ? g : best;
  });

  const widthM = pick.endM - pick.startM;
  return { centerM: (pick.startM + pick.endM) / 2, widthM };
}

/**
 * Shifts the road axis toward the open corridor between building footprints.
 * Blends with the BDTOPO (or fallback) axis — does not replace bearing.
 */
export interface BuildingCorridorRefineResult {
  axis: RoadAxis;
  /** True when lateral offsets were blended with the BDTOPO axis. */
  corridorApplied: boolean;
  /** Fast rehydrate payload when corridor blend was not applied. */
  roadAxisSerial?: SerializableRoadAxis | null;
}

export function refineRoadAxisWithBuildingCorridor(
  base: RoadAxis,
  buildingMask: { width: number; height: number; data: Uint8Array },
  pxPerM: number,
  opts: BuildingCorridorBlendOptions = {},
): BuildingCorridorRefineResult {
  const blend = opts.blend ?? 0.5;
  const maxScanM = opts.maxScanM ?? 25;
  const minGapWidthM = opts.minGapWidthM ?? 4;
  const maxGapWidthM = opts.maxGapWidthM ?? 28;
  const sampleStepM = opts.sampleStepM ?? 0.35;

  const spanM = base.spanM > 0 ? base.spanM : 20;
  const stepM = 0.5;
  const offsets: Array<{ tM: number; lateralM: number }> = [];

  for (let tM = -spanM; tM <= spanM; tM += stepM) {
    const ax = base.axisAt(tM);
    const gap = findOpenGapAlongPerp(
      buildingMask.data,
      buildingMask.width,
      buildingMask.height,
      ax,
      pxPerM,
      maxScanM,
      sampleStepM,
      minGapWidthM,
      maxGapWidthM,
    );
    if (gap) offsets.push({ tM, lateralM: gap.centerM });
  }

  if (offsets.length < 3 || offsets.length / ((2 * spanM) / stepM + 1) < 0.35) {
    return { axis: base, corridorApplied: false };
  }

  const smoothWindow = 3;
  const smoothAt = (tM: number): number => {
    const near = offsets.filter((o) => Math.abs(o.tM - tM) <= smoothWindow);
    if (near.length === 0) return 0;
    return near.reduce((s, o) => s + o.lateralM, 0) / near.length;
  };

  const axisAt = (tM: number): AxisSample => {
    const b = base.axisAt(tM);
    const lateralM = smoothAt(tM) * blend;
    return {
      cx: b.cx + lateralM * pxPerM * b.perpX,
      cy: b.cy + lateralM * pxPerM * b.perpY,
      tangentX: b.tangentX,
      tangentY: b.tangentY,
      perpX: b.perpX,
      perpY: b.perpY,
    };
  };

  const anchor = axisAt(0);
  return {
    axis: { anchor: { x: anchor.cx, y: anchor.cy }, spanM: base.spanM, axisAt },
    corridorApplied: true,
  };
}

export function buildRoadAxisWithBuildingBlend(
  W: number,
  H: number,
  pxPerM: number,
  bearingDeg: number,
  tile: TileGeoContext,
  tileIndex: 0 | 1 | 2 | undefined,
  buildingMask: { width: number; height: number; data: Uint8Array } | null,
): BuildingCorridorRefineResult {
  const base = buildRoadAxis(W, H, pxPerM, bearingDeg, tile, tileIndex);
  if (!buildingMask || (tile.buildingPolygons?.length ?? 0) === 0) {
    return { axis: base, corridorApplied: false };
  }
  return refineRoadAxisWithBuildingCorridor(base, buildingMask, pxPerM);
}

/**
 * Stitch / D10 road axis. Building-corridor blend is **off** unless
 * `ROAD_WIDTH_AXIS_BUILDING_BLEND=1` (experimental — see backlog to-control).
 */
export function isRoadAxisBuildingBlendEnabled(): boolean {
  const v =
    typeof process !== 'undefined' ? process.env?.ROAD_WIDTH_AXIS_BUILDING_BLEND : undefined;
  return v === '1' || v === 'true';
}

/** Single entry point for measurement + YOLO (smooth OSM axis by default). */
export function resolveStitchRoadAxis(
  W: number,
  H: number,
  pxPerM: number,
  bearingDeg: number,
  tile: TileGeoContext,
  tileIndex: 0 | 1 | 2 | undefined,
  buildingMask: { width: number; height: number; data: Uint8Array } | null,
): BuildingCorridorRefineResult {
  if (
    !isRoadAxisBuildingBlendEnabled() ||
    !buildingMask ||
    (tile.buildingPolygons?.length ?? 0) === 0
  ) {
    const built = buildRoadAxisWithSerial(W, H, pxPerM, bearingDeg, tile, tileIndex);
    return {
      axis: built.axis,
      corridorApplied: false,
      roadAxisSerial: built.serial,
    };
  }
  const blended = buildRoadAxisWithBuildingBlend(
    W,
    H,
    pxPerM,
    bearingDeg,
    tile,
    tileIndex,
    buildingMask,
  );
  return { ...blended, roadAxisSerial: null };
}

/**
 * Build a {@link RoadAxis} from a BDTOPO polyline already projected to image px.
 * Anchor is the closest point on the polyline to `anchorPx` (axisAt(0) there).
 * When `orientTowardPx` is set, the polyline is reversed so the end nearer that point
 * is the positive along-axis direction (mouth / ring for roundabout arms).
 */
export function buildRoadAxisFromPolylinePx(
  geometryPx: ReadonlyArray<readonly [number, number]>,
  pxPerM: number,
  anchorPx: readonly [number, number],
  orientTowardPx?: readonly [number, number],
): RoadAxis | null {
  if (geometryPx.length < 2 || pxPerM <= 0) return null;

  let ordered = geometryPx.map(([x, y]) => ({ x, y }));
  if (orientTowardPx) {
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    const towardFirst = Math.hypot(first.x - orientTowardPx[0], first.y - orientTowardPx[1]);
    const towardLast = Math.hypot(last.x - orientTowardPx[0], last.y - orientTowardPx[1]);
    if (towardFirst < towardLast) ordered = [...ordered].reverse();
  }

  const N = ordered.length;
  const cumLenM = new Float64Array(N);
  const segTanX = new Float64Array(N - 1);
  const segTanY = new Float64Array(N - 1);
  const segLenPx = new Float64Array(N - 1);
  for (let i = 0; i < N - 1; i++) {
    const a = ordered[i]!;
    const b = ordered[i + 1]!;
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const len = Math.hypot(sx, sy) || 1e-9;
    segTanX[i] = sx / len;
    segTanY[i] = sy / len;
    segLenPx[i] = len;
    cumLenM[i + 1] = cumLenM[i]! + len / pxPerM;
  }

  let anchorSeg = 0;
  let anchorT = 0;
  let anchorDist = Infinity;
  let anchorX = ordered[0]!.x;
  let anchorY = ordered[0]!.y;
  const [refX, refY] = anchorPx;
  for (let i = 0; i < N - 1; i++) {
    const a = ordered[i]!;
    const b = ordered[i + 1]!;
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const lenSq = sx * sx + sy * sy;
    if (lenSq < 1e-9) continue;
    const tProj = Math.max(0, Math.min(1, ((refX - a.x) * sx + (refY - a.y) * sy) / lenSq));
    const projX = a.x + tProj * sx;
    const projY = a.y + tProj * sy;
    const d = Math.hypot(refX - projX, refY - projY);
    if (d < anchorDist) {
      anchorDist = d;
      anchorSeg = i;
      anchorT = tProj;
      anchorX = projX;
      anchorY = projY;
    }
  }

  const anchorMeters = cumLenM[anchorSeg]! + anchorT * (segLenPx[anchorSeg]! / pxPerM);
  const totalM = cumLenM[N - 1]!;
  const spanM = Math.max(totalM - anchorMeters, anchorMeters);

  const axisAt = (tMeters: number): AxisSample => {
    const target = anchorMeters + tMeters;
    if (target <= 0) {
      const tx = segTanX[0]!;
      const ty = segTanY[0]!;
      const dPx = target * pxPerM;
      return {
        cx: ordered[0]!.x + dPx * tx,
        cy: ordered[0]!.y + dPx * ty,
        tangentX: tx,
        tangentY: ty,
        perpX: -ty,
        perpY: tx,
      };
    }
    if (target >= totalM) {
      const k = N - 2;
      const tx = segTanX[k]!;
      const ty = segTanY[k]!;
      const dPx = (target - totalM) * pxPerM;
      return {
        cx: ordered[N - 1]!.x + dPx * tx,
        cy: ordered[N - 1]!.y + dPx * ty,
        tangentX: tx,
        tangentY: ty,
        perpX: -ty,
        perpY: tx,
      };
    }
    let lo = 0;
    let hi = N - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cumLenM[mid]! <= target) lo = mid;
      else hi = mid;
    }
    const seg = lo;
    const u = (target - cumLenM[seg]!) * pxPerM / segLenPx[seg]!;
    const tx = segTanX[seg]!;
    const ty = segTanY[seg]!;
    const a = ordered[seg]!;
    const b = ordered[seg + 1]!;
    return {
      cx: a.x + u * (b.x - a.x),
      cy: a.y + u * (b.y - a.y),
      tangentX: tx,
      tangentY: ty,
      perpX: -ty,
      perpY: tx,
    };
  };

  return { anchor: { x: anchorX, y: anchorY }, spanM, axisAt };
}
