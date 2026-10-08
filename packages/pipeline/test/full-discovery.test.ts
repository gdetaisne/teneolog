/**
 * Le test d'or : la découverte allumée ne change RIEN en aval.
 *
 * « En silence » est la contrainte entière de cette tâche. Elle se prouve
 * ici : le même run, joué deux fois sur les mêmes ports et la même horloge,
 * `discovery.enabled` à faux puis à vrai, doit rendre des `candidates`, des
 * `collected`, une `projection` et un `summary` DEEP-EQUAL — et le même
 * ancrage, à `discovery` près, qui est le seul champ nouveau.
 *
 * Le juge, ce n'est pas la relecture du diff de `full.ts` : c'est ce fichier.
 * Si un jour la découverte se met à consommer le budget du routeur, à trier
 * les candidats ou à toucher un tableau partagé, c'est ici que ça tombe.
 *
 * La moitié amont — les ancres sur les deux mille voisinages tirés au sort —
 * est jugée par `packages/routes/test/discovery-silence.test.ts`, où ce corpus
 * vit.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint, TruckProfile } from '@teneolog/domain';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import type { PipelineParams } from '../src/analyse.js';
import { continueFromFacts, reprojectTruck, runFullAnalysis, type FullParams, type FullPorts } from '../src/full.js';

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

/** La policy de test, aux nombres près qui n'intéressent pas ce test. */
const BASE: FullParams = {
  pipeline: PIPELINE,
  gates: {
    searchRadiusM: 2000,
    gateCount: 5,
    minDistanceM: 500,
    //, etendu a R0 par zero, et non les 1 800 m de la prod :
    // les mondes de ces cas tiennent dans 900 m (les arteres sont a 800-900 m
    // de l'arret), donc le seuil de production n'y laisserait AUCUNE ancre R0
    // et, cote decouverte, ecarterait toutes les jambes posees sur le reseau
    // pour ne garder que les rayons tombes dans le vide a 2 000 m. Ces cas
    // mesurent le rapport de la decouverte, pas la portee ; la portee a ses
    // propres cas, a l'echelle reelle (packages/routes/test/discovery.test.ts,
    // packages/routes/test/gate-search.test.ts).
    minReachM: 0,
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
    enabled: false,
    rounds: [4, 8, 24],
    radiusM: 2000,
    windowM: 1000,
    maxConcurrent: 4,
    // La marge de confort de la policy de test (`projection.comfortMarginM`).
    stopWhen: { minMarginM: 0.4 },
  },
  obviousStop: { declaredWidthMinM: 10, measuredWidthMinM: 6.5 },
  policyVersion: 'test',
  reportShelfLifeDays: 30,
};

const WITH_DISCOVERY: FullParams = { ...BASE, discovery: { ...BASE.discovery, enabled: true } };

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

/**
 * Trois mondes, parce qu'un seul ne prouverait qu'un seul chemin de code.
 *
 *  - `large` : rue traversante de 8 m, une pénétrante au nord — le cas nominal ;
 *  - `étroit` : la même rue à 2,6 m, qui fait tomber le verdict et donc le
 *    critère d'arrêt ;
 *  - `sans artère` : aucune voie structurante, donc aucune ancre et aucun
 *    candidat — la branche où le pipeline sort tôt.
 */
interface World {
  readonly name: string;
  readonly ways: readonly RoadWay[];
}

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

function ports(world: World): FullPorts {
  const street = world.ways[0] as RoadWay;
  return {
    geocode: { geocode: async () => [{ source: 'ban', point: O, score: 0.95, formatted: '1 Rue Test', banId: null, positionType: 'housenumber' }] },
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
    corridor: { fetchCorridor: async () => [...world.ways] },
  };
}

/** Une horloge figée : deux runs comparables doivent porter le même instant. */
const frozen = () => '2026-09-11T10:00:00.000Z';

