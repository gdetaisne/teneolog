/**
 * S4 — is this manoeuvre a JUNCTION TURN or a CURVE?
 *
 * The distinction is the oldest one the engine made (juin 2026,
 * `itinerary-scoring-redesign` §2) and the one this app had lost: a driver
 * does not experience a corner at a crossroads and a bend in the road the same
 * way, and neither does a lorry. A junction turn is a pivot — the vehicle
 * swings through a fixed angle and its rear cuts inside; a curve is steered
 * through, and only its RADIUS and the width available decide anything.
 *
 * Two conditions, and both are needed:
 *
 *  1. **The apex sits on a node where corridor ways meet** — a vertex shared by
 *     at least two ways of the corridor, within `nodeSnapM`. That is June's
 *     rule ("apex at a node of degree ≥ 3, or way change"), read against OSM.
 *  2. **The deflection happens AT that node.** June ran on BD TOPO `cleabs`
 *     changes, where an apex was by construction the routed corner. OSM's
 *     corridor is dense — a bend that merely PASSES a side street has a shared
 *     node within a couple of metres too (Thairé: Rue Voisine 18 sweeping past
 *     Rue Voisine 29, a node 5 m off the apex). Condition 1 alone
 *     therefore calls half the bends in a village "carrefour". So the apex must
 *     also carry the manoeuvre: the heading change read ±`bearingOffsetM`
 *     around the apex must be at least `apexShare` of the whole manoeuvre's net
 *     deflection.
 *
 * Measured on the jury's three legs (2026-09-12): the three real
 * corners score 1.00, 1.00, 1.00; the six bends score 0.47 to 0.71. The
 * threshold sits in the gap, not on a value.
 */
import type { GeoPoint } from '@teneolog/domain';
import { haversineM, type RoadWay } from '@teneolog/topology';

export interface JunctionTestParams {
  /** A shared corridor vertex this close to the apex is the apex's node. */
  readonly nodeSnapM: number;
  /**
   * Fraction of the manoeuvre's net deflection that must happen at the apex
   * itself for the manoeuvre to be a junction turn rather than a curve.
   */
  readonly apexShare: number;
}

/**
 * Corridor vertices shared by two or more ways — the graph's real junctions,
 * built once per candidate rather than per turn.
 *
 * A way's `nodeIds` runs parallel to its `geometry`, so the node id gives the
 * identity and the vertex gives the position; nothing else has to be fetched.
 */
export function junctionNodes(corridor: readonly RoadWay[]): readonly GeoPoint[] {
  const waysPerNode = new Map<string, { readonly at: GeoPoint; ways: Set<string> }>();
  for (const way of corridor) {
    way.nodeIds.forEach((nodeId, index) => {
      const at = way.geometry[index];
      if (at === undefined) return;
      const entry = waysPerNode.get(nodeId);
      if (entry === undefined) waysPerNode.set(nodeId, { at, ways: new Set([way.id]) });
      else entry.ways.add(way.id);
    });
  }
  const out: GeoPoint[] = [];
  for (const entry of waysPerNode.values()) {
    if (entry.ways.size >= 2) out.push(entry.at);
  }
  return out;
}

/** True when the apex is a corridor junction AND carries the manoeuvre. */
export function isJunctionApex(
  apex: GeoPoint,
  apexDeflectionDeg: number,
  netDeflectionDeg: number,
  nodes: readonly GeoPoint[],
  params: JunctionTestParams,
): boolean {
  const net = Math.abs(netDeflectionDeg);
  if (net < 1) return false;
  if (Math.abs(apexDeflectionDeg) / net < params.apexShare) return false;
  return nodes.some((node) => haversineM(node, apex) <= params.nodeSnapM);
}
