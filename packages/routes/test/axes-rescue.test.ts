/**
 * LE SAUVETAGE DES JONCTIONS TRONQUÉES (BUG-045 de
 * l'engine), sur les mondes de laboratoire de `axes-world.ts`.
 *
 * Ce qui est jugé : le choix des disques (non couverts, les plus proches de
 * l'arrêt d'abord, espacés, plafonnés), le fait qu'une rue locale coupée par
 * le plafond de lignes redevient une porte, que le sauvetage relit un centre
 * dont le disque large était tronqué, et qu'il ne tourne QUE dans le mode
 * `axes` — la règle de secteurs, servie en prod, n'en sait rien.
 */
import { describe, expect, it } from 'vitest';

import type { AxisCorridor, AxisFetchReport, AxisGate } from '@teneolog/domain';
import { haversineM, type RoadWay } from '@teneolog/topology';

import {
  RESCUE_MAX_POINTS_PER_AXIS,
  uncoveredAxisEnds,
} from '../src/axes-rescue.js';
import { LocalWayPool, type Mutable } from '../src/axes-fetch.js';
import { runAxisStage, type AxisStageParams } from '../src/axes-stage.js';
import { at, O, PARAMS, sourceOf, way } from './axes-world.js';

// ------------------------------------------------------ le choix des disques --

function corridor(id: string, ways: readonly RoadWay[]): AxisCorridor {
  return {
    id,
    label: id,
    importance: 3,
    wayIds: ways.map((w) => w.id),
    sector: 0,
    discoveryRingM: 2_000,
    closestDistanceM: 0,
    azimuthDeg: 0,
    axisBearingDeg: 90,
    geometry: ways.flatMap((w) => w.geometry),
  };
}

function gateOn(axisId: string, site: ReturnType<typeof at>): AxisGate {
  return {
    id: `g-${site.lat}-${site.lon}`,
    at: site,
    inward: site,
    axisId,
    axisWayId: axisId,
    localWayId: 'L',
    label: 'g',
    importance: 3,
    localImportance: 4,
    azimuthDeg: 0,
    distanceM: haversineM(O, site),
    sector: 0,
    rank: null,
    reasonCodes: [],
    uncontrolledBeyondM: null,
  };
}

/** Un axe est-ouest à `northM` au nord de l'arrêt, découpé en tronçons de `stepM`. */
function eastWestAxis(northM: number, fromEastM: number, toEastM: number, stepM: number): RoadWay[] {
  const out: RoadWay[] = [];
  for (let e = fromEastM; e < toEastM; e += stepM) {
    out.push(way(`AX${e}`, [at(northM, e), at(northM, e + stepM)], 3));
  }
  return out;
}

describe('les disques de sauvetage : où, dans quel ordre, combien', () => {
  it('les plus proches de l’arrêt d’abord — pas l’ordre des latitudes de l’engine (écart validé le 2026-09-30)', () => {
    const ways = eastWestAxis(1_000, -2_000, 2_000, 500);
    const axis = corridor('AX', ways);
    const points = uncoveredAxisEnds(axis, new Map(ways.map((w) => [w.id, w])), [], O);
    const distances = points.map((p) => haversineM(O, p));
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    // Le premier est le bout d'axe plein nord, à 1 000 m : le point de l'axe
    // le plus proche de l'adresse.
    expect(distances[0]).toBeCloseTo(1_000, -1);
  });

  it('un bout couvert à moins de 350 m par une porte DE CET AXE n’est pas sauvé', () => {
    const ways = eastWestAxis(1_000, -1_000, 1_000, 500);
    const axis = corridor('AX', ways);
    const byId = new Map(ways.map((w) => [w.id, w]));
    const covered = uncoveredAxisEnds(axis, byId, [gateOn('AX', at(1_000, 100))], O);
    expect(covered.some((p) => haversineM(p, at(1_000, 0)) < 1)).toBe(false);
    // La même porte posée sur un AUTRE axe ne couvre rien ici.
    const other = uncoveredAxisEnds(axis, byId, [gateOn('AUTRE', at(1_000, 100))], O);
    expect(other.some((p) => haversineM(p, at(1_000, 0)) < 1)).toBe(true);
  });

  it('deux disques du même axe sont à 400 m au moins, et jamais plus de dix', () => {
    const ways = eastWestAxis(3_000, -20_000, 20_000, 100);
    const axis = corridor('AX', ways);
    const points = uncoveredAxisEnds(axis, new Map(ways.map((w) => [w.id, w])), [], O);
    expect(points).toHaveLength(RESCUE_MAX_POINTS_PER_AXIS);
    for (const [i, p] of points.entries()) {
      for (const q of points.slice(i + 1)) expect(haversineM(p, q)).toBeGreaterThanOrEqual(400);
    }
  });
});

// ------------------------------------------------ le monde qui tronque --

/**
 * UN AXE AU NORD, UNE SEULE RUE QUI Y MÈNE, ET UNE SOURCE QUI TRONQUE.
 *
 * Le défaut de Thairé en miniature : la source rend au plus quatre rues locales
 * par disque, et huit leurres (des bouts de rue 400 m au nord de l'axe, sans
 * lien avec lui) passent avant la rue qui rejoint l'axe. Les disques larges de
 * l'étage — celui de l'arrêt (2 400 m) et celui du chapelet le long de l'axe
 * (1 500 m, centré sur un sommet de l'axe) — rendent chacun au moins quatre
 * leurres, et ne la voient donc jamais. Un disque de 300 m au bout de tronçon
 * le plus proche de l'arrêt ne contient qu'elle : les leurres en sont à plus
 * de 700 m.
 */
