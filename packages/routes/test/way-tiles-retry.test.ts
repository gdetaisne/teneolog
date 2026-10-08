/**
 * LA RELECTURE AVANT DE
 * CONCLURE.
 *
 * Décision produit : « un tronçon de corridor non lu (Overpass muet, tuile
 * en échec) se relit avant de conclure — on n'est pas à une seconde près (2) —
 * et, s'il reste muet, il devient une question. »
 *
 * Deux faits à prouver, et rien d'autre :
 *
 *  1. une tuile qui échoue PUIS RÉUSSIT rend la jambe entière : couverture
 *     pleine, aucun code de corridor, aucun tronçon non lu ;
 *  2. une tuile qui échoue DEUX FOIS laisse un trou NOMMÉ : `corridor_partial`,
 *     et la liste des tronçons non lus avec leur position le long de
 *     l'itinéraire et les voies qui les bordent.
 *
 * Avant la tâche, le premier échec était avalé sur place
 * (`way-tiles.ts` : `.catch(() => [])`) et les deux cas rendaient la même
 * chose — un corridor plus pauvre, sans que rien ne dise que la carte avait
 * manqué.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';
import type { GraftOptions, RoadWay } from '@teneolog/topology';

import { annotateRoute } from '../src/annotate.js';
import { corridorReasonCodesFor } from '../src/candidates.js';
import { TiledCorridorSource, tileKeyOf, type TileBox, type WayTilePort } from '../src/way-tiles.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;
const MARGIN_M = 30;
const TILE_M = 250;
const SNAP_M = 25;
const STEP_M = 25;

const GRAFT: GraftOptions = {
  sampleStepM: 10,
  lateralToleranceM: 5,
  bearingToleranceDeg: 25,
  minCoverage: 0.6,
};

const RETRY = { enabled: true, timeoutMs: 1_000 };

function at(northM: number): GeoPoint {
  return { lat: O.lat + northM / M_PER_DEG_LAT, lon: O.lon };
}

/**
 * LE MONDE : une rue par tuile, chacune débordant de 12 m sur ses voisines pour
 * que l'itinéraire soit apparié d'un bout à l'autre quand tout répond.
 *
 * Le port ci-dessous sert les voies PAR CLÉ DE TUILE et non par géométrie —
 * c'est la seule façon d'éteindre une tuile et une seule. La boîte d'une tuile
 * est élargie de la garde de marge (60 m, `CORRIDOR_MARGIN_GUARD_M`), donc une
 * voie qui longe une frontière est rendue par les DEUX tuiles voisines : un
 * filtre géométrique ne saurait pas creuser un trou. L'invariant du cache,
 * lui, est prouvé ailleurs (`way-tiles.test.ts`) et contre une référence en
 * force brute.
 */
const TILE_COUNT = 4;

function waysByTile(): ReadonlyMap<string, readonly RoadWay[]> {
  const byTile = new Map<string, readonly RoadWay[]>();
  for (let i = 0; i < TILE_COUNT; i += 1) {
    const way: RoadWay = {
      id: `spine-${i}`,
      source: 'osm-overpass',
      nodeIds: [`spine-${i}:0`, `spine-${i}:1`],
      geometry: [at(i * TILE_M - 12), at((i + 1) * TILE_M + 12)],
      name: `spine-${i}`,
      importance: null,
      declaredWidthM: null,
      laneCount: null,
      oneWay: 'no',
      isPrivate: false,
      limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
      tags: { highway: 'residential' },
    };
    byTile.set(keyAt(i * TILE_M + TILE_M / 2), [way]);
  }
  return byTile;
}

function line(lengthM: number): readonly GeoPoint[] {
  const out: GeoPoint[] = [];
  for (let m = 0; m <= lengthM; m += STEP_M) out.push(at(m));
  return out;
}

/** La tuile que ce port sert : celle où tombe le point à `northM`. */
function keyAt(northM: number): string {
  return tileKeyOf(at(northM), TILE_M);
}

function boxKey(box: TileBox): string {
  return tileKeyOf({ lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 }, TILE_M);
}

/**
 * Un port dont UNE tuile tombe en panne les `failures` premières fois qu'on la
 * demande, et répond normalement ensuite.
 */
function flakyPort(
  byTile: ReadonlyMap<string, readonly RoadWay[]>,
  brokenKey: string,
  failures: number,
): { port: WayTilePort; attempts: () => number } {
  let left = failures;
  let attempts = 0;
  return {
    attempts: () => attempts,
    port: {
      async fetchGraphWays(box) {
        const key = boxKey(box);
        if (key === brokenKey) {
          attempts += 1;
          if (left > 0) {
            left -= 1;
            throw new Error('overpass muet');
          }
        }
        return byTile.get(key) ?? [];
      },
      async fetchDonorCorridor() {
        return [];
      },
    },
  };
}

