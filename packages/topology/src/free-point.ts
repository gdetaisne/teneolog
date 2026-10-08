/**
 * S1 ter — UN POINT CLIQUÉ SUR LA CARTE comme point de livraison (
 * tranche 2, contrats la note de conception interne).
 *
 * Après un « Non » sur le demi-tour, l'opérateur peut livrer depuis l'arrêt de
 * repli du moteur, ou cliquer n'importe où (principe 39, complété le
 * 2026-09-24 au soir). Ce module mesure ce clic comme le moteur mesure l'arrêt
 * de repli (principe 10) : le camion s'arrête sur la chaussée la plus proche
 * du clic, et la distance jusqu'à la porte se compte À PIED, LE LONG DE LA
 * CHAUSSÉE — jamais à vol d'oiseau (Sèvremoine : la Rue Voisine MA à 108 m à
 * vol d'oiseau, la bonne réponse était la marche).
 *
 * Trois lectures qui existent déjà, et aucune de plus (principe 23) :
 *  - la chaussée : `isCarriageway` (handoff.ts), le vocabulaire de la bouche ;
 *  - la distance par la route : `computeRoadReach` (reach.ts), qui part de la
 *    projection de la porte sur sa rue — SANS bouche : le point cliqué peut
 *    être n'importe où, dans l'impasse ou dehors ;
 *  - le dernier tronçon, porte → axe, et les deux bandes : ceux de l'arrêt de
 *    repli (`doorToAxisM`, `walkBandOf`, fallback-stop.ts).
 *
 * Quatre réponses, et trois ne sont pas des mesures (principe 14) :
 *  - `out_of_area` — plus loin de la porte que le voisinage qu'on lit autour
 *    d'elle (`freePointRadiusM`) : rien n'y serait mesurable ;
 *  - `no_street_near_point` — aucune chaussée à moins de `maxSnapM` du clic
 *    (le même seuil que S0 pour accrocher un point à sa rue) ;
 *  - `unreachable` — la chaussée existe, mais aucune route du voisinage lu ne
 *    la relie à la porte : un inconnu dit, jamais une distance inventée ;
 *  - `measured` — la marche et sa bande. Une bande `beyond` reste une mesure :
 *    c'est l'opérateur qui choisit (principe 10), l'écran dit « au-delà de la
 *    limite de portage ».
 *
 * Ce qu'il ne prouve pas : que le camion atteint ce point, ni qu'il y passe —
 * c'est le run que l'opérateur lance depuis le clic (contrat engine BUG-068).
 * Comme `reach.ts`, il ignore sens uniques et barrières sur la marche : c'est
 * un piéton qui porte.
 *
 * Pur : mêmes entrées, même réponse.
 */
import type { FallbackStop, FallbackStopBand, GeoPoint } from '@teneolog/domain';

import { doorToAxisM, stopStreetOf, walkBandOf } from './fallback-stop.js';
import { closestPointOnPolyline, haversineM, polylineLengthM, type ClosestPoint } from './geometry.js';
import { isCarriageway } from './handoff.js';
import type { RoadNeighbourhood, RoadWay } from './ports.js';
import { computeRoadReach, roadDistanceOf, type RoadReach } from './reach.js';

export interface FreePointParams {
  /** Policy `selection.maxSnapM`: how far a point may sit from the street it is hooked to. */
  readonly maxSnapM: number;
  /** Policy `assessment.fallbackStop.freePointRadiusM`: the zone round the door where a click is measured. */
  readonly areaRadiusM: number;
  readonly plainWalkMaxM: number;
  readonly portageWalkMaxM: number;
}

export interface FreePointInput {
  readonly neighbourhood: RoadNeighbourhood;
  /** The delivery street of the origin run — the walk ends on it. */
  readonly deliveryWayId: string;
  /** The door: the origin run's delivery point. */
  readonly deliveryPoint: GeoPoint;
  /** The point clicked on the map, as clicked. */
  readonly point: GeoPoint;
  readonly params: FreePointParams;
}

export type FreePointStatus = 'measured' | 'out_of_area' | 'no_street_near_point' | 'unreachable';

export interface FreePointWalk {
  readonly status: FreePointStatus;
  /** The click projected on the nearest carriageway; null when there is none within the snap. */
  readonly stopAt: GeoPoint | null;
  /** The street that carriageway belongs to, as the fallback stop describes its own. */
  readonly street: FallbackStop['street'] | null;
  /** Metres, unrounded: by road from the stop to the door's projection, then to the door. */
  readonly walk: { readonly roadM: number; readonly pointToAxisM: number; readonly totalM: number } | null;
  readonly band: FallbackStopBand | null;
}

