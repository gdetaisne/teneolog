/**
 * S1 — Egress candidate enumeration.
 *
 * Every place near the stop where a vehicle might turn around, each carrying a
 * measured geometry or an honest refusal. This replaces the engine's
 * `turnaround-area-finder` tier system; the tiers survive as the candidate
 * kinds, but scoring by surface area does not — a long thin car park clears any
 * area gate and still has nowhere to swing a rigid, so the inscribed-circle
 * diameter is the only size this module reports (TAF-01).
 *
 * Truck-agnostic: this stage says what space exists, never whether it is
 * enough. Whether a candidate is acceptable ground (church parvis, supermarket
 * car park) is a policy question answered downstream from `ground`; nothing is
 * filtered out here on ownership (Q4: private ground is a product-acceptable
 * answer, labelled).
 */
import type { EgressCandidate, Fact, GeoPoint, Turnaround, UsableSurface } from '@teneolog/domain';

import { isDrivableWay } from './continuity.js';
import { closestPointOnPolyline, haversineM, polylineLengthM } from './geometry.js';
import { isNonDrivableAreaWay } from './non-drivable-area.js';
import type { RoadNeighbourhood, RoadNode, RoadWay, Surface } from './ports.js';
import { computeRoadReach, reachOf, roadDistanceOf, type RoadReach } from './reach.js';
import { isMappedTurnaroundNode, measureTurnaround, type TurnaroundMeasurementOptions } from './turnaround.js';

/** By road, a candidate is looked for this many times further than the reporting radius. */
const REACH_BOUND_FACTOR = 4;
/** No walk at all: every reach `unknown`, every road distance null. */
const NO_REACH: RoadReach = { distanceM: new Map(), insideIds: null, why: 'disabled' };

export interface EgressSearchInput {
  readonly neighbourhood: RoadNeighbourhood;
  readonly surfaces: readonly Surface[];
  readonly deliveryWayId: string;
  readonly deliveryPoint: GeoPoint;
  /** Beyond this from the stop, a candidate is not worth reporting. Policy. */
  readonly searchRadiusM: number;
  readonly measurement: TurnaroundMeasurementOptions;
  /**
   * The impasse mouth S1 resolved, when it did. It is what tells a
   * place of THIS impasse from a place of the next street. Absent or null:
   * every reach is `unknown`, nothing is ranked out.
   */
  readonly mouth?: GeoPoint | null;
  /**
   * False on a through street: `inside` and `via_mouth` mean nothing there,
   * and the walk is a cost the checker pays on every query. Every reach is
   * then `unknown`. Default true.
   */
  readonly reachEnabled?: boolean;
}

/**
 * THE MAPPED PLACES THIS IMPASSE REACHES, best first — the one selection the
 * retained turnaround (`topology-assessment.ts`) and the review point's
 * position (`preferredMappedTurnaroundAt`) both read, so they never name two
 * different places (principe 23). Mapper-named nodes only: a ring is measured
 * as a ring and places its own centre. A node reached only through the mouth
 * is another street's and never answers here (Sèvremoine).
 */
export function rankedMappedNodes(
  candidates: readonly EgressCandidate[],
): readonly EgressCandidate[] {
  return candidates.filter((c) => nodeIdOfCandidate(c) !== null && c.reach !== 'via_mouth');
}

/** Whether a candidate is a mapped node, and which — `node:<id>` — or null. */
export function nodeIdOfCandidate(candidate: EgressCandidate): string | null {
  return candidate.id.startsWith(NODE_PREFIX) ? candidate.id.slice(NODE_PREFIX.length) : null;
}

const NODE_PREFIX = 'node:';

/** The mapper-named place, if any — where the review point should sit. */
export function preferredMappedTurnaroundAt(
  candidates: Fact<readonly EgressCandidate[]>,
): GeoPoint | undefined {
  if (!candidates.known) return undefined;
  return rankedMappedNodes(candidates.value)[0]?.at;
}

/** What every candidate family reads: the input, the street, the reach by road. */
interface EnumerationContext {
  readonly input: EgressSearchInput;
  readonly deliveryWay: RoadWay;
  readonly reach: RoadReach;
}

/**
 * Wrapped as a whole so "we searched and found nothing" (`known: true`, empty
 * list) and "we could not search" (`known: false`) are different answers —
 * the same distinction `RoadFacts.candidates` makes.
 */
