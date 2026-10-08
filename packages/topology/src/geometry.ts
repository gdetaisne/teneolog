/**
 * Geometric primitives. Pure, dependency-free, metres and degrees.
 */
import type { GeoPoint } from '@teneolog/domain';

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

export function haversineM(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Two vertices nearer than this carry no direction between them. At the six
 * decimals a router publishes, two DISTINCT positions are never closer than
 * about 11 cm, so this separates "the same point twice" from "two adjacent
 * points" without touching real geometry.
 */
const DEGENERATE_SEGMENT_M = 0.05;

/**
 * Drop the vertices a polyline repeats.
 *
 * The same position twice in a row is not a segment — and `bearingDeg` of a
 * zero-length one does not fail, it returns 0°: due north. That silent north
 * is how OSRM's routed geometry, which repeats its snapped departure vertex,
 * fabricated a turn at metre zero of every itinerary. The deflection
 * read there was the heading of the first REAL segment measured against a
 * north nobody drove — 242° on rue de l’Exemple, so 118° of phantom turn, well
 * past the 60° that makes a manoeuvre. A perfectly straight street opened the
 * review with « le 19 t tourne-t-il ici ? ».
 *
 * So the repeat goes at the door, where the geometry enters the domain. A
 * polyline that collapses to a single point stays a single point; it never
 * becomes empty.
 */
export function withoutDegenerateSegments(polyline: readonly GeoPoint[]): readonly GeoPoint[] {
  if (polyline.length < 2) return polyline;
  const kept: GeoPoint[] = [];
  for (const point of polyline) {
    const last = kept[kept.length - 1];
    if (last !== undefined && haversineM(last, point) < DEGENERATE_SEGMENT_M) continue;
    kept.push(point);
  }
  return kept.length === polyline.length ? polyline : kept;
}

/** Destination of a geodesic of `distanceM` along `azimuthDeg` (clockwise from north). */
export function offsetPoint(from: GeoPoint, azimuthDeg: number, distanceM: number): GeoPoint {
  const angular = distanceM / EARTH_RADIUS_M;
  const θ = toRad(azimuthDeg);
  const φ1 = toRad(from.lat);
  const λ1 = toRad(from.lon);
  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinφ2 = sinφ1 * Math.cos(angular) + cosφ1 * Math.sin(angular) * Math.cos(θ);
  const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(angular) * cosφ1,
      Math.cos(angular) - sinφ1 * Math.sin(φ2),
    );
  return {
    lat: toDeg(φ2),
    lon: ((toDeg(λ2) + 540) % 360) - 180,
  };
}

/** Initial bearing from `a` to `b`, degrees clockwise from north, [0, 360). */
export function bearingDeg(a: GeoPoint, b: GeoPoint): number {
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest absolute difference between two bearings, [0, 180]. */
export function bearingDeltaDeg(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

export interface ClosestPoint {
  readonly point: GeoPoint;
  readonly distanceM: number;
  /** Index of the polyline vertex starting the closest segment. */
  readonly segmentIndex: number;
  /** Distance from the polyline start to the projection, metres. */
  readonly alongM: number;
}

/** Projects `p` onto a polyline using a local equirectangular approximation. */
export function closestPointOnPolyline(
  polyline: readonly GeoPoint[],
  p: GeoPoint,
): ClosestPoint | null {
  if (polyline.length === 0) return null;
  const first = polyline[0];
  if (first === undefined) return null;
  if (polyline.length === 1) {
    return { point: first, distanceM: haversineM(first, p), segmentIndex: 0, alongM: 0 };
  }

  const latScale = Math.cos(toRad(p.lat));
  const x = (q: GeoPoint): number => q.lon * latScale;
  const y = (q: GeoPoint): number => q.lat;

  let best: ClosestPoint | null = null;
  let travelled = 0;

  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    if (a === undefined || b === undefined) continue;

    const ax = x(a);
    const ay = y(a);
    const dx = x(b) - ax;
    const dy = y(b) - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((x(p) - ax) * dx + (y(p) - ay) * dy) / lenSq));
    const projected: GeoPoint = { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
    const distanceM = haversineM(projected, p);

    if (best === null || distanceM < best.distanceM) {
      best = { point: projected, distanceM, segmentIndex: i, alongM: travelled + haversineM(a, projected) };
    }
    travelled += haversineM(a, b);
  }
  return best;
}

