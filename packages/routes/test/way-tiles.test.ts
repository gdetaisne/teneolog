/**
 * l'invariant du cache de voies par tuile.
 *
 * Une seule chose est à prouver, et tout le reste en découle : **le corridor
 * assemblé depuis les tuiles contient exactement les mêmes voies, avec
 * exactement les mêmes largeurs greffées, que le corridor demandé
 * directement.** Si ce n'était pas vrai, la phase 2 irait plus vite en
 * répondant autre chose, ce qui n'est pas aller plus vite.
 *
 * La référence de comparaison est écrite ici, en force brute, et non empruntée
 * au code testé : un filtre qui se juge lui-même ne juge rien. Elle applique
 * la même règle que `around:` d'Overpass et `ST_DWithin` de la BD TOPO — une
 * voie est dans le corridor dès qu'un de ses segments passe à moins de
 * `marginM` d'un segment de la ligne.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';
import { corridorExtent, graftDeclaredWidth, type GraftOptions, type RoadWay } from '@teneolog/topology';

import type { CorridorPort } from '../src/ports.js';
import {
  TiledCorridorSource,
  nearPolylineFilter,
  tileKeyOf,
  tilesAlongPolyline,
  type TileBox,
  type WayTilePort,
} from '../src/way-tiles.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;
const MARGIN_M = 30;

const GRAFT: GraftOptions = {
  sampleStepM: 10,
  lateralToleranceM: 5,
  bearingToleranceDeg: 25,
  minCoverage: 0.6,
};

/** Un point à `northM` au nord et `eastM` à l'est du repère. */
function at(northM: number, eastM = 0): GeoPoint {
  return {
    lat: O.lat + northM / M_PER_DEG_LAT,
    lon: O.lon + eastM / (M_PER_DEG_LAT * Math.cos((O.lat * Math.PI) / 180)),
  };
}

function way(id: string, geometry: readonly GeoPoint[], overrides: Partial<RoadWay> = {}): RoadWay {
  return {
    id,
    source: 'osm-overpass',
    nodeIds: geometry.map((_, i) => `${id}:${i}`),
    geometry,
    name: id,
    importance: null,
    declaredWidthM: null,
    laneCount: null,
    oneWay: 'no',
    isPrivate: false,
    limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    tags: { highway: 'residential' },
    ...overrides,
  };
}

function donor(id: string, geometry: readonly GeoPoint[], widthM: number): RoadWay {
  return way(id, geometry, {
    source: 'bdtopo-postgis',
    declaredWidthM: widthM,
    tags: { nature: 'Route à 1 chaussée' },
  });
}

// ---------------------------------------------------------------------------
// Le monde : une rue nord-sud de 3 km, des transversales tous les 200 m, une
// avenue rectiligne parallèle à 25 m (donc DANS la marge) et une à 80 m (donc
// dehors), plus le réseau BD TOPO qui porte les largeurs.
// ---------------------------------------------------------------------------

