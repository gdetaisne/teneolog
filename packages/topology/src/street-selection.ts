/**
 * S0 — which street do we deliver on.
 *
 * The Auxerre defect lives here. A geocoded point falls between a structuring
 * frontage and a same-name unclassified spur, nearest-segment snapping picks
 * the spur, and every later stage then measures, routes and judges the wrong
 * road while looking internally consistent.
 *
 * Three ideas carry the module:
 *
 *  - Nearest is a candidate, not an answer. Everything within `ambiguityWindowM`
 *    of the nearest is a contender, and the contest is decided by how
 *    structuring the road is, not by centimetres of snap distance.
 *  - Way identity is not street identity. A carriageway split at a name /
 *    importance / one-way change is one object, so the two halves must not
 *    compete with each other (they would tie, and a tie means "we don't know").
 *    Conversely two roads that merely share a name stay two objects: merging
 *    them is how the spur inherits the N77's importance and the N77 inherits
 *    the spur's dead end.
 *  - An unresolved choice is reported, never guessed. A confident wrong street
 *    is inherited silently by every downstream stage; `below_confidence` is not.
 *
 * Truck-agnostic by construction: nothing here reads a vehicle dimension.
 */
import type {
  ConsideredWay,
  DeliveryStreet,
  Fact,
  GeoPoint,
  Provenance,
  RejectedStreet,
  SourceId,
  StreetSearch,
} from '@teneolog/domain';
import { bearingDeg, bearingDeltaDeg, closestPointOnPolyline, haversineM } from './geometry.js';
// The class ladder is shared vocabulary (topology/highway-class.ts): the gate
// search and the pair ranking read the very same table.
import { highwayRank } from './highway-class.js';
import type { RoadNeighbourhood, RoadNode, RoadWay } from './ports.js';

/**
 * Confidence to report. Values are calibration, not code (architecture §6), so
 * they arrive with the input rather than being written into the domain.
 */
export interface StreetSelectionConfidence {
  /** One contender: the point is unambiguously beside one carriageway. */
  readonly unambiguous: number;
  /** Several contenders, separated by the structuring rank. */
  readonly resolvedByRank: number;
}

export interface StreetSelectionInput {
  readonly point: GeoPoint;
  readonly neighbourhood: RoadNeighbourhood;
  /** Beyond this, a way is not a candidate frontage at all. */
  readonly maxSnapM: number;
  /** Within this distance of each other, two candidates are close enough that importance decides. */
  readonly ambiguityWindowM: number;
  /**
   * A declared-width advantage smaller than this does not separate two
   * candidates. Declared widths are quantised source attributes; without this,
   * 5.0 against 5.1 would decide a delivery street.
   */
  readonly minWidthAdvantageM: number;
  /**
   * How far inside the fetch radius a way tip must be before it counts as a
   * real end of road.
   *
   * A fetch clips ways at its own circle, so a tip near the boundary may just
   * be where we stopped looking. This is the BUG-003 / BUG-068 trade-off and it
   * is a parameter precisely so it is chosen rather than inherited: too large
   * and a genuine spur tip near the edge becomes invisible, too small and every
   * clipped through street looks like a stub.
   */
  readonly tipInteriorMarginM: number;
  /**
   * Two ways meeting end to end are the same carriageway when the road bends
   * by no more than this at the shared node. Above it, they are two roads that
   * happen to meet.
   */
  readonly continuationDeviationDeg: number;
  /**
   * ISO 8601 instant the neighbourhood was fetched. Passed in because this
   * module is pure: a fact may not stamp itself with a clock it read.
   */
  readonly fetchedAt: string;
  readonly confidence: StreetSelectionConfidence;
  /** the way the point was measured on, and who put it there. */
  readonly declaredWay?: DeclaredWay;
}

