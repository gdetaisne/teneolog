/**
 * S1 — Continuity of the carriageway through a node.
 *
 * A street that changes name, importance or direction at a node is still the
 * same road. BDTOPO and OSM both split one physical roadway at every attribute
 * change, so the split point is a perfectly ordinary degree-2 junction between
 * two collinear ways — and a terminus test scoped to a single resolved way
 * reads it as the end of the road. That is the Clamart defect (BUG-037a): a
 * drivable street became a fabricated cul-de-sac and the engine demanded an
 * on-site U-turn on it.
 *
 * So continuity here is decided by geometry alone: does a drivable carriageway
 * leave this node along the line the delivery way arrives on. Attribute
 * identity is never evidence — neither for (Auxerre's two same-name Avenues
 * de l’Essai, EC-29) nor against (Clamart's name change).
 *
 * What this module deliberately does NOT decide:
 *  - whether a tip is interior to the fetch. A way clipped at the query circle
 *    has no continuation *in the payload*, and this function returns null for
 *    it exactly as it does for a real cul-de-sac. Telling the two apart needs
 *    the fetch radius, which is `TopologyAssessment.terminalNodeInterior`'s job
 *    (BUG-003), not this one's.
 *  - whether the continuation is legally usable. One-way direction, weight bans
 *    and private status are other dimensions; a private way is explicitly not
 *    impassable for a commissioned delivery.
 */
import type { Continuity, GeoPoint } from '@teneolog/domain';

import { bearingDeg, bearingDeltaDeg, haversineM } from './geometry.js';
import type { RoadNeighbourhood, RoadWay } from './ports.js';

export interface ContinuityInput {
  readonly neighbourhood: RoadNeighbourhood;
  /** The delivery way. */
  readonly wayId: string;
  /** A tip node of that way — the end being tested. */
  readonly atNodeId: string;
  /** Above this angular deviation, the road is not considered to continue. */
  readonly maxDeviationDeg: number;
}

/**
 * Classes that carry no delivery vehicle. Continuing into one of these is not
 * the road going on.
 *
 * `pedestrian` is deliberately absent. Rue Voisine LBE is mapped as a
 * pedestrian zone in OSM and is physically circulable (BUG-037b / BUG-067):
 * treating that class as a wall reproduces the false no-exit conclusion this
 * module exists to prevent. Pedestrianisation is a legality question, resolved
 * with the other access evidence, not a break in the carriageway.
 */
const NON_DRIVABLE_HIGHWAY: ReadonlySet<string> = new Set([
  'footway',
  'steps',
  'path',
  'cycleway',
]);

/** Null when the road genuinely stops here. */
export function assessContinuity(input: ContinuityInput): Continuity | null {
  const exit = assessExit(input);
  if (exit === null) return null;
  // The alignment threshold arbitrates way IDENTITY, so it only judges
  // continuations that need identity established — those crossing onto another
  // way. Inside a single way the identity is given by construction, and a way
  // does not stop being itself at a corner (BUG-048a's bend).
  if (exit.establishedBy === 'same_way') return exit;
  return exit.deviationDeg > input.maxDeviationDeg ? null : exit;
}

/**
 * Like {@link assessContinuity}, but with no alignment threshold: any drivable
 * arm at the node is an exit, however sharp the turn onto it.
 *
 * The two questions are different and conflating them was a latent false
 * cul-de-sac. The threshold answers "is this the SAME carriageway" — what
 * street selection and the handoff walk need to chain way identity. Terminal
 * classification asks "is there ANY way out": a street that tees into a
 * perpendicular road, or turns 90° and carries on as an L, ends as a geometric
 * object but not as a route, and a delivery vehicle leaves it without ever
 * turning around. The sharpness survives in `deviationDeg` for S4 to judge as
 * a turn; it is not this stage's business to reject it.
 */
