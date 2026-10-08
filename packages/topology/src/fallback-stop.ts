/**
 * S1 bis — l'ARRÊT DE REPLI : livrer avant d'entrer dans l'impasse.
 *
 * La règle, telle que le responsable produit l'a tranchée (principe 10, complété le
 * 2026-09-24, D3 ) : sur une impasse on ÉTABLIT la rue d'avant —
 * la rue traversante à la bouche — comme un arrêt possible pour le camion,
 * avec la distance À PIED, le long de la voie, de cet arrêt à la porte ; on la
 * PROPOSE en deux bandes (≤ 50 m telle quelle, 50–150 m avec le portage en
 * clair) et on la dit ABSENTE au-delà ; on ne la sélectionne JAMAIS à la place
 * de l'opérateur. Ce module ne fait que le calcul : la proposition est le fil,
 * le choix est l'humain, et le recalcul des itinéraires pour ce nouvel arrêt
 * est un autre run (contrat engine BUG-068, décision produit, 2026-07-09).
 *
 * Ce qu'il lit, et rien d'autre : la bouche que le handoff a nommée (avec sa
 * preuve — une jonction établie, ou une rue parente qui sort seulement du
 * fetch), la voie parente telle qu'elle est dans le voisinage déjà chargé
 * (largeur greffée, sens, classe, barrières), et la distance le long de
 * l'impasse que le handoff porte déjà. Pas un appel réseau, pas de seconde
 * formule pour une distance qui existe (principe 23).
 *
 * Ce qu'il ne prouve pas (principe 14) : que la rue parente est traversante
 * au-delà de ce que le handoff en sait — la confiance et les codes du handoff
 * voyagent tels quels dans la fiabilité du fait ; que le portage suit la route —
 * la marche est mesurée sur l'axe de chaussée, pas sur un trottoir ni un
 * raccourci. L'engine mesurait « le long de l'impasse » depuis la bouche
 * (`distanceAlongPolylineM`, impasse-access.ts) ; ici on ajoute les mètres de
 * l'arrêt à la bouche sur la parente, et l'écart porte → axe.
 *
 * Pur : mêmes entrées, même réponse.
 */
import type {
  Fact,
  FallbackStop,
  FallbackStopBand,
  FallbackWalk,
  GeoPoint,
  Mouth,
  PhysicalBarrier,
  TerminalTopology,
} from '@teneolog/domain';

import { closestPointOnPolyline, haversineM, polylineLengthM, withoutDegenerateSegments } from './geometry.js';
import { isCarriageway } from './handoff.js';
import type { RoadNeighbourhood, RoadNode, RoadWay } from './ports.js';

/** Policy: the two walking bands (principe 10) and where the stop sits on the parent. */
export interface FallbackStopParams {
  /** Up to this walk the stop is proposed as it is (engine, décision produit, 2026-07-07 : 50 m). */
  readonly plainWalkMaxM: number;
  /** Up to this walk the stop is proposed with the portage in clear; beyond, said absent (D3 : 150 m). */
  readonly portageWalkMaxM: number;
  /**
   * How far before the junction, along the parent street, the truck stops —
   * « on évite l'impasse en stationnant x m avant » (décision produit, 2026-09-11). Also what
   * keeps a run pinned there from snapping back onto the impasse at the node.
   */
  readonly stopOffsetM: number;
  /**
   * tranche 2 — how far from the door a point clicked on the map may
   * be measured (`free-point.ts`): the neighbourhood read round the door.
   * Optional in this type because `computeFallbackStop` never reads it; the
   * policy schema requires it.
   */
  readonly freePointRadiusM?: number;
}

export interface FallbackStopInput {
  readonly neighbourhood: RoadNeighbourhood;
  readonly deliveryWayId: string;
  readonly deliveryPoint: GeoPoint;
  readonly topologyKind: TerminalTopology['kind'];
  /** The mouth S1 resolved, with the proof it carries. */
  readonly handoff: Fact<Mouth>;
  /**
   * the chain the mouth was measured along, laid back on the
   * carriageway, door's projection first, mouth last (`handoffPathOf`): the
   * walk's line is drawn on it, never on a second route. Null when it could
   * not be laid back — the walk keeps its metres and loses its line.
   */
  readonly handoffPath: readonly GeoPoint[] | null;
  readonly params: FallbackStopParams;
  /**
   * The barriers S1 reads along a line — the assembler's own reading,
   * injected. Called with the path from the junction to the stop, so only a
   * closure the truck would actually meet counts, never one further up the
   * parent nor one standing in the impasse itself.
   */
  readonly barriersAlong: (path: readonly GeoPoint[]) => readonly Fact<PhysicalBarrier>[];
  readonly fetchedAt: string;
}

