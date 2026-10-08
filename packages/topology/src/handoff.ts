/**
 * S1 — Handoff.
 *
 * Where the truck leaves the delivery way and rejoins the public network: the
 * junction between the delivery street and the first street that is not itself
 * terminal.
 *
 * Three things the engine got wrong are structural here rather than patched.
 *
 * 1. A street is not a way. BDTOPO and OSM split one carriageway at every
 *    change of name, importance class or direction, and the engine read the
 *    split node as the end of the road (BUG-037a, Clamart). Continuity here is
 *    geometric: the walk crosses a degree-2 attribute break without noticing it,
 *    and only records that it happened as a reason code.
 * 2. A degree-1 node is not a dead-end. Every interior shape point of a way is
 *    referenced by exactly one way and is therefore degree-1 by construction
 *    (BUG-048a, Plougoumelen), and a way clipped at the edge of the fetch ends
 *    in a degree-1 node that is only where we stopped looking (BUG-003). Only a
 *    node that is a way *terminal*, referenced by one carriageway, and provably
 *    inside the fetch radius, closes a street.
 * 3. The walk is recursive and bounded. A dead-end whose parent is also a
 *    dead-end has to keep walking, and nothing in the engine limited how far it
 *    could drift from the address.
 *
 * No distance threshold is applied. Whether the handoff is close enough to be
 * acceptable is a policy comparison the caller makes; this module reports the
 * geometry and says how far along the road it is.
 */
import type {
  Fact,
  GeoPoint,
  Mouth,
  Provenance,
  Reliability,
  SourceId,
} from '@teneolog/domain';

import {
  bearingDeg,
  bearingDeltaDeg,
  closestPointOnPolyline,
  haversineM,
} from './geometry.js';
import type { RoadNeighbourhood, RoadWay } from './ports.js';

export interface HandoffInput {
  readonly neighbourhood: RoadNeighbourhood;
  readonly deliveryWayId: string;
  readonly deliveryPoint: GeoPoint;
  /** How many terminal streets deep the walk may go before giving up. */
  readonly maxDepth: number;
  readonly maxDeviationDeg: number;
  /**
   * When the neighbourhood was acquired, ISO 8601.
   *
   * The clock is an input because this module is pure: a `Fact` must carry a
   * `fetchedAt`, and reading one from the process would make the same fixture
   * produce a different value on every run.
   */
  readonly fetchedAt: string;
}

/**
 * `highway` values that are not carriageway.
 *
 * Vocabulary, not a tunable: these are classes no lorry can be on at all. They
 * are excluded from the whole walk, which closes two symmetric defects — a
 * footway meeting a cul-de-sac tip must not make that tip look like a junction
 * (EC-24), and a mouth must never hand the truck off onto a path. `pedestrian`
 * and `track` are deliberately absent: both are routinely driven by delivery
 * vehicles, and treating OSM pedestrian tagging as impassable was itself a
 * defect (BUG-037b).
 */
const NON_CARRIAGEWAY_HIGHWAY: ReadonlySet<string> = new Set([
  'footway',
  'path',
  'steps',
  'cycleway',
  'bridleway',
  'corridor',
  'platform',
  'construction',
  'proposed',
]);

/**
 * The two things this module can know about its own answer, on the system-wide
 * 0..1 confidence scale. Not business thresholds — nothing downstream tunes
 * these to move a verdict; they distinguish a parent street seen to reach a
 * junction inside the fetch from one whose only evidence of continuing is that
 * it left the fetch.
 */
const CONFIDENCE_JUNCTION_PROVEN = 1;
const CONFIDENCE_PARENT_LEFT_FETCH = 0.5;

const METHOD = 'handoff-street-walk';

interface OrientedWay {
  readonly way: RoadWay;
  readonly reversed: boolean;
}

