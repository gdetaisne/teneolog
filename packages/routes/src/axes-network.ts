/**
 * LES AXES : quel réseau structurant entoure l'adresse.
 *
 * Portage de la règle de l'engine (principe 29) :
 * `phase1-segment-diagnostics/{compute,encounters,helpers}.ts`, appelée par
 * `axis-diagnostics.ts`. Ce qu'on garde mot pour mot :
 *
 *  1. **Douze secteurs de 30°**, comptés depuis le nord, sur l'azimut de
 *     l'arrêt vers le point le plus proche de chaque tronçon
 *     (`segmentDirectionSector`).
 *  2. **Des anneaux croissants** : à chaque anneau et dans chaque secteur
 *     encore ouvert, on prend le tronçon NON ENCORE RETENU le plus proche
 *     comme graine (`discoverEncounters`). Un secteur ne se ferme qu'au
 *     dernier anneau (`shouldCloseSectorAfterRing`) : un anneau muet dans un
 *     secteur ne l'interdit pas au suivant.
 *  3. **Deux passes**, secteurs pairs puis impairs (`sectorsForPass`) : les
 *     directions cardinales d'abord, les diagonales ensuite, pour qu'un axe
 *     diagonal n'absorbe pas la direction d'un axe cardinal.
 *  4. **Une graine devient un AXE** en s'étendant à ses voisins de MÊME
 *     importance, orientés à moins de 45° (non orienté) et à moins d'un
 *     demi-rayon le long de l'axe (`expandEncounterFromSeed`).
 *  5. **Les axes qui partagent un tronçon fusionnent**
 *     (`mergeEncountersOverlappingSegmentIds`) : la D113 découverte deux fois
 *     par deux secteurs est un seul axe.
 *
 * CE QU'ON CHANGE, et pourquoi.
 *  - **Le voisinage se lit sur les BOUTS**, pas sur tous les sommets. L'engine
 *    compare les 60 m entre TOUTES les paires de sommets de toutes les paires
 *    de tronçons : à 15 km, le corpus rend 1 733 tronçons, soit 1,5 million de
 *    paires et cent fois plus de distances. Or la BD TOPO ne raccorde qu'aux
 *    BOUTS (`packages/adapters/src/bdtopo-mapping.ts` : « Only endpoints can be
 *    junctions in BDTOPO's model »), donc une grille de bouts au pas de 60 m
 *    rend le même graphe en temps linéaire. Même seuil, même résultat,
 *    mesurable en millisecondes.
 *  - **Pas d'occlusion croisée** (`applyCrossEncounterOcclusion`) : elle masque
 *    un axe caché derrière un autre. Là-bas elle allège un diagnostic ; ici les
 *    axes ne sont pas une fin, les PORTES le sont, et masquer un axe masque ses
 *    portes — exactement la forme du BUG-060 (ancres ouest d'Aubagne absentes).
 * Écrit dans la note de conception interne
 */
import type { AxisCorridor, GeoPoint } from '@teneolog/domain';
import { bearingDeg, haversineM, polylineLengthM, type RoadWay } from '@teneolog/topology';

import { endpointAdjacency } from './axes-adjacency.js';
import {
  chordInsideCircle,
  lineBearingDeg,
  localBearingDeg,
  nearestOn,
  sectorOf,
  undirectedDeltaDeg,
} from './axes-geometry.js';

/** Au-delà, deux morceaux ne décrivent plus la même droite (engine : `PHASE1_SEGMENT_BEARING_BAND_DEG`). */
export const AXIS_ORIENTATION_BAND_DEG = 45;

/** Un tronçon d'axe, sa direction vue de l'arrêt, et sa distance. */
export interface PlacedAxisWay {
  readonly way: RoadWay;
  readonly sector: number;
  readonly distanceM: number;
  readonly at: GeoPoint;
  readonly azimuthDeg: number;
}

/**
 * Le réseau préparé une fois pour toutes : chaque tronçon placé, et qui touche
 * qui. Les anneaux successifs le relisent sans le reconstruire — c'est ce qui
 * rend la montée jusqu'à 15 km tenable.
 */
export interface AxisNetwork {
  readonly stop: GeoPoint;
  readonly sectorCount: number;
  readonly placed: readonly PlacedAxisWay[];
  readonly byId: ReadonlyMap<string, PlacedAxisWay>;
  readonly adjacency: ReadonlyMap<string, readonly string[]>;
}

interface Encounter {
  readonly sector: number;
  readonly ringM: number;
  wayIds: string[];
}

/**
 * Les anneaux utiles pour un rayon : ceux qui tiennent dedans, et le rayon
 * lui-même quand il en dépasse au moins un.
 *
 * **Aucun anneau sous le rayon rend une liste VIDE**, et non « le rayon tout
 * seul » : une liste d'anneaux qui ne descendrait pas jusqu'au rayon demandé
 * ne peut rien servir, et l'inventer ferait rentrer par la fenêtre un anneau
 * que la policy n'a pas écrit. Avec la liste livrée (50 m d'abord), le cas ne
 * se présente pas — c'est une garde, pas un chemin.
 */