const TRUNCATING_WORLD: readonly RoadWay[] = [
  ...[-700, -600, -500, -400, 400, 500, 600, 700].map((eastM) =>
    way(`leurre${eastM}`, [at(1_400, eastM), at(1_460, eastM)], 5),
  ),
  way('AX-ouest', [at(1_000, -1_000), at(1_000, 0)], 3, { name: 'D 113' }),
  way('AX-est', [at(1_000, 0), at(1_000, 1_000)], 3, { name: 'D 113' }),
  // Importance 5 et non 4 : en règle de secteurs, une importance 4 deviendrait
  // elle-même une porte de la bande de classe 4 (`axes-band.ts`), et le cas ne
  // jugerait plus la troncature.
  way('L-nord', [at(1_000, 0), at(700, 0)], 5),
];

const TIGHT: AxisStageParams = { ...PARAMS, maxLocalSegmentsPerFetch: 4 };

describe('le sauvetage rend la porte que la troncature cachait', () => {
  it('règle de secteurs (la prod) : la troncature cache la porte, et rien ne la rattrape', async () => {
    const search = await runAxisStage({ stop: O, source: sourceOf(TRUNCATING_WORLD), params: TIGHT });
    expect(search.selection).toBe('sectors');
    expect(search.retained).toHaveLength(0);
    expect(search.fetch.truncated).toBe(true);
    expect(search.fetch.rescue).toBeUndefined();
  });

  it('mode `axes` : un disque de 300 m au bout d’axe le plus proche fait apparaître la porte', async () => {
    const calls: string[] = [];
    const search = await runAxisStage({
      stop: O,
      source: sourceOf(TRUNCATING_WORLD, calls),
      params: { ...TIGHT, selection: 'axes' },
    });
    expect(search.retained).toHaveLength(1);
    const gate = search.retained[0];
    expect(gate?.localWayId).toBe('L-nord');
    expect(gate?.distanceM).toBeCloseTo(1_000, -1);
    expect(search.fetch.rescue?.newLocalWays).toBeGreaterThanOrEqual(1);
    // Les disques de sauvetage sont de 300 m, et comptés avec les autres.
    expect(calls.filter((c) => c.startsWith('300:')).length).toBe(search.fetch.rescue?.queries);
  });

  it('sans troncature, le sauvetage ne rapporte rien de neuf et la porte reste la même', async () => {
    // Même monde sans leurres : les disques larges voient déjà la rue qui
    // rejoint l'axe. Le sauvetage demande les deux bouts d'axe non couverts,
    // et n'y trouve rien. (La mémoire des centres est jugée plus bas, sur le
    // pool lui-même : dans ce monde aucun bout d'axe n'est un centre du
    // chapelet — relecture du 2026-09-30.)
    const untruncated = TRUNCATING_WORLD.filter((w) => !w.id.startsWith('leurre'));
    const search = await runAxisStage({
      stop: O,
      source: sourceOf(untruncated),
      params: { ...TIGHT, selection: 'axes' },
    });
    expect(search.fetch.truncated).toBe(false);
    expect(search.retained).toHaveLength(1);
    expect(search.fetch.rescue?.newLocalWays).toBe(0);
  });
});

// ------------------------------------------------ la mémoire du pool --

/**
 * LA RÈGLE DU POOL POUR LE SAUVETAGE, jugée sur le pool lui-même : un centre
 * déjà lu plus large n'est sauté que si ce disque-là était COMPLET ; tronqué,
 * il est relu ; et un disque de sauvetage ne se demande qu'une fois.
 */
describe('le pool : quand un disque de sauvetage se relit', () => {
  const P = at(1_000, 0);
  const axis: AxisCorridor = { ...corridor('AX', []), geometry: [P, at(1_000, 900)] };

  function poolOver(ways: readonly RoadWay[], calls: string[]): { pool: LocalWayPool; report: Mutable<AxisFetchReport> } {
    const report: Mutable<AxisFetchReport> = { radiiM: [], axisSegments: 0, localSegments: 0, truncated: false, ms: 0, wallMs: 0, queries: 0 };
    const pool = new LocalWayPool({ source: sourceOf(ways, calls), stop: O, params: TIGHT, report, clock: () => 0 });
    return { pool, report };
  }

  it('centre du chapelet lu en entier : le disque de sauvetage au même centre est sauté', async () => {
    const calls: string[] = [];
    const { pool, report } = poolOver([way('L', [P, at(700, 0)], 5)], calls);
    await pool.forRing([axis], 2_000, 5_000);
    expect(calls).toContain('1500:4-5');
    expect(await pool.rescueAt([P], 300)).toBe(0);
    expect(report.rescue).toEqual({ queries: 0, newLocalWays: 0 });
  });

  it('centre du chapelet TRONQUÉ : le disque de sauvetage au même centre est relu', async () => {
    const calls: string[] = [];
    const leurres = [100, 150, 200, 250].map((e) => way(`leurre${e}`, [at(1_400, e), at(1_460, e)], 5));
    const { pool, report } = poolOver([...leurres, way('L', [P, at(700, 0)], 5)], calls);
    await pool.forRing([axis], 2_000, 5_000);
    expect(await pool.rescueAt([P], 300)).toBe(1);
    expect(report.rescue).toEqual({ queries: 1, newLocalWays: 1 });
  });

  it('un même centre deux fois, dans le même lot ou plus tard : une seule requête', async () => {
    const calls: string[] = [];
    const R = at(3_000, 3_000);
    const { pool, report } = poolOver([], calls);
    await pool.rescueAt([R, R], 300);
    await pool.rescueAt([R], 300);
    expect(calls.filter((c) => c.startsWith('300:'))).toHaveLength(1);
    expect(report.rescue?.queries).toBe(1);
  });
});
