/**
 * LES EMPRISES DU BÂTI autour de l'arrêt, pour la carte du demi-tour
 * (la note de conception interne, `buildings`).
 *
 * La carte montre les bâtis BD TOPO « en filigrane » (la note de conception interne
 * §7) : l'opérateur qui déplace le cercle requis doit voir la façade qu'il mord.
 * Ce n'est PAS une mesure et ce n'est jamais un verdict (principe 39) — la borne
 * haute de l'espace libre entre les façades (D7) est une autre affaire, qui se
 * calculera et se jugera ailleurs, derrière un A/B (principe 17).
 *
 * Une requête, sur la même table et le même index que `bdtopo-buildings.ts` :
 *  - `bdtopo.buildings.geom` est en WGS84 (SRID 4326, MULTIPOLYGON — relevé sur
 *    la base de prod le 2026-09-24), donc `ST_AsGeoJSON` rend déjà des
 *    longitudes/latitudes ; 6 décimales ≈ 0,1 m, plus fin que la BD TOPO ;
 *  - `ST_DWithin` en géographie pour le rayon en mètres, précédé du `&&` sur la
 *    bbox élargie pour que l'index GiST fasse le travail (même raison qu'en
 *    `bdtopo.ts`) ;
 *  - les plus proches d'abord, `LIMIT limit + 1` : la ligne de trop dit que la
 *    liste est COUPÉE, et la carte le dit (`truncated`) au lieu de laisser
 *    croire qu'il n'y a rien au-delà (principe 14).
 *
 * Seul l'anneau EXTÉRIEUR de chaque polygone est rendu : une cour intérieure
 * n'est pas un lieu de demi-tour, et la dessiner ne ferait que charger le fil.
 *
 * Même discipline que la lecture du cadre bâti : le budget part avec
 * la requête (`statement_timeout`), le minuteur n'est que le filet ; une base
 * muette ou lente rend une inconnue nommée, jamais une liste vide — une liste
 * vide dirait « aucun bâti ».
 */
import type { GeoPoint } from '@teneolog/domain';

import type { BuildingsUnknown } from './bdtopo-buildings.js';
import { DEFAULT_STATEMENT_GRACE_MS, isStatementTimeout } from './bdtopo-pool.js';
import { bboxPaddingDeg, type SqlClient } from './bdtopo.js';

export interface BuildingRingsOptions {
  /** Rayon autour du centre, en mètres (policy `turnaroundMap.buildingsRadiusM`). */
  readonly radiusM: number;
  /** Au plus tant d'emprises, les plus proches (policy `turnaroundMap.buildingsLimit`). */
  readonly limit: number;
}

export interface BuildingRings {
  /** L'anneau extérieur de chaque emprise, les plus proches d'abord. */
  readonly rings: readonly (readonly GeoPoint[])[];
  readonly radiusM: number;
  /** Vrai quand `limit` a coupé la liste : il y a d'autres bâtis dans le rayon. */
  readonly truncated: boolean;
  readonly queryMs: number;
}

/** Même enveloppe que `BuildingsReading` : une inconnue a sa cause, jamais un tableau vide. */
export type BuildingRingsReading =
  | { readonly known: true; readonly value: BuildingRings }
  | { readonly known: false; readonly why: BuildingsUnknown; readonly queryMs: number | null };

export interface BuildingRingsPort {
  rings(centre: GeoPoint, options: BuildingRingsOptions): Promise<BuildingRingsReading>;
}

const RINGS_SQL = `
WITH q AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom)
SELECT ST_AsGeoJSON(b.geom, 6) AS geojson
FROM bdtopo.buildings b, q
WHERE b.geom && ST_Expand(q.geom, $4)
  AND ST_DWithin(b.geom::geography, q.geom::geography, $3)
ORDER BY b.geom <-> q.geom
LIMIT $5
`;

type Position = readonly [number, number];

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

/** Un anneau GeoJSON → des points, sans le sommet de fermeture (il répète le premier). */
function ringOf(coordinates: unknown): GeoPoint[] | null {
  if (!Array.isArray(coordinates)) return null;
  const points = coordinates.filter(isPosition).map(([lon, lat]) => ({ lat, lon }));
  const first = points[0];
  const last = points[points.length - 1];
  if (first !== undefined && last !== undefined && points.length > 1 && first.lat === last.lat && first.lon === last.lon) {
    points.pop();
  }
  return points.length >= 3 ? points : null;
}

/**
 * Les anneaux extérieurs d'une géométrie GeoJSON (Polygon ou MultiPolygon).
 * Un texte illisible ou une autre géométrie ne rend rien : une emprise qu'on
 * ne sait pas lire n'est pas dessinée, elle n'est pas inventée.
 */
export function exteriorRingsOfGeoJson(text: unknown): GeoPoint[][] {
  if (typeof text !== 'string') return [];
  let geometry: { readonly type?: unknown; readonly coordinates?: unknown };
  try {
    geometry = JSON.parse(text) as typeof geometry;
  } catch {
    return [];
  }
  const polygons: unknown[] =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)
        ? geometry.coordinates
        : [];
  return polygons
    .map((polygon) => (Array.isArray(polygon) ? ringOf(polygon[0]) : null))
    .filter((ring): ring is GeoPoint[] => ring !== null);
}

/** Des lignes SQL à la lecture publiée — testable sans base. */
export function mapBuildingRingsRows(
  rows: readonly unknown[],
  options: BuildingRingsOptions,
  queryMs: number,
): BuildingRings {
  const kept = rows.slice(0, options.limit);
  return {
    rings: kept.flatMap((row) => exteriorRingsOfGeoJson((row as Record<string, unknown> | null)?.['geojson'])),
    radiusM: options.radiusM,
    truncated: rows.length > options.limit,
    queryMs,
  };
}

/**
 * La lecture, bornée par `timeoutMs` — le délai de la lecture du cadre bâti
 * (policy `buildings.timeoutMs`), puisque les deux partagent la pool et le
 * même bloc asynchrone.
 */
export async function fetchBuildingRings(
  sql: SqlClient,
  centre: GeoPoint,
  options: BuildingRingsOptions & { readonly timeoutMs: number },
): Promise<BuildingRingsReading> {
  const started = Date.now();
  const params = [centre.lon, centre.lat, options.radiusM, bboxPaddingDeg(options.radiusM, centre.lat), options.limit + 1];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      sql.query(RINGS_SQL, params, { timeoutMs: options.timeoutMs }).then((r) => ({ kind: 'rows' as const, rows: r.rows })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), options.timeoutMs + DEFAULT_STATEMENT_GRACE_MS);
      }),
    ]);
    if (raced.kind === 'timeout') return { known: false, why: 'timeout', queryMs: Date.now() - started };
    return { known: true, value: mapBuildingRingsRows(raced.rows, options, Date.now() - started) };
  } catch (error) {
    const queryMs = Date.now() - started;
    return { known: false, why: isStatementTimeout(error) ? 'timeout' : 'provider_error', queryMs };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
