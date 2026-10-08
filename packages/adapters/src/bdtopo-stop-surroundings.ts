/**
 * CE QUI ENTOURE L'ARRÊT, lu dans la BD TOPO : de quoi
 * dire si quelqu'un risque de passer pendant que le camion bloque la rue.
 *
 * Trois lectures, une requête chacune, sur la même pool et le même délai que le
 * cadre bâti (`bdtopo-buildings.ts`) — jamais sur le chemin critique :
 *
 *  - LE DISQUE : combien de MAISONS à moins de `discRadiusM` du point de
 *    livraison (la règle « rural, route locale ») ;
 *  - LA ROUTE : le tronçon BD TOPO le plus proche de l'arrêt, à moins de
 *    `roadSnapM`, et son `importance` (1 à 6) — la classe relevée par l'IGN,
 *    que la rue de livraison ne porte pas : `DeliveryStreet.importance` est le
 *    rang de la classe OSM en prod (`street-selection.ts`), une autre échelle ;
 *  - LE COULOIR, sur une impasse seulement : les maisons à moins de `corridorM`
 *    de l'axe AU-DELÀ de l'arrêt (la règle « personne ne passe »). Les lignes
 *    sont rendues une à une, avec leur centre : c'est la règle
 * (l'API (hors instantané)) qui garde celles dont la projection sur
 *    l'axe tombe au-delà de l'arrêt, et qui écarte le bâtiment livré.
 *
 * UNE MAISON, ici, c'est un BÂTIMENT DESSERVI : une emprise BD TOPO de nature
 * « Indifférenciée » ou « Industriel, agricole ou commercial », d'au moins
 * `houseMinFootprintM2`. La table ingérée n'a que `id`, `nature`, `geom`
 * (relevé du 2026-09-11, `bdtopo-buildings.ts`) : l'usage « Résidentiel » n'y
 * est pas, et « Indifférenciée » est ce que la BD TOPO donne à neuf bâtis sur
 * dix, maisons comprises. Les bâtiments d'activité comptent aussi : dans une
 * zone d'activités, ce sont eux qui font passer du monde (Genas, Auxerre — la
 * première mesure, maisons seules, y fermait la question). Le plancher de
 * surface écarte garages et abris. Une seule définition, posée ici en SQL et
 * lue par les deux règles. Le couloir rend la nature de chaque bâtiment : un
 * bâtiment d'activité au-delà de l'arrêt ne se compte pas en maisons (revue du
 * 2026-09-28 : Auxerre, Egly), c'est la règle A qui le lit.
 *
 * Comme les autres lectures du bâti : un échec rend une inconnue nommée, jamais
 * un zéro (principe 14) — « aucune maison » et « pas lu » ne se confondent pas.
 */
import type { GeoPoint } from '@teneolog/domain';

import type { BuildingsUnknown } from './bdtopo-buildings.js';
import { DEFAULT_STATEMENT_GRACE_MS, isStatementTimeout } from './bdtopo-pool.js';
import { bboxPaddingDeg, type SqlClient } from './bdtopo.js';

export interface StopSurroundingsRequest {
  /** Le point de livraison : le centre du disque. */
  readonly point: GeoPoint;
  /** L'arrêt : là où se cherche la route. */
  readonly stop: GeoPoint;
  /** L'axe de l'impasse de l'arrêt jusqu'au bout ; null hors impasse (pas de couloir lu). */
  readonly beyondAxis: readonly GeoPoint[] | null;
  readonly discRadiusM: number;
  readonly corridorM: number;
  readonly houseMinFootprintM2: number;
  readonly roadSnapM: number;
  /** Une garde sur le couloir : au-delà, la lecture est dite coupée. */
  readonly corridorLimit: number;
}

export interface CorridorHouse {
  readonly centroid: GeoPoint;
  readonly footprintM2: number;
  /** Distance de l'emprise au point de livraison — de quoi reconnaître le bâtiment livré. */
  readonly distanceToPointM: number;
  /** La nature BD TOPO : l'une de `SERVED_NATURES`. */
  readonly nature: string;
}

