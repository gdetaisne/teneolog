/**
 * S4 — roundabouts the route actually traverses.
 *
 * The ring is read from `junction=roundabout` corridor ways (OSM's one
 * reliable roundabout signal — BDTOPO's `Rond-point` was missing exactly
 * where BUG-088 hurt). The measure that matters is the SWEPT angle — the
 * arc between where the route enters the ring and where it leaves — not the
 * ring's full circumference: BUG-082 was the simulation sweeping ~270° for
 * a manoeuvre that drives ~180°.
 */
import type { Fact, GeoPoint, RoundaboutGeometry } from '@teneolog/domain';
import { bearingDeg, closestPointOnPolyline, haversineM, isDrivableWay, type RoadWay } from '@teneolog/topology';

export interface RoundaboutDetectionParams {
  /** A route sample within this of the ring counts as on it. */
  readonly ringSnapM: number;
  /** Ring ways whose centroids are within this merge into one roundabout. */
  readonly ringMergeM: number;
  readonly geometryConfidence: number;
  /** Confidence carried by a width a source declares rather than one we measure. */
  readonly declaredWidthConfidence: number;
}

export interface DetectedRoundabout {
  readonly at: GeoPoint;
  readonly geometry: Fact<RoundaboutGeometry>;
  /** Suppression radius for turn points detected on the ring itself. */
  readonly suppressWithinM: number;
  readonly alongM: number;
}

export function detectRoundabouts(
  polyline: readonly GeoPoint[],
  corridor: readonly RoadWay[],
  params: RoundaboutDetectionParams,
  fetchedAt: string,
): readonly DetectedRoundabout[] {
  const ringWays = corridor.filter((w) => w.tags['junction'] === 'roundabout');
  if (ringWays.length === 0) return [];

  // A ring often arrives split into several ways; group by centroid proximity.
  const groups: RoadWay[][] = [];
  for (const way of ringWays) {
    const c = centroid(way.geometry);
    if (c === null) continue;
    const group = groups.find((g) => {
      const gc = centroid(g.flatMap((w) => [...w.geometry]));
      return gc !== null && haversineM(gc, c) <= params.ringMergeM;
    });
    if (group === undefined) groups.push([way]);
    else group.push(way);
  }

  const out: DetectedRoundabout[] = [];
  for (const group of groups) {
    const ringPoints = group.flatMap((w) => [...w.geometry]);
    const centre = centroid(ringPoints);
    if (centre === null) continue;
    // Mean centroid-to-vertex distance: the radius of the ring's CENTRELINE,
    // not of its outer kerb. Published under the domain's `outerRadiusM`.
    const centrelineRadiusM =
      ringPoints.reduce((sum, p) => sum + haversineM(centre, p), 0) / ringPoints.length;

    // Where the route meets the ring: entry = first sample near it, exit = last.
    const touches = ringTouches(polyline, group, params.ringSnapM);
    if (touches === null) continue; // roundabout in the corridor, not on the route

    const entryAzDeg = bearingDeg(centre, touches.entry.point);
    const exitAzDeg = bearingDeg(centre, touches.exit.point);
    // French roundabouts run counterclockwise; the driven arc from entry to
    // exit is the CCW sweep, in [0, 360). A sweep of exactly 0 can only come
    // from entry and exit at the same azimuth — the touch detection saw a
    // single sample — and is published as such rather than dressed as 360.
    const sweptAngleDeg = ((entryAzDeg - exitAzDeg) % 360 + 360) % 360;

    const armCount = countArms(group, corridor);

    out.push({
      at: centre,
      alongM: touches.entry.alongM,
      suppressWithinM: centrelineRadiusM + params.ringSnapM,
      geometry: {
        known: true,
        value: {
          centre,
          outerRadiusM: centrelineRadiusM,
          // The inner island is not in the corridor data; kerb-to-kerb ring
          // width comes with imagery (S7). Null states "unmeasured", and S5
          // must treat the ring width as unknown, not as generous.
          innerRadiusM: null,
          armCount,
          sweptAngleDeg,
          ringWidthM: declaredRingWidth(group, params.declaredWidthConfidence, fetchedAt),
        },
        provenance: { source: group[0]?.source ?? 'osm-overpass', method: 'ring-ways-swept-arc', fetchedAt },
        reliability: {
          confidence: params.geometryConfidence,
          basis: 'derived',
          reasonCodes: ['roundabout_from_ring_ways'],
        },
      },
    });
  }
  return out;
}

/**
 * Ring width from what the sources declare about the ring ways themselves.
 *
 * Smallest wins, the same rule legal limits follow: a ring made of several ways
 * is only as wide as its narrowest stretch. A declared width is weaker evidence
 * than a measured one and says so through its confidence; where no way declares
 * one, the answer is `no_data` and the roundabout goes to a human.
 */
function declaredRingWidth(
  ring: readonly RoadWay[],
  confidence: number,
  fetchedAt: string,
): Fact<number> {
  const declared = ring
    .map((way) => way.declaredWidthM)
    .filter((width): width is number => typeof width === 'number' && width > 0);
  if (declared.length === 0) return { known: false, why: 'no_data' };
  return {
    known: true,
    value: Math.min(...declared),
    provenance: {
      source: ring[0]?.source ?? 'osm-overpass',
      method: 'ring-declared-width-smallest',
      fetchedAt,
    },
    reliability: { confidence, basis: 'declared', reasonCodes: ['ring_width_declared'] },
  };
}

interface Touch {
  readonly point: GeoPoint;
  readonly alongM: number;
}

function ringTouches(
  polyline: readonly GeoPoint[],
  ring: readonly RoadWay[],
  snapM: number,
): { entry: Touch; exit: Touch } | null {
  let entry: Touch | null = null;
  let exit: Touch | null = null;
  let travelled = 0;
  for (let i = 0; i < polyline.length; i += 1) {
    const point = polyline[i];
    if (point === undefined) continue;
    if (i > 0) {
      const prev = polyline[i - 1];
      if (prev !== undefined) travelled += haversineM(prev, point);
    }
    const onRing = ring.some((w) => {
      const c = closestPointOnPolyline(w.geometry, point);
      return c !== null && c.distanceM <= snapM;
    });
    if (onRing) {
      if (entry === null) entry = { point, alongM: travelled };
      exit = { point, alongM: travelled };
    }
  }
  return entry === null || exit === null ? null : { entry, exit };
}

/** Drivable non-ring ways sharing a node with the ring — its arms. */
function countArms(ring: readonly RoadWay[], corridor: readonly RoadWay[]): number {
  const ringNodeIds = new Set(ring.flatMap((w) => [...w.nodeIds]));
  const ringIds = new Set(ring.map((w) => w.id));
  let arms = 0;
  for (const way of corridor) {
    if (ringIds.has(way.id) || !isDrivableWay(way)) continue;
    if (way.nodeIds.some((n) => ringNodeIds.has(n))) arms += 1;
  }
  return arms;
}

function centroid(points: readonly GeoPoint[]): GeoPoint | null {
  if (points.length === 0) return null;
  let lat = 0;
  let lon = 0;
  for (const p of points) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / points.length, lon: lon / points.length };
}
