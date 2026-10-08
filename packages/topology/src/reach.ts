/**
 * S1 — Reach by road, from the stop.
 *
 * Two questions the egress search could not answer from a crow-flight radius:
 * how far a place is BY ROAD from the stop, and whether it is reached WITHOUT
 * leaving the impasse — that is, without passing through the mouth.
 *
 * Sèvremoine (run bf60317d): the loop of the next street, 45 m as the
 * crow flies and first in the node list, became the turnaround of an impasse
 * it does not belong to, while the loop at the end of the allée, on a service
 * stub off the allée itself, was there. Neither the radius nor the list order
 * can tell those two apart; the road can.
 *
 * What this module knowingly ignores, so nobody reads more into `inside` than
 * it says: one-way restrictions, barriers and `access=*` — a bollard on the
 * stub leaves its loop `inside`; those are S2's facts, judged elsewhere. And
 * what it depends on: the fetch. A neighbour not connected within the fetched
 * radius stays `unknown`, never `via_mouth`.
 *
 * Pure. Distances are metres along carriageway — the same vocabulary as the
 * mouth walk (`handoff.ts`), so the two never disagree on what a lorry can be
 * on. A node no carriageway reaches from the stop is absent from the result,
 * which is the honest answer for a place one cannot drive to.
 */
import type { EgressReach, GeoPoint } from '@teneolog/domain';

import { closestPointOnPolyline, haversineM } from './geometry.js';
import { isCarriageway } from './handoff.js';
import type { RoadNeighbourhood, RoadWay } from './ports.js';

export interface RoadReach {
  /** Metres by road from the stop, for every node a carriageway reaches. */
  readonly distanceM: ReadonlyMap<string, number>;
  /**
   * Nodes reached without passing through the mouth. Null when no mouth was
   * given or none matched a graph node: nothing can then be called inside or
   * outside.
   */
  readonly insideIds: ReadonlySet<string> | null;
  /**
   * Why every reach would be `unknown`, when it is: the walk was not run at
   * all (`disabled`, a through street), the delivery way was not found or its
   * nodes and geometry disagree (`not_built`), or no mouth node could be
   * blocked (`no_mouth`). Null when the search ran in full. Not published
   * yet: slice 3 puts it on the wire with the candidates.
   */
  readonly why: 'disabled' | 'not_built' | 'no_mouth' | null;
}

export interface RoadReachInput {
  readonly neighbourhood: RoadNeighbourhood;
  readonly deliveryWayId: string;
  readonly deliveryPoint: GeoPoint;
  /** The impasse mouth, when S1 resolved one. Null: no pruning. */
  readonly mouth: GeoPoint | null;
  /**
   * Beyond this by road, nothing is walked. A bound on the search, not a
   * verdict: the caller sets it from the radius it reports candidates within.
   */
  readonly maxDistanceM: number;
}

/**
 * The mouth is a node of the graph — `resolveHandoff` returns a node
 * position — so this snap only absorbs floating-point error between the two
 * readings of the same coordinate. Not a tunable: a real tolerance here would
 * let a node near the mouth pass for it.
 */
const MOUTH_SNAP_M = 2;

const NOT_BUILT: RoadReach = { distanceM: new Map(), insideIds: null, why: 'not_built' };

export function computeRoadReach(input: RoadReachInput): RoadReach {
  const delivery = input.neighbourhood.ways.find((w) => w.id === input.deliveryWayId);
  if (delivery === undefined || delivery.geometry.length < 2) return NOT_BUILT;
  if (delivery.nodeIds.length !== delivery.geometry.length) return NOT_BUILT;

  const projection = closestPointOnPolyline(delivery.geometry, input.deliveryPoint);
  if (projection === null) return NOT_BUILT;

  const graph = buildGraph(input.neighbourhood.ways.filter(isCarriageway));
  const seeds = seedDistances(delivery, projection.alongM);
  const distanceM = dijkstra(graph, seeds, null, input.maxDistanceM);

  const mouthId = input.mouth === null ? null : mouthNodeId(input.neighbourhood, graph, input.mouth);
  if (mouthId === null) return { distanceM, insideIds: null, why: 'no_mouth' };

  // Seeds only on the stop's side of the mouth: a delivery way that is not
  // split at the junction carries on past the mouth, and its far nodes would
  // otherwise be reached without ever crossing the blocked node.
  const stopSide = seedsOnStopSide(delivery, seeds, mouthId, projection.segmentIndex);
  const inside = dijkstra(graph, stopSide, mouthId, input.maxDistanceM);
  return { distanceM, insideIds: new Set(inside.keys()), why: null };
}

/** What the search says about one node. */
export function reachOf(reach: RoadReach, nodeId: string): EgressReach {
  if (!reach.distanceM.has(nodeId)) return 'unknown';
  if (reach.insideIds === null) return 'unknown';
  return reach.insideIds.has(nodeId) ? 'inside' : 'via_mouth';
}

/** Metres by road from the stop to this node, or null when no road reaches it. */
export function roadDistanceOf(reach: RoadReach, nodeId: string): number | null {
  return reach.distanceM.get(nodeId) ?? null;
}

