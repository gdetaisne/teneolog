/**
 * Le test d'or : la phase 2 réorganisée ne change RIEN.
 *
 * Quatre des cinq pièces de la tâche sont censées ne rien changer du tout — le
 * cache de voies par tuile, le préchargement de la destination, l'ordre des
 * jambes, la concurrence — et la cinquième est derrière deux drapeaux baissés.
 * « Rien » se prouve ici : le même run, joué deux fois sur le même monde et la
 * même horloge, cache de tuiles éteint puis allumé, doit rendre des
 * `candidates`, un `collected`, une `projection`, un `summary`, des `facts` et
 * un `gateSearch` DEEP-EQUAL. Seul `phase2` diffère, et c'est le champ qui
 * porte le compte rendu.
 *
 * Ce que ce fichier ne juge PAS : que le filtre « à moins de marginM de la
 * ligne » soit le bon. C'est `packages/routes/test/way-tiles.test.ts` qui s'en
 * charge, contre une référence en force brute. Ici les deux ports appliquent
 * le même filtre, pour que la comparaison porte sur l'organisation et sur elle
 * seule.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint, TruckProfile } from '@teneolog/domain';
import { nearPolylineFilter } from '@teneolog/routes';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import type { PipelineParams } from '../src/analyse.js';
import { runFullAnalysis, type FullParams, type FullPorts } from '../src/full.js';
import { DEFAULT_PHASE2 } from '../src/phase2.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(northM: number, eastM: number): GeoPoint {
  return {
    lat: O.lat + northM / M_PER_DEG_LAT,
    lon: O.lon + eastM / (M_PER_DEG_LAT * Math.cos((O.lat * Math.PI) / 180)),
  };
}

function way(
  id: string,
  nodeIds: readonly string[],
  geometry: readonly GeoPoint[],
  overrides: Partial<RoadWay> = {},
): RoadWay {
  return {
    id,
    source: 'osm-overpass',
    nodeIds,
    geometry,
    name: null,
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

function hoodOf(centre: GeoPoint, radiusM: number, ways: readonly RoadWay[]): RoadNeighbourhood {
  const positions = new Map<string, GeoPoint>();
  const owners = new Map<string, string[]>();
  for (const w of ways) {
    w.nodeIds.forEach((n, i) => {
      const p = w.geometry[i];
      if (p !== undefined) positions.set(n, p);
      const list = owners.get(n) ?? [];
      if (!list.includes(w.id)) list.push(w.id);
      owners.set(n, list);
    });
  }
  return {
    centre,
    radiusM,
    ways,
    nodes: [...positions].map(([id, p]) => ({ id, at: p, wayIds: owners.get(id) ?? [], tags: {} })),
  };
}

const PIPELINE: PipelineParams = {
  fetchLadderM: [80, 160],
  surfacesRadiusM: 120,
  selection: {
    maxSnapM: 30,
    ambiguityWindowM: 12,
    minWidthAdvantageM: 0.5,
    tipInteriorMarginM: 5,
    continuationDeviationDeg: 40,
    confidence: { unambiguous: 0.9, resolvedByRank: 0.75 },
  },
  assessment: {
    turnaroundSearchRadiusM: 120,
    maxMouthDepth: 2,
    maxDeviationDeg: 40,
    barrierSnapM: 6,
    measurement: {
      defaultTurningCircleDiameterM: null,
      fallbackCarriagewayWidthM: null,
      loopClosureToleranceM: 3,
    },
  },
  declaredWidthConfidence: 0.55,
  secondaryDescriptionSnapM: 25,
  geocoding: { minBanScore: 0.6 },
};

/** La policy de test, en petit : la découverte allumée, les deux drapeaux baissés. */
const BASE: FullParams = {
  pipeline: PIPELINE,
  gates: {
    searchRadiusM: 2000,
    gateCount: 5,
    minDistanceM: 500,
    //, etendu a R0 par zero : le monde de ces cas tient dans
    // 900 m, et le seuil de production n'y laisserait aucune ancre.
    minReachM: 0,
    byWidth: { enabled: false, maxApproaches: 12 },
  },
  candidates: {
    alternativesPerGate: 1,
    corridorMarginM: 30,
    sampleStepM: 25,
    snapM: 25,
    approachWindowM: 150,
    laneWidthM: 3,
    minCorridorCoverage: 0.8,
    maxConcurrentFetches: 2,
  },
  points: {
    turns: { windowM: 40, minDeflectionDeg: 45, bearingOffsetM: 10, mergeWithinM: 25, geometryConfidence: 0.7, curveIgnoreRadiusM: 60, junction: { nodeSnapM: 6, apexShare: 0.8 } },
    roundabouts: { ringSnapM: 8, ringMergeM: 40, geometryConfidence: 0.7, declaredWidthConfidence: 0.55 },
    narrowMaxFreeM: 5,
    dedupeWithinM: 15,
    chainedWithinM: 40,
  },
  projection: {
    lateralClearanceM: 0.8,
    turnSweptClearanceM: 1.0,
    roundaboutSweptClearanceM: 1.0,
    turnaroundClearanceM: 2.0,
    comfortMarginM: 0.4,
    publishableConfidence: 0.55,
    hgvThresholdT: 3.5,
    passingLaneWidthM: 2.75,
  },
  discovery: {
    enabled: true,
    rounds: [4, 8],
    radiusM: 2000,
    windowM: 1000,
    maxConcurrent: 2,
    stopWhen: { minMarginM: 0.4 },
  },
  phase2: { ...DEFAULT_PHASE2, wayTiles: { enabled: false, tileM: 250 } },
  obviousStop: { declaredWidthMinM: 10, measuredWidthMinM: 6.5 },
  policyVersion: 'test',
  reportShelfLifeDays: 30,
};