/**
 * the way a stop was measured on, and who put it there. The two do
 * not weigh the same:
 *
 *  - `fallback_stop`: the engine placed its fallback stop on the street before,
 *    by construction (principe 10). That way is retained as soon as it is a
 *    candidate (vehicular, within `maxSnapM`), without the contest: re-choosing
 *    the street of a stop posed 1.5–6 m from an impasse mouth, between two
 *    streets, is a contest nobody wins (La Crèche, `below_confidence`), and the
 *    stop's street already has a source (principe 23).
 *  - `clicked_point`: the preview snapped a click to the nearest carriageway
 *    (`free-point.ts`) — the very heuristic the Auxerre rule overrules. It only
 *    breaks a tie: the contest runs first, and the clicked way is kept only when
 *    the contest separates nothing and no contender beats it. Retained without
 *    the contest, a click 8 m inside the Auxerre spur turned the primary road
 *    (THROUGH) into the spur (DEAD_END), with no A/B (principe 17).
 *
 * Either way the outcome is said: `street_declared_by_stop`,
 * `street_declared_breaks_tie`, `street_declared_overruled` (the contest had a
 * winner elsewhere), `street_declared_not_found` (the neighbourhood does not
 * carry it). Rivals the declaration alone set aside read `declared_stop_street`.
 */
export interface DeclaredWay {
  readonly id: string;
  readonly by: 'fallback_stop' | 'clicked_point';
}

const METHOD = 'street-selection';

/**
 * Ways a delivery vehicle cannot be on at all. Deliberately short: `pedestrian`,
 * `living_street`, `service` and `track` stay candidates because OSM pedestrian
 * evidence has repeatedly been wrong about physically circulable streets
 * (BUG-037b), and excluding them here would launder that error into "no street".
 */
const NON_VEHICULAR_HIGHWAY: ReadonlySet<string> = new Set([
  'footway',
  'path',
  'steps',
  'cycleway',
  'bridleway',
  'corridor',
  'platform',
  'proposed',
  'construction',
]);

interface Candidate {
  readonly way: RoadWay;
  readonly distanceM: number;
  /** A degree-1 way tip provably inside the fetch: this road ends here. */
  readonly endsInsideFetch: boolean;
}

/** One physical carriageway, possibly described by several source ways. */
interface Carriageway {
  /** The member the point is actually beside — the frontage, whatever its attributes. */
  readonly frontage: Candidate;
  readonly members: readonly Candidate[];
}

/**
 * The decision, plus everything the decision looked at on its way there.
 *
 *. The search is a strict by-product: it is written to from the same
 * passes that decide, never read by them. `street` is bit-for-bit what
 * `selectDeliveryStreet` has always returned.
 */
export interface StreetSelectionResult {
  readonly street: Fact<DeliveryStreet>;
  readonly search: StreetSearch;
}

/**
 * One `ConsideredWay` under construction.
 *
 * Mutable on purpose: a way's fate is only fully known once the contest ends,
 * and rebuilding the row at each stage would be one more place for the log to
 * drift from the decision.
 */
interface Studied {
  readonly way: RoadWay;
  distanceM: number | null;
  endsInsideFetch: boolean | null;
  outcome: ConsideredWay['outcome'];
  stage: ConsideredWay['stage'];
  reason: RejectedStreet['reason'] | null;
}

/** The log, keyed by way IDENTITY — two ways may legitimately share an id. */
type SearchLog = Map<RoadWay, Studied>;

export function selectDeliveryStreet(input: StreetSelectionInput): Fact<DeliveryStreet> {
  return selectDeliveryStreetWithSearch(input).street;
}

/**
 * The same choice, with the grey layer kept.
 *
 * Used by `/explain`, which must be able to show that the spur was seen and
 * where it fell — not merely that it lost, which it never got the chance to do.
 */
export function selectDeliveryStreetWithSearch(input: StreetSelectionInput): StreetSelectionResult {
  const { neighbourhood } = input;
  const log: SearchLog = new Map();

  if (neighbourhood.ways.length === 0) {
    // Nothing was fetched here: an OSM/BDTOPO coverage gap, not a road-free address.
    return { street: { known: false, why: 'out_of_coverage' }, search: searchOf(input, log) };
  }

  const nodesById = new Map<string, RoadNode>(neighbourhood.nodes.map((n) => [n.id, n]));
  const candidates = collectCandidates(input, nodesById, log);

  const nearest = candidates[0];
  if (nearest === undefined) {
    // Roads are known here, none of them is a plausible frontage for this point.
    return { street: { known: false, why: 'no_data' }, search: searchOf(input, log) };
  }

  const contenders = candidates.filter((c) => c.distanceM <= nearest.distanceM + input.ambiguityWindowM);
  const inWindow = new Set(contenders);
  for (const candidate of candidates) {
    if (inWindow.has(candidate)) continue;
    mark(log, candidate.way, 'filtered', 'outside_window');
  }

  // a stop the engine placed on a way keeps that way; a click only breaks a tie.
  const declared = candidates.find((c) => c.way.id === input.declaredWay?.id);
  if (declared !== undefined && input.declaredWay?.by === 'fallback_stop') {
    return { street: retainDeclared(declared, contenders, input, log), search: searchOf(input, log) };
  }
  const carriageways = groupCarriageways(contenders, input.continuationDeviationDeg);
  const contested = contest(carriageways, input, log);
  const street =
    declared === undefined
      ? notFoundSaid(contested, input)
      : afterClick(contested, declared, carriageways, input, log);
  return { street, search: searchOf(input, log) };
}

