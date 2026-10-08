/**
 * S1 — the assembled topology assessment.
 *
 * Composes the pure modules into the domain's `TopologyAssessment`:
 * terminal shape, measured turnaround, handoff mouth, egress candidates,
 * physical barriers. One function, no I/O; the caller fetched the
 * neighbourhood, this stage reads it.
 *
 * The composition rule that matters: `classifyTerminal` names the shape with
 * an UNMEASURED turnaround, and this assembler is the one place the
 * measurement is injected. A terminal shape can therefore never skip its
 * sizing — the engine's `loop: true, circleDiameterM: null` had no equivalent
 * of this seam, which is why one OSM tag could wave every truck through.
 */
import type {
  EgressCandidate,
  Fact,
  GeoPoint,
  ImpasseGeometry,
  PhysicalBarrier,
  ReversingPath,
  TerminalTopology,
  TopologyAssessment,
  Turnaround,
} from '@teneolog/domain';

import { classifyTerminal } from './dead-end.js';
import { findEgressCandidates, nodeIdOfCandidate, rankedMappedNodes } from './egress-candidates.js';
import { computeFallbackStop, type FallbackStopParams } from './fallback-stop.js';
import { closestPointOnPolyline, haversineM } from './geometry.js';
import { resolveHandoffWalk, type HandoffWalk } from './handoff.js';
import { computeImpasseGeometry, type ImpasseGeometryParams } from './impasse-geometry.js';
import type { RoadNeighbourhood, RoadNode, RoadWay, Surface } from './ports.js';
import { computeReversing, handoffPathOf, type ReversingParams } from './reversing.js';
import { measureTurnaround, type TurnaroundMeasurementOptions } from './turnaround.js';

export interface TopologyAssessmentInput {
  readonly neighbourhood: RoadNeighbourhood;
  readonly surfaces: readonly Surface[];
  readonly deliveryWayId: string;
  readonly deliveryPoint: GeoPoint;
  /** Policy: how far from the stop a turnaround candidate may be sought. */
  readonly turnaroundSearchRadiusM: number;
  /** Policy: depth limit when re-anchoring through nested dead-ends. */
  readonly maxMouthDepth: number;
  /** Same-carriageway chaining threshold for the handoff walk. */
  readonly maxDeviationDeg: number;
  /** A barrier node further than this from the delivery axis is not on it. */
  readonly barrierSnapM: number;
  readonly measurement: TurnaroundMeasurementOptions;
  /**
   * the walking bands and stop offset of the fallback stop. Absent,
   * no fallback stop is computed and the assessment carries none: a fixture
   * or a caller from before the field reads exactly as it did.
   */
  readonly fallbackStop?: FallbackStopParams;
  /**
   * the display threshold of the reversing path. Absent, no
   * reversing path is computed and the assessment carries none, as for
   * `fallbackStop`.
   */
  readonly reversing?: ReversingParams;
  /**
   * how far along the axis the turnaround map lists branches.
   * Absent, no geometry is computed and the assessment carries none, as for
   * `reversing`.
   */
  readonly impasseGeometry?: ImpasseGeometryParams;
}