async function runWith(world: World, params: FullParams) {
  const s0s2 = await runFullAnalysis({ kind: 'address', address: '1 Rue Test' }, TRUCK, ports(world), params, frozen);
  if (!s0s2.ok) throw new Error(`${world.name} : ${s0s2.stage}/${s0s2.why}`);
  return s0s2.analysis;
}

describe('la découverte ne change rien en aval', () => {
  for (const world of worlds()) {
    it(`témoin : ${world.name}`, async () => {
      const silent = await runWith(world, BASE);
      const loud = await runWith(world, WITH_DISCOVERY);

      expect(loud.candidates).toEqual(silent.candidates);
      expect(loud.collected).toEqual(silent.collected);
      expect(loud.projection).toEqual(silent.projection);
      expect(loud.summary).toEqual(silent.summary);
      expect(loud.facts).toEqual(silent.facts);

      // L'ancrage aussi, à `discovery` près — le seul champ nouveau.
      const { discovery: off, ...silentSearch } = silent.gateSearch ?? { discovery: null };
      const { discovery: on, ...loudSearch } = loud.gateSearch ?? { discovery: null };
      expect(loudSearch).toEqual(silentSearch);
      expect(off).toBeNull();
      expect(on).not.toBeNull();
    });
  }

  it('éteinte, la policy laisse `discovery` à null et ne route rien de plus', async () => {
    const world = worlds()[0] as World;
    let calls = 0;
    const counted = ports(world);
    const spy: FullPorts = {
      ...counted,
      routing: {
        route: async (from, to, alternatives) => {
          calls += 1;
          return counted.routing.route(from, to, alternatives);
        },
      },
    };
    const s0s2 = await runFullAnalysis({ kind: 'address', address: '1 Rue Test' }, TRUCK, spy, BASE, frozen);
    expect(s0s2.ok).toBe(true);
    if (!s0s2.ok) return;
    expect(s0s2.analysis.gateSearch?.discovery).toBeNull();
    // Deux ancres × deux sens : rien d'autre n'a été routé.
    expect(calls).toBe(4);
  });
});