export function computeFallbackStop(input: FallbackStopInput): Fact<FallbackStop> {
  // A through street has nothing to fall back from: not applicable, which is
  // not the same answer as « looked for, none » (principe 14).
  if (input.topologyKind === 'THROUGH') return { known: false, why: 'not_applicable' };
  const { handoff } = input;
  if (!handoff.known) return { known: false, why: 'no_data' };

  const parent = input.neighbourhood.ways.find((w) => w.id === handoff.value.parentSegmentId);
  if (parent === undefined || parent.geometry.length < 2) {
    // The mouth names a parent the fetch does not carry as a line: nothing to
    // stand a stop on, and no coordinates to invent.
    return { known: false, why: 'out_of_coverage' };
  }

  const placed = placeStop(input, parent, handoff.value.point);
  if (placed === null) return { known: false, why: 'out_of_coverage' };

  const walk = walkOf(placed, handoff.value, input);
  const value: FallbackStop = {
    stopAt: placed.at,
    mouth: handoff.value.point,
    street: stopStreetOf(parent),
    walk,
    band: walkBandOf(walk.totalM, input.params),
    bandsM: { plainMaxM: input.params.plainWalkMaxM, portageMaxM: input.params.portageWalkMaxM },
    barriers: input.barriersAlong(placed.path),
    depth: handoff.value.depth,
  };
  return {
    known: true,
    value,
    provenance: { source: parent.source, method: 'fallback-stop-at-mouth', fetchedAt: input.fetchedAt },
    // The proof of through-ness is the handoff's, verbatim: a junction proven
    // (confidence 1) or a parent that merely leaves the fetch (0.5,
    // `parent_continuity_beyond_fetch`). Nothing here upgrades it.
    reliability: {
      confidence: handoff.reliability.confidence,
      basis: 'derived',
      reasonCodes: [...handoff.reliability.reasonCodes, 'walk_along_carriageway_axis'],
    },
  };
}

interface PlacedStop {
  readonly at: GeoPoint;
  /** The metres actually walked from the junction — the offset, or less where the street stops first. */
  readonly offsetM: number;
  /** The line walked, junction first, stop last — what the barriers are read along. */
  readonly path: readonly GeoPoint[];
}

/** A street walked in one direction from the junction: the parent, then the ways that carry it on. */
interface Street {
  readonly nodes: ReadonlyMap<string, RoadNode>;
  readonly ways: ReadonlyMap<string, RoadWay>;
  /** Never walked onto: the impasse itself. */
  readonly deliveryWayId: string;
  readonly centre: GeoPoint;
  readonly radiusM: number;
}

/** How many ways the walk may hop through past the parent: a street cut in short OSM pieces, not a route. */
const MAX_HOPS = 3;

/**
 * The stop `offsetM` before the junction, along the street the handoff proved
 * to go through — not along the single OSM way it named. The side is the one
 * where the street CONTINUES (another carriageway carries on at the way's end,
 * or the end leaves the fetch), never the one that ends in a closed tip: a
 * stop in a second pocket would be exactly the impasse again. Where the parent
 * way stops short of the offset, the walk follows the way that carries the
 * street on, up to `MAX_HOPS`; at a fork or a tip it stops there and the walk
 * says the metres actually there.
 */
function placeStop(input: FallbackStopInput, parent: RoadWay, mouth: GeoPoint): PlacedStop | null {
  const junction = closestPointOnPolyline(parent.geometry, mouth);
  if (junction === null) return null;
  const street: Street = {
    nodes: new Map(input.neighbourhood.nodes.map((n) => [n.id, n])),
    ways: new Map(input.neighbourhood.ways.filter(isCarriageway).map((w) => [w.id, w])),
    deliveryWayId: input.deliveryWayId,
    centre: input.neighbourhood.centre,
    radiusM: input.neighbourhood.radiusM,
  };
  const forward = {
    line: [junction.point, ...parent.geometry.slice(junction.segmentIndex + 1)],
    endNodeId: parent.nodeIds[parent.nodeIds.length - 1],
    availableM: polylineLengthM(parent.geometry) - junction.alongM,
  };
  const backward = {
    line: [junction.point, ...parent.geometry.slice(0, junction.segmentIndex + 1).reverse()],
    endNodeId: parent.nodeIds[0],
    availableM: junction.alongM,
  };
  const goesOn = (side: typeof forward) => continues(street, side.endNodeId, parent.id);
  const side =
    goesOn(forward) === goesOn(backward)
      ? forward.availableM >= backward.availableM
        ? forward
        : backward
      : goesOn(forward)
        ? forward
        : backward;

  const path: GeoPoint[] = [junction.point];
  let remaining = advance(path, side.line, input.params.stopOffsetM);
  const walked = new Set([parent.id]);
  let endNodeId = side.endNodeId;
  for (let hop = 0; hop < MAX_HOPS && remaining > 0 && endNodeId !== undefined; hop += 1) {
    const next = continuation(street, endNodeId, walked);
    if (next === null) break;
    remaining = advance(path, next.line, remaining);
    walked.add(next.way.id);
    endNodeId = next.endNodeId;
  }
  const at = path[path.length - 1];
  return at === undefined ? null : { at, offsetM: input.params.stopOffsetM - remaining, path };
}

/**
 * Walks `line` from its first point (already the last point of `path`) for
 * `remainingM` metres, appending to `path`; returns the metres left when the
 * line ended first. The point reached is interpolated inside its segment.
 */