export function assessTopology(input: TopologyAssessmentInput): TopologyAssessment {
  const classified = classifyTerminal({
    neighbourhood: input.neighbourhood,
    deliveryWayId: input.deliveryWayId,
    deliveryPoint: input.deliveryPoint,
    // the entry-direction fact shipped with `fetchedAt: ''` because
    // this instant was never forwarded — every fact of the assessment is
    // dated by the same acquisition.
    observedAt: input.measurement.observedAt,
  });

  const deliveryWay = input.neighbourhood.ways.find((w) => w.id === input.deliveryWayId);

  // The mouth first, then the candidates, then the retained turnaround — in
  // that order because each reads the one before: the mouth is what tells a
  // place of this impasse from a place of the next street, and the
  // retained place is the first of the candidates, never a second selection.
  const handoffWalk = resolveHandoffWalk({
    neighbourhood: input.neighbourhood,
    deliveryWayId: input.deliveryWayId,
    deliveryPoint: input.deliveryPoint,
    maxDepth: input.maxMouthDepth,
    maxDeviationDeg: input.maxDeviationDeg,
    fetchedAt: input.measurement.observedAt,
  });
  const handoff = handoffWalk.mouth;
  const egressCandidates = findEgressCandidates({
    neighbourhood: input.neighbourhood,
    surfaces: input.surfaces,
    deliveryWayId: input.deliveryWayId,
    deliveryPoint: input.deliveryPoint,
    searchRadiusM: input.turnaroundSearchRadiusM,
    measurement: input.measurement,
    mouth: handoff.known ? handoff.value.point : null,
    reachEnabled: classified.topology.kind !== 'THROUGH',
  });

  // the street before the impasse, read from the same mouth: an
  // answer computed for every terminal shape, proposed by the wire, chosen by
  // the operator, never taken here (principe 10).
  const fallbackStop =
    input.fallbackStop === undefined
      ? undefined
      : computeFallbackStop({
          neighbourhood: input.neighbourhood,
          deliveryWayId: input.deliveryWayId,
          deliveryPoint: input.deliveryPoint,
          topologyKind: classified.topology.kind,
          handoff,
          // the walk's line, on the chain the mouth was measured along.
          handoffPath: handoffPathOf(handoffWalk),
          params: input.fallbackStop,
          // Read along the walked path only, and never a node of the impasse
          // itself: a bollard at its entrance is the impasse's, not the
          // parent street's.
          barriersAlong: (path) => barriersAlongLine(path, NO_NODES, input, deliveryWay ?? null),
          fetchedAt: input.measurement.observedAt,
        });

  return {
    topology: withMeasuredTurnaround(classified.topology, deliveryWay, input, egressCandidates),
    barriers: deliveryWay === undefined ? [] : barriersOnWay(deliveryWay, input),
    handoff,
    egressCandidates,
    ...(fallbackStop === undefined ? {} : { fallbackStop }),
    ...reversingField(input, classified.topology.kind, handoffWalk),
    ...impasseGeometryField(input, classified.topology.kind, handoffWalk),
    resolvedWithinM: classified.resolvedWithinM,
    terminalNodeInterior: classified.terminalNodeInterior,
  };
}

/**
 * the reversing path, measured along the very chain the mouth was
 * measured on (`reversing.ts`). No field at all without the policy block: an
 * assessment from before it reads exactly as it did (principe 17).
 */
function reversingField(
  input: TopologyAssessmentInput,
  topologyKind: TerminalTopology['kind'],
  handoff: HandoffWalk,
): { readonly reversing?: Fact<ReversingPath> } {
  if (input.reversing === undefined) return {};
  return {
    reversing: computeReversing({
      neighbourhood: input.neighbourhood,
      topologyKind,
      handoff,
      params: input.reversing,
      fetchedAt: input.measurement.observedAt,
    }),
  };
}

/**
 * the geometry the turnaround map draws, read from the very walk
 * the mouth was measured on (`impasse-geometry.ts`). No field at all without
 * the policy block, as for `reversing` (principe 17).
 */
function impasseGeometryField(
  input: TopologyAssessmentInput,
  topologyKind: TerminalTopology['kind'],
  handoff: HandoffWalk,
): { readonly impasseGeometry?: Fact<ImpasseGeometry> } {
  if (input.impasseGeometry === undefined) return {};
  return {
    impasseGeometry: computeImpasseGeometry({
      neighbourhood: input.neighbourhood,
      topologyKind,
      handoff,
      params: input.impasseGeometry,
      fetchedAt: input.measurement.observedAt,
    }),
  };
}

/**
 * Injects the best available measurement into a terminal shape.
 *
 * Source preference is evidence strength, not convenience: a ring or a
 * dimensioned circle is real geometry; the carriageway width is the floor —
 * the reversal on the road itself, which always exists as a question even
 * when nothing else does. When even that cannot be measured, the unknown from
 * `classifyTerminal` stands, and the domain forces every consumer to face it.
 */
function withMeasuredTurnaround(
  topology: TerminalTopology,
  deliveryWay: RoadWay | undefined,
  input: TopologyAssessmentInput,
  candidates: Fact<readonly EgressCandidate[]>,
): TerminalTopology {
  if (topology.kind === 'THROUGH') return topology;
  if (deliveryWay === undefined) return topology;

  const measured = measureBestTurnaround(topology.kind, deliveryWay, input, candidates);
  if (!measured.known && topology.turnaround.known) return topology;
  return { ...topology, turnaround: measured };
}

