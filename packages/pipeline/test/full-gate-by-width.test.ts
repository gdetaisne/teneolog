/**
 * Le test d'or : l'ancre par largeur allumée ne change RIEN en aval.
 *
 * « En silence » est la contrainte entière de cette tâche, comme elle l'était
 * pour la découverte. Elle se prouve ici : le même run, joué deux
 * fois sur les mêmes ports et la même horloge, `gates.byWidth.enabled` à faux
 * puis à vrai, doit rendre des `candidates`, des `collected`, une `projection`
 * et un `summary` DEEP-EQUAL — et le même ancrage, à
 * `discovery.approaches[].gateByWidth`, `.widthProfile` et `discovery.byWidth`
 * près (des deux côtés, entrées et sorties), qui sont les seuls champs
 * nouveaux.
 *
 * Le juge, ce n'est pas la relecture du diff de `full.ts` : c'est ce fichier.
 * Si un jour l'ancre par largeur se met à choisir une ancre, à consommer le
 * budget des corridors de S4 ou à toucher un verdict, c'est ici que ça tombe.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint, TruckProfile } from '@teneolog/domain';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import type { PipelineParams } from '../src/analyse.js';
import { reprojectTruck, runFullAnalysis, type FullParams, type FullPorts } from '../src/full.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(base: GeoPoint, northM: number, eastM: number): GeoPoint {
  return {
    lat: base.lat + northM / M_PER_DEG_LAT,
    lon: base.lon + eastM / (M_PER_DEG_LAT * Math.cos((base.lat * Math.PI) / 180)),
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

/** La policy de test : la découverte allumée, l'ancre par largeur éteinte. */
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
    maxConcurrentFetches: 4,
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
    maxConcurrent: 4,
    stopWhen: { minMarginM: 0.4 },
  },
  obviousStop: { declaredWidthMinM: 10, measuredWidthMinM: 6.5 },
  policyVersion: 'test',
  reportShelfLifeDays: 30,
};

const WITH_WIDTH: FullParams = {
  ...BASE,
  // Plafond large ici : ce fichier juge le SILENCE, et le plafond a son propre
  // test dans `packages/routes/test/gate-by-width.test.ts`.
  gates: { ...BASE.gates, byWidth: { enabled: true, maxApproaches: 64 } },
};

const TRUCK: TruckProfile = {
  id: 'pl-19t',
  label: 'Porteur 19 t',
  family: 'rigid',
  envelope: { lengthM: 9, widthM: 2.5, heightM: 3.5, gvwT: 19, turnRadiusM: 11, wheelbaseM: 6.1, frontOverhangM: 1.2, rearOverhangM: 1.7 },
  equipment: { tailLift: true, crane: false, refrigerated: false },
};

const SEMI: TruckProfile = {
  id: 'semi-44t',
  label: 'Semi-remorque 44 t',
  family: 'semi',
  envelope: { lengthM: 16.5, widthM: 2.55, heightM: 4, gvwT: 44, turnRadiusM: 15, wheelbaseM: 3.9, frontOverhangM: 1.4, rearOverhangM: 3 },
  equipment: { tailLift: false, crane: false, refrigerated: false },
};

interface World {
  readonly name: string;
  readonly ways: readonly RoadWay[];
}

/**
 * Trois mondes, les mêmes que le test d'or de la découverte : le cas nominal,
 * celui où la rue de livraison fait tomber le verdict, et celui où aucune
 * artère n'existe — la branche où le pipeline sort avant les candidats.
 */
function worlds(): readonly World[] {
  const street = (widthM: number) =>
    way('street', ['a', 'b'], [at(O, 0, -170), at(O, 0, 170)], { name: 'Rue Test', declaredWidthM: widthM });
  const arterial = way('arterial', ['g1', 'g2'], [at(O, 800, 0), at(O, 900, 0)], {
    tags: { highway: 'primary' },
    declaredWidthM: 7,
  });
  const second = way('arterial-e', ['g3', 'g4'], [at(O, 0, 800), at(O, 0, 900)], {
    tags: { highway: 'secondary' },
    declaredWidthM: 6,
  });
  return [
    { name: 'large', ways: [street(8), arterial, second] },
    { name: 'étroit', ways: [street(2.6), arterial, second] },
    { name: 'sans artère', ways: [street(8)] },
  ];
}