const WITH_TILES: FullParams = {
  ...BASE,
  phase2: { ...DEFAULT_PHASE2, wayTiles: { enabled: true, tileM: 250 } },
};

const TRUCK: TruckProfile = {
  id: 'pl-19t',
  label: 'Porteur 19 t',
  family: 'rigid',
  envelope: { lengthM: 9, widthM: 2.5, heightM: 3.5, gvwT: 19, turnRadiusM: 11, wheelbaseM: 6.1, frontOverhangM: 1.2, rearOverhangM: 1.7 },
  equipment: { tailLift: true, crane: false, refrigerated: false },
};

interface World {
  readonly name: string;
  readonly ways: readonly RoadWay[];
}

/**
 * Quatre artères aux quatre points cardinaux et une rue de livraison : assez
 * de jambes pour que l'ordre et les lots veuillent dire quelque chose, et
 * assez peu pour que le monde reste lisible.
 */
function worlds(): readonly World[] {
  const street = (widthM: number) =>
    way('street', ['a', 'b'], [at(0, -170), at(0, 170)], { name: 'Rue Test', declaredWidthM: widthM });
  const arterials = [
    way('nord', ['n1', 'n2'], [at(800, 0), at(1_500, 0)], { tags: { highway: 'primary' }, declaredWidthM: 7 }),
    way('est', ['e1', 'e2'], [at(0, 800), at(0, 1_500)], { tags: { highway: 'secondary' }, declaredWidthM: 6 }),
    way('sud', ['s1', 's2'], [at(-800, 0), at(-1_500, 0)], { tags: { highway: 'tertiary' }, declaredWidthM: 5.5 }),
    way('ouest', ['o1', 'o2'], [at(0, -800), at(0, -1_500)], { tags: { highway: 'primary' }, declaredWidthM: 7 }),
  ];
  return [
    { name: 'large', ways: [street(8), ...arterials] },
    { name: 'étroit', ways: [street(2.6), ...arterials] },
    { name: 'sans artère', ways: [street(8)] },
  ];
}

/**
 * Le même filtre des deux côtés.
 *
 * Le port direct ne rendait, dans les tests d'or précédents, que le monde
 * entier ; le port par tuiles, lui, ne garde que ce qui passe à moins de la
 * marge. Comparer les deux mesurerait le filtre, pas l'organisation — et le
 * filtre a son propre juge, contre une référence en force brute
 * (`packages/routes/test/way-tiles.test.ts`).
 */
