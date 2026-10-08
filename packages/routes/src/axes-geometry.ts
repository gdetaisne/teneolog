/**
 * la géométrie que l'étage « axes » partage, et rien d'autre.
 *
 * Sorti à part pour qu'`axes-network.ts` et `axes-gates.ts` lisent LES MÊMES
 * fonctions (principe 23 : une seule source par règle). Les trois notions qui
 * comptent, et qui sont exactement celles de l'engine :
 *
 *  - **l'orientation non orientée** : une route et sa numérisation inverse
 *    décrivent le même axe, donc on replie l'écart dans [0, 90]. Sans ça, deux
 *    morceaux d'une même voie rapide stockés tête-bêche mesurent 180° d'écart
 *    et ne se recollent jamais (`undirectedOrientationDiffDeg` de l'engine,
 *    `phase1-segment-diagnostics/helpers.ts`) ;
 *  - **le secteur** : 12 bins FIXES de 30° comptés depuis le nord, indexés sur
 *    l'azimut de l'arrêt vers le point le plus proche de la voie. Fixes, donc
 *    sans « le premier arrivé prend la direction » — le défaut H4 de la fiche
 *    S3, où une ancre d'Auxerre a bloqué 28 voies à elle seule ;
 *  - **le côté** : le signe de `sin(bearing − axisBearing)`, avec une zone
 *    morte à ±5° où le côté n'a pas de sens (le point est sur l'axe).
 */
import type { GeoPoint } from '@teneolog/domain';
import { bearingDeg, bearingDeltaDeg, closestPointOnPolyline, haversineM } from '@teneolog/topology';

/** Le côté est indécidable sous cet angle à l'axe : le point est dessus. */
export const SIDE_AMBIGUOUS_SIN = Math.sin((5 * Math.PI) / 180);

export function normaliseDeg(value: number): number {
  return ((value % 360) + 360) % 360;
}

/**
 * Écart d'orientation entre deux droites, dans [0, 90].
 *
 * `bearingDeltaDeg` rend [0, 180] : c'est l'écart entre deux CAPS. Ici on
 * compare deux DROITES, pour lesquelles 180° vaut 0°.
 */
export function undirectedDeltaDeg(a: number, b: number): number {
  const delta = bearingDeltaDeg(a, b);
  return delta > 90 ? 180 - delta : delta;
}

/** L'index du secteur de 30° d'un azimut, dans [0, sectorCount[. */
export function sectorOf(azimuthDeg: number, sectorCount: number): number {
  const span = 360 / sectorCount;
  return Math.floor(normaliseDeg(azimuthDeg) / span) % sectorCount;
}

/**
 * DEUX DIRECTIONS, C'EST DEUX SECTEURS NON
 * VOISINS.
 *
 * Le constat, sur un run chaud de Thairé : l'étage posait quatre portes aux
 * azimuts 290, 294, 305 et 307° — secteurs 9 et 10, deux secteurs **côte à
 * côte** — et le critère d'arrêt (`gates.axes.minGateDirections` = 2) s'en
 * déclarait satisfait. Deux secteurs voisins, ce n'est pas deux directions :
 * c'est la même approche vue en deux fois, et le camion n'est testé que par un
 * côté de l'adresse — exactement ce que le critère devait empêcher.
 *
 * LA RÈGLE : deux portes ne comptent pour deux directions que si leurs
 * secteurs sont séparés d'au moins `minSeparationDeg` d'azimut — 60° livrés,
 * soit DEUX secteurs de 30° sur le cercle de douze. 9 et 10 = une direction ;
 * 9 et 11 = deux ; 0 et 11 = une (voisins par le bord du cercle). D'OÙ VIENT
 * LE 60 (principe 30, aucun nombre tiré d'une adresse) : R0 sépare ses ancres
 * de `360 / gateCount / 2` = 36° (`gates.ts`, `GateSearch.minSeparationDeg`)
 * et l'engine découpe ses secteurs à 30° (`PHASE1_AXIS_SECTOR_DEG`,
 * `ITINERARY_SECTOR_SIZE_DEG`) ; 60° est le plus petit écart qui, sur ce
 * découpage, garantit que deux portes ne partagent pas la même approche — un
 * secteur occupé, un secteur vide, un secteur occupé.
 *
 * L'ÉCART SE MESURE ENTRE DEUX PORTES, PAS ENTRE VOISINES DE PROCHE EN PROCHE
 * — et ça, c'est une MESURE, pas un avis (§12.2 du rapport du jour). La
 * première écriture de cette règle chaînait les secteurs adjacents : un
 * éventail continu comptait pour UNE direction, si large soit-il. Mesuré sur
 * les huit adresses (la note de conception interne),
 * ce chaînage lisait les secteurs 0 à 4 de Clamart — 150° d'éventail, du nord
 * au sud-est — comme une seule approche, et les secteurs 4 à 7 d'Aigrefeuille
 * de même : les deux adresses cessaient de qualifier dans le cercle, partaient
 * en passe classe 4, et dépassaient `gates.axes.stageTimeoutMs` (reproduit
 * deux fois). Deux portes à 120° l'une de l'autre ne partagent pas une
 * approche parce que des portes existent entre elles ; au contraire, plus il y
 * a de portes, plus il y a d'approches.
 *
 * Ce qui est rendu : UN secteur par direction, pris de proche en proche depuis
 * le secteur qui suit le plus grand vide (départ canonique : le compte ne doit
 * pas dépendre de l'origine des azimuts). C'est ce que `minGateDirections`
 * compte, et ce que `AxisSearch.gateDirections` publie ; le secteur de CHAQUE
 * porte reste lisible sur `AxisGate.sector`.
 */
