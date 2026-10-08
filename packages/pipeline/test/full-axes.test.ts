/**
 * LE TEST D'OR : l'étage axes éteint ne change RIEN en aval.
 *
 * « En silence » est la contrainte entière de cette tâche, et elle se prouve
 * ici, pas dans la relecture d'un diff : le même run, joué deux fois sur les
 * mêmes ports et la même horloge, `gates.axes.enabled` à faux puis à vrai,
 * doit rendre des `candidates`, des `collected`, une `projection` et un
 * `summary` DEEP-EQUAL tant que le drapeau est baissé — et le même ancrage, à
 * `axes` près, qui est le seul champ nouveau.
 *
 * Le troisième cas est celui qui manquait à l'engine (BUG-060 : « the correct
 * west-side itinerary cannot be ranked at all ») : quand l'étage ne trouve pas
 * d'axe, il ne doit rien casser — la sélection R0 reste, et le motif est écrit.
 *
 * Même forme que `full-discovery.test.ts` et `full-gate-by-width.test.ts`, et
 * pour la même raison : trois mondes, parce qu'un seul ne prouverait qu'un
 * seul chemin de code.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint, TruckProfile } from '@teneolog/domain';
import type { AxisSourcePort } from '@teneolog/routes';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';
import { closestPointOnPolyline } from '@teneolog/topology';

import type { PipelineParams } from '../src/analyse.js';
import { runFullAnalysis, type FullParams, type FullPorts } from '../src/full.js';

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

const BASE: FullParams = {
  pipeline: PIPELINE,
  gates: {
    searchRadiusM: 2000,
    gateCount: 5,
    minDistanceM: 500,
    // Zéro, et non les 1 800 m de la prod : les mondes de ce cas tiennent dans
    // 900 m, donc le seuil de production n'y laisserait aucune ancre R0. La
    // portée a ses propres cas, à l'échelle réelle (`gate-search.test.ts`).
    minReachM: 0,
    axes: {
      enabled: false,
      importanceMin: 2,
      importanceMax: 3,
      localImportance: { min: 4, max: 5 },
      ringsM: [50, 250, 500, 2000, 5000, 10000, 15000],
      fetchRadiiM: [500, 5000, 15000],
      sectorCount: 12,
      minGateDirections: 2,
      // les deux règles du soir, aux valeurs de
      // la prod : deux portes ne font deux directions qu'à 60° d'écart, et le
      // classe 4 se pose sur le cercle avant toute escalade.
      minDirectionSeparationDeg: 60,
      circleFallbackImportanceMax: 4,
      // PRINCIPE 23 (2026-09-14) — n'est plus lue depuis la policy :
      // `gate-stage.ts` câble toujours `escalationBoundM` sur
      // `gates.searchRadiusM` avant d'appeler l'étage, exactement comme il le
      // fait déjà pour `gateCount` et `minReachM` ci-dessous. La valeur écrite
      // ici est donc ignorée en pratique — gardée seulement parce que le type
      // d'entrée de l'étage (`AxisStageParams`, fourni par le pipeline) exige
      // le champ.
      escalationBoundM: 2_000,
      maxAxisSegmentsPerFetch: 2_000,
      maxLocalSegmentsPerFetch: 500,
      stageTimeoutMs: 60_000,
      localFetchRadiusM: 1500,
      localFetchSpacingM: 3500,
      localFetchMaxPointsPerAxis: 6,
      localFetchMaxPoints: 48,
      gateCount: 5,
      // Repris de `gates.minReachM` par `gate-stage.ts` ; la valeur écrite ici
      // est ignorée, et vaut 0 comme le reste de ce cas.
      minReachM: 0,
    },
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
    stopWhen: { minMarginM: 0.4 },
  },
  obviousStop: { declaredWidthMinM: 10, measuredWidthMinM: 6.5 },
  policyVersion: 'test',
  reportShelfLifeDays: 30,
};

const TRUCK: TruckProfile = {
  id: 'pl-19t',
  label: 'Porteur 19 t',
  family: 'rigid',
  envelope: { lengthM: 9, widthM: 2.5, heightM: 3.5, gvwT: 19, turnRadiusM: 11, wheelbaseM: 6.1, frontOverhangM: 1.2, rearOverhangM: 1.7 },
  equipment: { tailLift: true, crane: false, refrigerated: false },
};

/** Les tronçons BD TOPO que la source de l'étage axes rend, par monde. */
interface World {
  readonly name: string;
  /** Le voisinage OSM structurant que R0 lit. */
  readonly ways: readonly RoadWay[];
  /** Ce que la BD TOPO répond, par classe d'importance. */
  readonly bdtopo: readonly RoadWay[];
}