function corridorOf(world: World, onCorridor?: () => void) {
  return async (polyline: readonly GeoPoint[], marginM: number): Promise<readonly RoadWay[]> => {
    onCorridor?.();
    const near = nearPolylineFilter(polyline, marginM);
    return world.ways.filter((w) => near(w.geometry));
  };
}

function ports(world: World, opts: { onCorridor?: () => void; onTile?: () => void } = {}): FullPorts {
  const street = world.ways[0] as RoadWay;
  return {
    geocode: { geocode: async () => [{ source: 'ban', point: O, score: 0.95, formatted: '1 Rue Test', banId: null, positionType: null }] },
    graph: { fetchNeighbourhood: async (_c, r) => hoodOf(O, r, [street]) },
    surfaces: { fetchSurfaces: async () => [] },
    structuring: { fetchStructuring: async (_c, r) => hoodOf(O, r, world.ways) },
    routing: {
      route: async (from, to) => {
        const polyline: GeoPoint[] = [];
        for (let i = 0; i <= 16; i += 1) {
          polyline.push({
            lat: from.lat + ((to.lat - from.lat) * i) / 16,
            lon: from.lon + ((to.lon - from.lon) * i) / 16,
          });
        }
        return [{ polyline, distanceM: 800, durationS: 90 }];
      },
    },
    corridor: { fetchCorridor: corridorOf(world, opts.onCorridor) },
    // Une tuile rend un sur-ensemble : le monde entier. Le cache s'occupe de
    // n'en garder que ce qui longe la ligne, et c'est ce qu'on veut comparer.
    corridorTiles: {
      fetchGraphWays: async () => {
        opts.onTile?.();
        return world.ways;
      },
      fetchDonorCorridor: async () => [],
    },
  };
}

const frozen = () => '2026-09-11T10:00:00.000Z';

/** L'ancrage, moins la seule horloge murale qu'il porte. */
function steadyGateSearch(search: unknown): unknown {
  if (search === null || search === undefined) return search;
  const s = search as Record<string, unknown>;
  const discovery = s['discovery'] as Record<string, unknown> | null;
  if (discovery === null || discovery === undefined) return s;
  const { durationMs: _ms, ...cost } = discovery['cost'] as Record<string, unknown>;
  return { ...s, discovery: { ...discovery, cost } };
}

async function runWith(world: World, params: FullParams, opts: Parameters<typeof ports>[1] = {}) {
  const outcome = await runFullAnalysis(
    { kind: 'address', address: '1 Rue Test' },
    TRUCK,
    ports(world, opts),
    params,
    frozen,
  );
  if (!outcome.ok) throw new Error(`${world.name} : ${outcome.stage}/${outcome.why}`);
  return outcome.analysis;
}