/** A maximal geometric chain of ways: one physical street, however it is split. */
interface Street {
  readonly wayIds: ReadonlySet<string>;
  readonly nodeIds: readonly string[];
  readonly points: readonly GeoPoint[];
  /** Distance from the chain head to each vertex, metres. Parallel to `nodeIds`. */
  readonly alongM: readonly number[];
  /** Name, importance or direction changed somewhere inside the chain. Diagnostic only. */
  readonly attributeBreak: boolean;
}

/** How a street endpoint terminates. Only `closed_tip` is evidence of a dead end. */
type Endpoint = 'closed_tip' | 'junction' | 'beyond_fetch';

interface StreetClass {
  readonly terminal: boolean;
  /** Non-terminal solely because an end left the fetch — the weaker claim. */
  readonly restsOnFetchBoundary: boolean;
}

interface Candidate {
  readonly point: GeoPoint;
  readonly parentSegmentId: string;
  readonly distanceFromStopM: number;
  readonly depth: number;
  readonly restsOnFetchBoundary: boolean;
  readonly parentSource: SourceId;
  /** the stretches walked to reach this candidate, stop first. */
  readonly legs: readonly HandoffLeg[];
}

/**
 * one stretch of the walk: a street as the walk chained it, and the
 * two positions along it between which its metres were counted. A mouth's
 * `distanceFromStopM` is, by construction, the sum of `|toAlongM - fromAlongM|`
 * over its legs — so the line laid back from them (`reversing.ts`) is the very
 * path that was measured, never a second route.
 */
export interface HandoffLeg {
  readonly nodeIds: readonly string[];
  readonly points: readonly GeoPoint[];
  /** Distance from the chain head to each vertex, metres. Parallel to `nodeIds`. */
  readonly alongM: readonly number[];
  readonly fromAlongM: number;
  readonly toAlongM: number;
}

/**
 * the delivery street as the walk chained it, whole: the axis the
 * turnaround map draws. The same chain the mouth was measured along, so the
 * map and the metres cannot describe two streets; and it exists with or
 * without a mouth, because the geometry of an impasse whose mouth could not
 * be named is still worth drawing.
 */
export interface HandoffStreet {
  readonly wayIds: readonly string[];
  readonly nodeIds: readonly string[];
  readonly points: readonly GeoPoint[];
  /** Distance from the chain head to each vertex, metres. Parallel to `nodeIds`. */
  readonly alongM: readonly number[];
  /** Where the delivery point projects onto the chain, metres from its head. */
  readonly stopAlongM: number;
  /**
   * Whether each end of the chain is a closed tip, by the walk's own test: one
   * carriageway, a way terminal, strictly inside the fetch (BUG-003, BUG-048a).
   * False is « not proven », never « open ».
   */
  readonly closedTipAtHead: boolean;
  readonly closedTipAtTail: boolean;
}

/** The mouth, and the legs walked to reach it (null when there is no mouth). */
export interface HandoffWalk {
  readonly mouth: Fact<Mouth>;
  readonly legs: readonly HandoffLeg[] | null;
  /** the delivery street the walk started from; null when there is none to walk. */
  readonly street: HandoffStreet | null;
}

export function resolveHandoff(input: HandoffInput): Fact<Mouth> {
  return resolveHandoffWalk(input).mouth;
}

/** `resolveHandoff`, plus the legs the retained mouth was measured along. */
export function resolveHandoffWalk(input: HandoffInput): HandoffWalk {
  const walk = Walk.from(input);
  if (walk === null) return { mouth: { known: false, why: 'no_data' }, legs: null, street: null };
  return { ...walk.run(), street: walk.street() };
}

function legOf(street: Street, fromAlongM: number, toAlongM: number): HandoffLeg {
  return { nodeIds: street.nodeIds, points: street.points, alongM: street.alongM, fromAlongM, toAlongM };
}

class Walk {
  private readonly candidates: Candidate[] = [];