export function ringsUpTo(ringsM: readonly number[], radiusM: number): readonly number[] {
  const kept = ringsM.filter((r) => r <= radiusM);
  if (kept.length === 0) return [];
  const last = kept[kept.length - 1];
  return last === radiusM ? kept : [...kept, radiusM].sort((a, b) => a - b);
}

/** Les secteurs d'une passe : les pairs, puis les impairs (règle de l'engine). */
export function sectorsForPass(pass: 'pairs' | 'impairs', sectorCount: number): readonly number[] {
  const start = pass === 'pairs' ? 0 : 1;
  return Array.from({ length: Math.ceil(sectorCount / 2) }, (_, i) => start + i * 2).filter(
    (s) => s < sectorCount,
  );
}

/** Place chaque tronçon autour de l'arrêt et noue le graphe des bouts. Une fois. */
export function prepareAxisNetwork(
  stop: GeoPoint,
  ways: readonly RoadWay[],
  sectorCount: number,
): AxisNetwork {
  const placed: PlacedAxisWay[] = [];
  for (const way of ways) {
    if (way.geometry.length < 2 || way.importance === null) continue;
    const near = nearestOn(way.geometry, stop);
    if (near === null) continue;
    // À moins d'un mètre, l'azimut n'a pas de sens : l'arrêt EST sur l'axe.
    const azimuthDeg = near.distanceM <= 1 ? 0 : bearingDeg(stop, near.point);
    placed.push({
      way,
      sector: near.distanceM <= 1 ? 0 : sectorOf(azimuthDeg, sectorCount),
      distanceM: near.distanceM,
      at: near.point,
      azimuthDeg,
    });
  }
  return {
    stop,
    sectorCount,
    placed,
    byId: new Map(placed.map((p) => [p.way.id, p])),
    adjacency: endpointAdjacency(placed.map((p) => p.way)),
  };
}

/**
 * Les axes retenus dans un rayon donné, du plus proche au plus lointain.
 *
 * Pure : le réseau a déjà été préparé, cette fonction ne fait que choisir.
 */
export function findAxisCorridors(
  network: AxisNetwork,
  radiusM: number,
  ringsM: readonly number[],
): readonly AxisCorridor[] {
  const encounters: Encounter[] = [];
  const retained = new Set<string>();
  const closed = new Set<number>();

  for (const pass of ['pairs', 'impairs'] as const) {
    for (const ringM of ringsUpTo(ringsM, radiusM)) {
      for (const sector of sectorsForPass(pass, network.sectorCount)) {
        scanSector({ network, radiusM, sector, ringM, encounters, retained, closed });
      }
    }
  }

  return encounters
    .map((encounter) => corridorOf(encounter, network, radiusM))
    .filter((corridor): corridor is AxisCorridor => corridor !== null)
    .sort((a, b) => a.closestDistanceM - b.closestDistanceM || a.id.localeCompare(b.id));
}

/**
 * Un secteur à un anneau : une graine, son axe, et la fermeture du secteur.
 *
 * Sortie de la triple boucle pour tenir la borne d'imbrication du cliquet
 * (principe 26). Le secteur ne se ferme qu'au DERNIER anneau : c'est
 * `shouldCloseSectorAfterRing` de l'engine, et c'est ce qui permet à un secteur
 * muet à 500 m de rendre un axe à 5 km.
 */
function scanSector(params: {
  readonly network: AxisNetwork;
  readonly radiusM: number;
  readonly sector: number;
  readonly ringM: number;
  readonly encounters: Encounter[];
  readonly retained: Set<string>;
  readonly closed: Set<number>;
}): void {
  const { network, radiusM, sector, ringM, encounters, retained, closed } = params;
  if (closed.has(sector)) return;
  const seed = seedFor(network.placed, sector, ringM, retained);
  if (seed !== null) {
    const expanded = expand(seed, network, radiusM);
    for (const part of expanded) retained.add(part.way.id);
    absorb(encounters, expanded, sector, ringM);
  }
  if (ringM >= radiusM) closed.add(sector);
}

/** Le tronçon le plus proche du secteur, dans l'anneau, que rien n'a encore retenu. */
function seedFor(
  placed: readonly PlacedAxisWay[],
  sector: number,
  ringM: number,
  retained: ReadonlySet<string>,
): PlacedAxisWay | null {
  let best: PlacedAxisWay | null = null;
  for (const p of placed) {
    if (p.sector !== sector || p.distanceM > ringM || retained.has(p.way.id)) continue;
    const closer = best === null || p.distanceM < best.distanceM;
    const tie = best !== null && p.distanceM === best.distanceM && p.way.id < best.way.id;
    if (closer || tie) best = p;
  }
  return best;
}