export interface StopSurroundings {
  readonly housesWithin: number;
  readonly discRadiusM: number;
  /** Le tronçon le plus proche de l'arrêt ; null : aucun à moins de `roadSnapM`. */
  readonly road: { readonly importance: number | null; readonly nature: string | null; readonly distanceM: number } | null;
  /** Null quand aucun axe n'a été donné — pas « aucune maison ». */
  readonly corridor: {
    readonly houses: readonly CorridorHouse[];
    readonly corridorM: number;
    readonly truncated: boolean;
  } | null;
  readonly houseMinFootprintM2: number;
  readonly queryMs: number;
}

export type StopSurroundingsReading =
  | { readonly known: true; readonly value: StopSurroundings }
  | { readonly known: false; readonly why: BuildingsUnknown; readonly queryMs: number | null };

export interface StopSurroundingsPort {
  stopSurroundings(request: StopSurroundingsRequest): Promise<StopSurroundingsReading>;
}

/** La nature BD TOPO d'un bâtiment d'activité — usine, entrepôt, commerce, hangar agricole, sans distinction. */
export const ACTIVITY_NATURE = 'Industriel, agricole ou commercial';
/** Les natures BD TOPO d'un bâtiment desservi dans la table ingérée (voir l'en-tête). */
export const SERVED_NATURES = ['Indifférenciée', ACTIVITY_NATURE] as const;
const NATURE_FILTER = `b.nature IN (${SERVED_NATURES.map((n) => `'${n}'`).join(', ')})`;

/** $1 lon, $2 lat, $3 rayon, $4 marge bbox, $5 surface mini. */
export const DISC_HOUSES_SQL = `
WITH p AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom)
SELECT count(*)::int AS houses
FROM bdtopo.buildings b, p
WHERE b.geom && ST_Expand(p.geom, $4)
  AND ST_DWithin(b.geom::geography, p.geom::geography, $3)
  AND ${NATURE_FILTER}
  AND ST_Area(b.geom::geography) >= $5
`;

/** $1 lon, $2 lat (l'arrêt), $3 rayon, $4 marge bbox. */
export const NEAREST_ROAD_SQL = `
WITH s AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom)
SELECT r.importance, r.nature, ST_Distance(r.geom::geography, s.geom::geography) AS distance_m
FROM bdtopo.roads r, s
WHERE r.geom && ST_Expand(s.geom, $4)
  AND ST_DWithin(r.geom::geography, s.geom::geography, $3)
ORDER BY r.geom <-> s.geom
LIMIT 1
`;

/** $1 axe GeoJSON, $2 couloir, $3 marge bbox, $4 surface mini, $5 limite, $6 lon, $7 lat (le point). */
export const CORRIDOR_HOUSES_SQL = `
WITH l AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom),
     p AS (SELECT ST_SetSRID(ST_MakePoint($6, $7), 4326) AS geom)
SELECT ST_X(ST_Centroid(b.geom)) AS lon, ST_Y(ST_Centroid(b.geom)) AS lat,
       ST_Area(b.geom::geography) AS area_m2,
       ST_Distance(b.geom::geography, p.geom::geography) AS distance_m, b.nature
FROM bdtopo.buildings b, l, p
WHERE b.geom && ST_Expand(l.geom, $3)
  AND ST_DWithin(b.geom::geography, l.geom::geography, $2)
  AND ${NATURE_FILTER}
  AND ST_Area(b.geom::geography) >= $4
LIMIT $5
`;

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** L'axe en GeoJSON LineString, tel que `ST_GeomFromGeoJSON` le lit. */
export function lineStringOf(axis: readonly GeoPoint[]): string {
  return JSON.stringify({ type: 'LineString', coordinates: axis.map((p) => [p.lon, p.lat]) });
}

