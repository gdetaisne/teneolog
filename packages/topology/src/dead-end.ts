/**
 * S1 — Terminal shape of the delivery street.
 *
 * Answers one question, agnostically: at the stop, does the road go on, does it
 * end, or does it end in something you can drive round? No vehicle appears in
 * this file, and nothing here decides whether a turnaround is big enough — that
 * is a measurement, and it belongs to the module that can measure.
 *
 * Two defects of the detector this replaces are closed by construction:
 *
 *  - A `junction=turning_loop` tag used to answer "not a dead end", which took
 *    the whole turnaround question off the table for every truck. Here a loop is
 *    `TERMINAL_LOOP`, and the domain type forces it to carry a `Fact<Turnaround>`
 *    that this module can only report as unknown. The question survives.
 *  - A degree-1 node was trusted only inside a fixed 0.7 x radius, which lost a
 *    real cul-de-sac tip at 46.5 m in a 50 m fetch. There is no ratio here; see
 *    `isProvenInterior`.
 */
import type {
  Continuity,
  Fact,
  GeoPoint,
  OneWayConstraint,
  TerminalTopology,
  Turnaround,
} from '@teneolog/domain';
import { assessExit, isDrivableWay } from './continuity.js';
import { bearingDeg, closestPointOnPolyline, haversineM } from './geometry.js';
import type { RoadNeighbourhood, RoadNode, RoadWay } from './ports.js';

export interface TerminalInput {
  readonly neighbourhood: RoadNeighbourhood;
  readonly deliveryWayId: string;
  readonly deliveryPoint: GeoPoint;
  /**
   * ISO 8601 instant the neighbourhood was fetched.
   *
   * An input rather than a clock read: this stage is pure, so it cannot date its
   * own output. Absent, the derived facts say so by carrying an empty
   * `fetchedAt` rather than inventing an instant.
   */
  readonly observedAt?: string;
}

export interface TerminalClassification {
  readonly topology: TerminalTopology;
  /** False when the terminal node sits so near the fetch edge that it may be an artefact of where we stopped looking. */
  readonly terminalNodeInterior: boolean;
  readonly resolvedWithinM: number;
}

/** Named so the provenance of a one-way reading is greppable across the corpus. */
const ONE_WAY_METHOD = 'terminal-topology/declared-one-way';

/**
 * Nothing in this stage measures a turnaround, and a tag is not a measurement.
 *
 * The old code read `junction=turning_loop` or `highway=turning_circle` as
 * "a turnaround exists" and skipped the sizing test. The circle at Saint-Vivien
 * (EC-17) exists and is too small for a 19 t; the only honest answer here is
 * that nobody has measured it yet.
 */
const UNMEASURED_TURNAROUND: Fact<Turnaround> = { known: false, why: 'no_data' };