  private constructor(
    private readonly input: HandoffInput,
    private readonly ways: ReadonlyMap<string, RoadWay>,
    private readonly nodes: ReadonlyMap<string, { readonly at: GeoPoint; readonly wayIds: readonly string[] }>,
    private readonly deliveryStreet: Street,
    private readonly deliveryAlongM: number,
  ) {}

  static from(input: HandoffInput): Walk | null {
    const ways = new Map<string, RoadWay>();
    for (const way of input.neighbourhood.ways) {
      if (isCarriageway(way)) ways.set(way.id, way);
    }

    // Degree is counted over carriageway only, so a footway at a tip cannot
    // dress the tip up as a junction (EC-24).
    const nodes = new Map<string, { at: GeoPoint; wayIds: string[] }>();
    for (const node of input.neighbourhood.nodes) {
      const wayIds = node.wayIds.filter((id) => ways.has(id));
      nodes.set(node.id, { at: node.at, wayIds });
    }

    const seed = ways.get(input.deliveryWayId);
    if (seed === undefined) return null;

    const builder = new Walk(input, ways, nodes, EMPTY_STREET, 0);
    const street = builder.buildStreet(seed, new Set());
    if (street === null) return null;

    const projection = closestPointOnPolyline(street.points, input.deliveryPoint);
    if (projection === null) return null;

    return new Walk(input, ways, nodes, street, projection.alongM);
  }

  /** the delivery street, read-only, its two ends tested as the walk tests them. */
  street(): HandoffStreet {
    const { wayIds, nodeIds, points, alongM } = this.deliveryStreet;
    // An end the chain passes through again reads as a one-way terminal, and
    // is not a tip (`chainPassesAgainAt`).
    const closedTip = (index: number): boolean => {
      const id = nodeIds[index];
      return id !== undefined && !chainPassesAgainAt(nodeIds, index) && this.endpointOf(id) === 'closed_tip';
    };
    return {
      wayIds: [...wayIds].sort(),
      nodeIds,
      points,
      alongM,
      stopAlongM: this.deliveryAlongM,
      closedTipAtHead: closedTip(0),
      closedTipAtTail: closedTip(nodeIds.length - 1),
    };
  }

  run(): Omit<HandoffWalk, 'street'> {
    this.explore(this.deliveryStreet, this.deliveryAlongM, 0, 0, new Set(), []);

    const best = pickNearest(this.candidates);
    if (best === undefined) {
      // Either the walk ran out of depth, or every street in reach is a pocket.
      // Both are the same answer to the caller: we cannot name a mouth, and one
      // must never be invented. No provenance is attached because no source
      // produced anything — naming one would be a fabricated citation.
      return { mouth: { known: false, why: 'no_data' }, legs: null };
    }

    const reasonCodes: string[] = [
      best.depth === 0 ? 'mouth_at_delivery_street_junction' : 'mouth_through_nested_dead_end',
    ];
    if (this.deliveryStreet.attributeBreak) {
      reasonCodes.push('delivery_street_attribute_break_traversed');
    }
    if (best.restsOnFetchBoundary) reasonCodes.push('parent_continuity_beyond_fetch');

    const reliability: Reliability = {
      confidence: best.restsOnFetchBoundary
        ? CONFIDENCE_PARENT_LEFT_FETCH
        : CONFIDENCE_JUNCTION_PROVEN,
      basis: 'derived',
      reasonCodes,
    };

    const mouth: Fact<Mouth> = {
      known: true,
      value: {
        point: best.point,
        parentSegmentId: best.parentSegmentId,
        distanceFromStopM: best.distanceFromStopM,
        depth: best.depth,
      },
      provenance: this.provenance(best.parentSource),
      reliability,
    };
    return { mouth, legs: best.legs };
  }

  private provenance(source: SourceId): Provenance {
    return { source, method: METHOD, fetchedAt: this.input.fetchedAt };
  }

