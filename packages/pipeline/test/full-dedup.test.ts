/**
 * Le test d'or : le dédoublonnage BAISSÉ ne change rien.
 *
 * Trois promesses, et c'est tout ce que la tâche livre en production :
 *
 *  1. **`routes` absent ou baissé, c'est le même run.** Le jeu de candidats,
 *     les points de passage, la projection, le résumé et l'ancrage sont
 *     DEEP-EQUAL — une policy qui n'a jamais entendu parler de la tâche et une
 *     policy qui la porte à sa valeur livrée rendent la même analyse.
 *  2. **Un candidat n'a pas changé de forme.** Retirés ses trois champs
 * additifs, il porte exactement les clés d'. C'est la garde
 *     qui attrape le champ posé « en passant » dans une tâche suivante.
 *  3. **Drapeau levé, le doublon part avant son corridor.** Moins de jambes,
 *     moins de corridors, et l'original nomme ce qui a disparu.
 *
 * Le routeur de ce fichier rend DEUX chemins identiques par requête — le
 * principal et son alternative, ce que fait OSRM sur un axe unique, et la
 * situation même que le défaut F2 de la note de conception interne décrit.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint, RouteCandidate, TruckProfile } from '@teneolog/domain';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import type { PipelineParams } from '../src/analyse.js';
import { runFullAnalysis, type FullAnalysis, type FullParams, type FullPorts } from '../src/full.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(northM: number, eastM = 0): GeoPoint {
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

/** La policy de référence, moins la découverte : ce fichier juge R0 et R0 seul. */
const BASE: FullParams = {
  pipeline: PIPELINE,
  gates: {
    searchRadiusM: 2000,
    gateCount: 5,
    minDistanceM: 500,
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
    enabled: false,
    rounds: [4],
    radiusM: 2000,
    windowM: 1000,
    maxConcurrent: 4,
    stopWhen: { minMarginM: 0.4 },
  },
  obviousStop: { declaredWidthMinM: 10, measuredWidthMinM: 6.5 },
  policyVersion: 'test',
  reportShelfLifeDays: 30,
};

const BAISSÉ: FullParams = { ...BASE, routes: { dedup: { enabled: false, approach: false } } };
const LEVÉ: FullParams = { ...BASE, routes: { dedup: { enabled: true, approach: false } } };

const TRUCK: TruckProfile = {
  id: 'pl-19t',
  label: 'Porteur 19 t',
  family: 'rigid',
  envelope: { lengthM: 9, widthM: 2.5, heightM: 3.5, gvwT: 19, turnRadiusM: 11, wheelbaseM: 6.1, frontOverhangM: 1.2, rearOverhangM: 1.7 },
  equipment: { tailLift: true, crane: false, refrigerated: false },
};

const STREET = way('street', ['a', 'b'], [at(0, -170), at(0, 170)], {
  name: 'Rue Test',
  declaredWidthM: 8,
});
const WAYS: readonly RoadWay[] = [
  STREET,
  way('arterial', ['g1', 'g2'], [at(800), at(900)], { tags: { highway: 'primary' }, declaredWidthM: 7 }),
  way('arterial-e', ['g3', 'g4'], [at(0, 800), at(0, 900)], { tags: { highway: 'secondary' }, declaredWidthM: 6 }),
];

function ports(onCorridor?: () => void): FullPorts {
  return {
    geocode: { geocode: async () => [{ source: 'ban', point: O, score: 0.95, formatted: '1 Rue Test', banId: null, positionType: null }] },
    graph: { fetchNeighbourhood: async (_c, r) => hoodOf(O, r, [STREET]) },
    surfaces: { fetchSurfaces: async () => [] },
    structuring: { fetchStructuring: async (_c, r) => hoodOf(O, r, WAYS) },
    routing: {
      // Deux chemins IDENTIQUES : le principal et son alternative.
      route: async (from, to) => {
        const polyline: GeoPoint[] = [];
        for (let i = 0; i <= 8; i += 1) {
          polyline.push({
            lat: from.lat + ((to.lat - from.lat) * i) / 8,
            lon: from.lon + ((to.lon - from.lon) * i) / 8,
          });
        }
        const path = { polyline, distanceM: 800, durationS: 90 };
        return [path, path];
      },
    },
    corridor: {
      fetchCorridor: async () => {
        onCorridor?.();
        return [...WAYS];
      },
    },
  };
}

