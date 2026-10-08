/**
 * BDTOPO buildings — nearest footprint and built-area ratio. Same PostGIS
 * as `BdtopoRoadGraph`; injected `SqlClient` so the pool stays the app's.
 */
import type { GeoPoint } from '@teneolog/domain';

import { bboxPaddingDeg, type SqlClient } from './bdtopo.js';

export interface BdtopoBuildingHit {
  readonly nature: string | null;
  readonly areaM2: number;
  readonly distanceM: number;
}

export interface BdtopoBuiltEnvironment {
  readonly count: number;
  readonly builtRatio: number;
  readonly meanAreaM2: number | null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const NEAREST_BUILDING_SQL = `
WITH q AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom)
SELECT b.nature,
       ST_Area(b.geom::geography) AS area_m2,
       ST_Distance(b.geom::geography, q.geom::geography) AS distance_m
FROM bdtopo.buildings b, q
WHERE b.geom && ST_Expand(q.geom, $4)
  AND ST_DWithin(b.geom::geography, q.geom::geography, $3)
ORDER BY b.geom <-> q.geom
LIMIT 1
`;

const BUILT_ENV_SQL = `
WITH q AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom)
SELECT count(*)::int AS n,
       coalesce(sum(ST_Area(b.geom::geography)), 0)::float8 AS built_m2
FROM bdtopo.buildings b, q
WHERE b.geom && ST_Expand(q.geom, $4)
  AND ST_DWithin(b.geom::geography, q.geom::geography, $3)
`;

export async function fetchNearestBuilding(
  sql: SqlClient,
  centre: GeoPoint,
  radiusM: number,
): Promise<BdtopoBuildingHit | null> {
  const result = await sql.query(NEAREST_BUILDING_SQL, [
    centre.lon,
    centre.lat,
    radiusM,
    bboxPaddingDeg(radiusM, centre.lat),
  ]);
  const row = result.rows[0] as
    | { nature: string | null; area_m2: unknown; distance_m: unknown }
    | undefined;
  if (row === undefined) return null;
  const areaM2 = toNumber(row.area_m2);
  if (areaM2 === null || areaM2 <= 0) return null;
  return {
    nature: row.nature,
    areaM2: Math.round(areaM2),
    distanceM: toNumber(row.distance_m) ?? 0,
  };
}

export async function fetchBuiltEnvironment(
  sql: SqlClient,
  centre: GeoPoint,
  radiusM: number,
): Promise<BdtopoBuiltEnvironment | null> {
  const result = await sql.query(BUILT_ENV_SQL, [
    centre.lon,
    centre.lat,
    radiusM,
    bboxPaddingDeg(radiusM, centre.lat),
  ]);
  const row = result.rows[0] as { n: unknown; built_m2: unknown } | undefined;
  if (row === undefined) return null;
  const count = toNumber(row.n) ?? 0;
  const builtAreaM2 = toNumber(row.built_m2) ?? 0;
  const discM2 = Math.PI * radiusM * radiusM;
  return {
    count,
    builtRatio: discM2 > 0 ? builtAreaM2 / discM2 : 0,
    meanAreaM2: count > 0 ? Math.round(builtAreaM2 / count) : null,
  };
}