function bdtopoWay(id: string, geometry: readonly GeoPoint[], importance: number, name: string | null = null): RoadWay {
  return way(id, geometry.map((_, i) => `${id}:v${i}`), geometry, {
    source: 'bdtopo-postgis',
    importance,
    name,
    tags: {},
  });
}

function worlds(): readonly World[] {
  const street = (widthM: number): RoadWay =>
    way('street', ['a', 'b'], [at(0, -170), at(0, 170)], { name: 'Rue Test', declaredWidthM: widthM });
  const arterial = way('arterial', ['g1', 'g2'], [at(800, 0), at(900, 0)], {
    tags: { highway: 'primary' },
    declaredWidthM: 7,
  });
  const second = way('arterial-e', ['g3', 'g4'], [at(0, 800), at(0, 900)], {
    tags: { highway: 'secondary' },
    declaredWidthM: 6,
  });
  // Un axe BD TOPO au nord, à 700 m, et la rue locale qui en descend : l'étage
  // trouve une porte à 700 m là où R0 pose ses ancres à 800-900 m.
  const axis = bdtopoWay('AX', [at(700, -900), at(700, 900)], 3, 'D113');
  const local = bdtopoWay('LOC', [at(700, 0), at(150, 0)], 4, 'Rue de la Poste');
  return [
    { name: 'large', ways: [street(8), arterial, second], bdtopo: [axis, local] },
    { name: 'étroit', ways: [street(2.6), arterial, second], bdtopo: [axis, local] },
    // Le cas qui compte pour le repli : pas un axe BD TOPO à 15 km.
    { name: 'sans axe', ways: [street(8), arterial, second], bdtopo: [] },
  ];
}

/** La source BD TOPO de laboratoire : distance à la LIGNE, comme `ST_DWithin`. */
function axisSource(ways: readonly RoadWay[]): AxisSourcePort {
  return {
    fetchByImportance: async (centre, radiusM, range, limit) => {
      const kept = ways.filter((w) => {
        const importance = w.importance ?? 99;
        if (importance < range.min || importance > range.max) return false;
        const closest = closestPointOnPolyline(w.geometry, centre);
        return closest !== null && closest.distanceM <= radiusM;
      });
      return { ways: kept.slice(0, limit), truncated: kept.length >= limit };
    },
  };
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
    axes: axisSource(world.bdtopo),
  };
}

const frozen = (): string => '2026-09-14T10:00:00.000Z';

async function runWith(world: World, params: FullParams) {
  const run = await runFullAnalysis({ kind: 'address', address: '1 Rue Test' }, TRUCK, ports(world), params, frozen);
  if (!run.ok) throw new Error(`${world.name} : ${run.stage}/${run.why}`);
  return run.analysis;
}

/** La même policy, le drapeau levé — et rien d'autre de changé. */
const LOUD: FullParams = {
  ...BASE,
  gates: { ...BASE.gates, axes: { ...BASE.gates.axes!, enabled: true } },
};

describe('éteint, l’étage axes ne change rien en aval', () => {
  for (const world of worlds()) {
    it(`témoin : ${world.name}`, async () => {
      const { axes: _off, ...gatesWithoutStage } = BASE.gates;
      const withoutStage = await runWith(world, { ...BASE, gates: gatesWithoutStage });
      const silent = await runWith(world, BASE);

      expect(silent.candidates).toEqual(withoutStage.candidates);
      expect(silent.collected).toEqual(withoutStage.collected);
      expect(silent.projection).toEqual(withoutStage.projection);
      expect(silent.summary).toEqual(withoutStage.summary);
      expect(silent.facts).toEqual(withoutStage.facts);

      // L'ancrage aussi, à `axes` près — le seul champ nouveau.
      const { axes: off, ...bare } = withoutStage.gateSearch ?? { axes: null };
      const { axes: on, ...withAxes } = silent.gateSearch ?? { axes: null };
      expect(withAxes).toEqual(bare);
      expect(off).toBeNull();
      expect(on).not.toBeNull();
      expect(on?.enabled).toBe(false);
      expect(on?.fallback).toBe('r0_silent');
    });
  }
});