function world(): { primary: readonly RoadWay[]; donors: readonly RoadWay[] } {
  const primary: RoadWay[] = [];
  const donors: RoadWay[] = [];

  // L'axe de la BD TOPO ne se superpose jamais à celui d'OSM — l'écart mesuré
  // vaut 0,71 m de médiane (policy `pipeline.roadAttributes`) — et ses tronçons
  // ne sont pas coupés aux sommets d'OSM. Le monde du test le reproduit :
  // 0,7 m de décalage latéral, et des coupures de tronçon à 163 m + 200 k, qui
  // ne tombent sur aucun échantillon (pas à un multiple de 10 m d'un sommet).
  const OFFSET_M = 0.7;
  for (let i = 0; i < 15; i += 1) {
    const from = i * 200;
    primary.push(way(`spine-${i}`, [at(from), at(from + 200)]));
    primary.push(way(`cross-${i}`, [at(from, 0), at(from, 300)]));
  }
  for (let i = 0; i < 16; i += 1) {
    const from = i * 200 - 37;
    // Des largeurs toutes différentes, à dessein : `graftDeclaredWidth` prend
    // la PLUS ÉTROITE des donneuses qui ont gagné des échantillons.
    donors.push(donor(`d-spine-${i}`, [at(from, OFFSET_M), at(from + 200, OFFSET_M)], 5.2 + i * 0.1));
    donors.push(
      donor(`d-cross-${i}`, [at(i * 200 + OFFSET_M, -37), at(i * 200 + OFFSET_M, 263)], 4.0 + i * 0.1),
    );
  }

  // Une longue avenue rectiligne à 25 m à l'est : aucun de ses sommets n'est
  // près d'un sommet de la colonne, et elle doit pourtant être dans le
  // corridor. C'est le cas que seul un test segment à segment attrape.
  primary.push(way('avenue-proche', [at(-500, 25), at(3500, 25)]));
  donors.push(donor('d-avenue-proche', [at(-500, 25 + OFFSET_M), at(3500, 25 + OFFSET_M)], 6.5));

  // La même, à 80 m : elle ne doit JAMAIS entrer.
  primary.push(way('avenue-loin', [at(-500, 80), at(3500, 80)]));
  donors.push(donor('d-avenue-loin', [at(-500, 80 + OFFSET_M), at(3500, 80 + OFFSET_M)], 9.0));

  return { primary, donors };
}

/**
 * Distance minimale exacte entre deux segments, en projection plane locale.
 * Écrite ici pour que la référence ne dépende pas du code testé.
 */
function segmentDistanceM(a: GeoPoint, b: GeoPoint, c: GeoPoint, d: GeoPoint): number {
  const scale = Math.cos((O.lat * Math.PI) / 180);
  const x = (p: GeoPoint): number => (p.lon - O.lon) * scale * M_PER_DEG_LAT;
  const y = (p: GeoPoint): number => (p.lat - O.lat) * M_PER_DEG_LAT;
  const pts = [a, b, c, d].map((p) => ({ x: x(p), y: y(p) }));
  const [A, B, C, D] = pts as [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
  const toSeg = (
    p: { x: number; y: number },
    s: { x: number; y: number },
    e: { x: number; y: number },
  ): number => {
    const dx = e.x - s.x;
    const dy = e.y - s.y;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / len));
    return Math.hypot(p.x - (s.x + t * dx), p.y - (s.y + t * dy));
  };
  // Deux segments qui se croisent sont à distance nulle, et aucun de leurs
  // sommets n'a besoin d'être proche pour cela : une avenue qui traverse une
  // tuile de part en part n'a aucun sommet dedans.
  const side = (
    p: { x: number; y: number },
    q: { x: number; y: number },
    r: { x: number; y: number },
  ): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (
    side(A, B, C) > 0 !== side(A, B, D) > 0 &&
    side(C, D, A) > 0 !== side(C, D, B) > 0
  ) {
    return 0;
  }
  return Math.min(toSeg(A, C, D), toSeg(B, C, D), toSeg(C, A, B), toSeg(D, A, B));
}

function withinBrute(
  geometry: readonly GeoPoint[],
  polyline: readonly GeoPoint[],
  marginM: number,
): boolean {
  for (let i = 0; i + 1 < geometry.length; i += 1) {
    for (let j = 0; j + 1 < polyline.length; j += 1) {
      const d = segmentDistanceM(
        geometry[i] as GeoPoint,
        geometry[i + 1] as GeoPoint,
        polyline[j] as GeoPoint,
        polyline[j + 1] as GeoPoint,
      );
      if (d <= marginM) return true;
    }
  }
  return false;
}

/** Le chemin d'AVANT : une requête par corridor, la greffe faite dessus. */
function directCorridor(all: { primary: readonly RoadWay[]; donors: readonly RoadWay[] }): CorridorPort {
  return {
    async fetchCorridor(polyline, marginM) {
      const primary = all.primary.filter((w) => withinBrute(w.geometry, polyline, marginM));
      const donors = all.donors.filter((w) => withinBrute(w.geometry, polyline, marginM));
      return graftDeclaredWidth(primary, donors, GRAFT, corridorExtent(polyline, marginM));
    },
  };
}