/** The contest between contenders' carriageways: the rank, then width, the end of road, privacy. */
function contest(
  carriageways: readonly Carriageway[],
  input: StreetSelectionInput,
  log: SearchLog,
): Fact<DeliveryStreet> {
  const winner = carriageways[0];
  if (winner === undefined) return { known: false, why: 'no_data' };

  const provenance = provenanceOf(winner, input);

  if (carriageways.length === 1) {
    recordWinner(log, winner);
    return known(winner, [], input, provenance, [
      'street_unambiguous',
      ...continuationCode(winner),
      ...privacyCode(winner),
    ]);
  }

  const best = pickBest(carriageways, input.minWidthAdvantageM);
  if (best === null) {
    // Two plausible frontages the evidence does not separate. Downstream cannot
    // tell a guess from a measurement, so it does not get one.
    for (const carriageway of carriageways) recordRival(log, carriageway, null);
    return { known: false, why: 'below_confidence', provenance };
  }

  recordWinner(log, best.winner);
  for (const carriageway of carriageways) {
    if (carriageway === best.winner) continue;
    recordRival(log, carriageway, best.setAsideOf.get(carriageway)?.reason ?? null);
  }

  return known(best.winner, best.setAside, input, provenance, [
    ...new Set(best.setAside.map((r) => `street_resolved_by_${r.reason}`)),
    ...continuationCode(best.winner),
    ...privacyCode(best.winner),
  ]);
}

function provenanceOf(carriageway: Carriageway, input: StreetSelectionInput): Provenance {
  return { source: carriageway.frontage.way.source, method: METHOD, fetchedAt: input.fetchedAt };
}

/**
 * the way the stop was measured on, retained as the frontage (the
 * stop stands on it, whatever a nearer half says). What it merges with stays
 * merged; every other contender is set aside as `declared_stop_street`, named
 * in the fact and in the grey layer — never dropped in silence.
 */
function retainDeclared(
  declared: Candidate,
  contenders: readonly Candidate[],
  input: StreetSelectionInput,
  log: SearchLog,
): Fact<DeliveryStreet> {
  const inContest = contenders.includes(declared)
    ? contenders
    : [...contenders, declared].sort((a, b) => a.distanceM - b.distanceM || (a.way.id < b.way.id ? -1 : 1));
  const carriageways = groupCarriageways(inContest, input.continuationDeviationDeg);
  const own = carriageways.find((c) => c.members.includes(declared));
  const winner: Carriageway = { frontage: declared, members: own?.members ?? [declared] };
  recordWinner(log, winner);
  const setAside: RejectedStreet[] = [];
  for (const carriageway of carriageways) {
    if (carriageway === own) continue;
    recordRival(log, carriageway, 'declared_stop_street');
    setAside.push({
      segmentId: carriageway.frontage.way.id,
      name: carriageway.frontage.way.name,
      distanceFromPointM: carriageway.frontage.distanceM,
      reason: 'declared_stop_street',
    });
  }
  return known(winner, setAside, input, provenanceOf(winner, input), [
    'street_declared_by_stop',
    ...continuationCode(winner),
    ...privacyCode(winner),
  ]);
}

/** A declared way the neighbourhood did not carry: the contest ran, and the street says so. */
function notFoundSaid(street: Fact<DeliveryStreet>, input: StreetSelectionInput): Fact<DeliveryStreet> {
  return input.declaredWay === undefined ? street : noted(street, 'street_declared_not_found');
}