export function distinctDirections(
  sectors: readonly number[],
  sectorCount: number,
  minSeparationDeg: number,
): readonly number[] {
  const occupied = [...new Set(sectors)].sort((a, b) => a - b);
  if (occupied.length <= 1) return occupied;
  const start = canonicalStart(occupied, sectorCount);
  const kept: number[] = [];
  for (const sector of [...occupied].sort(
    (a, b) => forwardSectors(start, a, sectorCount) - forwardSectors(start, b, sectorCount),
  )) {
    const last = kept[kept.length - 1];
    if (last === undefined || sectorApartDeg(last, sector, sectorCount) >= minSeparationDeg) {
      kept.push(sector);
    }
  }
  // Le cercle se referme : la dernière gardée doit aussi être séparée de la
  // première, sinon deux « directions » se toucheraient par le bord.
  if (kept.length > 1 && sectorApartDeg(kept[kept.length - 1] as number, kept[0] as number, sectorCount) < minSeparationDeg) {
    kept.pop();
  }
  return kept.sort((a, b) => a - b);
}

/** Secteurs à parcourir de `from` vers `to` dans le sens des azimuts croissants. */
function forwardSectors(from: number, to: number, sectorCount: number): number {
  return (((to - from) % sectorCount) + sectorCount) % sectorCount;
}

/** L'écart d'azimut entre deux secteurs : le PLUS COURT des deux arcs. */
function sectorApartDeg(a: number, b: number, sectorCount: number): number {
  const forward = forwardSectors(a, b, sectorCount);
  return Math.min(forward, sectorCount - forward) * (360 / sectorCount);
}

/**
 * Par où commencer à compter : le secteur qui SUIT le plus grand vide (à
 * égalité, le plus petit index).
 *
 * Sans point de départ canonique, le compte dépendrait de l'origine des
 * azimuts — le nord — ce qui n'est pas une règle mais un accident. Commencer
 * après le plus grand vide, c'est commencer au début de l'éventail réel.
 */
function canonicalStart(occupied: readonly number[], sectorCount: number): number {
  let start = occupied[0] as number;
  let widest = -1;
  for (let index = 0; index < occupied.length; index += 1) {
    const sector = occupied[index] as number;
    const previous = occupied[(index - 1 + occupied.length) % occupied.length] as number;
    const gap = forwardSectors(previous, sector, sectorCount);
    if (gap > widest) {
      widest = gap;
      start = sector;
    }
  }
  return start;
}

/** Cap du premier au dernier sommet — l'orientation d'ensemble de la ligne. */
export function lineBearingDeg(geometry: readonly GeoPoint[]): number {
  const first = geometry[0];
  const last = geometry[geometry.length - 1];
  if (first === undefined || last === undefined || geometry.length < 2) return 0;
  return bearingDeg(first, last);
}

/**
 * Cap LOCAL de la ligne au droit d'un point de référence.
 *
 * Pas le cap d'ensemble : sur un axe de 3 km qui tourne, ce qui compte pour
 * dire « cette branche quitte l'axe » est l'orientation de l'axe LÀ où la
 * branche le rejoint, pas sa corde générale.
 */
