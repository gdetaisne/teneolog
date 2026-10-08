/**
 * S3 → S6 sequencing on stub ports. one run reads the clock once,
 * and every fact it produces carries that one instant — architecture §7
 * (same snapshot of facts → same verdict bit for bit) cannot hold when the
 * candidates, the points and the report's validity date from three reads.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint, TruckProfile } from '@teneolog/domain';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import type { PipelineParams } from '../src/analyse.js';
import { continueFromFacts, runFullAnalysis, type FullParams, type FullPorts } from '../src/full.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(base: GeoPoint, northM: number, eastM: number): GeoPoint {
  return {
    lat: base.lat + northM / M_PER_DEG_LAT,
    lon: base.lon + eastM / (M_PER_DEG_LAT * Math.cos((base.lat * Math.PI) / 180)),
  };
}

function way(id: string, nodeIds: readonly string[], geometry: readonly GeoPoint[], overrides: Partial<RoadWay> = {}): RoadWay {
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

// A through street at the stop, and one primary road 800 m north for a gate.
const STREET = way('street', ['a', 'b'], [at(O, 0, -170), at(O, 0, 170)], { name: 'Rue Test', declaredWidthM: 6 });
const GATE_AT = at(O, 800, 0);
const ARTERIAL = way('arterial', ['g1', 'g2'], [GATE_AT, at(O, 900, 0)], { tags: { highway: 'primary' }, declaredWidthM: 7 });

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
    measurement: { defaultTurningCircleDiameterM: null, fallbackCarriagewayWidthM: null, loopClosureToleranceM: 3 },
  },
  declaredWidthConfidence: 0.55,
  secondaryDescriptionSnapM: 25,
  geocoding: { minBanScore: 0.6 },
};

const PARAMS: FullParams = {
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
  // la découverte est éteinte ici — ce fichier teste S3–S6 et rien
  // d'autre. C'est `full-discovery.test.ts` qui l'allume et prouve qu'allumée,
  // elle ne déplace pas une virgule.
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

function ports(): FullPorts {
  return {
    geocode: { geocode: async () => [{ source: 'ban', point: O, score: 0.95, formatted: '1 Rue Test', banId: null, positionType: 'housenumber' }] },
    graph: { fetchNeighbourhood: async (c, r) => hoodOf(O, r, [STREET]) },
    surfaces: { fetchSurfaces: async () => [] },
    structuring: { fetchStructuring: async (c, r) => hoodOf(O, r, [STREET, ARTERIAL]) },
    // A straight line gate → stop, sampled every 100 m; the corridor is both ways.
    routing: {
      route: async (from, to) => {
        const polyline: GeoPoint[] = [];
        for (let i = 0; i <= 8; i += 1) {
          polyline.push({ lat: from.lat + ((to.lat - from.lat) * i) / 8, lon: from.lon + ((to.lon - from.lon) * i) / 8 });
        }
        return [{ polyline, distanceM: 800, durationS: 90 }];
      },
    },
    corridor: { fetchCorridor: async () => [STREET, ARTERIAL] },
  };
}

/** A clock that returns a distinct instant on every read, and counts reads. */
function tickingClock(): { now: () => string; reads: () => number } {
  let n = 0;
  return {
    now: () => {
      n += 1;
      return `2026-09-09T10:00:00.${String(n).padStart(3, '0')}Z`;
    },
    reads: () => n,
  };
}

describe('continueFromFacts — one fetchedAt per run', () => {
  it('reads the clock once and stamps candidates, points and validity from that one instant', async () => {
    const clock = tickingClock();
    const s0s2 = await runFullAnalysis({ kind: 'address', address: '1 Rue Test' }, TRUCK, ports(), PARAMS, clock.now);
    expect(s0s2.ok).toBe(true);
    if (!s0s2.ok) return;
    const { facts, candidates, collected, projection } = s0s2.analysis;

    // The whole S0 → S6 run read the clock exactly once.
    expect(clock.reads()).toBe(1);
    const stamp = '2026-09-09T10:00:00.001Z';

    expect(facts.anchor.point.known && facts.anchor.point.provenance.fetchedAt).toBe(stamp);
    expect(candidates.known).toBe(true);
    if (!candidates.known) return;
    expect(candidates.provenance.fetchedAt).toBe(stamp);
    expect(candidates.value.length).toBeGreaterThan(0);
    for (const candidate of candidates.value) {
      for (const segment of candidate.segments) {
        if (segment.width.known) expect(segment.width.provenance.fetchedAt).toBe(stamp);
      }
    }
    expect(collected).not.toBeNull();
    for (const point of collected?.points ?? []) {
      if (point.geometry.known) expect(point.geometry.provenance.fetchedAt).toBe(stamp);
    }
    expect(projection).not.toBeNull();
    expect(projection?.conclusion.validUntil).toBe(
      new Date(Date.parse(stamp) + PARAMS.reportShelfLifeDays * 86_400_000).toISOString(),
    );
  });

  it('the progressive split: S3–S6 alone also reads the clock once', async () => {
    const first = tickingClock();
    const s0s2 = await runFullAnalysis({ kind: 'address', address: '1 Rue Test' }, TRUCK, ports(), PARAMS, first.now);
    if (!s0s2.ok) throw new Error('fixture must resolve');

    const later = tickingClock();
    const outcome = await continueFromFacts(s0s2.analysis.facts, TRUCK, ports(), PARAMS, later.now);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(later.reads()).toBe(1);
    expect(outcome.analysis.candidates.known && outcome.analysis.candidates.provenance.fetchedAt).toBe(
      '2026-09-09T10:00:00.001Z',
    );
  });
});