function measureBestTurnaround(
  kind: 'DEAD_END' | 'TERMINAL_LOOP',
  deliveryWay: RoadWay,
  input: TopologyAssessmentInput,
  candidates: Fact<readonly EgressCandidate[]>,
): Fact<Turnaround> {
  // A named place beats a ring, a ring beats the carriageway at the stop: the
  // order is evidence strength. Each reading answers null when it has nothing
  // to say, and the next one speaks.
  return (
    measureMappedPlace(candidates, input) ??
    (kind === 'TERMINAL_LOOP' ? measureTerminalRing(deliveryWay, input) : null) ??
    measureTurnaround(
      // The floor: reversing on the carriageway at the stop. Its diameter is
      // the road's width — usually a rejection for anything large, reached as
      // a measurement instead of as a silently proposed route (BUG-001).
      { kind: 'carriageway', way: deliveryWay, at: input.deliveryPoint },
      input.measurement,
    )
  );
}

/**
 * The mapper-named place (circle or loop), when one is near — Sèvremoine
 *: the loop is on a service stub, not at the tip.
 *
 * The places are the candidates' own ranking (`rankedMappedNodes`), so the
 * point and the judgement name the same node. A mapped node nearby that this
 * impasse does NOT reach measures nothing — its tags are never read — and, as
 * before the road was read, it still ends the search: what the ring or the
 * carriageway would say once such a node is set aside is slice 2, behind an
 * A/B (principe 17), not a change smuggled in with the reach. Null when no
 * mapped node is near at all.
 */
function measureMappedPlace(
  candidates: Fact<readonly EgressCandidate[]>,
  input: TopologyAssessmentInput,
): Fact<Turnaround> | null {
  const nearby = candidates.known ? candidates.value.filter((c) => nodeIdOfCandidate(c) !== null) : [];
  const reachable = mappedNodesOf(rankedMappedNodes(nearby), input.neighbourhood);
  for (const node of reachable) {
    const fact = measureTurnaround({ kind: 'turning_circle_node', node }, input.measurement);
    if (fact.known) return fact;
  }
  const first = reachable[0];
  if (first !== undefined) {
    return measureTurnaround({ kind: 'turning_circle_node', node: first }, input.measurement);
  }
  if (nearby.length === 0) return null;
  // Only the next street's places are near: their tags are not read — a
  // diameter someone typed on the loop of the Allée Voisine JC says nothing
  // about the Allée des Essais — and, as before, nothing else is read
  // either. Unknown, said as such.
  return {
    known: false,
    why: 'no_data',
    provenance: {
      source: 'osm-overpass',
      method: 'turnaround-mapped-only-via-mouth',
      fetchedAt: input.measurement.observedAt,
    },
  };
}

/** The ring of a terminal loop: the delivery way itself when closed, else a loop way at a tip. */
function measureTerminalRing(deliveryWay: RoadWay, input: TopologyAssessmentInput): Fact<Turnaround> | null {
  const ringFacts: Fact<Turnaround>[] = [];
  if (isRing(deliveryWay)) {
    ringFacts.push(measureTurnaround({ kind: 'loop_way', way: deliveryWay }, input.measurement));
  }
  const tipIds = new Set(tipNodes(deliveryWay, input.neighbourhood).map((t) => t.id));
  for (const way of input.neighbourhood.ways) {
    if (way.id === deliveryWay.id) continue;
    if (!way.nodeIds.some((id) => tipIds.has(id))) continue;
    if (way.tags['junction'] !== 'turning_loop' && !isRing(way)) continue;
    ringFacts.push(measureTurnaround({ kind: 'loop_way', way }, input.measurement));
  }
  return ringFacts.find((f) => f.known) ?? null;
}

/** The survey nodes behind mapped candidates, in the candidates' order. */
function mappedNodesOf(
  candidates: readonly EgressCandidate[],
  hood: RoadNeighbourhood,
): readonly RoadNode[] {
  const byId = new Map(hood.nodes.map((n) => [n.id, n]));
  const out: RoadNode[] = [];
  for (const candidate of candidates) {
    const id = nodeIdOfCandidate(candidate);
    const node = id === null ? undefined : byId.get(id);
    if (node !== undefined) out.push(node);
  }
  return out;
}

/**
 * A7 — physical closure read from the survey tags.
 *
 * The engine never read `barrier=*` onto the graph at all: bollards and gates
 * existed only inside vision prompts, so a topologically through street that
 * is physically shut read as open — worse than a false dead end, because the
 * truck arrives and the report said it would pass.
 *
 * tranche 2 — exported for the street a point clicked on the map
 * stands on: what S1 would say of that street if a run were started there,
 * which is exactly the run the operator launches from the click.
 */