export function findEgressCandidates(input: EgressSearchInput): Fact<readonly EgressCandidate[]> {
  const deliveryWay = input.neighbourhood.ways.find((w) => w.id === input.deliveryWayId);
  if (deliveryWay === undefined || deliveryWay.geometry.length < 2) {
    return { known: false, why: 'no_data' };
  }

  const reach =
    input.reachEnabled === false
      ? NO_REACH
      : computeRoadReach({
          neighbourhood: input.neighbourhood,
          deliveryWayId: input.deliveryWayId,
          deliveryPoint: input.deliveryPoint,
          mouth: input.mouth ?? null,
          // A bound on the walk, not a verdict: a place four times the
          // reporting radius away by road is not worth walking to.
          maxDistanceM: REACH_BOUND_FACTOR * input.searchRadiusM,
        });
  const ctx: EnumerationContext = { input, deliveryWay, reach };

  const candidates = [
    carriagewayCandidate(ctx),
    ...mappedNodeCandidates(ctx),
    ...loopWayCandidates(ctx),
    ...surfaceCandidates(ctx),
  ];

  return {
    known: true,
    value: rankCandidates(candidates),
    provenance: {
      source: deliveryWay.source,
      method: 'egress-candidate-enumeration',
      fetchedAt: input.measurement.observedAt,
    },
    reliability: {
      confidence: 1,
      basis: 'derived',
      reasonCodes: candidates.length === 1 ? ['only_on_street_reversal_found'] : [],
    },
  };
}

function withinRadius(ctx: EnumerationContext, point: GeoPoint): boolean {
  return haversineM(ctx.input.deliveryPoint, point) <= ctx.input.searchRadiusM;
}

/**
 * The reversal on the delivery street itself is always a candidate: it is
 * how an on-site U-turn becomes a measurement to reject instead of a route
 * the engine silently proposes (BUG-001). S5 will compare its diameter —
 * the carriageway width — against the truck and refuse it for anything
 * large, which is the correct fate, reached transparently. It ranks last
 * (`rankCandidates`) and leaves with slice 2 of it is none of the
 * three manoeuvres of principle 39.
 */
function carriagewayCandidate(ctx: EnumerationContext): EgressCandidate {
  const { input, deliveryWay } = ctx;
  return buildCandidate({
    id: 'stop:carriageway',
    kind: 'junction',
    at: input.deliveryPoint,
    measured: measureTurnaround(
      { kind: 'carriageway', way: deliveryWay, at: input.deliveryPoint },
      input.measurement,
    ),
    ground: deliveryWay.isPrivate ? 'private' : 'public',
    deliveryWay,
    input,
    surfacePolygon: null,
    // The manoeuvre happens where the truck stands: no approach reversing.
    requiresReversingM: 0,
    reach: 'inside',
    roadDistanceFromStopM: 0,
  });
}

/** The mapper's own words: a `highway=turning_circle` or `turning_loop` node. */
function mappedNodeCandidates(ctx: EnumerationContext): EgressCandidate[] {
  const { input, deliveryWay, reach } = ctx;
  const out: EgressCandidate[] = [];
  for (const node of input.neighbourhood.nodes) {
    if (!isMappedTurnaroundNode(node.tags)) continue;
    if (!withinRadius(ctx, node.at)) continue;
    out.push(
      buildCandidate({
        id: `${NODE_PREFIX}${node.id}`,
        kind: node.tags['highway'] === 'turning_loop' ? 'turning_loop' : 'turning_circle',
        at: node.at,
        measured: measureTurnaround({ kind: 'turning_circle_node', node }, input.measurement),
        ground: groundOfNode(node, input.neighbourhood),
        deliveryWay,
        input,
        surfacePolygon: null,
        requiresReversingM: 0,
        reach: reachOf(reach, node.id),
        roadDistanceFromStopM: roadDistanceOf(reach, node.id),
      }),
    );
  }
  return out;
}

/**
 * A ring the truck drives round: `junction=turning_loop`, or a closed way.
 *
 * a closed way a truck does not drive on is not a ring it drives
 * round: a footway loop, and an AREA where it does not manoeuvre — the tag
 * list the planner reads (`NON_DRIVABLE_AREA_TAGS`, principe 23). At 5 Rue
 * Témoin, Clichy, the outline of the pedestrian square Place Voisine JC
 * (way 117624157, `highway=pedestrian`, `area=yes`) was served as option 1,
 * a « turning loop » of Ø 30.5 m on public ground.
 */
function isDrivableRing(way: RoadWay): boolean {
  return isDrivableWay(way) && !isNonDrivableAreaWay(way.tags);
}