describe('allumé, les portes des axes remplacent les ancres de R0', () => {
  it('les ancres servies sont celles de l’étage, et elles ne sont plus sur le cercle', async () => {
    const world = worlds()[0] as World;
    const silent = await runWith(world, BASE);
    const loud = await runWith(world, LOUD);

    expect(loud.gateSearch?.axes?.fallback).toBe('axes');
    expect(loud.gateSearch?.axes?.reachedRingM).toBe(2_000);
    expect(loud.gateSearch?.axes?.retained.length).toBeGreaterThan(0);

    // R0 garde ses deux ancres sur les artères ; l'étage pose la sienne à la
    // jonction D113 × Rue de la Poste. Les identifiants de jambes le disent.
    const before = silent.candidates.known ? silent.candidates.value.map((c) => c.id) : [];
    const after = loud.candidates.known ? loud.candidates.value.map((c) => c.id) : [];
    expect(before.some((id) => id.startsWith('arterial@'))).toBe(true);
    expect(after.every((id) => id.startsWith('AX+LOC@'))).toBe(true);
  });
});

describe('sans axe à 15 km, la sélection R0 reste, et le motif est écrit', () => {
  it('le repli est nommé, pas tu, et aucun verdict ne bouge', async () => {
    const world = worlds()[2] as World;
    const silent = await runWith(world, BASE);
    const loud = await runWith(world, LOUD);

    expect(loud.gateSearch?.axes?.reason).toBe('no_axis_within_max');
    expect(loud.gateSearch?.axes?.fallback).toBe('r0_no_axis');
    expect(loud.candidates).toEqual(silent.candidates);
    expect(loud.projection).toEqual(silent.projection);
  });

  it('sans port BD TOPO du tout, l’étage dit « on n’a pas regardé »', async () => {
    const world = worlds()[0] as World;
    const run = await runFullAnalysis(
      { kind: 'address', address: '1 Rue Test' },
      TRUCK,
      { ...ports(world), axes: null },
      LOUD,
      frozen,
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.analysis.gateSearch?.axes?.reason).toBe('no_source');
    expect(run.analysis.gateSearch?.axes?.fallback).toBe('r0_no_axis');
  });
});

