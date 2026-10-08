/**
 * LE TEST D'OR DU RUN SANS ANCRE R0 —, constat L5-1 de l'audit du
 * 2026-09-18.
 *
 * LE MONDE : une rue de livraison traversante de 8 m et RIEN d'autre — aucune
 * voie structurante, donc aucune ancre R0, donc aucun candidat de R0. C'est le
 * monde « sans artère » de `full-discovery.test.ts`, celui du bourg rural où la
 * règle d'hier n'a rien à proposer. Le routeur factice rentre en ligne droite
 * depuis chaque origine, donc la découverte garde ses rayons : le moteur a des
 * jambes routées en main.
 *
 * CE QU'IL FIGE, des deux côtés de la correction :
 *
 *  1. **les jambes découvertes sont promues et jugées.** `continueFromFacts`
 *     sortait avant la promotion : `candidates` restait un fait INCONNU,
 *     `collected`, `projection` et `summary` étaient nuls, et l'écran affichait
 *     « Carte indisponible » puis « Aucun détail technique n'a été renvoyé ».
 *     Après : `candidates` est connu, sa provenance dit `discovered-legs`, ses
 *     jambes portent `generatedBy: 'discovered'`, et il y a une conclusion.
 *  2. **quand il ne reste vraiment rien, la conclusion porte un motif.**
 *     Découverte éteinte, aucune jambe : `reasonCodes` ne peut pas être vide —
 *     c'est ce que le fil traduisait en `reasonCodes: []` à côté
 *     d'`itineraries: []`, l'impasse d'écran que l'audit appelle P0.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint, TruckProfile } from '@teneolog/domain';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import type { PipelineParams } from '../src/analyse.js';
import { runFullAnalysis, type FullParams, type FullPorts } from '../src/full.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(base: GeoPoint, northM: number, eastM: number): GeoPoint {
  return {
    lat: base.lat + northM / M_PER_DEG_LAT,
    lon: base.lon + eastM / (M_PER_DEG_LAT * Math.cos((base.lat * Math.PI) / 180)),
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

/** La rue de livraison, et le monde entier : 8 m, traversante, sans artère. */
const STREET: RoadWay = {
  id: 'street',
  source: 'osm-overpass',
  nodeIds: ['a', 'b'],
  geometry: [at(O, 0, -170), at(O, 0, 170)],
  name: 'Rue Test',
  importance: null,
  declaredWidthM: 8,
  laneCount: null,
  oneWay: 'no',
  isPrivate: false,
  limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
  tags: { highway: 'residential' },
};

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

/**
 * La policy de test pour ce qui décide ici : `discovery.enabled` et
 * `discovery.feedsCandidates` levés (`config/policy.example.json`).
 * `minReachM: 0` comme dans `full-discovery.test.ts` — le monde de laboratoire
 * tient dans 900 m, et c'est la PROMOTION qu'on mesure, pas la portée.
 */