export function assessExit(input: Omit<ContinuityInput, 'maxDeviationDeg'>): Continuity | null {
  const { neighbourhood, wayId, atNodeId } = input;

  const deliveryWay = neighbourhood.ways.find((way) => way.id === wayId);
  if (deliveryWay === undefined) return null;

  const occurrences = indicesOf(deliveryWay.nodeIds, atNodeId);
  if (occurrences.length === 0) return null;

  const withinWay = continuityWithinWay(deliveryWay, occurrences);
  if (withinWay !== null) return withinWay;

  const tipIndex = occurrences[0];
  if (tipIndex === undefined) return null;

  // Heading the vehicle carries as it reaches the tip: the reverse of the
  // direction in which the way leaves the tip back into itself.
  const backAlongWayDeg = departureBearingDeg(
    deliveryWay.geometry,
    tipIndex,
    tipIndex === 0 ? 1 : -1,
  );
  if (backAlongWayDeg === null) return null;
  const approachHeadingDeg = (backAlongWayDeg + 180) % 360;

  const arms = drivableArmsAt(neighbourhood, atNodeId, deliveryWay.id);

  let best: { readonly arm: DrivableArm; readonly deviationDeg: number } | null = null;
  const distinctArmWayIds = new Set<string>();
  for (const arm of arms) {
    distinctArmWayIds.add(arm.way.id);
    const deviationDeg = bearingDeltaDeg(approachHeadingDeg, arm.departureDeg);
    // Strict `<` keeps the first way in payload order on a tie, so the result
    // is a function of the payload and not of iteration luck.
    if (best === null || deviationDeg < best.deviationDeg) best = { arm, deviationDeg };
  }

  if (best === null) return null;

  return {
    establishedBy: distinctArmWayIds.size > 1 ? 'junction_traversal' : 'geometric_continuation',
    deviationDeg: best.deviationDeg,
    attributeBreak: hasAttributeBreak(deliveryWay, best.arm.way),
  };
}

/**
 * Continuity the way establishes on its own, with no second way involved.
 *
 * This covers the Plougoumelen trap (BUG-048a): node degree counts how many
 * *ways* reference a node, so every interior shape point of a through street is
 * referenced exactly once and is degree-1 by construction. Way 180628513's
 * vertex 266147484 sits 0.3 m from the delivery point and read as a dead-end
 * tip. Only the first and last entries of `nodeIds` are tips; everything
 * between them is the carriageway passing through.
 */
function continuityWithinWay(way: RoadWay, occurrences: readonly number[]): Continuity | null {
  const lastIndex = way.nodeIds.length - 1;

  const interiorIndex = occurrences.find((i) => i > 0 && i < lastIndex);
  if (interiorIndex !== undefined) {
    return throughDeviation(way.geometry, interiorIndex, interiorIndex);
  }

  // A closed way — the pocket loop at the end of a cul-de-sac, a roundabout —
  // meets itself at this node, so it carries the vehicle through without a
  // second way and without a `junction=turning_loop` tag to announce it (EC-18).
  if (lastIndex > 0 && occurrences.includes(0) && occurrences.includes(lastIndex)) {
    return throughDeviation(way.geometry, lastIndex, 0);
  }

  return null;
}

function throughDeviation(
  geometry: readonly GeoPoint[],
  arriveIndex: number,
  leaveIndex: number,
): Continuity | null {
  const backwardsDeg = departureBearingDeg(geometry, arriveIndex, -1);
  const onwardsDeg = departureBearingDeg(geometry, leaveIndex, 1);
  if (backwardsDeg === null || onwardsDeg === null) return null;
  return {
    establishedBy: 'same_way',
    deviationDeg: bearingDeltaDeg((backwardsDeg + 180) % 360, onwardsDeg),
    attributeBreak: false,
  };
}

/**
 * One direction of travel leaving a node along a way. Exported: the
 * turnaround map lists the branches of the delivery street with the very arms
 * terminal classification reads, rather than a second reading of the same
 * junction (principe 23).
 */
