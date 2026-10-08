/**
 * S4 — manoeuvre detection on a routed polyline.
 *
 * A manoeuvre is a **turning run**: consecutive vertices that bend the same
 * way, with no straight stretch longer than `mergeWithinM` between them, over
 * at most `windowM` of arc. Its angle is the **net** change of heading between
 * its entry and its exit — the mean bearings read `bearingOffsetM` before the
 * first turning vertex and after the last — never the sum of the vertex
 * deflections.
 *
 * That distinction is the whole. Summing deflections over a sliding
 * window reported "128°" where the road turns 42° (Thairé, Rue Voisine 18 →
 * Rue Voisine 10): a street debouching inside the window contributed its
 * own kink, the windows merged, and the total became an angle no vehicle ever
 * swings through. It then fixed the worst margin of all 100 plans. A net
 * heading change cannot do that: what comes in and what goes out is what the
 * driver does, whatever the router drew in between.
 *
 * Two corpus lessons survive the rewrite, and shaped it:
 *
 * - EC-26 (Poitiers): a truck-critical bend arrives from the router SPLIT into
 *   several sub-45° vertices. A run groups them, so the corner is one
 *   manoeuvre — that property is why runs replaced per-vertex detection, and
 *   the net angle over the run keeps it.
 * - BUG-079 (urgent/vital in the ledger): approach and exit bearings are
 *   measured at ±offset from the manoeuvre, never on the apex vertex pair.
 *
 * Truck-agnostic: a manoeuvre is reported with its geometry and its kind;
 * whether a given wheelbase clears it is S5's pure comparison.
 */
import type { Fact, GeoPoint, TurnGeometry } from '@teneolog/domain';
import { bearingDeg, haversineM, withoutDegenerateSegments, type RoadWay } from '@teneolog/topology';

import { isJunctionApex, junctionNodes, type JunctionTestParams } from './turn-kind.js';

/**
 * Below this a vertex is router noise, not steering: it neither starts a run
 * nor breaks one. Not a policy knob — it is the floor of what a polyline can
 * express, which is why it lives with the geometry and not in the JSON.
 */
const TURNING_FLOOR_DEG = 0.5;

export interface TurnDetectionParams {
  /** Longest arc one manoeuvre may span. Beyond it, a second manoeuvre starts. */
  readonly windowM: number;
  /** Net deflection at or above this is a manoeuvre. */
  readonly minDeflectionDeg: number;
  /** Entry/exit bearings are read this far either side of the manoeuvre. */
  readonly bearingOffsetM: number;
  /** Straight stretch inside a manoeuvre; longer than this, it is two. */
  readonly mergeWithinM: number;
  /** Confidence published for geometry derived from the routed polyline. */
  readonly geometryConfidence: number;
  /**
   * A curve gentler than this radius is not a difficulty for anything that
   * fits on the road, and produces NO point at all: the lorry steers through
   * it. Thairé's "virage 61°" was a bend of well over a hundred metres of
   * radius, and the sweep of a crossroads was demanded of it.
   */
  readonly curveIgnoreRadiusM: number;
  /** How a junction turn is told from a curve — see `turn-kind.ts`. */
  readonly junction: JunctionTestParams;
}

export interface DetectedTurn {
  readonly at: GeoPoint;
  readonly geometry: Fact<TurnGeometry>;
  readonly alongM: number;
  readonly kind: 'junction' | 'curve';
}

interface Vertex {
  readonly point: GeoPoint;
  readonly alongM: number;
  /** Signed heading change at this vertex, degrees; + is clockwise. */
  readonly deflectionDeg: number;
}

interface Manoeuvre {
  readonly vertices: readonly Vertex[];
  readonly apex: Vertex;
  /** Signed net heading change between entry and exit. */
  readonly netDeflectionDeg: number;
  readonly arcLengthM: number;
  readonly chordM: number;
  readonly approachBearingDeg: number;
  readonly exitBearingDeg: number;
}