export function localBearingDeg(geometry: readonly GeoPoint[], at: GeoPoint): number {
  if (geometry.length < 2) return 0;
  const closest = closestPointOnPolyline(geometry, at);
  const index = closest === null ? 0 : Math.min(closest.segmentIndex, geometry.length - 2);
  const a = geometry[index];
  const b = geometry[index + 1];
  return a === undefined || b === undefined ? 0 : bearingDeg(a, b);
}

/** Le signe du côté d'un cap par rapport à une droite : positif à droite, négatif à gauche. */
export function sideSign(bearing: number, axisBearing: number): number {
  return Math.sin(((bearing - axisBearing) * Math.PI) / 180);
}

/** Le point le plus proche d'une ligne, et sa distance. `null` quand la ligne est vide. */
export function nearestOn(
  geometry: readonly GeoPoint[],
  at: GeoPoint,
): { readonly point: GeoPoint; readonly distanceM: number } | null {
  const closest = closestPointOnPolyline(geometry, at);
  return closest === null ? null : { point: closest.point, distanceM: closest.distanceM };
}

/**
 * La corde d'une ligne à l'intérieur d'un cercle, en un seul morceau.
 *
 * Découper exactement (comme `clipPolylineToCircle` de l'engine) rendrait
 * plusieurs morceaux pour une route qui entre et ressort ; on garde la plus
 * longue suite de sommets consécutifs sous le rayon, ce qui suffit pour
 * dessiner l'axe et mesurer sa longueur utile — c'est un dessin, pas une
 * mesure de verdict.
 *
 * QUAND AUCUN SOMMET N'EST DEDANS, on rend le sommet le plus proche SEUL, et
 * non la ligne entière. Corrigé le 2026-09-14 : le repli `return geometry`
 * rendait hors du cercle une géométrie qui alimente ensuite une décision —
 * `axisBearingDeg` (l'orientation de l'axe) et `alongAxisM`, tous deux lus par
 * la découverte et par le filtre « la branche quitte l'axe ». Un tronçon de
 * 12 km dont un seul bout frôle le cercle donnait son cap sur 12 km au lieu du
 * cap au droit de l'adresse. Un point ne porte pas de cap : `lineBearingDeg`
 * rend 0 et `polylineLengthM` rend 0, ce qui écarte proprement ce tronçon du
 * choix de la plus longue corde, au lieu de le faire gagner.
 */
export function chordInsideCircle(
  geometry: readonly GeoPoint[],
  centre: GeoPoint,
  radiusM: number,
): readonly GeoPoint[] {
  let best: GeoPoint[] = [];
  let run: GeoPoint[] = [];
  for (const point of geometry) {
    if (haversineM(centre, point) <= radiusM) {
      run.push(point);
      if (run.length > best.length) best = [...run];
    } else {
      run = [];
    }
  }
  if (best.length >= 2) return best;
  const nearest = nearestVertex(geometry, centre);
  return nearest === null ? [] : [nearest];
}

/** Le sommet le plus proche du centre — le repli quand la corde est vide. */
function nearestVertex(geometry: readonly GeoPoint[], centre: GeoPoint): GeoPoint | null {
  let best: GeoPoint | null = null;
  let bestM = Number.POSITIVE_INFINITY;
  for (const point of geometry) {
    const d = haversineM(centre, point);
    if (d < bestM) {
      bestM = d;
      best = point;
    }
  }
  return best;
}

/** À moins de ça d'un axe retenu, la corde le FRÔLE, et l'engine traite ça comme une traversée. */
export const AXIS_CROSS_PROXIMITY_M = 20;

/** Les deux bouts d'une corde sont écartés à 2 % : une corde qui PART d'un axe le touche. */
const CHORD_ENDPOINT_EPS = 0.02;

interface Planar {
  readonly x: number;
  readonly y: number;
}

/**
 * Vrai quand le segment `[a, b]` coupe franchement la ligne `polyline`, OU
 * quand il la longe à moins de `AXIS_CROSS_PROXIMITY_M`.
 *
 * PORTAGE EXACT de `chordCrossesRetainedAxisSegment` (principe 29), les deux
 * tests compris. « Franchement » : on écarte les intersections au ras des deux
 * bouts de la corde (2 %), parce qu'une corde qui PART d'un axe le touche par
 * définition en son origine, et ce n'est pas une traversée. Même epsilon que
 * `CHORD_AXIS_CHECK_ENDPOINT_EPS` dans l'engine.
 *
 * LE SECOND TEST manquait à la première passe, et c'est lui qui
 * attrape le cas dangereux : une corde qui ne coupe pas l'axe mais le suit à
 * 8 m sur 300 m passe bien derrière lui — la porte est derrière une porte.
 * L'engine le mesure avec la même distance qu'il utilise pour dire qu'une
 * destination est SUR un axe (`ANCHOR_DESTINATION_AXIS_CROSS_PROXIMITY_M`).
 */