export interface DrivableArm {
  readonly way: RoadWay;
  /** Bearing of the carriageway leaving the node along this arm. */
  readonly departureDeg: number;
  /** Index of the node in `way.nodeIds` the arm leaves from. */
  readonly index: number;
  /** Direction of travel along `way.nodeIds`: +1 towards its end, -1 towards its start. */
  readonly step: -1 | 1;
}

/**
 * Every drivable direction of travel available at the node, other than back
 * down the delivery way.
 *
 * Arms are read from the ways rather than from `RoadNode.wayIds` because an arm
 * without geometry cannot be measured; a node naming a way absent from the
 * payload is a clipped fetch, which is the caller's interiority question.
 *
 * A way that passes *through* the node offers two arms, and a closed way that
 * meets itself there also offers two: the vehicle can leave either way round.
 */
export function drivableArmsAt(
  neighbourhood: RoadNeighbourhood,
  atNodeId: string,
  excludeWayId: string,
): readonly DrivableArm[] {
  const arms: DrivableArm[] = [];
  for (const way of neighbourhood.ways) {
    if (way.id === excludeWayId) continue;
    if (!isDrivableWay(way)) continue;
    for (const index of indicesOf(way.nodeIds, atNodeId)) {
      for (const step of [-1, 1] as const) {
        const departureDeg = departureBearingDeg(way.geometry, index, step);
        if (departureDeg !== null) arms.push({ way, departureDeg, index, step });
      }
    }
  }
  return arms;
}

/** Exported: terminal classification needs the same vocabulary for its escape walk. */
export function isDrivableWay(way: RoadWay): boolean {
  const highway = way.tags['highway'];
  // No `highway` tag is not evidence of a footpath — BDTOPO ways carry no OSM
  // classification at all. Skipping unclassified arms silently deletes real
  // junctions from the candidate set (TAF-03), which is the same false-terminus
  // failure by another route.
  if (highway === undefined) return true;
  return !NON_DRIVABLE_HIGHWAY.has(highway);
}

/**
 * Bearing from the vertex at `from` towards the next distinct vertex in
 * direction `step`.
 *
 * Coincident consecutive vertices are walked over rather than rejected: a
 * duplicated point has no bearing, but the road it belongs to still has one.
 * Exported for the heading of the delivery street's axis at a
 * junction — the same walk over a repeated vertex, not a second one.
 */
export function departureBearingDeg(
  geometry: readonly GeoPoint[],
  from: number,
  step: -1 | 1,
): number | null {
  const origin = geometry[from];
  if (origin === undefined) return null;
  for (let i = from + step; i >= 0 && i < geometry.length; i += step) {
    const vertex = geometry[i];
    if (vertex === undefined) continue;
    if (haversineM(origin, vertex) > 0) return bearingDeg(origin, vertex);
  }
  return null;
}

function indicesOf(nodeIds: readonly string[], nodeId: string): readonly number[] {
  const found: number[] = [];
  for (let i = 0; i < nodeIds.length; i += 1) {
    if (nodeIds[i] === nodeId) found.push(i);
  }
  return found;
}

/**
 * Whether the two ways describe the same physical street differently.
 *
 * The flag exists so the Clamart case is *visible* rather than silently right:
 * continuity found across an attribute change is exactly the situation a single
 * resolved way cannot see.
 */
function hasAttributeBreak(from: RoadWay, into: RoadWay): boolean {
  if (normaliseName(from.name) !== normaliseName(into.name)) return true;
  // An unknown importance on either side is not a stated difference. Only two
  // sources that both spoke, and disagreed, constitute a break.
  if (from.importance !== null && into.importance !== null && from.importance !== into.importance) {
    return true;
  }
  return from.oneWay !== into.oneWay;
}

/**
 * Case and diacritics are transcription, not a change of street. Anything
 * beyond that — a different word, a missing name — is reported as a break.
 */
function normaliseName(name: string | null): string | null {
  if (name === null) return null;
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
