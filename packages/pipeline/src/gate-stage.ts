/**
 * S3, PREMIER TEMPS : les ancres, et ce qui a servi à les poser.
 *
 * Sorti de `full.ts` pour la même raison que `gate-input.ts` l'a été en
 * la tâche y touchait et le fichier est gelé (principe 26, « ce qui
 * dépasse se découpe quand on y touche »). La coupure est celle du sujet — ici
 * on POSE les ancres, `full.ts` orchestre S3 → S6.
 *
 * Deux règles y cohabitent, et c'est voulu (principe 17) :
 *  - **R0**, la sélection d'aujourd'hui : les sommets les plus lointains du
 *    voisinage OSM structurant, séparés en azimut (`findStructuringGatesWithSearch`) ;
 * - **l'étage AXES** : les axes BD TOPO d'importance 2–3 cherchés
 *    par anneaux jusqu'à 15 km, et les portes par lesquelles on les quitte.
 *
 * `gates.axes.enabled` décide laquelle SERT. Éteint — la valeur livrée —
 * l'étage est calculé, publié dans `GateSearch.axes`, et les ancres servies
 * sont au bit près celles de R0 : c'est le test d'or de `packages/pipeline`
 * qui le juge, pas ce commentaire.
 */
import type { AxisGate, AxisSearch, GateSearch, GeoPoint } from '@teneolog/domain';
import {
  findStructuringGatesWithSearch,
  runAxisStage,
  type AxisSourcePort,
  type AxisStageParams,
  type Gate,
} from '@teneolog/routes';
import { closestPointOnPolyline, type RoadNeighbourhood, type RoadWay } from '@teneolog/topology';

import { gateSearchInputOf, type GateInputParams } from './gate-input.js';

export interface GateStagePorts {
  readonly structuring: {
    fetchStructuring(centre: GeoPoint, radiusM: number): Promise<RoadNeighbourhood>;
  };
  /** la BD TOPO par classe d'importance. Absente, l'étage axes dit `no_source`. */
  readonly axes?: AxisSourcePort | null;
}

export interface GateStageParams extends GateInputParams {
  readonly gates: GateInputParams['gates'] & { readonly axes?: AxisStageParams };
}

export interface GateStageResult {
  /** Le voisinage structurant OSM — relu plus bas par l'ordre des jambes et par la découverte. */
  readonly wide: RoadNeighbourhood;
  /** Les ancres qui SERVENT, dans l'ordre où S3 les consomme. */
  readonly gates: readonly Gate[];
  readonly gateSearch: GateSearch;
  /**
   * L'ÉTAGE AXES ENCORE EN VOL, quand le drapeau est baissé. `null` sinon.
   *
   * Éteint, l'étage ne décide rien : le faire attendre par S3 ferait payer 3 à
   * 10 s de BD TOPO à une lecture qui ne change pas un verdict. Il part donc en
   * même temps que la requête OSM de R0 et se rejoint APRÈS le routage, par
   * `sealAxes` — c'est la forme de la requête bâtiments de l'API (hors instantané)
   * (lancée en parallèle, jointe avant `complete`, jamais dans le chemin
   * critique). Levé, au contraire, il CHOISIT les ancres : il est attendu ici,
   * et `pendingAxes` est `null`.
   */
  readonly pendingAxes: Promise<AxisSearch> | null;
}

export async function runGateStage(
  stop: GeoPoint,
  ports: GateStagePorts,
  params: GateStageParams,
): Promise<GateStageResult> {
  const axisParams = params.gates.axes;
  // L'étage part AVANT la requête OSM de R0 : les deux sources sont
  // différentes et les deux requêtes ne s'attendent pas.
  const pending =
    axisParams === undefined
      ? null
      : runAxisStage({
          stop,
          source: ports.axes ?? null,
          params: {
            ...axisParams,
            gateCount: params.gates.gateCount,
            // PRINCIPE 34 — le MÊME nombre que R0 et la découverte, et il ne
            // choisit aucune porte : il dit ce qui n'est pas contrôlé.
            minReachM: params.gates.minReachM,
            // PRINCIPE 23 (2026-09-14) — CÂBLÉE, pas recopiée : le garde-fou
            // du principe 34 est `gates.searchRadiusM`, la même valeur que
            // R0 et la découverte, jamais un second nombre en policy. Avant
            // cette tâche, `gates.axes.escalationBoundM` était une recopie
            // manuelle en policy que rien ne forçait à rester égale.
            escalationBoundM: params.gates.searchRadiusM,
          },
        });

  const wide = await ports.structuring.fetchStructuring(stop, params.gates.searchRadiusM);
  // `…WithSearch` chooses exactly what `findStructuringGates` chooses and also
  // keeps the ways it set aside. Same gates, same order, one extra output.
  const { gates, search } = findStructuringGatesWithSearch(gateSearchInputOf(stop, wide, params));

  if (pending === null) return { wide, gates, gateSearch: search, pendingAxes: null };
  // LES NOMS SE POSENT ICI, où le graphe OSM existe : la BD TOPO n'a
  // pas de colonne nom, et `packages/routes` ne connaît pas OSM.
  const named = pending.then((axes) => namedFromOsm(axes, wide, stop));
  if (axisParams?.enabled !== true) {
    return { wide, gates, gateSearch: search, pendingAxes: named };
  }

  const axes = await named;
  return { wide, gates: gatesOf(gates, axes), gateSearch: sealed(search, axes), pendingAxes: null };
}