export function classifyTerminal(input: TerminalInput): TerminalClassification {
  const { neighbourhood, deliveryWayId } = input;
  const way = neighbourhood.ways.find((candidate) => candidate.id === deliveryWayId);
  const tipIds = way === undefined ? [] : terminalNodeIds(way);

  if (way === undefined || tipIds.length === 0) {
    // S0 named a street this payload does not contain, or contains without
    // geometry. We have resolved nothing, so we claim nothing: the caller sees
    // a reach of zero and an uncorroborated terminal, which reads as "fetch
    // again, wider or elsewhere" and never as a verdict. Answering THROUGH here
    // would be a false OK on an OSM coverage gap; answering a confident
    // DEAD_END would be a false NON_LIVRABLE on the same gap.
    return {
      topology: {
        kind: 'DEAD_END',
        turnaround: { known: false, why: 'out_of_coverage' },
        entryDirection: { known: false, why: 'out_of_coverage' },
      },
      terminalNodeInterior: false,
      resolvedWithinM: 0,
    };
  }

  const nodeById = indexNodes(neighbourhood.nodes);
  const resolvedWithinM = neighbourhood.radiusM;

  // Loop first, and deliberately so. A closed bulb at the end of the street is
  // the one shape that a continuity walk can misread as "the road goes on" —
  // it does go on, for thirty metres, and then it comes back. Deciding it here
  // means no continuity implementation can promote a loop to THROUGH.
  if (hasTerminalLoop(neighbourhood, way, tipIds, nodeById)) {
    return {
      topology: {
        kind: 'TERMINAL_LOOP',
        turnaround: UNMEASURED_TURNAROUND,
        entryDirection: readEntryDirection(way, input),
      },
      terminalNodeInterior: allTipsProvenInterior(tipIds, nodeById, neighbourhood),
      resolvedWithinM,
    };
  }

  // A street goes through only if a drivable exit leaves EVERY tip. One dead
  // tip is enough to end it: the mid-block segment of a normal street has two
  // live tips (THROUGH), the last segment of a cul-de-sac has one dead one
  // (DEAD_END). `assessExit` rather than the aligned `assessContinuity` is the
  // point — a street that tees into a perpendicular road, or turns 90° and
  // carries on as an L, is a route out, and the alignment threshold that
  // chains way identity elsewhere would fabricate a cul-de-sac here.
  //
  // An exit must also LEAD somewhere: the world reachable beyond the tip has
  // to leave the fetched view. Saint-Fulgent (EC-24) is the field case — the
  // impasse's far end sprouts two short service driveways, `assessExit`
  // happily takes one, and the street read as THROUGH. A branch whose whole
  // component is contained in the payload is a pocket, and an exit into a
  // pocket is not an exit. The symmetric caution: containment is judged on
  // drivable ways only, so an escaping footpath cannot keep a tip alive.
  const escapeAdjacency = buildAdjacency(
    neighbourhood.ways.filter((other) => other.id !== way.id && isDrivableWay(other)),
  );
  const continuities: Continuity[] = [];
  let allTipsContinue = true;
  for (const tipId of tipIds) {
    const exit = assessExit({ neighbourhood, wayId: deliveryWayId, atNodeId: tipId });
    if (exit === null) {
      allTipsContinue = false;
      break;
    }
    if (exit.establishedBy !== 'same_way') {
      const reachable = reachableFrom(escapeAdjacency, tipId);
      const escapes = [...reachable.nodeIds].some((id) => beyondView(id, nodeById, neighbourhood));
      if (!escapes) {
        allTipsContinue = false;
        break;
      }
    }
    continuities.push(exit);
  }

  // The reported geometry is the weakest surviving link — the sharpest exit —
  // so it describes a node that exists. `attributeBreak` alone is OR-ed across
  // the tips: it is a diagnostic flag saying "attribute identity broke
  // somewhere here", and letting the weakest-link choice silence it would
  // reproduce exactly the quiet loss of the Clamart signal (BUG-037a).
  const weakest = continuities.reduce<Continuity | null>(
    (worst, candidate) =>
      worst === null || candidate.deviationDeg > worst.deviationDeg ? candidate : worst,
    null,
  );

  if (allTipsContinue && weakest !== null) {
    const attributeBreak = continuities.some((c) => c.attributeBreak);
    return {
      topology: { kind: 'THROUGH', continuity: { ...weakest, attributeBreak } },
      // A through verdict cannot be overturned by looking further: a wider
      // fetch only ever adds road, and more road cannot close a street that
      // was already open.
      terminalNodeInterior: true,
      resolvedWithinM,
    };
  }

  return {
    topology: {
      kind: 'DEAD_END',
      turnaround: UNMEASURED_TURNAROUND,
      entryDirection: readEntryDirection(way, input),
    },
    terminalNodeInterior: allTipsProvenInterior(tipIds, nodeById, neighbourhood),
    resolvedWithinM,
  };
}

/**
 * The first and last node of the way, and nothing between them.
 *
 * Every interior vertex of a way is referenced by exactly that one way, so it
 * is degree-1 by construction. Iterating all of `nodeIds` is what turned the
 * through street at Plougoumelen (BUG-048a) into a cul-de-sac: its own shape
 * point, 0.3 m from the door, read as a tip.
 */
