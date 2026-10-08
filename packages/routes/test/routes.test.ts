/**
 * S3 units. The load-bearing case is E1: the same `access=destination` tag is
 * lawful where the segment is the terminal approach and unlawful where it is
 * transit — nothing in the engine ever distinguished the two.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';
import type { RoadWay } from '@teneolog/topology';

import { annotateRoute } from '../src/annotate.js';
import { buildRouteCandidates, buildRouteCandidatesWithCorridors } from '../src/candidates.js';
import { findStructuringGates } from '../src/gates.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(base: GeoPoint, northM: number, eastM: number): GeoPoint {
  return {
    lat: base.lat + northM / M_PER_DEG_LAT,
    lon: base.lon + eastM / (M_PER_DEG_LAT * Math.cos((base.lat * Math.PI) / 180)),
  };
}

function way(id: string, geometry: readonly GeoPoint[], overrides: Partial<RoadWay> = {}): RoadWay {
  return {
    id,
    source: 'osm-overpass',
    nodeIds: geometry.map((_, i) => `${id}:${i}`),
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

const AT = '2026-08-24T00:00:00Z';

describe('annotateRoute', () => {
  it('E1: destination-access is approach at the end of an inbound leg, transit in its middle', () => {
    // 600 m route: transit way for 500 m, then a destination-tagged way for 100 m.
    const transitWay = way('transit', [at(O, 0, -600), at(O, 0, -100)], {
      tags: { highway: 'secondary' },
    });
    const finalWay = way('final', [at(O, 0, -100), O], {
      tags: { highway: 'residential', access: 'destination' },
    });
    const polyline = [at(O, 0, -600), at(O, 0, -100), O];

    const result = annotateRoute({
      polyline,
      corridor: [transitWay, finalWay],
      sampleStepM: 25,
      snapM: 20,
      approachWindowM: 150,
      laneWidthM: 3.0,
      direction: 'in',
      fetchedAt: AT,
    });
    const { segments } = result;

    const finalSeg = segments.find((s) => s.segmentId === 'final');
    const transitSeg = segments.find((s) => s.segmentId === 'transit');
    expect(finalSeg?.position).toBe('approach');
    expect(transitSeg?.position).toBe('transit');
    // The band itself is identical on both — position is what differs.
    expect(finalSeg?.legal.access.known && finalSeg.legal.access.value.kind).toBe('conditional');
  });

  it('E1 mirror: on the outbound leg the local-service right sits at the START', () => {
    const finalWay = way('final', [O, at(O, 0, 100)], {
      tags: { access: 'destination', highway: 'residential' },
    });
    const transitWay = way('transit', [at(O, 0, 100), at(O, 0, 600)], {
      tags: { highway: 'secondary' },
    });

    const result = annotateRoute({
      polyline: [O, at(O, 0, 100), at(O, 0, 600)],
      corridor: [finalWay, transitWay],
      sampleStepM: 25,
      snapM: 20,
      approachWindowM: 150,
      laneWidthM: 3.0,
      direction: 'out',
      fetchedAt: AT,
    });
    const { segments } = result;

    expect(segments.find((s) => s.segmentId === 'final')?.position).toBe('egress');
    expect(segments.find((s) => s.segmentId === 'transit')?.position).toBe('transit');
  });

  it('a weight limit on a traversed way lands on its segment — the BUG-087 chain end to end', () => {
    const limited = way('limited', [at(O, 0, -400), at(O, 0, -100)], {
      limits: { maxWeightT: 7.5, maxHeightM: null, maxWidthM: null, maxLengthM: null },
      tags: { highway: 'secondary' },
    });
    const rest = way('rest', [at(O, 0, -100), O]);

    const result = annotateRoute({
      polyline: [at(O, 0, -400), at(O, 0, -100), O],
      corridor: [limited, rest],
      sampleStepM: 25,
      snapM: 20,
      approachWindowM: 50,
      laneWidthM: 3.0,
      direction: 'in',
      fetchedAt: AT,
    });
    const { segments } = result;

    const seg = segments.find((s) => s.segmentId === 'limited');
    expect(seg?.legal.maxWeightT.known && seg.legal.maxWeightT.value.value).toBe(7.5);
  });

  it('an unmatched stretch annotates nothing rather than borrowing the nearest wrong way', () => {
    const farWay = way('far', [at(O, 300, -400), at(O, 300, 0)]);
    const result = annotateRoute({
      polyline: [at(O, 0, -400), O],
      corridor: [farWay],
      sampleStepM: 25,
      snapM: 20,
      approachWindowM: 50,
      laneWidthM: 3.0,
      direction: 'in',
      fetchedAt: AT,
    });
    expect(result.segments).toHaveLength(0);
  });

  it('a segment carries the class of road it is and the distance driven on it', () => {
    // 600 m: 500 m of secondary, then 100 m of residential.
    const transitWay = way('transit', [at(O, 0, -600), at(O, 0, -100)], {
      tags: { highway: 'secondary' },
    });
    const finalWay = way('final', [at(O, 0, -100), O], { tags: { highway: 'residential' } });

    const { segments } = annotateRoute({
      polyline: [at(O, 0, -600), at(O, 0, -100), O],
      corridor: [transitWay, finalWay],
      sampleStepM: 25,
      snapM: 20,
      approachWindowM: 150,
      laneWidthM: 3.0,
      direction: 'in',
      fetchedAt: AT,
    });

    expect(segments.find((s) => s.segmentId === 'transit')?.highway).toBe('secondary');
    expect(segments.find((s) => s.segmentId === 'final')?.highway).toBe('residential');

    // The length is measured ALONG THE ROUTE, at the sampling step, so it is
    // the driven distance and not the way's own extent.
    expect(segments.find((s) => s.segmentId === 'transit')?.lengthM ?? 0).toBeGreaterThan(400);
    expect(segments.find((s) => s.segmentId === 'final')?.lengthM ?? 0).toBeGreaterThan(50);
    const total = segments.reduce((sum, s) => sum + s.lengthM, 0);
    expect(total).toBeLessThanOrEqual(600);
    expect(total).toBeGreaterThan(500);
  });

  it('a way with no highway tag says null rather than inventing a class', () => {
    const untagged = way('untagged', [at(O, 0, -200), O], { tags: {} });
    const { segments } = annotateRoute({
      polyline: [at(O, 0, -200), O],
      corridor: [untagged],
      sampleStepM: 25,
      snapM: 20,
      approachWindowM: 150,
      laneWidthM: 3.0,
      direction: 'in',
      fetchedAt: AT,
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.highway).toBeNull();
  });

  it('coverage counts unmatched samples when corridor covers only the near half — ', () => {
    // 1 000 m polyline from gate (north) to stop; way only covers the 500–1 000 m stretch.
    const halfWay = way('half', [at(O, 500, 0), at(O, 1_000, 0)]);
    const result = annotateRoute({
      polyline: [at(O, 1_000, 0), O],
      corridor: [halfWay],
      sampleStepM: 50,
      snapM: 25,
      approachWindowM: 150,
      laneWidthM: 3.0,
      direction: 'in',
      fetchedAt: AT,
    });
    expect(result.coverage.sampled).toBeGreaterThan(0);
    // Roughly the northern half matched, the southern half did not → ratio ≈ 0.5.
    const ratio = result.coverage.matched / result.coverage.sampled;
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(0.7);
  });
});

describe('findStructuringGates', () => {
  function hood(ways: readonly RoadWay[]) {
    return { centre: O, radiusM: 2_000, ways, nodes: [] };
  }

  it('spreads gates across azimuth sectors instead of clustering on the nearest arterial', () => {
    const north = way('north', [at(O, 800, 0), at(O, 1_200, 0)], { tags: { highway: 'primary' } });
    const south = way('south', [at(O, -800, 0), at(O, -1_200, 0)], { tags: { highway: 'primary' } });
    const eastNear = way('east', [at(O, 0, 500), at(O, 0, 700)], { tags: { highway: 'secondary' } });

    const gates = findStructuringGates({
      stop: O,
      neighbourhood: hood([north, south, eastNear]),
      gateCount: 4,
      minDistanceM: 300,
      // la portée ne décide rien ici : ce cas mesure le choix des ancres.
      minReachM: 0,
      maxDistanceM: 2_000,
    });

    expect(gates.length).toBeGreaterThanOrEqual(3);
    const wayIds = new Set(gates.map((g) => g.wayId));
    expect(wayIds.has('north')).toBe(true);
    expect(wayIds.has('south')).toBe(true);
    expect(wayIds.has('east')).toBe(true);
  });

  it('residential streets are not gates, and a gate cannot sit on the stop', () => {
    const residential = way('res', [at(O, 900, 0), at(O, 1_100, 0)]);
    const tooClose = way('close', [at(O, 100, 0), at(O, 200, 0)], { tags: { highway: 'primary' } });

    const gates = findStructuringGates({
      stop: O,
      neighbourhood: hood([residential, tooClose]),
      gateCount: 4,
      minDistanceM: 300,
      // la portée ne décide rien ici : ce cas mesure le choix des ancres.
      minReachM: 0,
      maxDistanceM: 2_000,
    });
    expect(gates).toHaveLength(0);
  });

  it('BDTOPO importance qualifies a way with no highway tag', () => {
    const departementale = way('d10', [at(O, 900, 0), at(O, 1_300, 0)], {
      source: 'bdtopo-postgis',
      importance: 3,
      tags: {},
    });
    const gates = findStructuringGates({
      stop: O,
      neighbourhood: hood([departementale]),
      gateCount: 4,
      minDistanceM: 300,
      // la portée ne décide rien ici : ce cas mesure le choix des ancres.
      minReachM: 0,
      maxDistanceM: 2_000,
    });
    expect(gates.length).toBeGreaterThan(0);
  });
});

describe('buildRouteCandidates', () => {
  const gate = { at: at(O, 1_000, 0), wayId: 'north', azimuthDeg: 0, distanceM: 1_000 };

  const stubPorts = (fail = false) => ({
    routing: {
      route: async (from: GeoPoint, to: GeoPoint) => {
        if (fail) throw new Error('OSRM down');
        return [{ polyline: [from, to], distanceM: 1_000, durationS: 90 }];
      },
    },
    corridor: { fetchCorridor: async () => [way('road', [at(O, 1_000, 0), O])] },
  });

  const buildInput = {
    stop: O,
    gates: [gate],
    stopTurnaround: { known: false as const, why: 'no_data' as const },
    alternativesPerGate: 0,
    corridorMarginM: 30,
    sampleStepM: 50,
    snapM: 25,
    approachWindowM: 150,
    laneWidthM: 3.0,
    fetchedAt: AT,
  };

  it('pairs the outbound with its inbound through egressOf — the BUG-001 seam', async () => {
    const fact = await buildRouteCandidates(buildInput, stubPorts());

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    const outbound = fact.value.find((c) => c.direction === 'out');
    const inbound = fact.value.find((c) => c.direction === 'in');
    expect(outbound?.egressOf?.inboundId).toBe(inbound?.id);
    expect(inbound?.egressOf).toBeNull();
  });

  it('a router outage is provider_error, not an empty success', async () => {
    const fact = await buildRouteCandidates(buildInput, stubPorts(true));
    expect(fact.known).toBe(false);
    if (fact.known) return;
    expect(fact.why).toBe('provider_error');
  });

  it('inbound legs fail, outbound legs route → known set, flagged, with dangling pairings', async () => {
    const halfDownPorts = {
      routing: {
        route: async (from: GeoPoint, to: GeoPoint) => {
          // Inbound legs end at the stop; that is the direction the router loses.
          if (to.lat === O.lat && to.lon === O.lon) throw new Error('OSRM 502');
          return [{ polyline: [from, to], distanceM: 1_000, durationS: 90 }];
        },
      },
      corridor: { fetchCorridor: async () => [way('road', [at(O, 1_000, 0), O])] },
    };
    const fact = await buildRouteCandidates(buildInput, halfDownPorts);
    expect(fact.known).toBe(true);
    if (!fact.known) return;
    // The outage is on the fact, where the conclusion reads it…
    expect(fact.reliability.reasonCodes).toContain('some_gate_routes_failed');
    // …and in the structure: every survivor is an outbound naming an inbound that never routed.
    const ids = new Set(fact.value.map((c) => c.id));
    expect(fact.value.every((c) => c.direction === 'out')).toBe(true);
    for (const c of fact.value) expect(ids.has(c.egressOf!.inboundId)).toBe(false);
  });

  it('no structuring gates is no_data — an answer about the address, not the router', async () => {
    const fact = await buildRouteCandidates({ ...buildInput, gates: [] }, stubPorts());
    expect(fact.known).toBe(false);
    if (fact.known) return;
    expect(fact.why).toBe('no_data');
  });

  it('corridor_partial reason code when matched/sampled is below minCorridorCoverage — ', async () => {
    // Way only spans the gate-side 500 m; the stop-side 500 m is unmatched → ratio ≈ 0.5 < 0.8.
    const halfPorts = {
      routing: { route: async (from: GeoPoint, to: GeoPoint) => [{ polyline: [from, to], distanceM: 1_000, durationS: 90 }] },
      corridor: { fetchCorridor: async () => [way('half', [at(O, 500, 0), at(O, 1_000, 0)])] },
    };
    const fact = await buildRouteCandidates({ ...buildInput, minCorridorCoverage: 0.8 }, halfPorts);
    expect(fact.known).toBe(true);
    if (!fact.known) return;
    const inbound = fact.value.find((c) => c.direction === 'in')!;
    expect(inbound.coverage.sampled).toBeGreaterThan(0);
    expect(inbound.coverage.matched / inbound.coverage.sampled).toBeLessThan(0.8);
    expect(inbound.corridorReasonCodes).toContain('corridor_partial');
  });
});

describe('buildRouteCandidatesWithCorridors', () => {
  const gate = { at: at(O, 1_000, 0), wayId: 'north', azimuthDeg: 0, distanceM: 1_000 };

  const baseInput = {
    stop: O,
    gates: [gate],
    stopTurnaround: { known: false as const, why: 'no_data' as const },
    alternativesPerGate: 0,
    corridorMarginM: 30,
    sampleStepM: 50,
    snapM: 25,
    approachWindowM: 150,
    laneWidthM: 3.0,
    fetchedAt: AT,
  };

  it('each candidate fetches the corridor exactly once — ', async () => {
    let fetchCount = 0;
    const countingPorts = {
      routing: { route: async (from: GeoPoint, to: GeoPoint) => [{ polyline: [from, to], distanceM: 1_000, durationS: 90 }] },
      corridor: {
        fetchCorridor: async () => {
          fetchCount++;
          return [way('road', [at(O, 1_000, 0), O])];
        },
      },
    };
    const { candidates } = await buildRouteCandidatesWithCorridors(baseInput, countingPorts);
    expect(candidates.known).toBe(true);
    if (!candidates.known) return;
    // 1 gate × 2 directions × 1 path = 2 corridor fetches — never more
    expect(fetchCount).toBe(candidates.value.length);
  });

  it('corridors map keys match candidate ids — corridors need no second fetch', async () => {
    const corridorPorts = {
      routing: { route: async (from: GeoPoint, to: GeoPoint) => [{ polyline: [from, to], distanceM: 1_000, durationS: 90 }] },
      corridor: { fetchCorridor: async () => [way('road', [at(O, 1_000, 0), O])] },
    };
    const { candidates, corridors } = await buildRouteCandidatesWithCorridors(baseInput, corridorPorts);
    expect(candidates.known).toBe(true);
    if (!candidates.known) return;
    for (const c of candidates.value) {
      expect(corridors.has(c.id)).toBe(true);
    }
  });

  it('corridor fetches respect maxConcurrentFetches — ', async () => {
    let concurrent = 0;
    let peak = 0;
    const slowPorts = {
      routing: { route: async (from: GeoPoint, to: GeoPoint) => [{ polyline: [from, to], distanceM: 1_000, durationS: 90 }] },
      corridor: {
        fetchCorridor: async () => {
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise<void>((r) => setTimeout(r, 5));
          concurrent--;
          return [way('road', [at(O, 1_000, 0), O])];
        },
      },
    };
    // 3 gates × 2 directions = 6 corridor tasks; limit to 2
    const gate2 = { at: at(O, 0, 1_000), wayId: 'east', azimuthDeg: 90, distanceM: 1_000 };
    const gate3 = { at: at(O, -1_000, 0), wayId: 'south', azimuthDeg: 180, distanceM: 1_000 };
    await buildRouteCandidatesWithCorridors(
      { ...baseInput, gates: [gate, gate2, gate3], maxConcurrentFetches: 2 },
      slowPorts,
    );
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('output order matches gate-then-direction order regardless of arrival order', async () => {
    // Each corridor call resolves with a delay inversely proportional to index → reversal would change order
    let callIndex = 0;
    const reorderedPorts = {
      routing: { route: async (from: GeoPoint, to: GeoPoint) => [{ polyline: [from, to], distanceM: 1_000, durationS: 90 }] },
      corridor: {
        fetchCorridor: async () => {
          const delay = (3 - callIndex++) * 5; // first call waits longest
          await new Promise<void>((r) => setTimeout(r, delay));
          return [way('road', [at(O, 1_000, 0), O])];
        },
      },
    };
    const gate2 = { at: at(O, 0, 1_000), wayId: 'east', azimuthDeg: 90, distanceM: 1_000 };
    const { candidates } = await buildRouteCandidatesWithCorridors(
      { ...baseInput, gates: [gate, gate2] },
      reorderedPorts,
    );
    expect(candidates.known).toBe(true);
    if (!candidates.known) return;
    const ids = candidates.value.map((c) => c.id);
    // Gate 'north' azimuth 0, gate 'east' azimuth 90 — north comes first (gate order preserved)
    expect(ids[0]).toContain('north');
    expect(ids[1]).toContain('north');
    expect(ids[2]).toContain('east');
    expect(ids[3]).toContain('east');
  });

  it('alt outbound references its matching alt inbound, not the primary — ', async () => {
    // Route always returns 2 paths: primary (index 0) + alt (index 1)
    const twoPathPorts = {
      routing: {
        route: async (from: GeoPoint, to: GeoPoint) => [
          { polyline: [from, to], distanceM: 1_000, durationS: 90 },
          { polyline: [from, at(O, 500, 100), to], distanceM: 1_200, durationS: 110 },
        ],
      },
      corridor: { fetchCorridor: async () => [way('road', [at(O, 1_000, 0), O])] },
    };
    const { candidates } = await buildRouteCandidatesWithCorridors(
      { ...baseInput, alternativesPerGate: 1 },
      twoPathPorts,
    );
    expect(candidates.known).toBe(true);
    if (!candidates.known) return;

    const ids = new Set(candidates.value.map((c) => c.id));
    const outbounds = candidates.value.filter((c) => c.direction === 'out');

    // Every outbound must reference an existing inbound candidate
    for (const out of outbounds) {
      expect(ids.has(out.egressOf!.inboundId)).toBe(true);
    }

    // alt1 outbound must reference alt1 inbound (not the primary)
    const inAlt1 = candidates.value.find((c) => c.direction === 'in' && c.generatedBy === 'alternative');
    const outAlt1 = candidates.value.find((c) => c.direction === 'out' && c.generatedBy === 'alternative');
    expect(inAlt1).toBeDefined();
    expect(outAlt1?.egressOf?.inboundId).toBe(inAlt1?.id);
  });
});