const PARAMS: FullParams = {
  pipeline: PIPELINE,
  gates: { searchRadiusM: 2000, gateCount: 5, minDistanceM: 500, minReachM: 0 },
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
    plans: { straightToleranceDeg: 60, headingSpanM: 20 },
    conclusion: { mode: 'plans' },
  },
  discovery: {
    enabled: true,
    feedsCandidates: true,
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

/** Le monde d'avant la correction, et le seul où il ne reste vraiment rien. */
const WITHOUT_DISCOVERY: FullParams = {
  ...PARAMS,
  discovery: { ...PARAMS.discovery, enabled: false, feedsCandidates: false },
};

const TRUCK: TruckProfile = {
  id: 'pl-19t',
  label: 'Porteur 19 t',
  family: 'rigid',
  envelope: { lengthM: 9, widthM: 2.5, heightM: 3.5, gvwT: 19, turnRadiusM: 11, wheelbaseM: 6.1, frontOverhangM: 1.2, rearOverhangM: 1.7 },
  equipment: { tailLift: true, crane: false, refrigerated: false },
};

function ports(): FullPorts {
  return {
    geocode: {
      geocode: async () => [
        { source: 'ban', point: O, score: 0.95, formatted: '1 Rue Test', banId: null, positionType: 'housenumber' },
      ],
    },
    graph: { fetchNeighbourhood: async (_c, r) => hoodOf(O, r, [STREET]) },
    surfaces: { fetchSurfaces: async () => [] },
    // Aucune voie structurante : c'est TOUT le cas de figure.
    structuring: { fetchStructuring: async (_c, r) => hoodOf(O, r, [STREET]) },
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
    corridor: { fetchCorridor: async () => [STREET] },
  };
}

const frozen = () => '2026-09-18T10:00:00.000Z';

async function run(params: FullParams) {
  const outcome = await runFullAnalysis(
    { kind: 'address', address: '1 Rue Test' },
    TRUCK,
    ports(),
    params,
    frozen,
  );
  if (!outcome.ok) throw new Error(`${outcome.stage}/${outcome.why}`);
  return outcome.analysis;
}

describe('sans ancre R0, les jambes découvertes sont promues et jugées', () => {
  it('les jambes deviennent des candidats, et le run conclut', async () => {
    const analysis = await run(PARAMS);

    expect(analysis.candidates.known).toBe(true);
    if (!analysis.candidates.known) return;
    // Ce sont bien des jambes de la découverte, et rien d'autre : R0 n'a posé
    // aucune ancre, donc aucun candidat `car-optimal` ne peut exister ici.
    expect(analysis.candidates.value.length).toBeGreaterThan(0);
    for (const candidate of analysis.candidates.value) {
      expect(candidate.generatedBy).toBe('discovered');
      // `egressOf` reste nul : aucune ancre n'est inventée, les plans
      // apparient n'importe quelle entrante avec n'importe quelle sortante.
      expect(candidate.egressOf).toBeNull();
    }
    // La provenance dit d'où elles viennent, et ses codes disent pourquoi.
    expect(analysis.candidates.provenance.method).toBe('discovered-legs');
    expect(analysis.candidates.reliability.reasonCodes).toEqual(['no_r0_candidates']);

    // Et le run a une conclusion — l'écran n'est plus muet.
    expect(analysis.collected).not.toBeNull();
    expect(analysis.projection).not.toBeNull();
    expect(analysis.summary).not.toBeNull();
    expect(analysis.projection?.conclusion.pointVerdicts.length).toBeGreaterThan(0);
    expect(analysis.projection?.conclusion.plans.length).toBeGreaterThan(0);
    // Un plan retenu, avec ses deux jambes : c'est ce que le deck déroule.
    expect(analysis.projection?.conclusion.retainedPlan).not.toBeNull();
  });

  it('le relevé de la découverte dit toujours que R0 n’a rien couvert', async () => {
    const analysis = await run(PARAMS);
    const discovery = analysis.gateSearch?.discovery;
    // Le contrefactuel du critère d'arrêt porte sur la règle d'HIER : la
    // promotion ne le rend pas vrai.
    expect(discovery?.stopCriterion.satisfied).toBe(false);
    expect(discovery?.stopCriterion.reasons).toContain('no_r0_candidates');
    expect(discovery?.coverageByR0.coveredByR0).toBe(0);
    // Aucune approche n'est « couverte » : il n'y avait pas de jambe R0 pour
    // les couvrir. Elles sont devenues des candidats, ce qui n'est pas la
    // même chose.
    for (const approach of discovery?.approaches ?? []) {
      expect(approach.coveredByCandidateId).toBeNull();
    }
  });

  it('quand il ne reste vraiment rien, la conclusion porte un motif', async () => {
    const analysis = await run(WITHOUT_DISCOVERY);

    expect(analysis.candidates.known).toBe(false);
    // Le cœur du constat L5-1 : une conclusion, pas un silence.
    expect(analysis.projection).not.toBeNull();
    const conclusion = analysis.projection?.conclusion;
    expect(conclusion?.overall).toBe('HUMAN');
    expect(conclusion?.reasonCodes).not.toEqual([]);
    expect(conclusion?.viaCandidateId).toBeNull();
    // Et une phrase pour l'opérateur, pas « aucun détail technique ».
    expect(analysis.summary?.headline).toBe('Accès en Porteur 19 t non déterminé.');
    expect(analysis.summary?.explanation.length).toBeGreaterThan(0);
  });
});
