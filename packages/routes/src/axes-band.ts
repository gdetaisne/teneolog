/**
 * LES PORTES DE CLASSE 4 SUR LE CERCLE, et nulle
 * part ailleurs.
 *
 * LA RÈGLE, telle que le responsable produit l'a tranchée. Quand aucun anneau ≤ 2 000 m
 * n'offre le compte de directions avec le réseau structurant (importance 2–3),
 * l'étage regarde les axes d'importance 4 — mais **seulement là où ils coupent
 * la bande `gates.minReachM` – `gates.searchRadiusM`** (1 800–2 000 m, les deux
 * clés existent déjà, aucun nombre nouveau, principe 23). Une porte par
 * DIRECTION, là où l'axe coupe la bande, jusqu'à `gateCount`, les directions
 * non voisines d'abord (`selectBandGates`, `axes-select.ts`).
 *
 * **AUCUNE PORTE DE CLASSE 4 NE SE POSE SOUS `gates.minReachM`.** C'est le
 * principe 7 — « l'ancre reste le point à 2 km ; toute l'approche est
 * contrôlée » — et c'est l'écart écrit du principe 34 : *importance 2–3 =
 * premier point rencontré ; importance 4 = au cercle, jamais plus près.* Ce que
 * la règle « classe 4 au plus proche » faisait taire a été mesuré le jour même
 * (§7 du rapport) : 30 à 50 questions par adresse, et à Thairé une ancre à
 * 24 m sur la rue du village, qui sortait 1,78 km d'approche de l'étude.
 *
 * CE QUE C'EST, DONC : la règle de R0 (`measureVertices`, `gates.ts` — le
 * sommet le plus lointain sous le plafond, jamais sous le plancher) réduite à
 * la classe 4 de la BD TOPO. Ce n'est PAS une jonction : il n'y a ni rue
 * locale, ni branche à quitter, donc aucun des six filtres de `axes-gates.ts`
 * n'a de sens ici — ils jugent tous la géométrie d'une jonction. Ne reste que
 * ce qui vaut pour une voie : elle n'est pas privée.
 *
 * L'AUTRE CHOIX POSSIBLE, ET POURQUOI IL A ÉTÉ ÉCARTÉ. On pouvait poser la
 * porte à la jonction axe × rue locale la plus proche de la bande, ce qui
 * aurait gardé la mécanique des portes intacte. Trois raisons de ne pas le
 * faire : (1) une jonction n'existe pas forcément dans 200 m de bande, et la
 * règle rendrait alors zéro porte là où l'axe traverse bel et bien — c'est
 * l'escalade à 5 km qu'on cherche justement à éviter ; (2) `inward`, le point
 * à 20 m sur la branche locale, n'existe que pour empêcher OSRM de suivre
 * l'axe puis de faire demi-tour (BUG-065) — sur une ancre posée SUR l'axe au
 * cercle, suivre l'axe vers l'adresse est exactement ce qu'on veut, et c'est
 * ce que R0 fait depuis toujours ; (3) l'ancre étant au même endroit que celle
 * de R0, l'écart mesuré entre les deux règles ne tient plus qu'à la CLASSE et
 * aux directions, ce qui rend l'A/B lisible.
 *
 * UNE SEULE DIVERGENCE AVEC R0, DÉLIBÉRÉE : on ajoute aux sommets **le point où
 * l'axe coupe le cercle extérieur**. R0 ne regarde que des sommets OSM, denses ;
 * un tronçon BD TOPO peut enjamber les 200 m de la bande d'un seul segment, et
 * l'axe serait alors déclaré trop court alors qu'il traverse. Le point de coupe
 * est le plus lointain que la bande puisse offrir, donc c'est lui qu'on veut de
 * toute façon.
 */
import type {
  AxisCorridor,
  AxisGate,
  AxisGateRejected,
  GeoPoint,
} from '@teneolog/domain';
import { bearingDeg, haversineM, type RoadWay } from '@teneolog/topology';

import type { AxisGateResult } from './axes-gates.js';
import { sectorOf } from './axes-geometry.js';
import { findAxisCorridors, type AxisNetwork } from './axes-network.js';
import { directionsOf, type AxisRingAttempt } from './axes-rings.js';
import { selectBandGates } from './axes-select.js';

export interface AxisBandInput {
  readonly stop: GeoPoint;
  readonly axes: readonly AxisCorridor[];
  /** Les tronçons d'axe, par identifiant — les géométries que les axes nomment. */
  readonly axisWays: ReadonlyMap<string, RoadWay>;
  /** Le bord INTÉRIEUR de la bande (`gates.minReachM`, 1 800 m), inclus. */
  readonly bandFromM: number;
  /** Le bord EXTÉRIEUR (`gates.searchRadiusM`, 2 000 m), inclus. */
  readonly bandToM: number;
  readonly sectorCount: number;
}