function advance(path: GeoPoint[], line: readonly GeoPoint[], remainingM: number): number {
  let remaining = remainingM;
  for (let i = 0; i < line.length - 1 && remaining > 0; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    if (a === undefined || b === undefined) continue;
    const step = haversineM(a, b);
    if (step <= remaining) {
      path.push(b);
      remaining -= step;
      continue;
    }
    const t = step === 0 ? 0 : remaining / step;
    path.push({ lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) });
    return 0;
  }
  return remaining;
}

/** Other carriageways at a node, the impasse and the ways already walked left out. */
function branchesAt(street: Street, nodeId: string, walked: ReadonlySet<string>): RoadWay[] {
  const node = street.nodes.get(nodeId);
  if (node === undefined) return [];
  const out: RoadWay[] = [];
  for (const id of node.wayIds) {
    const way = street.ways.get(id);
    if (way !== undefined && !walked.has(id) && id !== street.deliveryWayId) out.push(way);
  }
  return out;
}

/**
 * Does the street go on past this end of the way? Yes when another carriageway
 * leaves the node, or when the node lies at or beyond the fetch radius — the
 * same reading of « beyond the fetch » the handoff makes. A lone end inside
 * the fetch is a closed tip.
 */
function continues(street: Street, endNodeId: string | undefined, wayId: string): boolean {
  if (endNodeId === undefined) return false;
  if (branchesAt(street, endNodeId, new Set([wayId])).length > 0) return true;
  const node = street.nodes.get(endNodeId);
  return node !== undefined && haversineM(street.centre, node.at) >= street.radiusM;
}

/** The single way that carries the street on from a node, oriented away from it; null at a tip or a fork. */
function continuation(
  street: Street,
  nodeId: string,
  walked: ReadonlySet<string>,
): { readonly way: RoadWay; readonly line: readonly GeoPoint[]; readonly endNodeId: string | undefined } | null {
  const branches = branchesAt(street, nodeId, walked);
  const way = branches[0];
  if (way === undefined || branches.length !== 1) return null;
  const last = way.nodeIds.length - 1;
  if (way.nodeIds[0] === nodeId) return { way, line: way.geometry, endNodeId: way.nodeIds[last] };
  if (way.nodeIds[last] === nodeId) return { way, line: [...way.geometry].reverse(), endNodeId: way.nodeIds[0] };
  // The street joins this way mid-length: a junction, not a continuation.
  return null;
}

function walkOf(placed: PlacedStop, mouth: Mouth, input: FallbackStopInput): FallbackWalk {
  const stopToMouthM = placed.offsetM;
  const pointToAxisM = doorToAxisM(input.neighbourhood, input.deliveryWayId, input.deliveryPoint);
  const mouthToPointM = mouth.distanceFromStopM;
  return {
    stopToMouthM,
    mouthToPointM,
    pointToAxisM,
    totalM: stopToMouthM + mouthToPointM + pointToAxisM,
    path: walkPathOf(placed, input),
  };
}

/**
 * the walk's line, on exactly what the three legs measured: A, the
 * path the stop was placed along (junction first, so walked back), B, the
 * handoff's chain from the mouth back to the door's projection, C, the door.
 * The same metres, so the line and `totalM` cannot disagree (principe 23).
 */
function walkPathOf(placed: PlacedStop, input: FallbackStopInput): readonly GeoPoint[] | null {
  if (input.handoffPath === null) return null;
  const line = [...placed.path].reverse().concat([...input.handoffPath].reverse(), [input.deliveryPoint]);
  return withoutDegenerateSegments(line);
}

/**
 * The last leg of every walk to the door: from its projection on the axis of
 * the delivery street to the door itself, straight. One reading for the
 * fallback stop and for a point clicked on the map ( tranche 2,
 * principe 23).
 */
export function doorToAxisM(neighbourhood: RoadNeighbourhood, deliveryWayId: string, door: GeoPoint): number {
  const deliveryWay = neighbourhood.ways.find((w) => w.id === deliveryWayId);
  return deliveryWay === undefined ? 0 : (closestPointOnPolyline(deliveryWay.geometry, door)?.distanceM ?? 0);
}

/** The two walking bands of principe 10 — the fallback stop's and a clicked point's alike. */
export function walkBandOf(
  totalM: number,
  params: Pick<FallbackStopParams, 'plainWalkMaxM' | 'portageWalkMaxM'>,
): FallbackStopBand {
  if (totalM <= params.plainWalkMaxM) return 'plain';
  if (totalM <= params.portageWalkMaxM) return 'portage';
  return 'beyond';
}

/** How the wire describes the street a stop stands on — the fallback stop's and a clicked point's alike. */
export function stopStreetOf(way: RoadWay): FallbackStop['street'] {
  return {
    segmentId: way.id,
    name: way.name,
    highway: way.tags['highway'] ?? null,
    declaredWidthM: way.declaredWidthM,
    laneCount: way.laneCount,
    oneWay: way.oneWay !== 'no',
    isPrivate: way.isPrivate,
    importance: way.importance,
  };
}