export function detectTurns(
  routed: readonly GeoPoint[],
  corridor: readonly RoadWay[],
  params: TurnDetectionParams,
  fetchedAt: string,
): readonly DetectedTurn[] {
  // A repeated vertex has no bearing, and `bearingDeg` answers 0° — north —
  // rather than saying so. Read as a real heading, that north turned the first
  // segment of every route into a manoeuvre. The whole detector works
  // on the compacted line, so the apex, the arc and the bearings all describe
  // the same geometry.
  const polyline = withoutDegenerateSegments(routed);
  const vertices = deflectionsAlong(polyline);
  if (vertices.length === 0) return [];

  const nodes = junctionNodes(corridor);
  const out: DetectedTurn[] = [];
  for (const run of turningRuns(vertices, params)) {
    const manoeuvre = measure(run, polyline, params);
    if (manoeuvre === null) continue;
    if (Math.abs(manoeuvre.netDeflectionDeg) < params.minDeflectionDeg) continue;

    // No corridor, nothing to classify with — and "curve" is the LENIENT
    // reading (a bend's off-tracking instead of a crossroads' sweep). An
    // absent corridor may not buy a vehicle a gentler rule, so it falls back
    // to the junction turn, which is what every manoeuvre was judged as before
    // this taxonomy existed.
    const junction =
      nodes.length === 0 ||
      isJunctionApex(
        manoeuvre.apex.point,
        manoeuvre.apex.deflectionDeg,
        manoeuvre.netDeflectionDeg,
        nodes,
        params.junction,
      );
    const radiusM = curveRadiusM(manoeuvre);
    // A gentle curve is no manoeuvre at all. A junction turn is never dropped:
    // its radius is the router's rounding of a corner, not a road's curvature.
    if (!junction && radiusM !== null && radiusM > params.curveIgnoreRadiusM) continue;

    out.push(toTurn(manoeuvre, junction, radiusM, params, fetchedAt));
  }
  return out;
}

/**
 * Consecutive same-sign turning vertices, split where the road runs straight
 * for `mergeWithinM` or where the run would exceed `windowM` of arc.
 *
 * The arc cap is what keeps a manoeuvre a manoeuvre. Without it, a winding
 * lane chains bend after bend into one 86° "turn" spanning a hundred metres
 * (Thairé, Rue Voisine 14) — an object no driver meets.
 */
function turningRuns(
  vertices: readonly Vertex[],
  params: TurnDetectionParams,
): readonly (readonly Vertex[])[] {
  const runs: Vertex[][] = [];
  for (const vertex of vertices) {
    if (Math.abs(vertex.deflectionDeg) < TURNING_FLOOR_DEG) continue;
    const current = runs[runs.length - 1];
    const last = current?.[current.length - 1];
    const first = current?.[0];
    const continues =
      current !== undefined &&
      last !== undefined &&
      first !== undefined &&
      vertex.alongM - last.alongM <= params.mergeWithinM &&
      Math.sign(vertex.deflectionDeg) === Math.sign(last.deflectionDeg) &&
      vertex.alongM - first.alongM <= params.windowM;
    if (continues && current !== undefined) current.push(vertex);
    else runs.push([vertex]);
  }
  return runs;
}