/**
 * a clicked point's way, once the contest has spoken. A winner
 * stands: the click only adds that it was elsewhere (`street_declared_overruled`),
 * or nothing when it was on the winner. A tie is broken by the click, provided
 * no contender beats the clicked carriageway — a click breaks a tie, never a
 * separation. Otherwise the contest's answer stands, unknown included.
 */
function afterClick(
  contested: Fact<DeliveryStreet>,
  clicked: Candidate,
  carriageways: readonly Carriageway[],
  input: StreetSelectionInput,
  log: SearchLog,
): Fact<DeliveryStreet> {
  const own = carriageways.find((c) => c.members.includes(clicked));
  if (contested.known) {
    const onWinner = own !== undefined && own.members.some((m) => m.way.id === contested.value.segmentId);
    return onWinner ? contested : noted(contested, 'street_declared_overruled');
  }
  if (contested.why !== 'below_confidence' || own === undefined) return contested;
  return breakTie(own, carriageways, input, log) ?? contested;
}

/**
 * The clicked carriageway against every other, on the contest's own grounds:
 * null as soon as one beats it. The ones it beats are set aside on that
 * ground; the ones level with it, as `declared_stop_street`.
 */
function breakTie(
  own: Carriageway,
  carriageways: readonly Carriageway[],
  input: StreetSelectionInput,
  log: SearchLog,
): Fact<DeliveryStreet> | null {
  const setAside: { readonly carriageway: Carriageway; readonly rejected: RejectedStreet }[] = [];
  for (const other of carriageways) {
    if (other === own) continue;
    const decision = separate(own, other, input.minWidthAdvantageM);
    if (decision !== null && decision.winner !== own) return null;
    const reason = decision?.reason ?? 'declared_stop_street';
    const { way, distanceM } = other.frontage;
    setAside.push({ carriageway: other, rejected: { segmentId: way.id, name: way.name, distanceFromPointM: distanceM, reason } });
  }
  recordWinner(log, own);
  for (const { carriageway, rejected } of setAside) recordRival(log, carriageway, rejected.reason);
  const beaten = setAside.filter((r) => r.rejected.reason !== 'declared_stop_street');
  return known(own, setAside.map((r) => r.rejected), input, provenanceOf(own, input), [
    'street_declared_breaks_tie',
    ...new Set(beaten.map((r) => `street_resolved_by_${r.rejected.reason}`)),
    ...continuationCode(own),
    ...privacyCode(own),
  ]);
}

/** A known street with one more reason code: what the declaration came to, said on the fact. */
function noted(street: Fact<DeliveryStreet>, code: string): Fact<DeliveryStreet> {
  if (!street.known) return street;
  return { ...street, reliability: { ...street.reliability, reasonCodes: [...street.reliability.reasonCodes, code] } };
}

// ------------------------------------------------------------- the grey log --

/** Opens a way's row the moment the way is first looked at. */
function study(log: SearchLog, way: RoadWay): Studied {
  const row: Studied = {
    way,
    distanceM: null,
    endsInsideFetch: null,
    outcome: 'filtered',
    stage: 'beyond_snap',
    reason: null,
  };
  log.set(way, row);
  return row;
}

function mark(
  log: SearchLog,
  way: RoadWay,
  outcome: ConsideredWay['outcome'],
  stage: ConsideredWay['stage'],
  reason: RejectedStreet['reason'] | null = null,
): void {
  const row = log.get(way);
  if (row === undefined) return;
  row.outcome = outcome;
  row.stage = stage;
  row.reason = reason;
}

/** The delivery street, and whatever was folded into it. */
function recordWinner(log: SearchLog, carriageway: Carriageway): void {
  mark(log, carriageway.frontage.way, 'retained', 'retained');
  for (const member of carriageway.members) {
    if (member === carriageway.frontage) continue;
    mark(log, member.way, 'merged_into_retained', 'continuation_merged');
  }
}

/**
 * A carriageway that reached the contest and did not win it.
 *
 * Its merged members read `compared` too: they were in the contest, just not as
 * the face of it. Calling them `merged_into_retained` would name the wrong
 * carriageway.
 */
function recordRival(
  log: SearchLog,
  carriageway: Carriageway,
  reason: RejectedStreet['reason'] | null,
): void {
  mark(log, carriageway.frontage.way, 'compared', 'compared', reason);
  for (const member of carriageway.members) {
    if (member === carriageway.frontage) continue;
    mark(log, member.way, 'compared', 'continuation_merged');
  }
}