  /**
   * Walks one street looking for a junction with a street that is not itself
   * terminal, and steps into terminal streets while the depth budget allows.
   */
  private explore(
    street: Street,
    arrivalAlongM: number,
    distanceAtArrivalM: number,
    depth: number,
    excluded: ReadonlySet<string>,
    trail: readonly HandoffLeg[],
  ): void {
    const deeperExcluded = new Set(excluded);
    for (const id of street.wayIds) deeperExcluded.add(id);

    for (let i = 0; i < street.nodeIds.length; i += 1) {
      const nodeId = street.nodeIds[i];
      const alongM = street.alongM[i];
      if (nodeId === undefined || alongM === undefined) continue;
      const node = this.nodes.get(nodeId);
      if (node === undefined) continue;

      const distanceM = distanceAtArrivalM + Math.abs(alongM - arrivalAlongM);
      // the stretch those metres were counted along, kept with them.
      const legs = [...trail, legOf(street, arrivalAlongM, alongM)];

      // Sorted so the answer does not depend on the order the fetch happened to
      // list the ways in.
      const branchWayIds = [...node.wayIds].sort();
      const seenBranches = new Set<string>();

      for (const wayId of branchWayIds) {
        if (street.wayIds.has(wayId) || excluded.has(wayId)) continue;
        const way = this.ways.get(wayId);
        if (way === undefined) continue;

        const branch = this.buildStreet(way, deeperExcluded);
        if (branch === null) continue;
        const key = streetKey(branch);
        if (seenBranches.has(key)) continue;
        seenBranches.add(key);

        const classification = this.classify(branch, nodeId);
        if (!classification.terminal) {
          this.candidates.push({
            point: node.at,
            parentSegmentId: wayId,
            distanceFromStopM: distanceM,
            depth,
            restsOnFetchBoundary: classification.restsOnFetchBoundary,
            parentSource: way.source,
            legs,
          });
          continue;
        }

        if (depth >= this.input.maxDepth) continue;
        const entryIndex = branch.nodeIds.indexOf(nodeId);
        const entryAlongM = entryIndex < 0 ? 0 : (branch.alongM[entryIndex] ?? 0);
        this.explore(branch, entryAlongM, distanceM, depth + 1, deeperExcluded, legs);
      }
    }
  }

  /**
   * A street reached at `arrivalNodeId` is terminal when every other end of it
   * is a closed tip. The arrival node is excluded because it is a junction by
   * definition — that is how we got here.
   */
  private classify(street: Street, arrivalNodeId: string): StreetClass {
    const first = street.nodeIds[0];
    const last = street.nodeIds[street.nodeIds.length - 1];

    const ends: Endpoint[] = [];
    for (const end of [first, last]) {
      if (end === undefined || end === arrivalNodeId) continue;
      ends.push(this.endpointOf(end));
    }

    // A street that leads nowhere but back to the node we arrived at is not a
    // way out either.
    if (ends.length === 0) return { terminal: true, restsOnFetchBoundary: false };

    const terminal = ends.every((e) => e === 'closed_tip');
    const restsOnFetchBoundary =
      !terminal && !ends.includes('junction') && ends.includes('beyond_fetch');
    return { terminal, restsOnFetchBoundary };
  }

  private endpointOf(nodeId: string): Endpoint {
    const node = this.nodes.get(nodeId);
    // A node the fetch did not describe is a node we know nothing about, which
    // is not evidence that the road stops there.
    if (node === undefined) return 'beyond_fetch';
    if (node.wayIds.length !== 1) return 'junction';

    const wayId = node.wayIds[0];
    if (wayId === undefined) return 'junction';
    const way = this.ways.get(wayId);
    if (way === undefined) return 'beyond_fetch';

    // BUG-048a: every interior shape point of a way is referenced by exactly one
    // way and is degree-1 by construction. Only the two ends of a way are tips.
    if (!isWayTerminal(way, nodeId)) return 'junction';

    // BUG-003: a tip on the edge of the fetch circle is where we stopped
    // looking, not where the carriageway stops.
    const { centre, radiusM } = this.input.neighbourhood;
    return haversineM(node.at, centre) < radiusM ? 'closed_tip' : 'beyond_fetch';
  }