/** Des lignes SQL à la lecture publiée — testable sans base. */
export function mapStopSurroundings(
  rows: {
    readonly disc: readonly unknown[];
    readonly road: readonly unknown[];
    readonly corridor: readonly unknown[] | null;
  },
  request: Pick<StopSurroundingsRequest, 'discRadiusM' | 'corridorM' | 'houseMinFootprintM2' | 'corridorLimit'>,
  queryMs: number,
): StopSurroundings {
  const disc = rows.disc[0] as Record<string, unknown> | undefined;
  const road = rows.road[0] as Record<string, unknown> | undefined;
  const roadDistance = num(road?.['distance_m']);
  const corridor =
    rows.corridor === null
      ? null
      : {
          houses: rows.corridor.slice(0, request.corridorLimit).flatMap((raw): CorridorHouse[] => {
            const r = raw as Record<string, unknown>;
            const lat = num(r['lat']);
            const lon = num(r['lon']);
            const area = num(r['area_m2']);
            const d = num(r['distance_m']);
            const nature = typeof r['nature'] === 'string' ? r['nature'] : null;
            if (lat === null || lon === null || area === null || d === null || nature === null) return [];
            return [{ centroid: { lat, lon }, footprintM2: Math.round(area), distanceToPointM: Math.round(d * 10) / 10, nature }];
          }),
          corridorM: request.corridorM,
          truncated: rows.corridor.length > request.corridorLimit,
        };
  return {
    housesWithin: num(disc?.['houses']) ?? 0,
    discRadiusM: request.discRadiusM,
    road:
      road === undefined || roadDistance === null
        ? null
        : {
            importance: num(road['importance']),
            nature: typeof road['nature'] === 'string' ? road['nature'] : null,
            distanceM: Math.round(roadDistance * 10) / 10,
          },
    corridor,
    houseMinFootprintM2: request.houseMinFootprintM2,
    queryMs,
  };
}

/** Les trois requêtes, en parallèle, sous le même budget que le cadre bâti. */
export async function fetchStopSurroundings(
  sql: SqlClient,
  request: StopSurroundingsRequest,
  timeoutMs: number,
): Promise<StopSurroundingsReading> {
  const started = Date.now();
  const opts = { timeoutMs };
  const { point, stop, beyondAxis } = request;
  const disc = sql.query(
    DISC_HOUSES_SQL,
    [point.lon, point.lat, request.discRadiusM, bboxPaddingDeg(request.discRadiusM, point.lat), request.houseMinFootprintM2],
    opts,
  );
  const road = sql.query(
    NEAREST_ROAD_SQL,
    [stop.lon, stop.lat, request.roadSnapM, bboxPaddingDeg(request.roadSnapM, stop.lat)],
    opts,
  );
  const corridor =
    beyondAxis === null || beyondAxis.length < 2
      ? Promise.resolve(null)
      : sql.query(
          CORRIDOR_HOUSES_SQL,
          [
            lineStringOf(beyondAxis),
            request.corridorM,
            bboxPaddingDeg(request.corridorM, stop.lat),
            request.houseMinFootprintM2,
            request.corridorLimit + 1,
            point.lon,
            point.lat,
          ],
          opts,
        );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      Promise.all([disc, road, corridor]).then(([d, r, c]) => ({ kind: 'rows' as const, d, r, c })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs + DEFAULT_STATEMENT_GRACE_MS);
      }),
    ]);
    if (raced.kind === 'timeout') return { known: false, why: 'timeout', queryMs: Date.now() - started };
    const rows = { disc: raced.d.rows, road: raced.r.rows, corridor: raced.c === null ? null : raced.c.rows };
    return { known: true, value: mapStopSurroundings(rows, request, Date.now() - started) };
  } catch (error) {
    const queryMs = Date.now() - started;
    return { known: false, why: isStatementTimeout(error) ? 'timeout' : 'provider_error', queryMs };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