function searchOf(input: StreetSelectionInput, log: SearchLog): StreetSearch {
  const considered: ConsideredWay[] = [];
  for (const row of log.values()) {
    considered.push({
      segmentId: row.way.id,
      name: row.way.name,
      highway: row.way.tags['highway'] ?? null,
      // Referenced, not copied: the neighbourhood owns these points and is
      // discarded with the run.
      geometry: row.way.geometry,
      distanceM: row.distanceM,
      endsInsideFetch: row.endsInsideFetch,
      outcome: row.outcome,
      stage: row.stage,
      reason: row.reason,
    });
  }
  return {
    centre: input.point,
    fetchRadiusM: input.neighbourhood.radiusM,
    maxSnapM: input.maxSnapM,
    ambiguityWindowM: input.ambiguityWindowM,
    considered,
  };
}

function known(
  carriageway: Carriageway,
  alternativesConsidered: readonly RejectedStreet[],
  input: StreetSelectionInput,
  provenance: Provenance,
  reasonCodes: readonly string[],
): Fact<DeliveryStreet> {
  const way = carriageway.frontage.way;
  return {
    known: true,
    value: {
      segmentId: way.id,
      name: way.name,
      // Only BDTOPO fills `importance`, and production runs on OSM — so the
      // field was null for every address ever analysed, and nothing downstream
      // could tell a boulevard from a cul-de-sac. The OSM highway class already
      // ranks on the same axis (this module ranks streets by it), so it stands
      // in where the surveyed class is absent.
      importance: way.importance ?? highwayRank(way),
      declaredWidthM: way.declaredWidthM,
      oneWay: way.oneWay !== 'no',
      isPrivate: way.isPrivate,
      alternativesConsidered,
    },
    provenance,
    reliability: {
      confidence:
        alternativesConsidered.length === 0
          ? input.confidence.unambiguous
          : input.confidence.resolvedByRank,
      basis: 'derived',
      reasonCodes,
    },
  };
}

/** Privacy is noted, never disqualifying: a commissioned delivery to a private way is normal. */
function privacyCode(carriageway: Carriageway): readonly string[] {
  return carriageway.frontage.way.isPrivate ? ['street_is_private'] : [];
}

/** Says out loud that an attribute break was crossed rather than treated as an end of road. */
function continuationCode(carriageway: Carriageway): readonly string[] {
  return carriageway.members.length > 1 ? ['street_continuation_merged'] : [];
}

/**
 * Every way, measured once, in the order the source listed them.
 *
 * Each `continue` below used to be silent — the way left no trace at all, which
 * is how the Auxerre spur could be discarded without ever being named. Each now
 * writes its stage to `log` first. The log is write-only here: nothing read
 * back from it takes part in the decision.
 */
function collectCandidates(
  input: StreetSelectionInput,
  nodesById: ReadonlyMap<string, RoadNode>,
  log: SearchLog,
): readonly Candidate[] {
  const out: Candidate[] = [];
  for (const way of input.neighbourhood.ways) {
    const row = study(log, way);

    const highway = way.tags['highway'];
    if (highway !== undefined && NON_VEHICULAR_HIGHWAY.has(highway)) {
      // Never measured: the class alone disqualifies it, so no distance exists.
      row.stage = 'non_vehicular';
      continue;
    }

    const closest = closestPointOnPolyline(way.geometry, input.point);
    // A null closest means the way carries no line at all — no distance to
    // state either, which is why `distanceM` stays null rather than reading 0.
    row.distanceM = closest === null ? null : closest.distanceM;
    if (closest === null) continue;

    // the end-of-road test runs on EVERY measured way, not only on
    // the ones near enough to snap. The decision is untouched — `out` still
    // only receives snapped ways, and `Candidate.endsInsideFetch` still only
    // exists for them. What it feeds is the log: /explain's grey layer says
    // whether a street eighty metres away ends. The rule it was first written
    // for (dead-end avoidance) left with; the reading stays, because
    // re-deriving it elsewhere would be a second definition of "this road
    // ends here" drifting away from this one.
    const ends = endsInsideFetch(way, input, nodesById);
    row.endsInsideFetch = ends;
    if (closest.distanceM > input.maxSnapM) continue;

    out.push({
      way,
      distanceM: closest.distanceM,
      endsInsideFetch: ends,
    });
  }
  // Ties broken by id so the same neighbourhood always yields the same answer.
  return out.sort((a, b) => a.distanceM - b.distanceM || (a.way.id < b.way.id ? -1 : 1));
}