function terminalNodeIds(way: RoadWay): readonly string[] {
  const first = way.nodeIds[0];
  const last = way.nodeIds[way.nodeIds.length - 1];
  if (first === undefined || last === undefined) return [];
  return first === last ? [first] : [first, last];
}

function indexNodes(nodes: readonly RoadNode[]): ReadonlyMap<string, RoadNode> {
  const byId = new Map<string, RoadNode>();
  for (const node of nodes) byId.set(node.id, node);
  return byId;
}

/**
 * Whether a node is inside the fetch deeply enough that a wider fetch could not
 * change what we know about it.
 *
 * There is no tuned fraction here, and there should not be one: the port
 * promises that a neighbourhood of radius R contains every way touching any
 * point inside R. A node strictly inside R therefore has its full way
 * membership in the payload — one way means one way, not "one way that we
 * happened to download". A node at or beyond the edge carries no such promise.
 *
 * The Auxerre spur tip sits 46.5 m out in a 50 m fetch. Under the old 0.7 ratio
 * it fell in the blind ring between 35 m and 50 m and the dead end vanished.
 * Under this rule it is interior, and the spur is a dead end.
 *
 * A false result means "ask for a bigger neighbourhood". It does not mean
 * "not a dead end".
 */
function isProvenInterior(
  nodeId: string,
  nodeById: ReadonlyMap<string, RoadNode>,
  neighbourhood: RoadNeighbourhood,
): boolean {
  const node = nodeById.get(nodeId);
  if (node === undefined) return false;
  return haversineM(neighbourhood.centre, node.at) < neighbourhood.radiusM;
}

function allTipsProvenInterior(
  tipIds: readonly string[],
  nodeById: ReadonlyMap<string, RoadNode>,
  neighbourhood: RoadNeighbourhood,
): boolean {
  return tipIds.every((id) => isProvenInterior(id, nodeById, neighbourhood));
}

/** True when the node is beyond what this payload can speak for. */
function beyondView(
  nodeId: string,
  nodeById: ReadonlyMap<string, RoadNode>,
  neighbourhood: RoadNeighbourhood,
): boolean {
  return !isProvenInterior(nodeId, nodeById, neighbourhood);
}

interface GraphEdge {
  readonly to: string;
  /** Identifies the physical segment, so a walk can refuse to step back along it. */
  readonly key: string;
}

function buildAdjacency(ways: readonly RoadWay[]): ReadonlyMap<string, readonly GraphEdge[]> {
  const adjacency = new Map<string, GraphEdge[]>();
  const link = (from: string, to: string, key: string): void => {
    const existing = adjacency.get(from);
    if (existing === undefined) adjacency.set(from, [{ to, key }]);
    else existing.push({ to, key });
  };

  for (const way of ways) {
    for (let i = 0; i < way.nodeIds.length - 1; i += 1) {
      const a = way.nodeIds[i];
      const b = way.nodeIds[i + 1];
      if (a === undefined || b === undefined) continue;
      // A repeated node id is a data artefact, not a segment; walking it would
      // register as a cycle of length one.
      if (a === b) continue;
      const key = `${way.id}#${i}`;
      link(a, b, key);
      link(b, a, key);
    }
  }
  return adjacency;
}

interface Reachable {
  readonly nodeIds: ReadonlySet<string>;
  readonly hasCycle: boolean;
}

/** Undirected walk from `start`, refusing to re-cross the segment it arrived on. */
function reachableFrom(
  adjacency: ReadonlyMap<string, readonly GraphEdge[]>,
  start: string,
): Reachable {
  const seen = new Set<string>([start]);
  const stack: { readonly node: string; readonly viaKey: string | null }[] = [
    { node: start, viaKey: null },
  ];
  let hasCycle = false;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const edge of adjacency.get(current.node) ?? []) {
      if (edge.key === current.viaKey) continue;
      if (seen.has(edge.to)) {
        hasCycle = true;
        continue;
      }
      seen.add(edge.to);
      stack.push({ node: edge.to, viaKey: edge.key });
    }
  }
  return { nodeIds: seen, hasCycle };
}