/** Le port de tuiles : une boîte de voies, les deux sources interrogées à part. */
function tilePort(
  all: { primary: readonly RoadWay[]; donors: readonly RoadWay[] },
  onFetch?: (box: TileBox) => void,
): WayTilePort {
  // Overpass rend une voie ENTIÈRE dès qu'un de ses points touche la boîte.
  const inBox = (box: TileBox) => (w: RoadWay): boolean =>
    w.geometry.some(
      (p) => p.lat >= box.south && p.lat <= box.north && p.lon >= box.west && p.lon <= box.east,
    ) || crossesBox(w.geometry, box);
  return {
    async fetchGraphWays(box) {
      onFetch?.(box);
      return all.primary.filter(inBox(box));
    },
    async fetchDonorCorridor(polyline, marginM) {
      // La BD TOPO répond DÉJÀ taillé à la bande : c'est sa requête, inchangée.
      return all.donors.filter((w) => withinBrute(w.geometry, polyline, marginM));
    },
  };
}

/** Un segment qui traverse la boîte sans qu'aucun sommet n'y tombe. */
function crossesBox(geometry: readonly GeoPoint[], box: TileBox): boolean {
  const corners: GeoPoint[] = [
    { lat: box.south, lon: box.west },
    { lat: box.south, lon: box.east },
    { lat: box.north, lon: box.east },
    { lat: box.north, lon: box.west },
    { lat: box.south, lon: box.west },
  ];
  return withinBrute(geometry, corners, 0);
}

function sortedIds(ways: readonly RoadWay[]): readonly string[] {
  return [...ways].map((w) => w.id).sort();
}

/** Une ligne qui monte la colonne puis tourne à l'est — un vrai corridor en L. */
function elbow(): readonly GeoPoint[] {
  const line: GeoPoint[] = [];
  for (let m = 0; m <= 1_400; m += 25) line.push(at(m));
  for (let e = 25; e <= 300; e += 25) line.push(at(1_400, e));
  return line;
}

function straight(lengthM: number): readonly GeoPoint[] {
  const line: GeoPoint[] = [];
  for (let m = 0; m <= lengthM; m += 25) line.push(at(m));
  return line;
}

