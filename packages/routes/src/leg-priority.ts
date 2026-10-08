/**
 * S3 — dans quel ordre payer les corridors.
 *
 * Décision produit : « prioriser les itinéraires qui paraissent les plus
 * certains ; ça doit impacter l'organisation des lots de 4 ou 8 qui partent en
 * concurrence. »
 *
 * Trois indices, et ils sont **gratuits** : ils se lisent sur le tracé qu'OSRM
 * vient de rendre et sur le réseau structurant que R0 a déjà chargé pour
 * placer ses ancres. Aucun appel réseau, aucun corridor — c'est la condition
 * pour que le tri puisse décider de l'ordre des corridors.
 *
 *  1. **Les virages serrés du tracé.** Un itinéraire qui tourne beaucoup a
 *     beaucoup d'occasions de poser une question : `points/turns.ts` compte
 *     les virages à plus de `minDeflectionDeg` (60° en policy) et c'est le
 *     même seuil qui sert ici, sur la géométrie brute.
 *  2. **La classe de la voie d'origine.** Une jambe qui part d'une primaire
 *     est plus plausible pour un camion qu'une jambe qui part d'un
 *     lotissement ; c'est l'échelle de `discovery.ts`, lue une seule fois
 *     (`highwayRankOf`).
 *  3. **La longueur hors réseau structurant.** Ce qui coûte des questions,
 *     c'est le réseau local. On l'approxime par la longueur parcourue après le
 *     dernier sommet encore accroché au réseau structurant.
 *
 * Ce module est **pur** et ne décide de rien d'autre que d'un ordre : le même
 * ensemble de jambes rend le même ensemble de candidats, quel que soit l'ordre
 * de départ. Le test d'or de `packages/pipeline` en est le juge.
 */
import type { GeoPoint, LegPriority } from '@teneolog/domain';
import {
  bearingDeg,
  bearingDeltaDeg,
  closestPointOnPolyline,
  haversineM,
  isDrivableWay,
  type RoadNeighbourhood,
  type RoadWay,
} from '@teneolog/topology';

import { highwayRankOf } from './discovery.js';
import { isStructuringWay } from './gates.js';

/** Une jambe réduite à ce que le tri regarde. */
export interface LegShape {
  readonly id: string;
  readonly direction: 'in' | 'out';
  /** Le tracé tel qu'OSRM l'a rendu, dans son sens de parcours. */
  readonly polyline: readonly GeoPoint[];
}

export interface LegPriorityInput {
  readonly legs: readonly LegShape[];
  /** Le voisinage structurant que R0 a déjà chargé — jamais refetché ici. */
  readonly neighbourhood: RoadNeighbourhood;
  /** Angle au-delà duquel un changement de cap est un virage serré. */
  readonly minTurnDeg: number;
  /** Longueur minimale d'un tronçon pour que son cap compte. */
  readonly minSegmentM: number;
  /** Distance au-delà de laquelle un sommet n'est plus sur le réseau structurant. */
  readonly snapM: number;
  /** Taille d'un lot de concurrence — ce qui donne à chaque jambe son `batch`. */
  readonly batchSize: number;
}

/**
 * Les jambes, triées de la plus certaine à la moins certaine.
 *
 * L'ordre : moins de virages serrés, puis plus structurante, puis moins de
 * réseau local, puis plus courte — et l'identifiant en dernier recours, pour
 * qu'un run rejoué donne le même ordre que le précédent.
 */