const NONE = { stopAt: null, street: null, walk: null, band: null } as const;

/**
 * The zone test alone, before anything is fetched: a click beyond it costs no
 * network call. Null when the click is inside the zone.
 */
export function freePointOutOfArea(
  door: GeoPoint,
  point: GeoPoint,
  params: Pick<FreePointParams, 'areaRadiusM'>,
): FreePointWalk | null {
  return haversineM(door, point) > params.areaRadiusM ? { status: 'out_of_area', ...NONE } : null;
}

export function measureFreePoint(input: FreePointInput): FreePointWalk {
  const outside = freePointOutOfArea(input.deliveryPoint, input.point, input.params);
  if (outside !== null) return outside;

  const snap = snapToCarriageway(input.neighbourhood, input.point, input.params.maxSnapM);
  if (snap === null) return { status: 'no_street_near_point', ...NONE };

  const placed = { stopAt: snap.at.point, street: stopStreetOf(snap.way) };
  const roadM = roadMetresToDoor(input, snap);
  if (roadM === null) return { status: 'unreachable', ...placed, walk: null, band: null };

  const pointToAxisM = doorToAxisM(input.neighbourhood, input.deliveryWayId, input.deliveryPoint);
  const totalM = roadM + pointToAxisM;
  return {
    status: 'measured',
    ...placed,
    walk: { roadM, pointToAxisM, totalM },
    band: walkBandOf(totalM, input.params),
  };
}

interface Snap {
  readonly way: RoadWay;
  readonly at: ClosestPoint;
}

/** The nearest carriageway to the click, within the snap; the first one drawn on a tie. */
function snapToCarriageway(hood: RoadNeighbourhood, point: GeoPoint, maxSnapM: number): Snap | null {
  let best: Snap | null = null;
  for (const way of hood.ways) {
    if (!isCarriageway(way) || way.geometry.length < 2) continue;
    const at = closestPointOnPolyline(way.geometry, point);
    if (at === null || at.distanceM > maxSnapM) continue;
    if (best === null || at.distanceM < best.at.distanceM) best = { way, at };
  }
  return best;
}

/**
 * Metres by road from the stop to the door's projection on its street.
 *
 * `computeRoadReach` gives the distance from that projection to every node;
 * the stop sits inside a segment of its way, so the walk leaves it by one of
 * the segment's two nodes — the shorter sum wins. On the delivery street
 * itself the stop and the projection may share a segment, where neither node
 * lies between them: the direct run along the street is then the walk. Null
 * when no road of the fetched neighbourhood joins the two — the fetch is the
 * bound, and a distance nobody walked is not a distance.
 */
function roadMetresToDoor(input: FreePointInput, snap: Snap): number | null {
  const { way, at } = snap;
  if (way.nodeIds.length !== way.geometry.length) return null;
  const reach = computeRoadReach({
    neighbourhood: input.neighbourhood,
    deliveryWayId: input.deliveryWayId,
    deliveryPoint: input.deliveryPoint,
    mouth: null,
    maxDistanceM: Number.POSITIVE_INFINITY,
  });
  const segmentStartM = polylineLengthM(way.geometry.slice(0, at.segmentIndex + 1));
  const segmentEndM = polylineLengthM(way.geometry.slice(0, at.segmentIndex + 2));
  const candidates = [
    viaNode(reach, way.nodeIds[at.segmentIndex], at.alongM - segmentStartM),
    viaNode(reach, way.nodeIds[at.segmentIndex + 1], segmentEndM - at.alongM),
    alongDeliveryStreet(input, snap),
  ].filter((m): m is number => m !== null);
  return candidates.length === 0 ? null : Math.min(...candidates);
}

function viaNode(reach: RoadReach, nodeId: string | undefined, stopToNodeM: number): number | null {
  if (nodeId === undefined) return null;
  const nodeM = roadDistanceOf(reach, nodeId);
  return nodeM === null ? null : nodeM + stopToNodeM;
}

/** The straight run along the delivery street, when the stop stands on it. */
function alongDeliveryStreet(input: FreePointInput, snap: Snap): number | null {
  if (snap.way.id !== input.deliveryWayId) return null;
  const door = closestPointOnPolyline(snap.way.geometry, input.deliveryPoint);
  return door === null ? null : Math.abs(snap.at.alongM - door.alongM);
}