/**
 * True when this way provably ends within the fetch.
 *
 * Three guards, each closing a way this has been got wrong:
 *
 *  - Only the first and last entries of `nodeIds` may be tips. Every interior
 *    vertex of a way is referenced by exactly one way and is degree-1 by
 *    construction, which is what turned a through street into a cul-de-sac in
 *    BUG-048a — the shape point 0.3 m from the delivery point fired the test.
 *  - A tip near the fetch boundary is not evidence: it may be the cut rather
 *    than the end (BUG-003).
 *  - Any interior tip that survives those two guards is a genuine end of road.
 *    A through street clipped at both fetched ends has both cuts AT the
 *    boundary, so the margin guard already removed them; a way still holding
 *    two interior tips is an isolated segment, which ends twice over.
 */
function endsInsideFetch(
  way: RoadWay,
  input: StreetSelectionInput,
  nodesById: ReadonlyMap<string, RoadNode>,
): boolean {
  const { centre, radiusM } = input.neighbourhood;
  const provableRadiusM = radiusM - input.tipInteriorMarginM;

  let tips = 0;
  for (const nodeId of terminalNodeIds(way)) {
    const node = nodesById.get(nodeId);
    if (node === undefined) continue; // degree unknown: not evidence of anything
    if (node.wayIds.length !== 1) continue; // a junction: the road goes on
    if (haversineM(centre, node.at) > provableRadiusM) continue; // may be the fetch cut
    tips += 1;
  }
  return tips >= 1;
}

function terminalNodeIds(way: RoadWay): readonly string[] {
  const first = way.nodeIds[0];
  const last = way.nodeIds[way.nodeIds.length - 1];
  if (first === undefined || last === undefined) return [];
  return first === last ? [first] : [first, last];
}

/**
 * Collapses contenders that are the same physical carriageway.
 *
 * BDTOPO and OSM split a roadway at every attribute change, so the two halves
 * of one street arrive as two ways with different names, importances or
 * one-way flags. Left as rivals they either tie (reported as ambiguity that
 * does not exist) or the far half wins on importance and the frontage moves to
 * a stretch the point is not beside.
 */
function groupCarriageways(
  contenders: readonly Candidate[],
  continuationDeviationDeg: number,
): readonly Carriageway[] {
  const groupOf = new Map<string, number>();
  const groups: Candidate[][] = [];

  for (const candidate of contenders) {
    let target: number | null = null;
    for (const other of contenders) {
      if (other === candidate) continue;
      const groupIndex = groupOf.get(other.way.id);
      if (groupIndex === undefined) continue;
      const deviation = continuationDeviationAt(candidate.way, other.way);
      if (deviation !== null && deviation <= continuationDeviationDeg) {
        target = groupIndex;
        break;
      }
    }
    if (target === null) {
      target = groups.length;
      groups.push([]);
    }
    const group = groups[target];
    if (group === undefined) continue;
    group.push(candidate);
    groupOf.set(candidate.way.id, target);
  }

  const out: Carriageway[] = [];
  for (const group of groups) {
    // Contenders arrive sorted, so the first member is the stretch the point is beside.
    const frontage = group[0];
    if (frontage === undefined) continue;
    out.push({ frontage, members: group });
  }
  return out;
}

/**
 * Angle the road turns through where two ways meet end to end, or null when
 * they do not share a tip. Zero means the carriageway simply carries on.
 */
function continuationDeviationAt(a: RoadWay, b: RoadWay): number | null {
  for (const endA of [0, 1] as const) {
    for (const endB of [0, 1] as const) {
      if (terminalNodeId(a, endA) !== terminalNodeId(b, endB)) continue;
      const outwardA = outwardBearing(a, endA);
      const outwardB = outwardBearing(b, endB);
      if (outwardA === null || outwardB === null) return null;
      // Both bearings point away from the shared node, so a straight road reads 180°.
      return 180 - bearingDeltaDeg(outwardA, outwardB);
    }
  }
  return null;
}