describe('ce que la découverte, elle, rapporte', () => {
  it('elle joue tous ses tours et dit ce que R0 couvre', async () => {
    const world = worlds()[0] as World;
    const analysis = await runWith(world, WITH_DISCOVERY);
    const discovery = analysis.gateSearch?.discovery;
    expect(discovery).toBeDefined();
    if (discovery === undefined || discovery === null) return;

    expect(discovery.budget).toEqual({ maxRounds: 3, playedRounds: 3, settingKind: null });
    expect(discovery.rounds.map((round) => round.rays)).toEqual([4, 8, 24]);
    expect(discovery.cost.routingCalls).toBeGreaterThan(0);
    expect(discovery.windowM).toBe(1_000);
    expect(discovery.fetchedAt).toBe(frozen());
    // Le routeur factice rentre en ligne droite depuis chaque origine : les
    // jambes ne se rejoignent qu'à l'arrêt, donc chaque rayon est sa propre
    // approche. C'est une géométrie de laboratoire — la vraie convergence est
    // celle d'OSRM, mesurée sur la prod — mais elle vérifie ce qui compte ici :
    // le compte publié EST le nombre d'approches gardées, sans arrondi.
    expect(discovery.approaches.length).toBeGreaterThan(1);
    expect(discovery.coverageByR0.approachesTotal).toBe(discovery.approaches.length);
    expect(discovery.rounds.reduce((sum, round) => sum + round.legsKept, 0)).toBe(
      discovery.approaches.length,
    );
    // Les deux ancres de R0 arrivent aussi par une ligne droite : leurs
    // approches font partie des découvertes.
    expect(discovery.coverageByR0.coveredByR0).toBeGreaterThan(0);
    expect(discovery.coverageByR0.r0CandidatesUncovered).toEqual([]);
    expect(discovery.stopCriterion.evaluatedOn).toBe('R0');
  });

  it('elle rapporte aussi les sorties, jointes aux sorties de R0', async () => {
    const world = worlds()[0] as World;
    const analysis = await runWith(world, WITH_DISCOVERY);
    const discovery = analysis.gateSearch?.discovery;
    expect(discovery).toBeDefined();
    if (discovery === undefined || discovery === null) return;

    expect(discovery.approachesOut.length).toBeGreaterThan(1);
    for (const approach of discovery.approachesOut) expect(approach.direction).toBe('out');
    for (const approach of discovery.approaches) expect(approach.direction).toBe('in');
    expect(discovery.rounds.reduce((sum, round) => sum + round.legsKeptOut, 0)).toBe(
      discovery.approachesOut.length,
    );

    // Une approche sortante n'est jamais couverte par une jambe ENTRANTE : la
    // jointure se fait côté sortie, sur les premiers mètres.
    const outIds = new Set(
      (analysis.candidates.known ? analysis.candidates.value : [])
        .filter((candidate) => candidate.direction === 'out')
        .map((candidate) => candidate.id),
    );
    const named = discovery.approachesOut
      .map((approach) => approach.coveredByCandidateId)
      .filter((id): id is string => id !== null);
    expect(named.length).toBeGreaterThan(0);
    for (const id of named) expect(outIds.has(id)).toBe(true);
  });

  it('sans candidat R0, elle existe quand même et le dit', async () => {
    const world = worlds()[2] as World; // aucune artère : aucune ancre
    const analysis = await runWith(world, WITH_DISCOVERY);
    expect(analysis.candidates.known).toBe(false);
    const discovery = analysis.gateSearch?.discovery;
    expect(discovery?.stopCriterion.satisfied).toBe(false);
    expect(discovery?.stopCriterion.reasons).toContain('no_r0_candidates');
    expect(discovery?.coverageByR0.coveredByR0).toBe(0);
  });

  it('le critère d’arrêt suit le camion : reprojeter le rejoue', async () => {
    const world = worlds()[0] as World;
    const analysis = await runWith(world, WITH_DISCOVERY);
    const other = reprojectTruck(analysis, SEMI, WITH_DISCOVERY, frozen);

    // Les tours, les origines et les approches ne dépendent pas du camion :
    // rien n'est rerouté.
    expect(other.gateSearch?.discovery?.rounds).toEqual(analysis.gateSearch?.discovery?.rounds);
    expect(other.gateSearch?.discovery?.approaches).toEqual(analysis.gateSearch?.discovery?.approaches);
    expect(other.gateSearch?.discovery?.approachesOut).toEqual(
      analysis.gateSearch?.discovery?.approachesOut,
    );
    // Le critère, lui, est rejoué sur la projection du NOUVEAU camion.
    expect(other.gateSearch?.discovery?.stopCriterion.evaluatedOn).toBe('R0');
    expect(other.projection?.conclusion.profileId).toBe('semi-44t');
  });

  it('la découverte survit à un routeur en panne, et le run aussi', async () => {
    const world = worlds()[0] as World;
    const base = ports(world);
    let seen = 0;
    const flaky: FullPorts = {
      ...base,
      routing: {
        route: async (from, to, alternatives) => {
          seen += 1;
          // Les quatre premiers appels sont ceux de R0 : on ne casse qu'après,
          // sinon c'est le run qu'on teste, pas la découverte.
          if (seen > 4) throw new Error('OSRM 503');
          return base.routing.route(from, to, alternatives);
        },
      },
    };
    const s0s2 = await runFullAnalysis({ kind: 'address', address: '1 Rue Test' }, TRUCK, flaky, WITH_DISCOVERY, frozen);
    expect(s0s2.ok).toBe(true);
    if (!s0s2.ok) return;
    expect(s0s2.analysis.candidates.known).toBe(true);
    const discovery = s0s2.analysis.gateSearch?.discovery;
    expect(discovery?.approaches).toEqual([]);
    expect(discovery?.rounds.reduce((sum, round) => sum + round.legsFailed, 0)).toBeGreaterThan(0);
  });
});