/**
 * A loop the street ends in, anchored to this street's own tips.
 *
 * Anchoring is the point. The old signal was neighbourhood-wide, so a turning
 * loop belonging to the cul-de-sac next door answered for this one (EC-18's
 * inverse trap), and conversely an untagged loop of ordinary residential ways —
 * the common mapping reality — was invisible.
 *
 * Three admissible shapes, in order of how much they assert:
 *  1. the delivery way is itself a closed ring;
 *  2. a way tagged `junction=turning_loop` meets one of its tips — the mapper
 *     is asserting the shape, and we take the assertion but not a size;
 *  3. from a tip, over ways other than the delivery way, there is a cycle whose
 *     whole component stays inside the fetch. The containment clause is what
 *     separates a turning bulb from the road network at the mouth: a component
 *     that runs off the edge of the payload leads somewhere, and somewhere is
 *     not a turnaround.
 */
function hasTerminalLoop(
  neighbourhood: RoadNeighbourhood,
  way: RoadWay,
  tipIds: readonly string[],
  nodeById: ReadonlyMap<string, RoadNode>,
): boolean {
  if (tipIds.length === 1 && way.nodeIds.length > 2) return true;

  const tipSet = new Set(tipIds);
  // Drivable ways only: a ring of footpaths is a shape a pedestrian enjoys,
  // not a turnaround a lorry can trace.
  const others = neighbourhood.ways.filter(
    (candidate) => candidate.id !== way.id && isDrivableWay(candidate),
  );

  for (const other of others) {
    if (other.tags['junction'] !== 'turning_loop') continue;
    if (other.nodeIds.some((id) => tipSet.has(id))) return true;
  }

  const adjacency = buildAdjacency(others);
  for (const tipId of tipIds) {
    const reachable = reachableFrom(adjacency, tipId);
    if (!reachable.hasCycle) continue;
    const escapes = [...reachable.nodeIds].some((id) =>
      beyondView(id, nodeById, neighbourhood),
    );
    if (!escapes) return true;
  }
  return false;
}

/**
 * The legal direction of travel on the delivery street, as the source declares
 * it, expressed at the stop.
 *
 * Nothing in the old detector looked at this, and it decides a case no
 * turnaround can rescue: a dead end that is one-way inbound cannot be left
 * legally even from a perfect turning circle.
 */
function readEntryDirection(way: RoadWay, input: TerminalInput): Fact<OneWayConstraint> {
  const value: OneWayConstraint =
    way.oneWay === 'no'
      ? { oneWay: false, permittedHeadingDeg: null }
      : { oneWay: true, permittedHeadingDeg: permittedHeadingAt(way, input.deliveryPoint) };

  return {
    known: true,
    value,
    provenance: {
      source: way.source,
      method: ONE_WAY_METHOD,
      // Empty when the caller did not state it: a pure stage may not read a
      // clock, and a fabricated instant would outrank the real one downstream.
      fetchedAt: input.observedAt ?? '',
    },
    reliability: {
      // The source's own field, reproduced without inference. That the source
      // may be wrong is what `basis: 'declared'` says.
      confidence: 1,
      basis: 'declared',
      reasonCodes: [way.oneWay === 'no' ? 'two_way_declared' : 'one_way_declared'],
    },
  };
}

/**
 * Heading permitted at the stop, read off the segment the stop projects onto
 * rather than off the whole way: a curving street has no single direction.
 */
function permittedHeadingAt(way: RoadWay, deliveryPoint: GeoPoint): number | null {
  const projection = closestPointOnPolyline(way.geometry, deliveryPoint);
  if (projection === null) return null;
  const from = way.geometry[projection.segmentIndex];
  const to = way.geometry[projection.segmentIndex + 1];
  if (from === undefined || to === undefined) return null;

  const alongNodeOrder = bearingDeg(from, to);
  return way.oneWay === 'forward' ? alongNodeOrder : (alongNodeOrder + 180) % 360;
}