function ports(world: World, onCorridor?: () => void): FullPorts {
  const street = world.ways[0] as RoadWay;
  return {
    geocode: { geocode: async () => [{ source: 'ban', point: O, score: 0.95, formatted: '1 Rue Test', banId: null, positionType: null }] },
    graph: { fetchNeighbourhood: async (_c, r) => hoodOf(O, r, [street]) },
    surfaces: { fetchSurfaces: async () => [] },
    structuring: { fetchStructuring: async (_c, r) => hoodOf(O, r, world.ways) },
    routing: {
      route: async (from, to) => {
        const polyline: GeoPoint[] = [];
        for (let i = 0; i <= 8; i += 1) {
          polyline.push({
            lat: from.lat + ((to.lat - from.lat) * i) / 8,
            lon: from.lon + ((to.lon - from.lon) * i) / 8,
          });
        }
        return [{ polyline, distanceM: 800, durationS: 90 }];
      },
    },
    corridor: {
      fetchCorridor: async () => {
        onCorridor?.();
        return [...world.ways];
      },
    },
  };
}

const frozen = () => '2026-09-11T10:00:00.000Z';

async function runWith(world: World, params: FullParams, onCorridor?: () => void) {
  const outcome = await runFullAnalysis(
    { kind: 'address', address: '1 Rue Test' },
    TRUCK,
    ports(world, onCorridor),
    params,
    frozen,
  );
  if (!outcome.ok) throw new Error(`${world.name} : ${outcome.stage}/${outcome.why}`);
  return outcome.analysis;
}

/**
 * La découverte, dépouillée de ce que ajoute.
 *
 * `cost.durationMs` part avec : c'est une horloge murale, elle diffère d'un run
 * à l'autre par construction et ne dit rien du silence. `cost.routingCalls`,
 * lui, reste comparé — un rayon de plus serait exactement la régression que ce
 * fichier cherche.
 */
function withoutByWidth(discovery: unknown) {
  if (discovery === null || discovery === undefined) return discovery;
  const d = discovery as Record<string, unknown>;
  const strip = (list: unknown) =>
    (list as { gateByWidth?: unknown; widthProfile?: unknown }[]).map(
      ({ gateByWidth: _g, widthProfile: _p, ...rest }) => rest,
    );
  const { byWidth: _b, cost, ...rest } = d;
  const { durationMs: _ms, ...steadyCost } = cost as Record<string, unknown>;
  return {
    ...rest,
    cost: steadyCost,
    approaches: strip(d['approaches']),
    approachesOut: strip(d['approachesOut']),
  };
}

