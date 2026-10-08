/**
 * ce qui entoure l'arrêt : les trois requêtes, leurs paramètres, la
 * lecture des lignes, la coupe du couloir et les échecs. Aucune base : le
 * client SQL est un bouchon, comme pour le cadre bâti.
 */
import { describe, expect, it } from 'vitest';

import { BdtopoBuildings } from '../src/bdtopo-buildings.js';
import {
  ACTIVITY_NATURE,
  CORRIDOR_HOUSES_SQL,
  DISC_HOUSES_SQL,
  fetchStopSurroundings,
  lineStringOf,
  mapStopSurroundings,
  NEAREST_ROAD_SQL,
  type StopSurroundingsRequest,
} from '../src/bdtopo-stop-surroundings.js';
import type { SqlClient, SqlQueryOptions } from '../src/bdtopo.js';

const POINT = { lat: 46.372455, lon: -0.256067 };
const STOP = { lat: 46.37246, lon: -0.25607 };
const AXIS = [STOP, { lat: 46.3735, lon: -0.2573 }];

const REQUEST: StopSurroundingsRequest = {
  point: POINT,
  stop: STOP,
  beyondAxis: AXIS,
  discRadiusM: 300,
  corridorM: 30,
  houseMinFootprintM2: 40,
  roadSnapM: 25,
  corridorLimit: 2,
};

interface Call {
  readonly text: string;
  readonly params: readonly unknown[];
  readonly options: SqlQueryOptions | undefined;
}

function stubSql(rowsFor: (text: string) => readonly unknown[] | Error): SqlClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    query(text: string, params: readonly unknown[], options?: SqlQueryOptions) {
      calls.push({ text, params, options });
      const rows = rowsFor(text);
      return rows instanceof Error ? Promise.reject(rows) : Promise.resolve({ rows });
    },
  };
}

const ROWS = (text: string): readonly unknown[] => {
  if (text === DISC_HOUSES_SQL) return [{ houses: '14' }];
  if (text === NEAREST_ROAD_SQL) return [{ importance: '5', nature: 'Route à 1 chaussée', distance_m: 2.34 }];
  return [{ lon: -0.2564, lat: 46.3728, area_m2: 132.6, distance_m: 38.04, nature: 'Indifférenciée' }];
};

describe('fetchStopSurroundings', () => {
  it('trois requêtes sous le même budget, la maison définie une fois (nature + surface)', async () => {
    const sql = stubSql(ROWS);
    const r = await fetchStopSurroundings(sql, REQUEST, 1500);
    expect(sql.calls.map((c) => c.text)).toEqual([DISC_HOUSES_SQL, NEAREST_ROAD_SQL, CORRIDOR_HOUSES_SQL]);
    expect(sql.calls.every((c) => c.options?.timeoutMs === 1500)).toBe(true);
    expect(sql.calls[0]?.params[4]).toBe(40);
    expect(sql.calls[2]?.params[0]).toBe(lineStringOf(AXIS));
    expect(sql.calls[2]?.params[4]).toBe(3); // limite + 1 : la ligne de trop dit la coupe
    const natures = "b.nature IN ('Indifférenciée', 'Industriel, agricole ou commercial')";
    expect(DISC_HOUSES_SQL).toContain(natures);
    expect(CORRIDOR_HOUSES_SQL).toContain(natures);
    expect(r).toMatchObject({
      known: true,
      value: {
        housesWithin: 14,
        road: { importance: 5, nature: 'Route à 1 chaussée', distanceM: 2.3 },
        corridor: {
          houses: [{ centroid: { lat: 46.3728, lon: -0.2564 }, footprintM2: 133, distanceToPointM: 38, nature: 'Indifférenciée' }],
          corridorM: 30,
          truncated: false,
        },
      },
    });
  });

  it('hors impasse : pas de couloir lu — null, pas « aucune maison »', async () => {
    const sql = stubSql(ROWS);
    const r = await fetchStopSurroundings(sql, { ...REQUEST, beyondAxis: null }, 1500);
    expect(sql.calls).toHaveLength(2);
    expect(r.known && r.value.corridor).toBeNull();
  });

  it('une base en panne rend une inconnue nommée', async () => {
    const r = await fetchStopSurroundings(stubSql(() => new Error('boom')), REQUEST, 1500);
    expect(r).toMatchObject({ known: false, why: 'provider_error' });
  });

  it('le port passe par BdtopoBuildings, même pool, même délai', async () => {
    const sql = stubSql(ROWS);
    const port = new BdtopoBuildings(sql, { densityRadiusM: 200, buildingRadiusM: 40, timeoutMs: 900 });
    const r = await port.stopSurroundings(REQUEST);
    expect(r.known).toBe(true);
    expect(sql.calls.every((c) => c.options?.timeoutMs === 900)).toBe(true);
  });
});

describe('mapStopSurroundings', () => {
  it('coupe le couloir à la limite et le dit ; aucun tronçon proche = road null', () => {
    const row = { lon: 0, lat: 0, area_m2: 50, distance_m: 10, nature: 'Indifférenciée' };
    const v = mapStopSurroundings({ disc: [{ houses: 3 }], road: [], corridor: [row, row, row] }, REQUEST, 5);
    expect(v.road).toBeNull();
    expect(v.corridor).toMatchObject({ truncated: true });
    expect(v.corridor?.houses).toHaveLength(2);
  });

  it('une ligne illisible du couloir est écartée, pas inventée', () => {
    const v = mapStopSurroundings({ disc: [{ houses: 0 }], road: [], corridor: [{ lon: 'x', lat: 1, area_m2: 50, distance_m: 1, nature: 'Indifférenciée' }] }, REQUEST, 5);
    expect(v.corridor?.houses).toEqual([]);
    expect(v.housesWithin).toBe(0);
  });

  it('chaque bâtiment du couloir porte sa nature : un bâtiment d’activité se reconnaît (revue du 28/09, Auxerre)', () => {
    expect(CORRIDOR_HOUSES_SQL).toContain('b.nature');
    const activity = { lon: 3.6207, lat: 47.803, area_m2: 12303.4, distance_m: 5.85, nature: ACTIVITY_NATURE };
    const noNature = { lon: 3.6207, lat: 47.803, area_m2: 115, distance_m: 22.6 };
    const v = mapStopSurroundings({ disc: [{ houses: 2 }], road: [], corridor: [activity, noNature] }, REQUEST, 5);
    expect(v.corridor?.houses).toEqual([
      { centroid: { lat: 47.803, lon: 3.6207 }, footprintM2: 12303, distanceToPointM: 5.9, nature: 'Industriel, agricole ou commercial' },
    ]);
  });
});
