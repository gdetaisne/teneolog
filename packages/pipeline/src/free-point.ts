/**
 * S1 ter + S2 ter — UN POINT CLIQUÉ SUR LA CARTE, mesuré et contrôlé comme
 * l'arrêt de repli ( tranche 2, contrats §3).
 *
 * Le calcul pur est `measureFreePoint` (topology) ; ce module fait ce qu'il ne
 * peut pas faire seul : lire le voisinage autour de la porte, retrouver la rue
 * de livraison quand le run d'origine ne l'a plus en mémoire, et assembler les
 * contraintes du camion à l'arrêt — avec la MÊME assemblée que l'arrêt de
 * repli (`constraintsAtStop`, principe 23) et les barrières que S1 lirait sur
 * cette rue si un run y démarrait (`barriersOnWay`).
 *
 * Le voisinage : le plus petit barreau de `fetchLadderM` qui couvre la zone
 * cliquable, centré sur la porte. Il ne partage le cache disque Overpass avec
 * S0 que si S0 est monté jusqu'à ce barreau ; S0 s'arrête souvent plus tôt (80
 * ou 160 m, dès que la forme est prouvée), et alors le PREMIER aperçu d'un run
 * paie une requête Overpass et une BD TOPO — les suivants sont en cache (même
 * centre, même rayon). Un clic hors de la zone ne coûte aucun appel.
 *
 * La rue de livraison : celle que S0 a retenue (run vivant, ou fichier depuis
 * t2). Seul un fichier d'avant le champ la rechoisit ici, sur ce
 * barreau — une lecture qui peut différer de celle de S0 quand deux rues se
 * départagent par leur bout (`dead_end_spur`), dite ici plutôt que cachée.
 */
import type { GeoPoint, StopConstraints } from '@teneolog/domain';
import {
  barriersOnWay,
  freePointOutOfArea,
  measureFreePoint,
  selectDeliveryStreet,
  type FreePointParams,
  type FreePointWalk,
  type RoadNeighbourhood,
} from '@teneolog/topology';

import type { PipelineParams, PipelinePorts } from './analyse.js';
import { constraintsAtStop } from './fallback-stop.js';

export interface FreePointRequest {
  /** The door: the origin run's delivery point. */
  readonly door: GeoPoint;
  /**
   * The origin run's delivery street, when its facts are still in memory.
   * Null for a run reopened from disk: the street is then chosen again, by the
   * same selection as S0, on the neighbourhood read here — one source.
   */
  readonly deliveryWayId: string | null;
  readonly point: GeoPoint;
}

export interface FreePointFacts {
  readonly place: FreePointWalk;
  /** S2 at the stop — only for a measured point; null otherwise. */
  readonly stop: StopConstraints | null;
}

/**
 * The policy numbers of a click: the snap of S0, the zone and the two bands of
 * the fallback stop. Null when the policy carries no fallback block or no zone
 * — the caller says so; it never measures against a zone nobody set.
 */
export function freePointParamsOf(params: PipelineParams): FreePointParams | null {
  const fallback = params.assessment.fallbackStop;
  if (fallback?.freePointRadiusM === undefined) return null;
  return {
    maxSnapM: params.selection.maxSnapM,
    areaRadiusM: fallback.freePointRadiusM,
    plainWalkMaxM: fallback.plainWalkMaxM,
    portageWalkMaxM: fallback.portageWalkMaxM,
  };
}

export async function freePointFacts(
  request: FreePointRequest,
  settings: FreePointParams,
  ports: PipelinePorts,
  params: PipelineParams,
  fetchedAt: string,
): Promise<FreePointFacts> {
  const outside = freePointOutOfArea(request.door, request.point, settings);
  if (outside !== null) return { place: outside, stop: null };

  const neighbourhood = await ports.graph.fetchNeighbourhood(request.door, rungFor(settings.areaRadiusM, params));
  const deliveryWayId = request.deliveryWayId ?? streetAt(request.door, neighbourhood, params, fetchedAt);
  const place = measureFreePoint({
    neighbourhood,
    // No street under the door: nothing to walk to, and `computeRoadReach`
    // answers `not_built` — the click reads `unreachable`, never a distance.
    deliveryWayId: deliveryWayId ?? '',
    deliveryPoint: request.door,
    point: request.point,
    params: settings,
  });
  const way = neighbourhood.ways.find((w) => w.id === place.street?.segmentId);
  if (place.status !== 'measured' || place.stopAt === null || way === undefined) {
    return { place, stop: null };
  }
  const barriers = barriersOnWay(way, {
    neighbourhood,
    barrierSnapM: params.assessment.barrierSnapM,
    measurement: { observedAt: fetchedAt },
  });
  const stop = await constraintsAtStop(place.stopAt, way, barriers, ports, params, fetchedAt);
  return { place, stop };
}

/** The smallest rung that covers the zone; the last one when none does (the policy schema forbids it). */
function rungFor(areaRadiusM: number, params: PipelineParams): number {
  const rungs = params.fetchLadderM;
  return rungs.find((r) => r >= areaRadiusM) ?? rungs[rungs.length - 1] ?? areaRadiusM;
}

function streetAt(
  door: GeoPoint,
  neighbourhood: RoadNeighbourhood,
  params: PipelineParams,
  fetchedAt: string,
): string | null {
  const street = selectDeliveryStreet({ ...params.selection, point: door, neighbourhood, fetchedAt });
  return street.known ? street.value.segmentId : null;
}