describe('la phase 2 réorganisée ne change rien', () => {
  for (const world of worlds()) {
    it(`témoin : ${world.name}`, async () => {
      const direct = await runWith(world, BASE);
      const tiled = await runWith(world, WITH_TILES);

      expect(tiled.candidates).toEqual(direct.candidates);
      expect(tiled.collected).toEqual(direct.collected);
      expect(tiled.projection).toEqual(direct.projection);
      expect(tiled.summary).toEqual(direct.summary);
      expect(tiled.facts).toEqual(direct.facts);
      // `discovery.cost.durationMs` est une horloge murale : elle diffère d'un
      // run à l'autre par construction et ne dit rien de l'organisation.
      // `cost.routingCalls`, lui, reste comparé — un rayon de plus serait
      // exactement la régression que ce fichier cherche.
      expect(steadyGateSearch(tiled.gateSearch)).toEqual(steadyGateSearch(direct.gateSearch));
    });

    it(`drapeaux baissés, aucune jambe n'est sautée : ${world.name}`, async () => {
      for (const params of [BASE, WITH_TILES]) {
        const analysis = await runWith(world, params);
        expect(analysis.phase2?.skippedLegs).toEqual([]);
        expect(analysis.phase2?.stoppedAfterBatch).toBeNull();
        expect(analysis.phase2?.stopBetweenBatches).toBe(false);
        expect(analysis.phase2?.commonRefusalStops).toBe(false);
      }
    });
  }

  it('le cache de tuiles charge une tuile par tuile, pas un corridor par jambe', async () => {
    const world = worlds()[0] as World;
    let direct = 0;
    await runWith(world, BASE, { onCorridor: () => (direct += 1) });

    let tiles = 0;
    let viaPort = 0;
    const tiled = await runWith(world, WITH_TILES, {
      onCorridor: () => (viaPort += 1),
      onTile: () => (tiles += 1),
    });

    // Le port direct n'est plus appelé du tout : tout passe par les tuiles.
    expect(viaPort).toBe(0);
    expect(direct).toBeGreaterThan(0);
    expect(tiled.phase2?.tiles?.corridorsBuilt).toBe(direct);
    expect(tiled.phase2?.tiles?.tilesLoaded).toBe(tiles);
    // Et une tuile sert plusieurs corridors : sinon le cache ne sert à rien.
    expect(tiled.phase2?.tiles?.tileHits ?? 0).toBeGreaterThan(0);
  });

  it("l'ordre de départ nomme chaque jambe une fois, avec ses trois indices", async () => {
    const world = worlds()[0] as World;
    const analysis = await runWith(world, WITH_TILES);
    const order = analysis.phase2?.legOrder ?? [];
    const ids = analysis.candidates.known ? analysis.candidates.value.map((c) => c.id) : [];

    expect(order.length).toBe(ids.length);
    expect([...order.map((leg) => leg.id)].sort()).toEqual([...ids].sort());
    expect(order.map((leg) => leg.rank)).toEqual(order.map((_, i) => i + 1));
    for (const leg of order) {
      expect(leg.sharpTurns).toBeGreaterThanOrEqual(0);
      expect(leg.highwayRank).toBeGreaterThanOrEqual(0);
      expect(leg.offStructuringM).toBeGreaterThanOrEqual(0);
      expect(leg.batch).toBeGreaterThanOrEqual(1);
    }
    // Les indices sont triés : c'est la définition de l'ordre.
    for (let i = 0; i + 1 < order.length; i += 1) {
      const a = order[i]!;
      const b = order[i + 1]!;
      expect(a.sharpTurns).toBeLessThanOrEqual(b.sharpTurns);
    }
  });

  it('le tronc commun est publié, avec ce qu’il porte', async () => {
    const world = worlds()[0] as World;
    const analysis = await runWith(world, WITH_TILES);
    const trunk = analysis.phase2?.commonTrunk;
    expect(trunk).not.toBeUndefined();
    expect(trunk?.legsCompared).toBeGreaterThan(0);
    // Quatre artères aux quatre vents : les jambes divergent dès le point de
    // livraison, donc il n'y a rien de commun. C'est une mesure, pas un trou.
    expect(trunk?.lengthM).toBe(0);
    expect(trunk?.points).toEqual([]);
  });

  it('deux jambes qui arrivent par la même rue donnent un tronc commun contrôlé', async () => {
    // Un seul axe : les deux artères sont sur la même droite nord-sud, donc
    // toutes les jambes montent et descendent la même rue.
    const world: World = {
      name: 'un seul axe',
      ways: [
        way('street', ['a', 'b'], [at(0, -170), at(0, 170)], { name: 'Rue Test', declaredWidthM: 8 }),
        way('nord', ['n1', 'n2'], [at(800, 0), at(1_500, 0)], { tags: { highway: 'primary' }, declaredWidthM: 7 }),
      ],
    };
    const analysis = await runWith(world, WITH_TILES);
    const trunk = analysis.phase2?.commonTrunk;
    expect(trunk?.lengthM).toBeGreaterThan(100);
    expect(trunk?.worstVerdict).not.toBeNull();
  });
});