function terminalNodeId(way: RoadWay, end: 0 | 1): string | null {
  const index = end === 0 ? 0 : way.nodeIds.length - 1;
  return way.nodeIds[index] ?? null;
}

/** Bearing leaving the way's tip along its own geometry. */
function outwardBearing(way: RoadWay, end: 0 | 1): number | null {
  const n = way.geometry.length;
  if (n < 2) return null;
  const tip = end === 0 ? way.geometry[0] : way.geometry[n - 1];
  const next = end === 0 ? way.geometry[1] : way.geometry[n - 2];
  if (tip === undefined || next === undefined) return null;
  return bearingDeg(tip, next);
}

interface Separation {
  readonly winner: Carriageway;
  readonly reason: RejectedStreet['reason'];
}

/**
 * The one contender that strictly beats every other, with the ground on which
 * each of the others was set aside. Null when the evidence leaves two of them
 * level — which is an answer, not a failure.
 */
function pickBest(
  carriageways: readonly Carriageway[],
  minWidthAdvantageM: number,
): {
  readonly winner: Carriageway;
  readonly setAside: readonly RejectedStreet[];
  /**
   * The same rejections, reachable by the carriageway they are about. Two
   * carriageways may share a segment id, so the log is keyed by object.
   */
  readonly setAsideOf: ReadonlyMap<Carriageway, RejectedStreet>;
} | null {
  for (const candidate of carriageways) {
    const setAside: RejectedStreet[] = [];
    const setAsideOf = new Map<Carriageway, RejectedStreet>();
    let beatsAll = true;
    for (const other of carriageways) {
      if (other === candidate) continue;
      const decision = separate(candidate, other, minWidthAdvantageM);
      if (decision === null || decision.winner !== candidate) {
        beatsAll = false;
        break;
      }
      const rejected: RejectedStreet = {
        segmentId: other.frontage.way.id,
        name: other.frontage.way.name,
        distanceFromPointM: other.frontage.distanceM,
        reason: decision.reason,
      };
      setAside.push(rejected);
      setAsideOf.set(other, rejected);
    }
    if (beatsAll) return { winner: candidate, setAside, setAsideOf };
  }
  return null;
}

/**
 * Which of two contenders is the delivery frontage, and on what grounds.
 *
 * Order is the argument. Structuring rank first — that is the Auxerre rule, and
 * it is the only axis on which a primary N77 frontage and an unclassified spur
 * differ in a way a report can defend. The end-of-road test sits below width so
 * that a genuine cul-de-sac address is never taken away from its own street by
 * a wider through road next to it; it only speaks when nothing else does.
 * Privacy speaks last, and only against an otherwise equal public frontage.
 */
function separate(a: Carriageway, b: Carriageway, minWidthAdvantageM: number): Separation | null {
  const wa = a.frontage.way;
  const wb = b.frontage.way;

  const importance = lowerWins(wa.importance, wb.importance);
  if (importance !== null) return { winner: importance === 'a' ? a : b, reason: 'lower_importance' };

  const klass = lowerWins(highwayRank(wa), highwayRank(wb));
  if (klass !== null) return { winner: klass === 'a' ? a : b, reason: 'lower_importance' };

  const width = widerWins(wa.declaredWidthM, wb.declaredWidthM, minWidthAdvantageM);
  if (width !== null) return { winner: width === 'a' ? a : b, reason: 'narrower' };

  if (a.frontage.endsInsideFetch !== b.frontage.endsInsideFetch) {
    return { winner: a.frontage.endsInsideFetch ? b : a, reason: 'dead_end_spur' };
  }

  if (wa.isPrivate !== wb.isPrivate) {
    return { winner: wa.isPrivate ? b : a, reason: 'private' };
  }

  return null;
}

/** Unknown is not "worse": a missing importance must not lose to a stated one. */
function lowerWins(a: number | null, b: number | null): 'a' | 'b' | null {
  if (a === null || b === null || a === b) return null;
  return a < b ? 'a' : 'b';
}

function widerWins(a: number | null, b: number | null, minAdvantageM: number): 'a' | 'b' | null {
  if (a === null || b === null) return null;
  if (Math.abs(a - b) < minAdvantageM) return null;
  return a > b ? 'a' : 'b';
}