export interface AxisBandProbeInput extends Omit<AxisBandInput, 'axes'> {
  readonly network: AxisNetwork;
  readonly ringsM: readonly number[];
  readonly importanceMax: number;
  readonly gateCount: number;
  readonly minDirectionSeparationDeg: number;
  readonly minReachM: number;
}

/**
 * LA PASSE CLASSE 4, de bout en bout : les axes du cercle, leurs portes de
 * bande, la sélection, les directions.
 *
 * Rendue sous la forme d'un `AxisRingAttempt` — le même objet que les anneaux —
 * pour que `betterRing` puisse les comparer et que l'étage n'ait qu'une seule
 * notion d'« anneau retenu ». `ringM` vaut le bord extérieur de la bande : c'est
 * bien le cercle de 2 000 m qui a répondu.
 */
export function probeBand(input: AxisBandProbeInput): AxisRingAttempt {
  const axes = findAxisCorridors(input.network, input.bandToM, input.ringsM);
  const found = findBandGates({ ...input, axes });
  const selection = selectBandGates(
    found.gates,
    input.gateCount,
    input.sectorCount,
    input.minDirectionSeparationDeg,
    input.minReachM,
  );
  return {
    ringM: input.bandToM,
    fetchRadiusM: input.bandToM,
    importanceMax: input.importanceMax,
    axes,
    found,
    selection,
    directions: directionsOf(selection, input),
  };
}

/**
 * Les portes de bande de tous les axes, la plus lointaine d'abord.
 *
 * L'ORDRE EST CELUI DE R0, ET C'EST VOULU : `spreadByAzimuth` (`gates.ts`) trie
 * ses sommets par distance DÉCROISSANTE, parce qu'une approche longue traverse
 * davantage de ce qu'un candidat existe pour révéler. Dans une bande de 200 m
 * l'ordre ne décide presque rien — mais il décide quelque chose, et autant que
 * ce soit la même règle des deux côtés.
 */
export function findBandGates(input: AxisBandInput): AxisGateResult {
  const gates: AxisGate[] = [];
  const rejected: AxisGateRejected[] = [];

  for (const axis of input.axes) {
    const before = gates.length;
    for (const wayId of axis.wayIds) {
      const way = input.axisWays.get(wayId);
      if (way === undefined) continue;
      collectFromWay(axis, way, input, gates, rejected);
    }
    if (gates.length === before) rejected.push(shortOfBand(axis, input));
  }

  return {
    gates: gates.sort((a, b) => b.distanceM - a.distanceM || a.id.localeCompare(b.id)),
    rejected,
  };
}

/** Les portes d'UN tronçon : une par secteur, la plus lointaine de la bande. */
function collectFromWay(
  axis: AxisCorridor,
  way: RoadWay,
  input: AxisBandInput,
  gates: AxisGate[],
  rejected: AxisGateRejected[],
): void {
  const points = bandPoints(way.geometry, input);
  if (points.length === 0) return;
  // Une voie privée n'est une entrée de secteur pour personne, quel que soit le
  // véhicule — le seul filtre de `axes-gates.ts` qui juge la VOIE et non la
  // géométrie d'une jonction (`legalForReference`).
  if (way.isPrivate) {
    const first = points[0] as BandPoint;
    rejected.push({
      axisWayId: way.id,
      localWayId: null,
      at: first.at,
      distanceM: Math.round(first.distanceM),
      reasons: ['legal_incompatible'],
    });
    return;
  }
  for (const point of farthestPerSector(points).values()) {
    gates.push(gateOf(axis, way, point));
  }
}

/** Un point de la bande : là où l'axe la traverse, vu de l'arrêt. */
interface BandPoint {
  readonly at: GeoPoint;
  readonly distanceM: number;
  readonly azimuthDeg: number;
  readonly sector: number;
}

/**
 * Les points d'une géométrie qui sont DANS la bande : ses sommets, plus les
 * points où elle coupe le cercle extérieur.
 *
 * Le point de coupe est à exactement `bandToM` — le plus lointain que la bande
 * puisse offrir. Sans lui, un tronçon qui saute de 1 700 à 2 200 m d'un seul
 * segment ne rendrait rien, et l'axe passerait pour trop court.
 */