/** Entry and exit bearings, the net angle between them, the arc and the chord. */
function measure(
  run: readonly Vertex[],
  polyline: readonly GeoPoint[],
  params: TurnDetectionParams,
): Manoeuvre | null {
  const first = run[0];
  const last = run[run.length - 1];
  if (first === undefined || last === undefined) return null;

  const before = pointAtAlong(polyline, first.alongM - params.bearingOffsetM);
  const after = pointAtAlong(polyline, last.alongM + params.bearingOffsetM);
  if (before === null || after === null) return null;
  if (haversineM(before, first.point) < 0.5 || haversineM(last.point, after) < 0.5) return null;

  const approachBearingDeg = bearingDeg(before, first.point);
  const exitBearingDeg = bearingDeg(last.point, after);
  let apex = first;
  for (const vertex of run) {
    if (Math.abs(vertex.deflectionDeg) > Math.abs(apex.deflectionDeg)) apex = vertex;
  }
  return {
    vertices: run,
    apex,
    netDeflectionDeg: signedDelta(approachBearingDeg, exitBearingDeg),
    arcLengthM: last.alongM - first.alongM + 2 * params.bearingOffsetM,
    chordM: haversineM(before, after),
    approachBearingDeg,
    exitBearingDeg,
  };
}

/**
 * Radius of the bend: chord / (2·sin(θ/2)) over the manoeuvre's window — the
 * circle through its entry and its exit. Exact for a circular arc, and honest
 * about anything else: a wandering line yields a shorter chord and so a
 * tighter radius, which errs towards asking.
 */
function curveRadiusM(manoeuvre: Manoeuvre): number | null {
  const net = Math.abs(manoeuvre.netDeflectionDeg);
  if (net < 1 || net >= 180) return null;
  const half = Math.sin((net * Math.PI) / 360);
  if (half <= 0) return null;
  return manoeuvre.chordM / (2 * half);
}

function toTurn(
  manoeuvre: Manoeuvre,
  junction: boolean,
  radiusM: number | null,
  params: TurnDetectionParams,
  fetchedAt: string,
): DetectedTurn {
  const kind = junction ? 'junction' : 'curve';
  return {
    at: manoeuvre.apex.point,
    alongM: manoeuvre.apex.alongM,
    kind,
    geometry: {
      known: true,
      value: {
        apex: manoeuvre.apex.point,
        kind,
        deflectionDeg: Math.abs(manoeuvre.netDeflectionDeg),
        approachBearingDeg: manoeuvre.approachBearingDeg,
        exitBearingDeg: manoeuvre.exitBearingDeg,
        arcLengthM: manoeuvre.arcLengthM,
        // A junction turn publishes no radius: what the router drew around a
        // corner is its own rounding, not a curvature the lorry follows, and
        // published as a measurement it read downstream as a carriageway
        // metres in deficit. A corner is judged on its angle and its width.
        radiusM: junction ? null : radiusM,
        chainedWithPreviousM: null,
        approachWidth: { known: false, why: 'no_data' },
        exitWidth: { known: false, why: 'no_data' },
      },
      provenance: { source: 'osrm', method: 'net-deflection-over-turning-run', fetchedAt },
      reliability: {
        confidence: params.geometryConfidence,
        basis: 'derived',
        reasonCodes: [junction ? 'junction_turn_at_corridor_node' : 'curve_not_a_junction'],
      },
    },
  };
}

function signedDelta(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

function deflectionsAlong(polyline: readonly GeoPoint[]): readonly Vertex[] {
  const out: Vertex[] = [];
  let travelled = 0;
  for (let i = 1; i < polyline.length - 1; i += 1) {
    const prev = polyline[i - 1];
    const here = polyline[i];
    const next = polyline[i + 1];
    if (prev === undefined || here === undefined || next === undefined) continue;
    travelled += haversineM(prev, here);
    out.push({
      point: here,
      alongM: travelled,
      deflectionDeg: signedDelta(bearingDeg(prev, here), bearingDeg(here, next)),
    });
  }
  return out;
}

function pointAtAlong(polyline: readonly GeoPoint[], targetM: number): GeoPoint | null {
  if (targetM < 0) return polyline[0] ?? null;
  let travelled = 0;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    if (a === undefined || b === undefined) continue;
    const legM = haversineM(a, b);
    if (legM === 0) continue;
    if (travelled + legM >= targetM) {
      const t = (targetM - travelled) / legM;
      return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
    }
    travelled += legM;
  }
  return polyline[polyline.length - 1] ?? null;
}