describe('l’ancre par largeur ne change rien en aval', () => {
  for (const world of worlds()) {
    it(`témoin : ${world.name}`, async () => {
      const silent = await runWith(world, BASE);
      const loud = await runWith(world, WITH_WIDTH);

      expect(loud.candidates).toEqual(silent.candidates);
      expect(loud.collected).toEqual(silent.collected);
      expect(loud.projection).toEqual(silent.projection);
      expect(loud.summary).toEqual(silent.summary);
      expect(loud.facts).toEqual(silent.facts);

      // L'ancrage aussi, `gateByWidth` et `byWidth` mis de côté — les seuls
      // champs que la tâche ajoute. Les ancres retenues, les voies examinées,
      // les tours, les origines, la couverture et le critère d'arrêt sont
      // bit pour bit ceux d'avant.
      const { discovery: off, ...silentSearch } = silent.gateSearch ?? { discovery: null };
      const { discovery: on, ...loudSearch } = loud.gateSearch ?? { discovery: null };
      expect(loudSearch).toEqual(silentSearch);
      expect(withoutByWidth(on)).toEqual(withoutByWidth(off));
    });
  }

  it('éteinte, elle ne fetche pas un corridor de plus', async () => {
    const world = worlds()[0] as World;
    let silentCalls = 0;
    await runWith(world, BASE, () => {
      silentCalls += 1;
    });
    let loudCalls = 0;
    const loud = await runWith(world, WITH_WIDTH, () => {
      loudCalls += 1;
    });

    // Deux ancres × deux sens = quatre corridors pour S4, dans les deux cas.
    // Le tronc commun n'en ajoute pas un ici : les deux ancres sont
    // au nord et à l'est, les jambes divergent dès le point de livraison, donc
    // il n'y a rien de commun à contrôler. Quand il y en a, il coûte un
    // corridor — gratuit derrière le cache par tuile, compté ici.
    expect(silentCalls).toBe(4);
    const byWidth = loud.gateSearch?.discovery?.byWidth;
    expect(byWidth).not.toBeNull();
    // Et ceux en plus, comptés et publiés — jamais estimés.
    expect(loudCalls).toBe(silentCalls + (byWidth?.cost.overpassCalls ?? 0));
  });

  it('éteinte, `byWidth` vaut null et aucune approche ne porte d’ancre ni de profil', async () => {
    const world = worlds()[0] as World;
    const silent = await runWith(world, BASE);
    const discovery = silent.gateSearch?.discovery;
    expect(discovery?.byWidth).toBeNull();
    for (const approach of [...(discovery?.approaches ?? []), ...(discovery?.approachesOut ?? [])]) {
      expect(approach.gateByWidth).toBeNull();
      expect(approach.widthProfile).toBeNull();
    }
  });
});

