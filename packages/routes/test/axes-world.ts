/**
 * /434 — LE MONDE DE LABORATOIRE de l'étage axes, en mètres lisibles.
 *
 * Sorti de `axes.test.ts` le 2026-09-15, quand la règle de l'échelle du lieu a
 * eu besoin des mêmes mondes : deux fichiers de tests qui décriraient chacun
 * leur arrêt, leur `way()` et leur source finiraient par ne plus parler du même
 * terrain, et l'A/B des deux règles cesserait de vouloir dire quelque chose.
 * Une seule définition du monde (principe 23), deux jeux de questions.
 */
import type { GeoPoint } from '@teneolog/domain';
import { closestPointOnPolyline, type RoadWay } from '@teneolog/topology';

import type { AxisSourcePort, AxisStageParams } from '../src/index.js';

export const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

/** Un point à `northM` mètres au nord et `eastM` à l'est de l'arrêt. */
export function at(northM: number, eastM: number): GeoPoint {
  return {
    lat: O.lat + northM / M_PER_DEG_LAT,
    lon: O.lon + eastM / (M_PER_DEG_LAT * Math.cos((O.lat * Math.PI) / 180)),
  };
}

export function way(
  id: string,
  geometry: readonly GeoPoint[],
  importance: number,
  overrides: Partial<RoadWay> = {},
): RoadWay {
  return {
    id,
    source: 'bdtopo-postgis',
    nodeIds: geometry.map((_, i) => `${id}:v${i}`),
    geometry,
    name: null,
    importance,
    declaredWidthM: null,
    laneCount: null,
    oneWay: 'no',
    isPrivate: false,
    limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    tags: {},
    ...overrides,
  };
}

export const RINGS = [50, 250, 500, 2_000, 5_000, 10_000, 15_000] as const;

export const PARAMS: AxisStageParams = {
  enabled: true,
  importanceMin: 2,
  importanceMax: 3,
  localImportance: { min: 4, max: 5 },
  ringsM: [...RINGS],
  fetchRadiiM: [500, 5_000, 15_000],
  sectorCount: 12,
  minGateDirections: 2,
  // 60° : deux secteurs de 30°, donc au moins un
  // secteur VIDE entre deux portes pour qu'elles fassent deux directions.
  minDirectionSeparationDeg: 60,
  // la classe 4 dans le cercle, avant d'élargir.
  circleFallbackImportanceMax: 4,
  // PRINCIPE 34 — `gates.searchRadiusM` en prod. Sépare des mondes de moins
  // de 900 m (§79) où presque tout est « dans le cercle » : les cas qui
  // veulent le dépasser posent leur monde au-delà explicitement.
  escalationBoundM: 2_000,
  maxAxisSegmentsPerFetch: 2_000,
  maxLocalSegmentsPerFetch: 500,
  // Large : les sources de laboratoire répondent tout de suite, et le budget a
  // son propre cas, avec sa propre valeur.
  stageTimeoutMs: 60_000,
  localFetchRadiusM: 1_500,
  localFetchSpacingM: 3_500,
  localFetchMaxPointsPerAxis: 6,
  localFetchMaxPoints: 48,
  gateCount: 5,
  // Zéro dans les cas unitaires : les mondes tiennent dans 900 m, et le
  // plancher de production n'y laisserait aucune porte. Il a son propre cas.
  minReachM: 0,
};

/**
 * DEUX DIRECTIONS, C'EST DEUX SECTEURS NON
 * VOISINS. La règle seule, sur des index de secteurs, sans monde autour :
 * c'est elle qui décide de l'arrêt de l'étage et de ce que l'onglet affiche.
 */

/**
 * Une source de laboratoire : elle rend ce qu'on lui met, filtré par rayon et
 * par classe.
 *
 * La distance se mesure à la LIGNE, pas aux sommets — c'est ce que fait
 * `ST_DWithin` sur la géométrie, et c'est ce qui distingue « une route qui
 * passe à 400 m » d'« une route dont les bouts sont à 985 m ». Une source qui
 * ne filtrerait que sur les sommets rendrait le test faux et le code innocent.
 */
export function sourceOf(ways: readonly RoadWay[], calls: string[] = []): AxisSourcePort {
  return {
    fetchByImportance: async (centre, radiusM, range, limit) => {
      calls.push(`${radiusM}:${range.min}-${range.max}`);
      const kept = ways.filter((w) => {
        const importance = w.importance ?? 99;
        if (importance < range.min || importance > range.max) return false;
        const closest = closestPointOnPolyline(w.geometry, centre);
        return closest !== null && closest.distanceM <= radiusM;
      });
      return { ways: kept.slice(0, limit), truncated: kept.length >= limit };
    },
  };
}