/**
 * L'ÉCRAN NOMME : le `ref` puis le `name` de la voie OSM
 * la plus proche de la porte.
 *
 * Décision produit : une ancre se lit « D 939 au nord, 3,7 km », pas
 * « BD TOPO 44012845 × BD TOPO 44013207 ». La BD TOPO n'a pas de colonne nom —
 * `axes-network.ts` retombe donc sur la nature ou l'identifiant — alors que le
 * voisinage structurant OSM de R0 (`wide`) porte `ref` (« D 939 ») et `name`.
 * Le `ref` d'abord : c'est ce qu'un opérateur lit sur un panneau et ce qui
 * nomme une départementale ; le `name` quand il n'y a pas de `ref` (une rue de
 * ville n'en a pas).
 *
 * TRENTE MÈTRES, ET LE NOMBRE N'EST PAS NEUF (principe 30) : c'est l'écart sous
 * lequel le harnais croise déjà une voie OSM et un axe BD TOPO
 * (`MATCH_M`, `packages/pipeline/scripts/ab-ancres-axes.ts`) — deux
 * numérisations de la même route s'écartent de quelques mètres, jamais de
 * trente.
 *
 * CE QU'ON NE NOMME PAS, ET ON LE DIT : une porte hors du voisinage OSM chargé
 * (le disque de `gates.searchRadiusM`, donc toute ancre au-delà de 2 km — c'est
 * Thairé) garde le libellé de la BD TOPO. Une donnée absente s'affiche comme
 * absente (principe 14).
 *
 * SEULEMENT EN MODE `axes` (principe 17) : la règle de secteurs reste au bit
 * près celle du 2026-09-14, libellés compris, tant que le responsable produit n'a pas
 * tranché sur l'A/B du jour.
 *
 * DOUBLON CONNU, non corrigé ici : `/explain` refait ce travail à sa façon
 * (l'API (hors instantané), `withOsmNames`, 40 m, `name` seul), et
 * il le refait sur ce que l'API lui envoie. Les deux ne peuvent pas partager de
 * code — le front web ne dépend ni de `@teneolog/pipeline` ni de
 * `@teneolog/routes`, et c'est le verrou qui garantit que `/explain` ne
 * recalcule rien. À trancher avec l'activation de la règle (principe 23).
 */
export const OSM_LABEL_MAX_M = 30;

function namedFromOsm(axes: AxisSearch, wide: RoadNeighbourhood, stop: GeoPoint): AxisSearch {
  if (axes.selection !== 'axes') return axes;
  const named = wide.ways.map(namedWayOf).filter((way): way is NamedWay => way !== null);
  if (named.length === 0) return axes;

  const labelByAxisId = new Map<string, string>();
  const corridors = axes.axes.map((axis) => {
    const closest = closestPointOnPolyline(axis.geometry, stop);
    const found = closest === null ? null : nameNear(closest.point, named);
    if (found === null) return axis;
    labelByAxisId.set(axis.id, found);
    return { ...axis, label: found };
  });
  const rename = (gate: AxisGate): AxisGate => {
    const found = nameNear(gate.at, named) ?? labelByAxisId.get(gate.axisId) ?? null;
    return found === null ? gate : { ...gate, label: found };
  };
  const axisIdByGateId = new Map(axes.gates.map((gate) => [gate.id, gate.axisId]));

  return {
    ...axes,
    axes: corridors,
    gates: axes.gates.map(rename),
    retained: axes.retained.map(rename),
    uncontrolled: axes.uncontrolled.map((row) => ({
      ...row,
      axisLabel: labelByAxisId.get(axisIdByGateId.get(row.gateId) ?? '') ?? row.axisLabel,
    })),
  };
}

/** Une voie OSM qui porte un nom lisible, avec sa boîte — le rejet à coup sûr d'abord. */
interface NamedWay {
  readonly label: string;
  readonly geometry: readonly GeoPoint[];
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLon: number;
  readonly maxLon: number;
}