/** La graine et tout ce qui la prolonge : même importance, même droite, dans la fenêtre axiale. */
function expand(
  seed: PlacedAxisWay,
  network: AxisNetwork,
  radiusM: number,
): readonly PlacedAxisWay[] {
  const axialLimitM = radiusM / 2;
  const seedBearing = localBearingDeg(seed.way.geometry, seed.at);
  const visited = new Set<string>();
  const queue: string[] = [seed.way.id];
  const kept: PlacedAxisWay[] = [];

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || visited.has(id)) continue;
    const current = network.byId.get(id);
    if (current === undefined) continue;
    visited.add(id);
    if (!prolongs(current, seed, seedBearing, axialLimitM, radiusM)) continue;
    kept.push(current);
    for (const neighbour of network.adjacency.get(id) ?? []) {
      if (!visited.has(neighbour)) queue.push(neighbour);
    }
  }
  return kept;
}

/** Un tronçon prolonge-t-il la graine : même classe, même droite, dans la fenêtre. */
function prolongs(
  current: PlacedAxisWay,
  seed: PlacedAxisWay,
  seedBearing: number,
  axialLimitM: number,
  radiusM: number,
): boolean {
  if (current.way.importance !== seed.way.importance) return false;
  if (current.distanceM > radiusM) return false;
  if (alongAxisM(seed.at, current.at, seedBearing) > axialLimitM) return false;
  const bearing = localBearingDeg(current.way.geometry, current.at);
  return undirectedDeltaDeg(bearing, seedBearing) <= AXIS_ORIENTATION_BAND_DEG;
}

/** Distance de la graine au tronçon LE LONG de l'axe ; infinie hors de la bande d'orientation. */
function alongAxisM(seedAt: GeoPoint, at: GeoPoint, seedBearing: number): number {
  const distanceM = haversineM(seedAt, at);
  if (distanceM < 1) return 0;
  return undirectedDeltaDeg(bearingDeg(seedAt, at), seedBearing) > AXIS_ORIENTATION_BAND_DEG
    ? Number.POSITIVE_INFINITY
    : distanceM;
}

/**
 * Range les tronçons d'une graine dans un axe — en fusionnant ceux qui en
 * touchent déjà un (règle `mergeEncountersOverlappingSegmentIds`).
 */
function absorb(
  encounters: Encounter[],
  expanded: readonly PlacedAxisWay[],
  sector: number,
  ringM: number,
): void {
  if (expanded.length === 0) return;
  const ids = new Set(expanded.map((p) => p.way.id));
  const touched = encounters.filter((e) => e.wayIds.some((id) => ids.has(id)));
  if (touched.length === 0) {
    encounters.push({ sector, ringM, wayIds: [...ids].sort() });
    return;
  }
  const host = touched[0];
  if (host === undefined) return;
  const merged = new Set([...ids, ...touched.flatMap((e) => e.wayIds)]);
  for (const other of touched.slice(1)) {
    const index = encounters.indexOf(other);
    if (index >= 0) encounters.splice(index, 1);
  }
  host.wayIds = [...merged].sort();
}

/** Un axe publiable : son étiquette, sa corde la plus longue, son orientation. */
function corridorOf(
  encounter: Encounter,
  network: AxisNetwork,
  radiusM: number,
): AxisCorridor | null {
  const parts = encounter.wayIds
    .map((id) => network.byId.get(id))
    .filter((p): p is PlacedAxisWay => p !== undefined);
  const anchor = parts.reduce<PlacedAxisWay | null>(
    (best, p) => (best === null || p.distanceM < best.distanceM ? p : best),
    null,
  );
  if (anchor === null || anchor.way.importance === null) return null;

  const longest = parts.reduce<PlacedAxisWay>((best, p) => {
    const here = polylineLengthM(chordInsideCircle(p.way.geometry, network.stop, radiusM));
    const there = polylineLengthM(chordInsideCircle(best.way.geometry, network.stop, radiusM));
    return here > there ? p : best;
  }, anchor);
  const geometry = chordInsideCircle(longest.way.geometry, network.stop, radiusM);

  return {
    id: `axis-${anchor.way.id}`,
    label: anchor.way.name ?? anchor.way.tags['nature'] ?? `BD TOPO ${anchor.way.id.slice(-8)}`,
    importance: anchor.way.importance,
    wayIds: encounter.wayIds,
    sector: anchor.sector,
    discoveryRingM: encounter.ringM,
    closestDistanceM: anchor.distanceM,
    azimuthDeg: anchor.azimuthDeg,
    axisBearingDeg: lineBearingDeg(geometry),
    geometry,
  };
}