function loopWayCandidates(ctx: EnumerationContext): EgressCandidate[] {
  const { input, deliveryWay, reach } = ctx;
  const out: EgressCandidate[] = [];
  for (const way of input.neighbourhood.ways) {
    if (way.id === deliveryWay.id) continue;
    if (!isDrivableRing(way)) continue;
    const isTaggedLoop = way.tags['junction'] === 'turning_loop';
    const isRing =
      way.nodeIds.length > 2 && way.nodeIds[0] === way.nodeIds[way.nodeIds.length - 1];
    if (!isTaggedLoop && !isRing) continue;
    const anchor = way.geometry[0];
    const anchorId = way.nodeIds[0];
    if (anchor === undefined || !withinRadius(ctx, anchor)) continue;
    out.push(
      buildCandidate({
        id: `way:${way.id}`,
        kind: 'turning_loop',
        at: anchor,
        measured: measureTurnaround({ kind: 'loop_way', way }, input.measurement),
        ground: way.isPrivate ? 'private' : 'public',
        deliveryWay,
        input,
        surfacePolygon: way.geometry,
        requiresReversingM: 0,
        reach: anchorId === undefined ? 'unknown' : reachOf(reach, anchorId),
        roadDistanceFromStopM: anchorId === undefined ? null : roadDistanceOf(reach, anchorId),
      }),
    );
  }
  return out;
}

/** A mapped open area: car park, square, `area:highway`. */
function surfaceCandidates(ctx: EnumerationContext): EgressCandidate[] {
  const { input, deliveryWay } = ctx;
  const out: EgressCandidate[] = [];
  for (const surface of input.surfaces) {
    const anchor = surface.polygon[0];
    if (anchor === undefined || !withinRadius(ctx, anchor)) continue;
    out.push(
      buildCandidate({
        id: `surface:${surface.id}`,
        kind: surfaceKind(surface),
        at: anchor,
        measured: measureTurnaround({ kind: 'surface', surface }, input.measurement),
        ground: surface.isPrivate ? 'private' : 'public',
        deliveryWay,
        input,
        surfacePolygon: surface.polygon,
        // Coarse upper bound: entering forward and backing out to the axis.
        // The centre stands in for the entrance until imagery refines it (S5).
        requiresReversingM: perpendicularToAxisM(surface.polygon, deliveryWay),
        // A polygon is not on the road graph: nothing to walk to (slice 2 of
        // will snap its entrance onto the graph).
        reach: 'unknown',
        roadDistanceFromStopM: null,
      }),
    );
  }
  return out;
}

function buildCandidate(args: {
  readonly id: string;
  readonly kind: EgressCandidate['kind'];
  readonly at: GeoPoint;
  readonly measured: Fact<Turnaround>;
  readonly ground: EgressCandidate['ground'];
  readonly deliveryWay: RoadWay;
  readonly input: EgressSearchInput;
  readonly surfacePolygon: readonly GeoPoint[] | null;
  readonly requiresReversingM: number;
  readonly reach: EgressCandidate['reach'];
  readonly roadDistanceFromStopM: number | null;
}): EgressCandidate {
  return {
    id: args.id,
    kind: args.kind,
    at: args.at,
    distanceFromStopM: haversineM(args.input.deliveryPoint, args.at),
    roadDistanceFromStopM: args.roadDistanceFromStopM,
    reach: args.reach,
    beyondStop: isBeyondStop(args.at, args.input.deliveryPoint, args.deliveryWay),
    geometry: toUsableSurface(args.measured, args.surfacePolygon),
    ground: args.ground,
    requiresReversingM: args.requiresReversingM,
  };
}

/**
 * The order the options are worth showing in (D4 — le responsable produit,
 * 2026-09-24): a place this impasse reaches before one it does not, a place
 * the road reaches before one it does not (a circle drawn on a footway, a
 * polygon), then the nearest BY ROAD, then measured before unknown, then
 * public ground before private. The on-street reversal — the width of the
 * road called a diameter — is none of the three manoeuvres of principle 39
 * and goes last whatever its distance; it leaves the code with slice 2.
 *
 * Total and deterministic: the id breaks the last tie, so two twin loops do
 * not swap with the order of the fetch.
 */
function rankCandidates(candidates: readonly EgressCandidate[]): readonly EgressCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      rankFloor(a) - rankFloor(b) ||
      REACH_RANK[a.reach] - REACH_RANK[b.reach] ||
      Number(a.roadDistanceFromStopM === null) - Number(b.roadDistanceFromStopM === null) ||
      roadOrCrow(a) - roadOrCrow(b) ||
      Number(!a.geometry.known) - Number(!b.geometry.known) ||
      GROUND_RANK[a.ground] - GROUND_RANK[b.ground] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

const REACH_RANK = { inside: 0, unknown: 1, via_mouth: 2 } as const;
const GROUND_RANK = { public: 0, unknown: 1, private: 2 } as const;