function namedWayOf(way: RoadWay): NamedWay | null {
  const label = (way.tags['ref'] ?? way.name ?? '').trim();
  if (label === '' || way.geometry.length === 0) return null;
  const lats = way.geometry.map((point) => point.lat);
  const lons = way.geometry.map((point) => point.lon);
  return {
    label,
    geometry: way.geometry,
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLon: Math.min(...lons),
    maxLon: Math.max(...lons),
  };
}

/** Le nom de la voie OSM la plus proche du point, ou `null` au-delà de la tolérance. */
function nameNear(point: GeoPoint, ways: readonly NamedWay[]): string | null {
  // Un degré de latitude fait 111 320 m ; 30 m en font moins de 0,0003. La
  // boîte élargie de cette marge écarte la quasi-totalité des voies sans
  // mesurer une seule distance à la polyligne.
  const padLat = OSM_LABEL_MAX_M / 111_320;
  const padLon = padLat / Math.max(Math.cos((point.lat * Math.PI) / 180), 0.01);
  let best: { readonly label: string; readonly distanceM: number } | null = null;
  for (const way of ways) {
    if (point.lat < way.minLat - padLat || point.lat > way.maxLat + padLat) continue;
    if (point.lon < way.minLon - padLon || point.lon > way.maxLon + padLon) continue;
    const closest = closestPointOnPolyline(way.geometry, point);
    if (closest === null || closest.distanceM > OSM_LABEL_MAX_M) continue;
    if (best === null || closest.distanceM < best.distanceM) {
      best = { label: way.label, distanceM: closest.distanceM };
    }
  }
  return best === null ? null : best.label;
}

/**
 * Rejoint l'étage axes après le routage, quand il ne décidait rien.
 *
 * Rend la sélection telle quelle si rien n'était en vol. Ne lève jamais :
 * `runAxisStage` transforme déjà ses échecs en motifs.
 */
export async function sealAxes(
  search: GateSearch,
  pending: Promise<AxisSearch> | null,
): Promise<GateSearch> {
  return pending === null ? search : sealed(search, await pending);
}

/** Les ancres servies : celles de l'étage quand il sert, celles de R0 sinon. */
function gatesOf(r0: readonly Gate[], axes: AxisSearch): readonly Gate[] {
  return axes.fallback === 'axes' ? axes.retained.map(gateOf) : r0;
}

/**
 * La sélection augmentée de ce que l'étage a vu.
 *
 * PRINCIPE 34 — `uncontrolledApproaches` ne voyage que si l'étage SERT :
 * drapeau baissé, le fil de l’API ne change pas d'un octet, et `/explain` lit
 * tout dans `axes.uncontrolled`.
 */
function sealed(search: GateSearch, axes: AxisSearch): GateSearch {
  return {
    ...search,
    axes,
    uncontrolledApproaches: axes.fallback === 'axes' ? axes.uncontrolled : [],
  };
}

/**
 * Une porte d'axe telle que S3 la consomme.
 *
 * `at` est le point d'entrée SUR LA RUE LOCALE, pas la jonction elle-même :
 * c'est `gateRoutingPoint` de l'engine, et la raison est mesurée là-bas —
 * partir de l'axe fait suivre l'axe à OSRM, puis faire demi-tour (BUG-065).
 * Pour une PORTE DE BANDE (classe 4 sur le cercle, `axes-band.ts`), `inward`
 * est le point lui-même : il n'y a pas de rue locale, et suivre l'axe vers
 * l'adresse est exactement ce qu'on veut — c'est ce que R0 fait depuis
 * toujours pour ses cinq ancres.
 *
 * `wayId` est le couple `axe+rue`, parce que l'identifiant d'une jambe est
 * `wayId@azimut:sens` (`candidates.ts`) : deux portes du même axe sur deux rues
 * différentes doivent porter deux identifiants, sinon leurs corridors s'écrasent
 * l'un l'autre (le piège F3 de la fiche S3). Sans rue locale, l'axe seul suffit
 * — deux portes de bande du même axe sont dans deux secteurs différents, donc
 * deux azimuts différents, donc deux identifiants de jambe différents.
 */
function gateOf(gate: AxisGate): Gate {
  return {
    at: gate.inward,
    wayId: gate.localWayId === null ? gate.axisWayId : `${gate.axisWayId}+${gate.localWayId}`,
    azimuthDeg: gate.azimuthDeg,
    distanceM: gate.distanceM,
  };
}

/** Ce que l'étage axes a réellement servi — pour le harnais et les tests. */
export function axesServed(search: AxisSearch | null): boolean {
  return search !== null && search.fallback === 'axes';
}