describe('éteint, l’étage ne BLOQUE pas le run, et il a un budget', () => {
  /**
   * LE TÉMOIN MÉCANIQUE DE LA MISE EN PARALLÈLE.
   *
   * La source BD TOPO ne répond que lorsque le ROUTEUR a été appelé. Si
   * l'étage était attendu avant la sélection R0 — comme il l'était avant cette
   * tâche —, le routeur ne serait jamais appelé, la source ne répondrait
   * jamais, et le cas resterait bloqué jusqu'au délai de vitest. Qu'il rende
   * une analyse est la preuve que l'étage court À CÔTÉ et se rejoint après.
   */
  it('la BD TOPO peut attendre le routeur : le run aboutit quand même', async () => {
    const world = worlds()[0] as World;
    let release = (): void => {};
    const routed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = ports(world);
    const slowAxes: AxisSourcePort = {
      fetchByImportance: async (centre, radiusM, range, limit) => {
        await routed;
        return (base.axes as AxisSourcePort).fetchByImportance(centre, radiusM, range, limit);
      },
    };
    const run = await runFullAnalysis(
      { kind: 'address', address: '1 Rue Test' },
      TRUCK,
      {
        ...base,
        axes: slowAxes,
        routing: {
          route: async (from, to, alternatives) => {
            release();
            return base.routing.route(from, to, alternatives);
          },
        },
      },
      BASE,
      frozen,
    );

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    // Et l'étage a bien été rejoint : son compte rendu est là, complet.
    // `best_ring_kept` et non `ring_reached` : le monde de laboratoire n'a
    // qu'UNE rue locale, donc une seule direction de porte, et le critère de
    // en demande deux — l'étage garde son meilleur anneau et le dit.
    expect(run.analysis.gateSearch?.axes?.fallback).toBe('r0_silent');
    expect(run.analysis.gateSearch?.axes?.reason).toBe('best_ring_kept');
  });

  /**
   * LE BUDGET DE L'ÉTAGE LIBÈRE LA FIN DU RUN.
   *
   * `sealAxes` attend l'étage avant que l'analyse soit rendue (`full.ts`, puis
   * `run.status = 'complete'` côté API). Une source muette tiendrait donc le
   * run en otage, drapeau baissé compris — jusqu'à 7 min 44 s au pire
   * théorique (58 requêtes en série à `queryTimeoutMs`, et non 52 : le pool
   * par anneau redemande le disque de l'arrêt jusqu'à 7 fois). Avec le
   * budget, le run se termine, l'étage DIT pourquoi il n'a rien, et les
   * ancres de R0 sont intactes.
   */
  it('une source muette : le budget rend la main, le run se termine, R0 sert', async () => {
    const world = worlds()[0] as World;
    const base = ports(world);
    const mute: AxisSourcePort = { fetchByImportance: () => new Promise(() => undefined) };

    const reference = await runFullAnalysis(
      { kind: 'address', address: '1 Rue Test' },
      TRUCK,
      base,
      BASE,
      frozen,
    );
    const run = await runFullAnalysis(
      { kind: 'address', address: '1 Rue Test' },
      TRUCK,
      { ...base, axes: mute },
      { ...BASE, gates: { ...BASE.gates, axes: { ...BASE.gates.axes!, stageTimeoutMs: 50 } } },
      frozen,
    );

    expect(run.ok).toBe(true);
    expect(reference.ok).toBe(true);
    if (!run.ok || !reference.ok) return;
    expect(run.analysis.gateSearch?.axes?.reason).toBe('timeout');
    expect(run.analysis.gateSearch?.axes?.retained).toEqual([]);
    // Les ancres servies n'ont pas bougé d'un bit : l'étage était en silence,
    // et son abandon est une lecture en moins, pas une jambe en moins.
    const { axes: _abandoned, ...muteSearch } = run.analysis.gateSearch ?? { axes: null };
    const { axes: _measured, ...fullSearch } = reference.analysis.gateSearch ?? { axes: null };
    expect(muteSearch).toEqual(fullSearch);
    expect(run.analysis.candidates).toEqual(reference.analysis.candidates);
  });
});

describe('PRINCIPE 34 — l’approche non étudiée ne voyage que si l’étage sert', () => {
  /** `minReachM` à 1 800 m : les portes des mondes de ce cas sont toutes en deçà. */
  const withCircle = (params: FullParams, enabled: boolean): FullParams => ({
    ...params,
    gates: {
      ...params.gates,
      minReachM: 1_800,
      axes: { ...(params.gates.axes as NonNullable<FullParams['gates']['axes']>), enabled },
    },
  });

  it('allumé : la porte est retenue, et ses mètres non contrôlés sont sur le fil', async () => {
    const world = worlds()[0] as World;
    const loud = await runWith(world, withCircle(BASE, true));
    const axes = loud.gateSearch?.axes;

    expect(axes?.fallback).toBe('axes');
    expect(axes?.retained.length).toBeGreaterThan(0);
    // La porte est SOUS le cercle et concourt quand même (principe 34)…
    const first = axes?.retained[0];
    expect(first?.distanceM).toBeLessThan(1_800);
    expect(first?.rank).not.toBeNull();
    // … et elle porte son motif et ses mètres.
    expect(first?.reasonCodes).toEqual(['approach_uncontrolled_beyond_gate']);
    expect(first?.uncontrolledBeyondM).toBe(Math.round(1_800 - (first?.distanceM ?? 0)));
    expect(loud.gateSearch?.uncontrolledApproaches.length).toBe(axes?.retained.length);
    expect(loud.gateSearch?.uncontrolledApproaches[0]?.minReachM).toBe(1_800);
  });

  it('éteint : l’étage le mesure, le fil ne le porte pas', async () => {
    const world = worlds()[0] as World;
    const silent = await runWith(world, withCircle(BASE, false));
    expect(silent.gateSearch?.axes?.uncontrolled.length).toBeGreaterThan(0);
    expect(silent.gateSearch?.uncontrolledApproaches).toEqual([]);
  });
});