  /**
   * Grows the maximal geometric chain through `seed`, in both directions.
   *
   * Continuity is angular, never attribute identity: a way whose name,
   * importance or direction differs is still the same street when it carries
   * straight on (BUG-037a).
   */
  private buildStreet(seed: RoadWay, excluded: ReadonlySet<string>): Street | null {
    if (!isUsable(seed) || excluded.has(seed.id)) return null;

    const used = new Set(excluded);
    used.add(seed.id);

    const head: OrientedWay = { way: seed, reversed: false };
    const forward = this.grow(head, used);
    const backward = this.grow({ way: seed, reversed: true }, used);

    const chain: OrientedWay[] = [
      ...backward.map(flip).reverse(),
      head,
      ...forward,
    ];

    const nodeIds: string[] = [];
    const points: GeoPoint[] = [];
    for (const oriented of chain) {
      const ns = orientedNodeIds(oriented);
      const ps = orientedPoints(oriented);
      const skip = nodeIds.length === 0 ? 0 : 1;
      for (let i = skip; i < ns.length; i += 1) {
        const n = ns[i];
        const p = ps[i];
        if (n === undefined || p === undefined) return null;
        nodeIds.push(n);
        points.push(p);
      }
    }
    if (points.length < 2) return null;

    const alongM: number[] = [0];
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1];
      const cur = points[i];
      const last = alongM[i - 1];
      if (prev === undefined || cur === undefined || last === undefined) return null;
      alongM.push(last + haversineM(prev, cur));
    }

    return {
      wayIds: new Set(chain.map((o) => o.way.id)),
      nodeIds,
      points,
      alongM,
      attributeBreak: hasAttributeBreak(chain),
    };
  }

  /** Extends past the tail of `from`, returning only the ways appended. */
  private grow(from: OrientedWay, used: Set<string>): OrientedWay[] {
    const appended: OrientedWay[] = [];
    let current = from;

    for (;;) {
      const ns = orientedNodeIds(current);
      const ps = orientedPoints(current);
      const tailId = ns[ns.length - 1];
      const incoming = headingIntoTail(ps);
      if (tailId === undefined || incoming === null) break;

      const node = this.nodes.get(tailId);
      if (node === undefined) break;

      let best: { readonly oriented: OrientedWay; readonly deviationDeg: number } | null = null;
      for (const wayId of [...node.wayIds].sort()) {
        if (used.has(wayId)) continue;
        const way = this.ways.get(wayId);
        if (way === undefined || !isUsable(way)) continue;

        // Only a way that *ends* at this node continues the carriageway. A way
        // merely passing through is a street you turn onto, not this street.
        const oriented = orientFromTerminal(way, tailId);
        if (oriented === null) continue;

        const outgoing = headingOutOfHead(orientedPoints(oriented));
        if (outgoing === null) continue;

        const deviationDeg = bearingDeltaDeg(incoming, outgoing);
        if (deviationDeg > this.input.maxDeviationDeg) continue;
        if (best === null || deviationDeg < best.deviationDeg) {
          best = { oriented, deviationDeg };
        }
      }

      if (best === null) break;
      used.add(best.oriented.way.id);
      appended.push(best.oriented);
      current = best.oriented;
    }

    return appended;
  }
}

const EMPTY_STREET: Street = {
  wayIds: new Set<string>(),
  nodeIds: [],
  points: [],
  alongM: [],
  attributeBreak: false,
};

/**
 * Whether the chain passes again through the node at `index`. Such an end is
 * where the road turns back, not where it stops: a ring (head = tail) has no
 * end at all, and a loop drawn as one way in a « P » ends on its own neck — the
 * street leaves that node both ways. Exported: the turnaround map
 * (`impasse-geometry.ts`) must agree with the walk on what an end of the chain is.
 */
