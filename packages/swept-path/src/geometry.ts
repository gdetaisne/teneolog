import type { Point, Pose, TruckSpec } from './types.js';

const EPS = 1e-9;

export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(v: Point, s: number): Point {
  return { x: v.x * s, y: v.y * s };
}

export function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

export function length(v: Point): number {
  return Math.hypot(v.x, v.y);
}

export function normalize(v: Point): Point {
  const len = length(v);
  if (len < EPS) return { x: 1, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

export function leftNormal(v: Point): Point {
  return { x: -v.y, y: v.x };
}

export function rightNormal(v: Point): Point {
  return { x: v.y, y: -v.x };
}

/** Geographic-style bearing (0=north, 90=east) to screen-metric unit vector (y down). */
export function unitFromBearingDeg(bearingDeg: number): Point {
  const rad = (bearingDeg * Math.PI) / 180;
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}

export function headingRadFromUnit(direction: Point): number {
  return Math.atan2(direction.y, direction.x);
}

export function lerp(a: Point, b: Point, t: number): Point {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

export function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

export function sampleCubicBezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  sampleCount: number,
): Point[] {
  const count = Math.max(2, sampleCount);
  return Array.from({ length: count }, (_, index) =>
    cubicBezier(p0, p1, p2, p3, index / (count - 1)),
  );
}

export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += length(sub(points[i]!, points[i - 1]!));
  }
  return total;
}

export function poseAtPathIndex(points: readonly Point[], index: number): Pose {
  const point = points[index] ?? points[0] ?? { x: 0, y: 0 };
  const prev = points[Math.max(0, index - 1)] ?? point;
  const next = points[Math.min(points.length - 1, index + 1)] ?? point;
  const direction = normalize(sub(next, prev));
  return { x: point.x, y: point.y, headingRad: headingRadFromUnit(direction) };
}

/** Body footprint with rear axle as pose anchor. Points are clockwise. */
export function truckFootprint(pose: Pose, truck: TruckSpec): Point[] {
  const c = new Float64Array(8);
  truckCornersInto(pose, truck, c);
  return [
    { x: c[0]!, y: c[1]! },
    { x: c[2]!, y: c[3]! },
    { x: c[4]!, y: c[5]! },
    { x: c[6]!, y: c[7]! },
  ];
}

/**
 * The corners of `truckFootprint`, written as x0, y0 … x3, y3 into `out` — the
 * one rectangle of the package, without an object per corner (le
 * trois temps en teste ~10⁴ poses à chaque déplacement de la poignée). Side =
 * `leftNormal(forward)`, which is the driver's RIGHT in this y-down frame.
 */
export function truckCornersInto(pose: Pose, truck: TruckSpec, out: Float64Array): void {
  const fx = Math.cos(pose.headingRad);
  const fy = Math.sin(pose.headingRad);
  const sx = -fy;
  const sy = fx;
  const frontM = truck.wheelbaseM + truck.frontOverhangM;
  const rearM = truck.rearOverhangM;
  const halfW = truck.widthM / 2;
  const fcx = pose.x + fx * frontM;
  const fcy = pose.y + fy * frontM;
  const rcx = pose.x + fx * -rearM;
  const rcy = pose.y + fy * -rearM;
  out[0] = fcx + sx * halfW;
  out[1] = fcy + sy * halfW;
  out[2] = fcx + sx * -halfW;
  out[3] = fcy + sy * -halfW;
  out[4] = rcx + sx * -halfW;
  out[5] = rcy + sy * -halfW;
  out[6] = rcx + sx * halfW;
  out[7] = rcy + sy * halfW;
}

export function polygonArea(points: readonly Point[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function convexHull(points: readonly Point[]): Point[] {
  const unique = [...new Map(points.map((p) => [`${p.x.toFixed(6)},${p.y.toFixed(6)}`, p])).values()];
  if (unique.length <= 3) return unique;
  unique.sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const p = unique[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

export function pointInConvexPolygon(point: Point, polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (Math.abs(cross) < EPS) continue;
    const current = Math.sign(cross);
    if (sign === 0) sign = current;
    if (current !== sign) return false;
  }
  return true;
}

export function distancePointToSegment(point: Point, a: Point, b: Point): number {
  const ab = sub(b, a);
  const denom = dot(ab, ab);
  if (denom < EPS) return length(sub(point, a));
  const t = Math.max(0, Math.min(1, dot(sub(point, a), ab) / denom));
  return length(sub(point, add(a, scale(ab, t))));
}

export function signedClearanceToConvexPolygon(point: Point, polygon: readonly Point[]): number {
  if (polygon.length < 3) return Number.NEGATIVE_INFINITY;
  let minDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i += 1) {
    minDist = Math.min(
      minDist,
      distancePointToSegment(point, polygon[i]!, polygon[(i + 1) % polygon.length]!),
    );
  }
  return pointInConvexPolygon(point, polygon) ? minDist : -minDist;
}