// ---------------------------------------------------------------------------

interface Edge {
  readonly to: string;
  readonly lengthM: number;
}

type Graph = ReadonlyMap<string, readonly Edge[]>;

/**
 * Distance from the stop to every node of the delivery way, along the way.
 *
 * Nodes before the projection are reached by walking back, nodes after it by
 * walking on. Every node of the way is a seed, so the walk can leave the way
 * at any junction it carries.
 */
function seedDistances(way: RoadWay, stopAlongM: number): Map<string, number> {
  const seeds = new Map<string, number>();
  let alongM = 0;
  for (let i = 0; i < way.geometry.length; i += 1) {
    const nodeId = way.nodeIds[i];
    if (nodeId === undefined) continue;
    if (i > 0) {
      const previous = way.geometry[i - 1];
      const current = way.geometry[i];
      if (previous !== undefined && current !== undefined) alongM += haversineM(previous, current);
    }
    const d = Math.abs(alongM - stopAlongM);
    const held = seeds.get(nodeId);
    if (held === undefined || d < held) seeds.set(nodeId, d);
  }
  return seeds;
}

/**
 * The seeds that lie on the stop's side of the mouth, the mouth included.
 *
 * When the mouth is not a node of the delivery way (a nested dead end: the
 * mouth is on the parent street), every seed is on the stop's side.
 */
function seedsOnStopSide(
  way: RoadWay,
  seeds: ReadonlyMap<string, number>,
  mouthId: string,
  stopSegmentIndex: number,
): Map<string, number> {
  const mouthIndex = way.nodeIds.indexOf(mouthId);
  if (mouthIndex < 0) return new Map(seeds);
  const keep = (i: number): boolean =>
    mouthIndex <= stopSegmentIndex ? i >= mouthIndex : i <= mouthIndex;
  const kept = new Map<string, number>();
  way.nodeIds.forEach((nodeId, i) => {
    const d = seeds.get(nodeId);
    if (d !== undefined && keep(i)) kept.set(nodeId, d);
  });
  return kept;
}

function buildGraph(ways: readonly RoadWay[]): Graph {
  const graph = new Map<string, Edge[]>();
  const link = (from: string, to: string, lengthM: number): void => {
    const edges = graph.get(from);
    if (edges === undefined) graph.set(from, [{ to, lengthM }]);
    else edges.push({ to, lengthM });
  };
  for (const way of ways) {
    for (let i = 0; i < way.nodeIds.length - 1; i += 1) {
      const a = way.nodeIds[i];
      const b = way.nodeIds[i + 1];
      const pa = way.geometry[i];
      const pb = way.geometry[i + 1];
      if (a === undefined || b === undefined || pa === undefined || pb === undefined) continue;
      if (a === b) continue;
      const lengthM = haversineM(pa, pb);
      link(a, b, lengthM);
      link(b, a, lengthM);
    }
  }
  return graph;
}

/**
 * Shortest road distance from the seeds to every reachable node within the
 * bound.
 *
 * `blocked` is a node the walk may reach but never expand from: with the
 * mouth blocked, what remains reachable is the impasse itself. Neighbourhoods
 * hold a few hundred nodes — up to two thousand at the 320 m rung in a dense
 * town — and the bound keeps the linear scan for the next node cheap; it is
 * still simpler than a heap and impossible to get wrong.
 */
function dijkstra(
  graph: Graph,
  seeds: ReadonlyMap<string, number>,
  blocked: string | null,
  maxDistanceM: number,
): Map<string, number> {
  const best = new Map<string, number>(seeds);
  const settled = new Set<string>();
  for (;;) {
    let current: string | null = null;
    let currentM = Number.POSITIVE_INFINITY;
    for (const [id, d] of best) {
      if (!settled.has(id) && d < currentM) {
        current = id;
        currentM = d;
      }
    }
    if (current === null || currentM > maxDistanceM) return withinBound(best, maxDistanceM);
    settled.add(current);
    if (current === blocked) continue;
    for (const edge of graph.get(current) ?? []) {
      const candidate = currentM + edge.lengthM;
      const held = best.get(edge.to);
      if (held === undefined || candidate < held) best.set(edge.to, candidate);
    }
  }
}

/**
 * Only what was settled within the bound: a node relaxed from the last
 * settled one may sit beyond it, and a distance nobody walked is not a
 * distance.
 */
function withinBound(best: ReadonlyMap<string, number>, maxDistanceM: number): Map<string, number> {
  const kept = new Map<string, number>();
  for (const [id, d] of best) if (d <= maxDistanceM) kept.set(id, d);
  return kept;
}

/** The graph node at the mouth position, or null when none sits there. */
function mouthNodeId(neighbourhood: RoadNeighbourhood, graph: Graph, mouth: GeoPoint): string | null {
  let bestId: string | null = null;
  let bestM = MOUTH_SNAP_M;
  for (const node of neighbourhood.nodes) {
    if (!graph.has(node.id)) continue;
    const d = haversineM(node.at, mouth);
    if (d < bestM) {
      bestId = node.id;
      bestM = d;
    }
  }
  return bestId;
}