export function chainPassesAgainAt(nodeIds: readonly string[], index: number): boolean {
  const id = nodeIds[index];
  return id !== undefined && nodeIds.indexOf(id) !== nodeIds.lastIndexOf(id);
}

/** Exported: the reach by road (`reach.ts`) must agree with the mouth walk on what a lorry can be on. */
export function isCarriageway(way: RoadWay): boolean {
  const highway = way.tags['highway'];
  if (highway === undefined) return true;
  return !NON_CARRIAGEWAY_HIGHWAY.has(highway);
}

function isUsable(way: RoadWay): boolean {
  return way.geometry.length >= 2 && way.geometry.length === way.nodeIds.length;
}

function isWayTerminal(way: RoadWay, nodeId: string): boolean {
  return way.nodeIds[0] === nodeId || way.nodeIds[way.nodeIds.length - 1] === nodeId;
}

function flip(oriented: OrientedWay): OrientedWay {
  return { way: oriented.way, reversed: !oriented.reversed };
}

function orientedNodeIds(oriented: OrientedWay): readonly string[] {
  return oriented.reversed ? [...oriented.way.nodeIds].reverse() : oriented.way.nodeIds;
}

function orientedPoints(oriented: OrientedWay): readonly GeoPoint[] {
  return oriented.reversed ? [...oriented.way.geometry].reverse() : oriented.way.geometry;
}

function orientFromTerminal(way: RoadWay, nodeId: string): OrientedWay | null {
  if (way.nodeIds[0] === nodeId) return { way, reversed: false };
  if (way.nodeIds[way.nodeIds.length - 1] === nodeId) return { way, reversed: true };
  return null;
}

/** Bearing of the last non-degenerate segment, i.e. the heading arriving at the tail. */
function headingIntoTail(points: readonly GeoPoint[]): number | null {
  const tail = points[points.length - 1];
  if (tail === undefined) return null;
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const p = points[i];
    if (p === undefined) continue;
    if (p.lat !== tail.lat || p.lon !== tail.lon) return bearingDeg(p, tail);
  }
  return null;
}

/** Bearing of the first non-degenerate segment, i.e. the heading leaving the head. */
function headingOutOfHead(points: readonly GeoPoint[]): number | null {
  const head = points[0];
  if (head === undefined) return null;
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i];
    if (p === undefined) continue;
    if (p.lat !== head.lat || p.lon !== head.lon) return bearingDeg(head, p);
  }
  return null;
}

function hasAttributeBreak(chain: readonly OrientedWay[]): boolean {
  for (let i = 1; i < chain.length; i += 1) {
    const a = chain[i - 1];
    const b = chain[i];
    if (a === undefined || b === undefined) continue;
    if (
      a.way.name !== b.way.name ||
      a.way.importance !== b.way.importance ||
      a.way.oneWay !== b.way.oneWay
    ) {
      return true;
    }
  }
  return false;
}

function streetKey(street: Street): string {
  return [...street.wayIds].sort().join('|');
}

/**
 * The mouth is where the truck first meets a street that goes somewhere, so the
 * nearest one along the road wins. Depth and id break ties only, and exist so
 * the same neighbourhood always yields the same mouth.
 */
function pickNearest(candidates: readonly Candidate[]): Candidate | undefined {
  let best: Candidate | undefined;
  for (const candidate of candidates) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    if (candidate.distanceFromStopM < best.distanceFromStopM) {
      best = candidate;
      continue;
    }
    if (candidate.distanceFromStopM > best.distanceFromStopM) continue;
    if (candidate.depth < best.depth) {
      best = candidate;
      continue;
    }
    if (candidate.depth > best.depth) continue;
    if (candidate.parentSegmentId < best.parentSegmentId) best = candidate;
  }
  return best;
}