export function barriersOnWay(way: RoadWay, reading: BarrierReading): readonly Fact<PhysicalBarrier>[] {
  return barriersAlongLine(way.geometry, new Set(way.nodeIds), reading, null);
}

/** What a barrier reading needs of the assessment input — and nothing else. */
export type BarrierReading = Pick<TopologyAssessmentInput, 'neighbourhood' | 'barrierSnapM'> & {
  readonly measurement: { readonly observedAt: string };
};

const NO_NODES: ReadonlySet<string> = new Set();

/** True when the node belongs to `way` or stands within the snap of its axis. */
function attachedTo(node: RoadNode, way: RoadWay, snapM: number): boolean {
  return (
    way.nodeIds.includes(node.id) ||
    (closestPointOnPolyline(way.geometry, node.at)?.distanceM ?? Infinity) <= snapM
  );
}

/**
 * The barrier nodes on a line: those named in `onLine`, or within
 * `barrierSnapM` of it. `notOf`, when given, is a way whose own barriers are
 * left out (the fallback stop's path starts at the impasse mouth,
 * and a closure of the impasse must not read as one of the parent street).
 */
function barriersAlongLine(
  line: readonly GeoPoint[],
  onLine: ReadonlySet<string>,
  input: BarrierReading,
  notOf: RoadWay | null,
): readonly Fact<PhysicalBarrier>[] {
  const out: Fact<PhysicalBarrier>[] = [];

  for (const node of input.neighbourhood.nodes) {
    const classified = classifyBarrier(node);
    if (classified === null) continue;
    if (notOf !== null && attachedTo(node, notOf, input.barrierSnapM)) continue;

    const attached =
      onLine.has(node.id) ||
      (closestPointOnPolyline(line, node.at)?.distanceM ?? Infinity) <= input.barrierSnapM;
    if (!attached) continue;

    out.push({
      known: true,
      value: classified.barrier,
      provenance: {
        source: 'osm-overpass',
        method: 'barrier-tag',
        fetchedAt: input.measurement.observedAt,
      },
      reliability: {
        confidence: 1,
        basis: 'declared',
        reasonCodes: [classified.reasonCode],
      },
    });
  }
  return out;
}

interface ClassifiedBarrier {
  readonly barrier: PhysicalBarrier;
  readonly reasonCode: string;
}

/**
 * OSM `barrier=*` vocabulary onto the domain's kinds. Passability is read
 * conservatively: a plain bollard stops a lorry (`no`); anything that opens,
 * lifts or retracts is `conditional`; a gate with no access statement is
 * `unknown`, never assumed open.
 */
function classifyBarrier(node: RoadNode): ClassifiedBarrier | null {
  const tag = node.tags['barrier'];
  if (tag === undefined) return null;

  const build = (
    kind: PhysicalBarrier['kind'],
    passable: PhysicalBarrier['passable'],
  ): ClassifiedBarrier => ({
    barrier: { kind, at: node.at, passable },
    reasonCode: `barrier_${tag}`,
  });

  switch (tag) {
    case 'bollard': {
      const variant = node.tags['bollard'];
      if (variant === 'rising' || variant === 'removable' || variant === 'foldable') {
        return build('retractable_post', 'conditional');
      }
      return build('bollard', 'no');
    }
    case 'gate':
    case 'swing_gate':
    case 'lift_gate': {
      if (node.tags['locked'] === 'yes') return build('gate', 'no');
      const access = node.tags['access'];
      if (access === 'yes' || access === 'permissive' || access === 'delivery') {
        return build('gate', 'conditional');
      }
      return build('gate', 'unknown');
    }
    case 'block':
    case 'jersey_barrier':
      return build('block', 'no');
    case 'height_restrictor':
      return build('height_frame', 'conditional');
    case 'chicane':
    case 'cycle_barrier':
      return build('chicane', 'conditional');
    default:
      // An unrecognised barrier value is still a barrier someone surveyed.
      return build('block', 'unknown');
  }
}

function tipNodes(way: RoadWay, hood: RoadNeighbourhood): readonly RoadNode[] {
  const first = way.nodeIds[0];
  const last = way.nodeIds[way.nodeIds.length - 1];
  const ids = new Set([first, last].filter((id): id is string => id !== undefined));
  return hood.nodes.filter((n) => ids.has(n.id));
}

function isRing(way: RoadWay): boolean {
  return way.nodeIds.length > 2 && way.nodeIds[0] === way.nodeIds[way.nodeIds.length - 1];
}