export function orderLegsByCertainty(input: LegPriorityInput): readonly LegPriority[] {
  const structuring = indexOf(
    input.neighbourhood.ways.filter((way) => isDrivableWay(way) && isStructuringWay(way)),
    input.snapM,
  );

  const measured = input.legs.map((leg) => {
    // L'origine d'une jambe, c'est le bout LOIN du point de livraison : le
    // départ d'une entrante, l'arrivée d'une sortante. Les deux se lisent au
    // même endroit une fois la ligne orientée vers l'extérieur.
    const outward = leg.direction === 'in' ? [...leg.polyline].reverse() : [...leg.polyline];
    return {
      id: leg.id,
      direction: leg.direction,
      sharpTurns: countSharpTurns(leg.polyline, input.minSegmentM, input.minTurnDeg),
      highwayRank: rankAtOrigin(outward, structuring, input.snapM),
      offStructuringM: offStructuringLengthM(outward, structuring, input.snapM),
      lengthM: lengthOf(leg.polyline),
    };
  });

  const sorted = [...measured].sort((a, b) => {
    if (a.sharpTurns !== b.sharpTurns) return a.sharpTurns - b.sharpTurns;
    if (a.highwayRank !== b.highwayRank) return a.highwayRank - b.highwayRank;
    if (a.offStructuringM !== b.offStructuringM) return a.offStructuringM - b.offStructuringM;
    if (a.lengthM !== b.lengthM) return a.lengthM - b.lengthM;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const batchSize = Math.max(1, input.batchSize);
  return sorted.map((leg, index) => ({
    ...leg,
    rank: index + 1,
    batch: Math.floor(index / batchSize) + 1,
  }));
}

/**
 * Les virages serrés d'un tracé.
 *
 * Les sommets d'OSRM sont serrés (quelques mètres) et un cap mesuré d'un
 * sommet au suivant est du bruit : la ligne est donc réduite à des tronçons
 * d'au moins `minSegmentM`, et c'est entre ces tronçons que l'angle se lit.
 * C'est la même précaution que `projection.plans.headingSpanM` prend pour les
 * caps d'arrivée et de départ, à l'échelle du tracé entier.
 */
export function countSharpTurns(
  polyline: readonly GeoPoint[],
  minSegmentM: number,
  minTurnDeg: number,
): number {
  const bearings: number[] = [];
  let anchor = polyline[0];
  if (anchor === undefined) return 0;
  for (let i = 1; i < polyline.length; i += 1) {
    const point = polyline[i] as GeoPoint;
    if (haversineM(anchor, point) < minSegmentM) continue;
    bearings.push(bearingDeg(anchor, point));
    anchor = point;
  }
  let turns = 0;
  for (let i = 0; i + 1 < bearings.length; i += 1) {
    if (bearingDeltaDeg(bearings[i] as number, bearings[i + 1] as number) > minTurnDeg) turns += 1;
  }
  return turns;
}

/** La classe de la voie sur laquelle la jambe commence, vue depuis l'extérieur. */
function rankAtOrigin(
  outward: readonly GeoPoint[],
  structuring: WayIndex,
  snapM: number,
): number {
  const origin = outward[outward.length - 1];
  if (origin === undefined) return UNKNOWN_RANK;
  const way = structuring.nearest(origin, snapM);
  return way === null ? UNKNOWN_RANK : highwayRankOf(way);
}

/**
 * Ce qui reste à parcourir après le dernier sommet encore accroché au réseau
 * structurant — c'est-à-dire le réseau local que S4 aura à contrôler.
 *
 * Approximation assumée : le voisinage structurant s'arrête au cercle de R0
 * (`gates.searchRadiusM`), donc une jambe qui part de plus loin est comptée
 * comme locale sur tout ce qu'elle fait hors du cercle. Ce n'est pas faux du
 * point de vue du tri — c'est du réseau qu'on n'a pas chargé, donc dont on ne
 * sait rien — et c'est pour ça que l'indice sert à ordonner, jamais à conclure.
 */
function offStructuringLengthM(
  outward: readonly GeoPoint[],
  structuring: WayIndex,
  snapM: number,
): number {
  // `outward` va du point de livraison vers l'extérieur : le dernier sommet
  // structurant rencontré en remontant est le point où le réseau local commence.
  let lastStructuringIndex: number | null = null;
  for (let i = outward.length - 1; i >= 0; i -= 1) {
    if (structuring.nearest(outward[i] as GeoPoint, snapM) !== null) {
      lastStructuringIndex = i;
      break;
    }
  }
  if (lastStructuringIndex === null) return lengthOf(outward);
  return lengthOf(outward.slice(0, lastStructuringIndex + 1));
}

const UNKNOWN_RANK = 9;

/**
 * Un index de grille sur les voies structurantes.
 *
 * Sans lui, chercher la voie la plus proche de chaque sommet d'une jambe
 * coûterait « toutes les voies × tous leurs segments », soit des dizaines de
 * millions de projections pour une adresse dense. Le tri doit être gratuit,
 * sinon il n'a plus de raison d'exister.
 */
interface WayIndex {
  nearest(point: GeoPoint, snapM: number): RoadWay | null;
}

function indexOf(ways: readonly RoadWay[], snapM: number): WayIndex {
  const cellDeg = Math.max((snapM * 4) / 111_320, 1e-5);
  const cells = new Map<string, number[]>();
  const key = (lat: number, lon: number): string =>
    `${Math.floor(lat / cellDeg)},${Math.floor(lon / cellDeg)}`;

  // Chaque SEGMENT est inscrit dans les cases de sa boîte, pas seulement ses
  // sommets : une voie rapide peut faire 500 m entre deux sommets, et un index
  // par sommets la rendrait invisible au milieu.
  ways.forEach((way, index) => {
    const seen = new Set<string>();
    for (let i = 0; i + 1 < way.geometry.length; i += 1) {
      const a = way.geometry[i] as GeoPoint;
      const b = way.geometry[i + 1] as GeoPoint;
      const latMin = Math.floor(Math.min(a.lat, b.lat) / cellDeg);
      const latMax = Math.floor(Math.max(a.lat, b.lat) / cellDeg);
      const lonMin = Math.floor(Math.min(a.lon, b.lon) / cellDeg);
      const lonMax = Math.floor(Math.max(a.lon, b.lon) / cellDeg);
      for (let r = latMin; r <= latMax; r += 1) {
        for (let c = lonMin; c <= lonMax; c += 1) {
          const k = `${r},${c}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const held = cells.get(k);
          if (held === undefined) cells.set(k, [index]);
          else held.push(index);
        }
      }
    }
  });

  return {
    nearest(point, limitM) {
      let best: RoadWay | null = null;
      let bestD = limitM;
      const seen = new Set<number>();
      for (let dLat = -1; dLat <= 1; dLat += 1) {
        for (let dLon = -1; dLon <= 1; dLon += 1) {
          const held = cells.get(key(point.lat + dLat * cellDeg, point.lon + dLon * cellDeg));
          if (held === undefined) continue;
          for (const index of held) {
            if (seen.has(index)) continue;
            seen.add(index);
            const way = ways[index] as RoadWay;
            const closest = closestPointOnPolyline(way.geometry, point);
            if (closest === null || closest.distanceM >= bestD) continue;
            bestD = closest.distanceM;
            best = way;
          }
        }
      }
      return best;
    },
  };
}

function lengthOf(polyline: readonly GeoPoint[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < polyline.length; i += 1) {
    sum += haversineM(polyline[i] as GeoPoint, polyline[i + 1] as GeoPoint);
  }
  return sum;
}
