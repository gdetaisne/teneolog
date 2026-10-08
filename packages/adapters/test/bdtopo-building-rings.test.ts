/**
 * les emprises du bâti de la carte du demi-tour : le SQL, sa
 * lecture, sa coupe et ses échecs. Aucune base : le client SQL est un
 * bouchon, comme pour le cadre bâti (`bdtopo-buildings.test.ts`).
 */
import { describe, expect, it } from 'vitest';

import {
  exteriorRingsOfGeoJson,
  fetchBuildingRings,
  mapBuildingRingsRows,
} from '../src/bdtopo-building-rings.js';
import { BdtopoBuildings } from '../src/bdtopo-buildings.js';
import { DEFAULT_STATEMENT_GRACE_MS } from '../src/bdtopo-pool.js';
import { bboxPaddingDeg, type SqlClient, type SqlQueryOptions } from '../src/bdtopo.js';

const SEVREMOINE = { lat: 47.125714, lon: -0.946111 };

interface SqlCall {
  readonly text: string;
  readonly params: readonly unknown[];
  readonly options: SqlQueryOptions | undefined;
}

function stubSql(rows: readonly unknown[]): SqlClient & { calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  return {
    calls,
    query(text: string, params: readonly unknown[], options?: SqlQueryOptions) {
      calls.push({ text, params, options });
      return Promise.resolve({ rows });
    },
  };
}

/** Un carré de 10 m (fermé, comme PostGIS le rend) avec une cour intérieure. */
const MULTI = JSON.stringify({
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [-0.9461, 47.1257],
        [-0.9460, 47.1257],
        [-0.9460, 47.1258],
        [-0.9461, 47.1258],
        [-0.9461, 47.1257],
      ],
      [
        [-0.94608, 47.12572],
        [-0.94602, 47.12572],
        [-0.94602, 47.12578],
        [-0.94608, 47.12572],
      ],
    ],
    [
      [
        [-0.9459, 47.1259],
        [-0.9458, 47.1259],
        [-0.9458, 47.126],
        [-0.9459, 47.1259],
      ],
    ],
  ],
});

describe('exteriorRingsOfGeoJson — l’anneau extérieur de chaque emprise, en lat/lon', () => {
  it('MultiPolygon : un anneau par polygone, sans la cour, sans le sommet de fermeture, lon/lat → lat/lon', () => {
    const rings = exteriorRingsOfGeoJson(MULTI);
    expect(rings).toHaveLength(2);
    expect(rings[0]).toEqual([
      { lat: 47.1257, lon: -0.9461 },
      { lat: 47.1257, lon: -0.9460 },
      { lat: 47.1258, lon: -0.9460 },
      { lat: 47.1258, lon: -0.9461 },
    ]);
    expect(rings[1]).toHaveLength(3);
  });

  it('Polygon simple accepté ; un texte illisible, une autre géométrie, un anneau dégénéré → rien d’inventé', () => {
    const square = JSON.stringify({ type: 'Polygon', coordinates: [[[1, 47], [1.001, 47], [1.0381, 47.001], [1, 47]]] });
    expect(exteriorRingsOfGeoJson(square)).toHaveLength(1);
    expect(exteriorRingsOfGeoJson('{pas du json')).toEqual([]);
    expect(exteriorRingsOfGeoJson(JSON.stringify({ type: 'Point', coordinates: [1, 47] }))).toEqual([]);
    expect(exteriorRingsOfGeoJson(JSON.stringify({ type: 'Polygon', coordinates: [[[1, 47], [1.001, 47], [1, 47]]] }))).toEqual([]);
    expect(exteriorRingsOfGeoJson(null)).toEqual([]);
  });
});

describe('mapBuildingRingsRows — la coupe dite', () => {
  it('limit + 1 lignes rendues → les `limit` plus proches gardées, truncated: true', () => {
    const rows = [{ geojson: MULTI }, { geojson: MULTI }, { geojson: MULTI }];
    const mapped = mapBuildingRingsRows(rows, { radiusM: 120, limit: 2 }, 9);
    expect(mapped.truncated).toBe(true);
    expect(mapped.rings).toHaveLength(4); // 2 lignes × 2 polygones
    expect(mapped).toMatchObject({ radiusM: 120, queryMs: 9 });
  });

  it('au plus `limit` lignes → truncated: false ; aucune ligne → une liste vide LUE (known), pas une inconnue', () => {
    expect(mapBuildingRingsRows([{ geojson: MULTI }], { radiusM: 120, limit: 2 }, 1).truncated).toBe(false);
    expect(mapBuildingRingsRows([], { radiusM: 120, limit: 2 }, 1)).toEqual({ rings: [], radiusM: 120, truncated: false, queryMs: 1 });
  });
});

describe('fetchBuildingRings — la requête et ses échecs', () => {
  it('SQL : GeoJSON à 6 décimales, ST_DWithin en géographie, préfiltre bbox, les plus proches, LIMIT limit + 1 ; budget serveur', async () => {
    const sql = stubSql([{ geojson: MULTI }]);
    const reading = await fetchBuildingRings(sql, SEVREMOINE, { radiusM: 120, limit: 400, timeoutMs: 1_500 });
    expect(reading.known).toBe(true);
    const call = sql.calls[0];
    expect(call?.text).toContain('ST_AsGeoJSON(b.geom, 6)');
    expect(call?.text).toContain('ST_DWithin(b.geom::geography, q.geom::geography, $3)');
    expect(call?.text).toContain('b.geom && ST_Expand(q.geom, $4)');
    expect(call?.text).toContain('ORDER BY b.geom <-> q.geom');
    expect(call?.params).toEqual([SEVREMOINE.lon, SEVREMOINE.lat, 120, bboxPaddingDeg(120, SEVREMOINE.lat), 401]);
    expect(call?.options).toEqual({ timeoutMs: 1_500 });
  });

  it('base en panne → provider_error ; coupe du serveur (57014) → timeout — jamais une liste vide', async () => {
    const failing = (error: unknown): SqlClient => ({ query: () => Promise.reject(error) });
    const down = await fetchBuildingRings(failing(new Error('ECONNREFUSED')), SEVREMOINE, { radiusM: 120, limit: 400, timeoutMs: 50 });
    expect(down).toMatchObject({ known: false, why: 'provider_error' });
    const cut = await fetchBuildingRings(failing({ code: '57014' }), SEVREMOINE, { radiusM: 120, limit: 400, timeoutMs: 50 });
    expect(cut).toMatchObject({ known: false, why: 'timeout' });
  });

  it('un client qui ignore le budget : le filet coupe à timeoutMs + la grâce', async () => {
    const mute: SqlClient = { query: () => new Promise(() => {}) };
    const started = Date.now();
    const reading = await fetchBuildingRings(mute, SEVREMOINE, { radiusM: 120, limit: 400, timeoutMs: 10 });
    expect(reading).toMatchObject({ known: false, why: 'timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(10 + DEFAULT_STATEMENT_GRACE_MS - 5);
  });

  it('BdtopoBuildings.rings : même client, même délai que le cadre bâti', async () => {
    const sql = stubSql([{ geojson: MULTI }]);
    const port = new BdtopoBuildings(sql, { densityRadiusM: 200, buildingRadiusM: 40, timeoutMs: 1_500 });
    const reading = await port.rings(SEVREMOINE, { radiusM: 120, limit: 400 });
    expect(reading.known && reading.value.rings).toHaveLength(2);
    expect(sql.calls[0]?.options).toEqual({ timeoutMs: 1_500 });
  });
});