function sourceWith(port: WayTilePort, retry?: { enabled: boolean; timeoutMs: number }) {
  return new TiledCorridorSource({
    tiles: port,
    tileM: TILE_M,
    maxConcurrent: 4,
    donorConcurrent: 2,
    graft: GRAFT,
    ...(retry === undefined ? {} : { retryMissingTiles: retry }),
  });
}

async function judge(source: TiledCorridorSource) {
  const polyline = line(750);
  const corridor = await source.fetchCorridor(polyline, MARGIN_M);
  const annotated = annotateRoute({
    polyline,
    corridor,
    sampleStepM: STEP_M,
    snapM: SNAP_M,
    approachWindowM: 150,
    laneWidthM: 3,
    direction: 'in',
    fetchedAt: '2026-09-18T00:00:00.000Z',
  });
  return {
    annotated,
    // La MÊME règle que la production : `minCorridorCoverage` de la policy.
    codes: corridorReasonCodesFor(annotated.coverage, 0.8),
  };
}

describe('une tuile en échec se relit avant que la jambe soit jugée', () => {
  const ways = waysByTile();
  // La tuile du milieu de la jambe : son absence creuse un trou entouré de
  // voies lues des deux côtés, donc un tronçon que la question peut nommer.
  const broken = keyAt(375);

  it('une tuile qui échoue puis réussit rend une jambe jugée normalement', async () => {
    const { port, attempts } = flakyPort(ways, broken, 1);
    const source = sourceWith(port, RETRY);
    const { annotated, codes } = await judge(source);

    expect(attempts()).toBe(2); // un échec, une relecture — jamais trois
    expect(source.stats().tilesRetried).toBe(1);
    expect(source.stats().tilesFailed).toBe(0);
    expect(source.missingTiles()).toEqual([]);
    expect(annotated.coverage.matched).toBe(annotated.coverage.sampled);
    expect(annotated.unread).toEqual([]);
    expect(codes).toEqual([]);
  });

  it('une tuile qui échoue deux fois laisse un tronçon non lu, nommé', async () => {
    const { port, attempts } = flakyPort(ways, broken, 2);
    const source = sourceWith(port, RETRY);
    const { annotated, codes } = await judge(source);

    expect(attempts()).toBe(2); // UN seul ré-essai, jamais une boucle
    expect(source.stats().tilesRetried).toBe(1);
    expect(source.stats().tilesFailed).toBe(1);
    expect(source.missingTiles()).toEqual([broken]);

    expect(codes).toEqual(['corridor_partial']);
    expect(annotated.unread.length).toBeGreaterThan(0);
    const [stretch] = annotated.unread;
    expect(stretch).toBeDefined();
    // Le trou a une position le long de l'itinéraire, et un milieu à montrer.
    expect(stretch!.toAlongM).toBeGreaterThan(stretch!.fromAlongM);
    expect(stretch!.at.lat).toBeGreaterThanOrEqual(stretch!.from.lat);
    expect(stretch!.at.lat).toBeLessThanOrEqual(stretch!.to.lat);
    // Et il nomme ses VOISINS — la voie quittée, la voie retrouvée. C'est la
    // seule « référence de voie » qu'un tronçon non lu peut porter : la voie
    // du tronçon est précisément ce qui manque.
    expect(stretch!.afterSegmentId).not.toBeNull();
    expect(stretch!.beforeSegmentId).not.toBeNull();
  });

  it('sans la clé de policy, l’échec est avalé comme avant la tâche', async () => {
    const { port, attempts } = flakyPort(ways, broken, 1);
    const source = sourceWith(port); // pas de `retryMissingTiles`
    const { annotated } = await judge(source);

    expect(attempts()).toBe(1);
    expect(source.stats().tilesRetried).toBe(0);
    // L'échec ne casse toujours pas le run (principe 5) — mais il est
    // maintenant COMPTÉ, là où il disparaissait sans laisser de trace.
    expect(source.stats().tilesFailed).toBe(1);
    expect(annotated.unread.length).toBeGreaterThan(0);
  });

  it('la relecture hors budget est un échec, pas une attente sans fin', async () => {
    let calls = 0;
    const port: WayTilePort = {
      async fetchGraphWays(box) {
        const key = boxKey(box);
        if (key !== broken) return ways.get(key) ?? [];
        calls += 1;
        if (calls === 1) throw new Error('overpass muet');
        return new Promise<readonly RoadWay[]>(() => undefined); // ne répond jamais
      },
      async fetchDonorCorridor() {
        return [];
      },
    };
    const source = sourceWith(port, { enabled: true, timeoutMs: 20 });
    const { codes } = await judge(source);

    expect(source.stats().tilesFailed).toBe(1);
    expect(codes).toEqual(['corridor_partial']);
  });
});