function rankFloor(candidate: EgressCandidate): number {
  return candidate.kind === 'junction' ? 1 : 0;
}

/** By road when the graph reaches the place; as the crow flies otherwise. */
function roadOrCrow(candidate: EgressCandidate): number {
  return candidate.roadDistanceFromStopM ?? candidate.distanceFromStopM;
}

/**
 * A measured turnaround projected into the surface vocabulary. Occupancy is
 * `unassessed` by construction: no imagery has spoken at S1, and this field is
 * three-valued precisely so this stage never has to claim `clear`.
 *
 * the centre the diameter was measured on travels with it: the
 * inscribed circle of a ring or a surface is not at the candidate's `at` (the
 * first vertex of the ring), and the turnaround map places the required
 * circle there. Additive: nothing downstream reads it to decide anything.
 */
function toUsableSurface(
  measured: Fact<Turnaround>,
  polygon: readonly GeoPoint[] | null,
): Fact<UsableSurface> {
  if (!measured.known) return measured;
  return {
    ...measured,
    value: {
      usableDiameterM: measured.value.usableDiameterM,
      areaM2: polygon === null ? null : polygonAreaM2(polygon),
      polygon,
      occupancy: 'unassessed',
      centre: measured.value.centre,
    },
  };
}

/**
 * Whether using this candidate means driving deeper into the street before
 * coming back — past the stop, away from the mouth.
 *
 * Orientation comes from the delivery way's own geometry rather than from the
 * resolved mouth, so the answer exists even when the mouth does not: "deeper"
 * means "further along the way in the direction the stop's far tip lies".
 * Both directions are physically valid product answers (B5); the flag only
 * says which one this is.
 */
function isBeyondStop(candidate: GeoPoint, stop: GeoPoint, way: RoadWay): boolean {
  const candidateOnAxis = closestPointOnPolyline(way.geometry, candidate);
  const stopOnAxis = closestPointOnPolyline(way.geometry, stop);
  if (candidateOnAxis === null || stopOnAxis === null) return false;

  const totalM = polylineLengthM(way.geometry);
  // The far tip is whichever way end the stop is closest to reaching last.
  const stopToEndM = totalM - stopOnAxis.alongM;
  const farEndIsAtEnd = stopToEndM <= stopOnAxis.alongM;
  return farEndIsAtEnd
    ? candidateOnAxis.alongM < stopOnAxis.alongM
    : candidateOnAxis.alongM > stopOnAxis.alongM;
}

/** The ground under a node is the ground of a way that carries it, when one does. */
function groundOfNode(node: RoadNode, hood: RoadNeighbourhood): EgressCandidate['ground'] {
  for (const wayId of node.wayIds) {
    const way = hood.ways.find((w) => w.id === wayId);
    if (way !== undefined) return way.isPrivate ? 'private' : 'public';
  }
  return 'unknown';
}

function surfaceKind(surface: Surface): EgressCandidate['kind'] {
  switch (surface.kind) {
    case 'parking':
      return 'parking';
    case 'square':
      return 'square';
    case 'field_entrance':
      return 'field_entrance';
    case 'yard':
    case 'area_highway':
      return 'square';
  }
}

/** Distance from the surface's centroid to the delivery axis, metres. */
function perpendicularToAxisM(polygon: readonly GeoPoint[], way: RoadWay): number {
  const centroid = centroidOf(polygon);
  if (centroid === null) return 0;
  return closestPointOnPolyline(way.geometry, centroid)?.distanceM ?? 0;
}

function centroidOf(polygon: readonly GeoPoint[]): GeoPoint | null {
  if (polygon.length === 0) return null;
  let lat = 0;
  let lon = 0;
  for (const p of polygon) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / polygon.length, lon: lon / polygon.length };
}

/** Shoelace area on a local equirectangular plane — survey-grade inputs only. */
function polygonAreaM2(polygon: readonly GeoPoint[]): number | null {
  if (polygon.length < 3) return null;
  const first = polygon[0];
  if (first === undefined) return null;
  const mPerDegLat = 111_320;
  const mPerDegLon = mPerDegLat * Math.cos((first.lat * Math.PI) / 180);

  let doubled = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (a === undefined || b === undefined) return null;
    const ax = (a.lon - first.lon) * mPerDegLon;
    const ay = (a.lat - first.lat) * mPerDegLat;
    const bx = (b.lon - first.lon) * mPerDegLon;
    const by = (b.lat - first.lat) * mPerDegLat;
    doubled += ax * by - bx * ay;
  }
  return Math.abs(doubled) / 2;
}