function bandPoints(geometry: readonly GeoPoint[], input: AxisBandInput): readonly BandPoint[] {
  const out: BandPoint[] = [];
  let previous: { readonly at: GeoPoint; readonly distanceM: number } | null = null;
  for (const at of geometry) {
    const distanceM = haversineM(input.stop, at);
    if (distanceM >= input.bandFromM && distanceM <= input.bandToM) {
      out.push(placed(at, distanceM, input));
    }
    if (previous !== null && straddles(previous.distanceM, distanceM, input.bandToM)) {
      const cut = crossingAt(previous.at, at, input.stop, input.bandToM);
      out.push(placed(cut, input.bandToM, input));
    }
    previous = { at, distanceM };
  }
  return out;
}

function placed(at: GeoPoint, distanceM: number, input: AxisBandInput): BandPoint {
  const azimuthDeg = bearingDeg(input.stop, at);
  return { at, distanceM, azimuthDeg, sector: sectorOf(azimuthDeg, input.sectorCount) };
}

function straddles(a: number, b: number, edgeM: number): boolean {
  return (a < edgeM && b > edgeM) || (a > edgeM && b < edgeM);
}

/**
 * Le point d'un segment qui est à exactement `radiusM` du centre, par
 * dichotomie sur le paramètre du segment.
 *
 * Douze tours : sur un segment d'un kilomètre, la dernière division vaut 24 cm,
 * et l'azimut d'un point à 2 km ne bouge pas d'un centième de degré pour ça. La
 * distance est monotone le long d'un segment qui ne coupe le cercle qu'une
 * fois, ce que `straddles` vient de vérifier.
 */
function crossingAt(from: GeoPoint, to: GeoPoint, centre: GeoPoint, radiusM: number): GeoPoint {
  let low = 0;
  let high = 1;
  const startsInside = haversineM(centre, from) < radiusM;
  for (let step = 0; step < 12; step += 1) {
    const mid = (low + high) / 2;
    if ((haversineM(centre, lerp(from, to, mid)) < radiusM) === startsInside) low = mid;
    else high = mid;
  }
  return lerp(from, to, (low + high) / 2);
}

function lerp(from: GeoPoint, to: GeoPoint, t: number): GeoPoint {
  return { lat: from.lat + (to.lat - from.lat) * t, lon: from.lon + (to.lon - from.lon) * t };
}

/**
 * Un point par secteur de 30° : le plus lointain.
 *
 * Un axe peut couper la bande DEUX FOIS — la départementale qui traverse le
 * bourg en ressort des deux côtés — et ce sont bien deux approches, pas une.
 * Le secteur est ce qui les distingue ; deux coupes du même secteur sont le
 * même endroit vu deux fois.
 */
function farthestPerSector(points: readonly BandPoint[]): ReadonlyMap<number, BandPoint> {
  const best = new Map<number, BandPoint>();
  for (const point of points) {
    const held = best.get(point.sector);
    if (held === undefined || point.distanceM > held.distanceM) best.set(point.sector, point);
  }
  return best;
}

/**
 * Une porte de bande, prête pour la sélection.
 *
 * `inward` est le point LUI-MÊME : il n'y a pas de branche locale par où
 * partir, et c'est exactement d'un point pareil que R0 route ses cinq ancres
 * depuis toujours.
 */
function gateOf(axis: AxisCorridor, way: RoadWay, point: BandPoint): AxisGate {
  return {
    id: `axis:${way.id}@${String(point.sector)}`,
    at: point.at,
    inward: point.at,
    axisId: axis.id,
    axisWayId: way.id,
    localWayId: null,
    label: way.name ?? way.tags['nature'] ?? `BD TOPO ${way.id.slice(-8)}`,
    importance: way.importance ?? axis.importance,
    localImportance: null,
    azimuthDeg: point.azimuthDeg,
    distanceM: point.distanceM,
    sector: point.sector,
    rank: null,
    reasonCodes: [],
    uncontrolledBeyondM: null,
  };
}

/** L'axe qui ne coupe pas la bande, nommé — et où il s'arrête (principe 1). */
function shortOfBand(axis: AxisCorridor, input: AxisBandInput): AxisGateRejected {
  let at: GeoPoint = input.stop;
  let distanceM = 0;
  for (const wayId of axis.wayIds) {
    const way = input.axisWays.get(wayId);
    if (way === undefined) continue;
    for (const vertex of way.geometry) {
      const d = haversineM(input.stop, vertex);
      if (d < input.bandFromM && d > distanceM) {
        at = vertex;
        distanceM = d;
      }
    }
  }
  return {
    axisWayId: axis.wayIds[0] ?? axis.id,
    localWayId: null,
    at,
    distanceM: Math.round(distanceM),
    reasons: ['axis_short_of_ring_band'],
  };
}