/** Total length of a polyline, metres. */
export function polylineLengthM(polyline: readonly GeoPoint[]): number {
  let total = 0;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    if (a !== undefined && b !== undefined) total += haversineM(a, b);
  }
  return total;
}

/**
 * The point `alongM` metres from the start of a polyline, interpolated inside
 * its segment and clamped to the two ends. Null on an empty polyline.
 */
export function pointAlongPolyline(polyline: readonly GeoPoint[], alongM: number): GeoPoint | null {
  const first = polyline[0];
  if (first === undefined) return null;
  if (alongM <= 0) return first;
  let travelled = 0;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i] as GeoPoint;
    const b = polyline[i + 1] as GeoPoint;
    const segM = haversineM(a, b);
    if (segM > 0 && travelled + segM >= alongM) {
      const t = (alongM - travelled) / segM;
      return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
    }
    travelled += segM;
  }
  return polyline[polyline.length - 1] as GeoPoint;
}

/**
 * The stretch of a polyline between two distances from its start, both ends
 * interpolated, the vertices in between kept — so a slice follows the line it
 * was cut from, never a chord. Clamped to the polyline; empty when it is.
 */
export function slicePolyline(polyline: readonly GeoPoint[], fromM: number, toM: number): GeoPoint[] {
  const start = pointAlongPolyline(polyline, fromM);
  const end = pointAlongPolyline(polyline, toM);
  if (start === null || end === null) return [];
  const inner: GeoPoint[] = [];
  let travelled = 0;
  for (let i = 1; i < polyline.length; i += 1) {
    travelled += haversineM(polyline[i - 1] as GeoPoint, polyline[i] as GeoPoint);
    if (travelled > fromM && travelled < toM) inner.push(polyline[i] as GeoPoint);
  }
  return [start, ...inner, end];
}

/**
 * Largest circle that fits inside a polygon, as a diameter in metres.
 *
 * Grid-sampled rather than exact: the inputs are surveyed polygons with metre-scale
 * error, so an exact inscribed-circle solver would report precision the data does
 * not have. Returns the diameter and the centre it was found at.
 */
export function largestInscribedCircle(
  polygon: readonly GeoPoint[],
  samples = 24,
): { readonly diameterM: number; readonly centre: GeoPoint } | null {
  if (polygon.length < 3) return null;

  const lats = polygon.map((q) => q.lat);
  const lons = polygon.map((q) => q.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);

  let bestR = 0;
  let bestCentre: GeoPoint | null = null;

  for (let i = 0; i <= samples; i += 1) {
    for (let j = 0; j <= samples; j += 1) {
      const candidate: GeoPoint = {
        lat: minLat + ((maxLat - minLat) * i) / samples,
        lon: minLon + ((maxLon - minLon) * j) / samples,
      };
      if (!pointInPolygon(candidate, polygon)) continue;
      const r = distanceToBoundaryM(candidate, polygon);
      if (r > bestR) {
        bestR = r;
        bestCentre = candidate;
      }
    }
  }
  return bestCentre === null ? null : { diameterM: 2 * bestR, centre: bestCentre };
}

export function pointInPolygon(p: GeoPoint, polygon: readonly GeoPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;
    const straddles = a.lat > p.lat !== b.lat > p.lat;
    if (!straddles) continue;
    const xAtLat = ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon;
    if (p.lon < xAtLat) inside = !inside;
  }
  return inside;
}

function distanceToBoundaryM(p: GeoPoint, polygon: readonly GeoPoint[]): number {
  const closed = polygon[0] === undefined ? polygon : [...polygon, polygon[0]];
  const closest = closestPointOnPolyline(closed as readonly GeoPoint[], p);
  return closest?.distanceM ?? 0;
}