const frozen = () => '2026-09-14T10:00:00.000Z';

async function run(params: FullParams, onCorridor?: () => void): Promise<FullAnalysis> {
  const outcome = await runFullAnalysis(
    { kind: 'address', address: '1 Rue Test' },
    TRUCK,
    ports(onCorridor),
    params,
    frozen,
  );
  if (!outcome.ok) throw new Error(`${outcome.stage}/${outcome.why}`);
  return outcome.analysis;
}

function candidatesOf(analysis: FullAnalysis): readonly RouteCandidate[] {
  return analysis.candidates.known ? analysis.candidates.value : [];
}

/** Les clés d'un `RouteCandidate` d', et elles seules. */
const CLÉS_DU_CANDIDAT = [
  'coverage',
  'corridorReasonCodes',
  'direction',
  'distanceM',
  'durationS',
  'egressOf',
  'generatedBy',
  'id',
  'polyline',
  'segments',
].sort();

describe('drapeau baissé, c’est le même run', () => {
  it('`routes` absent et `routes.dedup` baissé rendent la même analyse', async () => {
    const sans = await run(BASE);
    const baissé = await run(BAISSÉ);
    expect(baissé.candidates).toEqual(sans.candidates);
    expect(baissé.collected).toEqual(sans.collected);
    expect(baissé.projection).toEqual(sans.projection);
    expect(baissé.summary).toEqual(sans.summary);
    expect(baissé.gateSearch).toEqual(sans.gateSearch);
  });

  it('aucun corridor n’est économisé : c’est bien le silence, pas l’activation', async () => {
    let sans = 0;
    let baissé = 0;
    await run(BASE, () => { sans += 1; });
    await run(BAISSÉ, () => { baissé += 1; });
    expect(baissé).toBe(sans);
    expect(sans).toBeGreaterThan(0);
  });

  it('un candidat garde EXACTEMENT les clés d’avant la tâche, plus les quatre nommées', async () => {
    const analysis = await run(BAISSÉ);
    for (const candidate of candidatesOf(analysis)) {
      const rest = { ...candidate } as Record<string, unknown>;
      delete rest['duplicateOf'];
      delete rest['duplicatesRemoved'];
      delete rest['passesThroughGate'];
      // la quatrième marque additive : OÙ la carte a manqué. Comme
      // les trois autres, elle n'est posée que lorsqu'elle dit quelque chose,
      // et la retirer rend le candidat d'avant la tâche.
      delete rest['corridorUnread'];
      expect(Object.keys(rest).sort()).toEqual(CLÉS_DU_CANDIDAT);
    }
  });

  it('les alternatives se disent doublons, et restent', async () => {
    const candidates = candidatesOf(await run(BAISSÉ));
    const doublons = candidates.filter((c) => (c.duplicateOf ?? null) !== null);
    expect(doublons.length).toBeGreaterThan(0);
    expect(doublons.every((c) => c.duplicateOf?.on === 'geometry')).toBe(true);
    // Chaque doublon nomme un candidat qui est, lui, bien là.
    const ids = new Set(candidates.map((c) => c.id));
    expect(doublons.every((c) => ids.has(c.duplicateOf?.candidateId ?? ''))).toBe(true);
  });
});

describe('drapeau levé, le doublon part avant son corridor', () => {
  it('moins de jambes et moins de corridors', async () => {
    let baissé = 0;
    let levé = 0;
    const avant = await run(BAISSÉ, () => { baissé += 1; });
    const après = await run(LEVÉ, () => { levé += 1; });
    expect(candidatesOf(après).length).toBeLessThan(candidatesOf(avant).length);
    expect(levé).toBeLessThan(baissé);
  });

  it('plus un seul doublon dans le jeu, et l’original nomme ce qui a disparu', async () => {
    const candidates = candidatesOf(await run(LEVÉ));
    expect(candidates.filter((c) => (c.duplicateOf ?? null) !== null)).toEqual([]);
    const nommés = candidates.flatMap((c) => [...(c.duplicatesRemoved ?? [])]);
    expect(nommés.length).toBeGreaterThan(0);
  });

  it('aucun verdict ne se dégrade sur ce monde', async () => {
    const avant = await run(BAISSÉ);
    const après = await run(LEVÉ);
    expect(après.projection?.conclusion.overall).toEqual(avant.projection?.conclusion.overall);
  });
});