describe('ce que la mesure, elle, rapporte', () => {
  it('chaque approche gardée porte son ancre, entrées ET sorties', async () => {
    const world = worlds()[0] as World;
    const analysis = await runWith(world, WITH_WIDTH);
    const discovery = analysis.gateSearch?.discovery;
    expect(discovery).toBeTruthy();
    if (!discovery) return;

    const all = [...discovery.approaches, ...discovery.approachesOut];
    expect(all.length).toBeGreaterThan(1);
    for (const approach of all) expect(approach.gateByWidth).not.toBeNull();

    const byWidth = discovery.byWidth;
    expect(byWidth?.computedFor).toBe(all.length);
    expect(byWidth?.skipped).toBe(0);
    expect(byWidth?.truckId).toBe('pl-19t');
    // Le seuil est celui de S5 : 2,5 + 0,8 + 0,4. Rien n'est inventé ici.
    expect(byWidth?.requiredWidthM).toBeCloseTo(3.7, 9);
    expect(byWidth?.cost.overpassCalls).toBe(all.length);
    // Toutes les approches traversent le même petit monde : trois voies
    // distinctes, dérivées une fois, quel que soit le nombre de corridors.
    expect(byWidth?.waysLoaded).toBe(world.ways.length);
  });

  it('l’ancre tombe là où la voie redevient large et le reste : sur la pénétrante', async () => {
    const world = worlds()[0] as World;
    const analysis = await runWith(world, WITH_WIDTH);
    const gate = analysis.gateSearch?.discovery?.approaches[0]?.gateByWidth;

    // La rue de livraison fait 8 m, mais elle s'arrête à 170 m et rien n'est
    // décrit entre elle et la pénétrante : ce trou n'est pas du réseau sûr, il
    // est du réseau qu'on ne connaît pas. L'ancre se pose donc sur l'artère à
    // 7 m — c'est le premier point d'où TOUT tient jusqu'au bout.
    expect(gate?.basis).toBe('width');
    expect(gate?.wayId).toBe('arterial');
    expect(gate?.widthM).toBe(7);
    expect((gate?.distanceFromDeliveryM ?? 0) > 500).toBe(true);
  });

  it('la rue à 2,6 m ne suffit pas : elle pousse l’ancre, et se nomme', async () => {
    const world = worlds()[1] as World;
    const analysis = await runWith(world, WITH_WIDTH);
    const gates = (analysis.gateSearch?.discovery?.approaches ?? []).map((a) => a.gateByWidth);
    expect(gates.length).toBeGreaterThan(0);
    for (const gate of gates) {
      expect(gate?.firstNarrowSegment?.wayId).toBe('street');
      expect(gate?.firstNarrowSegment?.widthM).toBe(2.6);
      expect(gate?.firstNarrowSegment?.atM).toBe(0);
    }
  });

  it('sans candidat R0, la mesure existe quand même', async () => {
    const world = worlds()[2] as World; // aucune artère : aucune ancre
    const analysis = await runWith(world, WITH_WIDTH);
    expect(analysis.candidates.known).toBe(false);
    const discovery = analysis.gateSearch?.discovery;
    expect(discovery?.byWidth).not.toBeNull();
    for (const approach of discovery?.approaches ?? []) expect(approach.gateByWidth).not.toBeNull();
  });

  it('reprojeter rejoue les ancres pour le nouveau camion, sans un appel réseau', async () => {
    const world = worlds()[0] as World;
    let calls = 0;
    const analysis = await runWith(world, WITH_WIDTH, () => {
      calls += 1;
    });
    const before = calls;
    const other = reprojectTruck(analysis, SEMI, WITH_WIDTH, frozen);

    // Aucun corridor de plus : le PROFIL des voies est un fait de la route,
    // mesuré une fois ; seul le seuil dépend du camion. C'est le même partage
    // que `projectTruck`, qui rejoue un verdict sur des faits déjà établis.
    expect(calls).toBe(before);

    const byWidth = other.gateSearch?.discovery?.byWidth;
    expect(byWidth?.truckId).toBe('semi-44t');
    // 2,55 + 0,8 + 0,4 pour le semi, contre 3,7 pour le porteur.
    expect(byWidth?.requiredWidthM).toBeCloseTo(3.75, 9);
    for (const approach of other.gateSearch?.discovery?.approaches ?? []) {
      expect(approach.gateByWidth?.requiredWidthM).toBeCloseTo(3.75, 9);
    }

    // Le profil, lui, n'a pas bougé d'un tronçon.
    expect(other.gateSearch?.discovery?.approaches.map((a) => a.widthProfile)).toEqual(
      analysis.gateSearch?.discovery?.approaches.map((a) => a.widthProfile),
    );
    expect(other.projection?.conclusion.profileId).toBe('semi-44t');
  });

  it('un camion plus large repousse l’ancre, sur le même profil', async () => {
    // La rue de livraison fait 2,6 m : trop étroite pour les deux. L'artère en
    // fait 7 : assez pour les deux. Ce qui change entre les deux camions, c'est
    // le seuil, et la mesure doit le porter là où il compte.
    const world = worlds()[1] as World;
    const analysis = await runWith(world, WITH_WIDTH);
    const other = reprojectTruck(analysis, SEMI, WITH_WIDTH, frozen);
    const narrowOf = (a: { gateByWidth: { firstNarrowSegment: unknown } | null }) =>
      a.gateByWidth?.firstNarrowSegment;
    for (const [i, approach] of (other.gateSearch?.discovery?.approaches ?? []).entries()) {
      const held = analysis.gateSearch?.discovery?.approaches[i];
      if (held === undefined) continue;
      expect(narrowOf(approach)).toEqual(narrowOf(held));
    }
  });

  it('chaque approche mesurée porte son profil de largeurs', async () => {
    const world = worlds()[0] as World;
    const analysis = await runWith(world, WITH_WIDTH);
    const discovery = analysis.gateSearch?.discovery;
    for (const approach of discovery?.approaches ?? []) {
      const profile = approach.widthProfile;
      expect(profile, approach.key).not.toBeNull();
      expect((profile ?? []).length).toBeGreaterThan(0);
      // Le profil se lit du point de livraison vers l'extérieur, sans trou :
      // chaque tronçon commence où le précédent finit.
      let previousTo = -1;
      for (const run of profile ?? []) {
        expect(run.fromM).toBeGreaterThan(previousTo);
        expect(run.toM).toBeGreaterThanOrEqual(run.fromM);
        previousTo = run.toM;
      }
      expect(profile?.[0]?.fromM).toBe(0);
    }
  });
});