describe('le cache par tuile rend le même corridor que la requête directe', () => {
  const all = world();

  for (const [name, line] of [
    ['une ligne droite de 1 km', straight(1_000)],
    ['une ligne droite de 3 km', straight(3_000)],
    ['un coude', elbow()],
  ] as const) {
    it(`mêmes voies et mêmes largeurs greffées — ${name}`, async () => {
      const direct = await directCorridor(all).fetchCorridor(line, MARGIN_M);
      const tiled = await new TiledCorridorSource({
        tiles: tilePort(all),
        tileM: 250,
        maxConcurrent: 4,
        donorConcurrent: 4,
        graft: GRAFT,
      }).fetchCorridor(line, MARGIN_M);

      expect(sortedIds(tiled)).toEqual(sortedIds(direct));

      // La largeur greffée et sa provenance, voie par voie : c'est là que la
      // greffe par corridor se distingue d'une greffe mise en cache.
      const widthOf = (ways: readonly RoadWay[]): Record<string, unknown> =>
        Object.fromEntries(
          [...ways]
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map((w) => [w.id, { widthM: w.declaredWidthM, attributed: w.attributed ?? null }]),
        );
      expect(widthOf(tiled)).toEqual(widthOf(direct));
    });
  }

  it("l'avenue à 25 m est dedans, celle à 80 m ne l'est jamais", async () => {
    const tiled = await new TiledCorridorSource({
      tiles: tilePort(all),
      tileM: 250,
      maxConcurrent: 4,
      donorConcurrent: 4,
      graft: GRAFT,
    }).fetchCorridor(straight(3_000), MARGIN_M);
    expect(tiled.map((w) => w.id)).toContain('avenue-proche');
    expect(tiled.map((w) => w.id)).not.toContain('avenue-loin');
  });

  it('une tuile n’est chargée qu’une fois, quel que soit le nombre de corridors', async () => {
    const centres: TileBox[] = [];
    const source = new TiledCorridorSource({
      tiles: tilePort(all, (box) => centres.push(box)),
      tileM: 250,
      maxConcurrent: 4,
      donorConcurrent: 4,
      graft: GRAFT,
    });
    // Trois corridors qui partagent leur premier kilomètre, comme trois jambes
    // qui partagent leurs derniers mètres.
    await source.fetchCorridor(straight(1_000), MARGIN_M);
    const afterFirst = centres.length;
    await source.fetchCorridor(straight(900), MARGIN_M);
    await source.fetchCorridor(straight(800), MARGIN_M);

    expect(centres.length).toBe(afterFirst);
    const keys = new Set(
      centres.map((b) => tileKeyOf({ lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 }, 250)),
    );
    expect(keys.size).toBe(centres.length);
    expect(source.stats().corridorsBuilt).toBe(3);
    expect(source.stats().tilesLoaded).toBe(afterFirst);
  });

  it('deux corridors lancés en même temps ne chargent pas deux fois la même tuile', async () => {
    let fetches = 0;
    const source = new TiledCorridorSource({
      tiles: tilePort(all, () => {
        fetches += 1;
      }),
      tileM: 250,
      maxConcurrent: 4,
      donorConcurrent: 4,
      graft: GRAFT,
    });
    const [a, b] = await Promise.all([
      source.fetchCorridor(straight(1_000), MARGIN_M),
      source.fetchCorridor(straight(1_000), MARGIN_M),
    ]);
    expect(sortedIds(a)).toEqual(sortedIds(b));
    expect(fetches).toBe(source.stats().tilesLoaded);
  });

  it('le préchargement de la destination sert les jambes sans requête neuve', async () => {
    let fetches = 0;
    const source = new TiledCorridorSource({
      tiles: tilePort(all, () => {
        fetches += 1;
      }),
      tileM: 250,
      maxConcurrent: 4,
      donorConcurrent: 4,
      graft: GRAFT,
    });
    await source.preloadAround(at(0), 400);
    const preloadFetches = fetches;
    expect(preloadFetches).toBeGreaterThan(0);
    await source.fetchCorridor(straight(300), MARGIN_M);
    expect(fetches).toBe(preloadFetches);
  });

  it('une tuile muette coûte ses voies, jamais le corridor', async () => {
    const source = new TiledCorridorSource({
      tiles: {
        fetchGraphWays: async () => {
          throw new Error('overpass down');
        },
        fetchDonorCorridor: async () => [],
      },
      tileM: 250,
      maxConcurrent: 4,
      donorConcurrent: 4,
      graft: GRAFT,
    });
    await expect(source.fetchCorridor(straight(500), MARGIN_M)).resolves.toEqual([]);
  });

  it('les tuiles d’une ligne couvrent sa marge — aucune n’est oubliée', () => {
    const line = elbow();
    const keys = new Set(tilesAlongPolyline(line, MARGIN_M, 250));
    // Tout point à moins de la marge de la ligne tombe dans une tuile listée.
    for (const point of line) {
      for (const offsetM of [-MARGIN_M, 0, MARGIN_M]) {
        const probe = { lat: point.lat, lon: point.lon + offsetM / (M_PER_DEG_LAT * Math.cos((O.lat * Math.PI) / 180)) };
        expect(keys.has(tileKeyOf(probe, 250))).toBe(true);
      }
    }
  });

  it('le filtre « à moins de marginM » est exact, pas échantillonné', () => {
    const line = straight(1_000);
    const near = nearPolylineFilter(line, MARGIN_M);
    for (const w of [...world().primary, ...world().donors]) {
      expect(near(w.geometry)).toBe(withinBrute(w.geometry, line, MARGIN_M));
    }
  });
});