export function chordCrosses(
  a: GeoPoint,
  b: GeoPoint,
  polyline: readonly GeoPoint[],
  proximityM: number = AXIS_CROSS_PROXIMITY_M,
): boolean {
  // Le repère plan est centré sur le MILIEU de la corde, comme chez l'engine :
  // à 15 km, poser l'origine sur `a` fait dériver l'échelle des longitudes.
  const origin = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
  const chordStart = planar(a, origin);
  const chordEnd = planar(b, origin);

  for (let i = 1; i < polyline.length; i += 1) {
    const c = polyline[i - 1];
    const d = polyline[i];
    if (c === undefined || d === undefined) continue;
    const axisStart = planar(c, origin);
    const axisEnd = planar(d, origin);

    const hit = intersect(chordStart, chordEnd, axisStart, axisEnd);
    if (hit !== null && inside(hit.t, hit.u)) return true;

    const near = segmentDistance(chordStart, chordEnd, axisStart, axisEnd);
    if (near.distanceM <= proximityM && inside(near.tOnA, near.tOnB)) return true;
  }
  return false;
}

/** Le paramètre sur la corde évite ses deux bouts ; celui sur l'axe couvre tout le tronçon. */
function inside(tOnChord: number, tOnAxis: number): boolean {
  return (
    tOnChord > CHORD_ENDPOINT_EPS
    && tOnChord < 1 - CHORD_ENDPOINT_EPS
    && tOnAxis >= 0
    && tOnAxis <= 1
  );
}

/** Mètres locaux autour d'une origine — assez juste sur une corde de quelques kilomètres. */
function planar(point: GeoPoint, origin: GeoPoint): Planar {
  return {
    x: (point.lon - origin.lon) * 111_320 * Math.cos((origin.lat * Math.PI) / 180),
    y: (point.lat - origin.lat) * 111_320,
  };
}

function intersect(a1: Planar, a2: Planar, b1: Planar, b2: Planar): { t: number; u: number } | null {
  const dax = a2.x - a1.x;
  const day = a2.y - a1.y;
  const dbx = b2.x - b1.x;
  const dby = b2.y - b1.y;
  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-12) return null;
  return {
    t: ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denom,
    u: ((b1.x - a1.x) * day - (b1.y - a1.y) * dax) / denom,
  };
}

/**
 * Distance minimale entre deux segments, avec les paramètres où elle est
 * atteinte. Les huit candidats de `planarSegmentToSegmentDistanceM`.
 */
function segmentDistance(
  a1: Planar,
  a2: Planar,
  b1: Planar,
  b2: Planar,
): { distanceM: number; tOnA: number; tOnB: number } {
  const pairs: { distanceM: number; tOnA: number; tOnB: number }[] = [
    pair(a1, 0, b1, 0),
    pair(a1, 0, b2, 1),
    pair(a2, 1, b1, 0),
    pair(a2, 1, b2, 1),
  ];
  const aOnB1 = project(a1, b1, b2);
  pairs.push(pair(a1, 0, aOnB1.point, aOnB1.t));
  const aOnB2 = project(a2, b1, b2);
  pairs.push(pair(a2, 1, aOnB2.point, aOnB2.t));
  const bOnA1 = project(b1, a1, a2);
  pairs.push(pair(bOnA1.point, bOnA1.t, b1, 0));
  const bOnA2 = project(b2, a1, a2);
  pairs.push(pair(bOnA2.point, bOnA2.t, b2, 1));
  return pairs.reduce((best, candidate) => (candidate.distanceM < best.distanceM ? candidate : best));
}

function pair(pointA: Planar, tOnA: number, pointB: Planar, tOnB: number): {
  distanceM: number;
  tOnA: number;
  tOnB: number;
} {
  return { distanceM: Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y), tOnA, tOnB };
}

function project(point: Planar, start: Planar, end: Planar): { point: Planar; t: number } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { point: start, t: 0 };
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq));
  return { point: { x: start.x + dx * t, y: start.y + dy * t }, t };
}
