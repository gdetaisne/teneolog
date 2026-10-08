/**
 * le rejeu d'une jambe déjà routée.
 *
 * La question que ces tests tranchent n'est pas « le rejeu marche-t-il » mais
 * « rend-il EXACTEMENT le candidat que la production aurait rendu ». Tout
 * l'A/B repose là-dessus : une annotation qui dériverait d'un cheveu ferait
 * comparer au rapport ses propres écarts au lieu de ceux des ancres.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';
import type { RoadWay } from '@teneolog/topology';

import { buildRouteCandidatesWithCorridors } from '../src/candidates.js';
import { candidateFromRoutedLeg, legTruncatedAtM, polylineLengthM } from '../src/replay.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;
const AT = '2026-09-11T00:00:00Z';

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

/** Un corridor à deux voies : de la secondaire, puis la rue de livraison. */
const CORRIDOR: readonly RoadWay[] = [
  way('transit', [at(O, 1_000, 0), at(O, 200, 0)], { tags: { highway: 'secondary' }, declaredWidthM: 6 }),
  way('local', [at(O, 200, 0), O], { tags: { highway: 'residential', access: 'destination' } }),
];

const LEG: readonly GeoPoint[] = [at(O, 1_000, 0), at(O, 200, 0), O];

const SHAPE = {
  sampleStepM: 25,
  snapM: 25,
  approachWindowM: 150,
  laneWidthM: 3.0,
  minCorridorCoverage: 0.8,
  fetchedAt: AT,
} as const;

describe('candidateFromRoutedLeg', () => {
  it('rend champ pour champ le candidat que la production rend sur la même jambe', async () => {
    const built = await buildRouteCandidatesWithCorridors(
      {
        stop: O,
        gates: [{ at: at(O, 1_000, 0), wayId: 'transit', azimuthDeg: 0, distanceM: 1_000 }],
        stopTurnaround: { known: false, why: 'no_data' },
        alternativesPerGate: 0,
        corridorMarginM: 30,
        sampleStepM: SHAPE.sampleStepM,
        snapM: SHAPE.snapM,
        approachWindowM: SHAPE.approachWindowM,
        laneWidthM: SHAPE.laneWidthM,
        minCorridorCoverage: SHAPE.minCorridorCoverage,
        maxConcurrentFetches: 4,
        fetchedAt: AT,
      },
      {
        routing: {
          route: async (from: GeoPoint, to: GeoPoint) =>
            to.lat === O.lat && to.lon === O.lon
              ? [{ polyline: LEG, distanceM: 1_000, durationS: 90 }]
              : [{ polyline: [...LEG].reverse(), distanceM: 1_000, durationS: 90 }],
        },
        corridor: { fetchCorridor: async () => CORRIDOR },
      },
    );
    expect(built.candidates.known).toBe(true);
    if (!built.candidates.known) return;

    const inbound = built.candidates.value.find((candidate) => candidate.direction === 'in');
    expect(inbound).toBeDefined();
    if (inbound === undefined) return;

    const replayed = candidateFromRoutedLeg({
      id: inbound.id,
      direction: 'in',
      polyline: LEG,
      corridor: CORRIDOR,
      distanceM: 1_000,
      durationS: 90,
      generatedBy: 'car-optimal',
      egressOf: null,
      ...SHAPE,
    });

    // Pas `toMatchObject` : l'égalité entière, segments, positions, bandes
    // légales, largeurs et couverture comprises.
    expect(replayed).toEqual(inbound);
  });

  it('une jambe dont le corridor est à moitié muet porte corridor_partial, comme en production', () => {
    const replayed = candidateFromRoutedLeg({
      id: 'muette:in',
      direction: 'in',
      polyline: LEG,
      // Les 400 premiers mètres seulement : les échantillons proches de
      // l'arrêt n'accrochent rien.
      corridor: [way('amont', [at(O, 1_000, 0), at(O, 600, 0)], { tags: { highway: 'secondary' } })],
      distanceM: 1_000,
      durationS: 90,
      generatedBy: 'car-optimal',
      egressOf: null,
      ...SHAPE,
    });
    expect(replayed.coverage.matched).toBeLessThan(replayed.coverage.sampled);
    expect(replayed.corridorReasonCodes).toContain('corridor_partial');
  });
});

describe('legTruncatedAtM', () => {
  it("garde les mètres qui vont du point de livraison à l'ancre, et les rend dans le sens de l'entrante", () => {
    const truncated = legTruncatedAtM({ direction: 'in', polyline: LEG }, 300);
    expect(truncated.length).toBeGreaterThanOrEqual(2);
    // Une entrante finit au point de livraison, tronquée ou non.
    expect(truncated.at(-1)).toEqual(O);
    expect(polylineLengthM(truncated)).toBeCloseTo(300, 0);
  });

  it('sur une sortante, la troncature part du point de livraison et le garde en tête', () => {
    const outward = [...LEG].reverse();
    const truncated = legTruncatedAtM({ direction: 'out', polyline: outward }, 300);
    expect(truncated[0]).toEqual(O);
    expect(polylineLengthM(truncated)).toBeCloseTo(300, 0);
  });

  it('une troncature plus longue que la jambe rend la jambe entière, jamais davantage', () => {
    const truncated = legTruncatedAtM({ direction: 'in', polyline: LEG }, 99_000);
    expect(polylineLengthM(truncated)).toBeCloseTo(polylineLengthM(LEG), 0);
  });

  it("une troncature nulle ou négative ne rend pas un point seul : ce ne serait pas un itinéraire", () => {
    expect(legTruncatedAtM({ direction: 'in', polyline: LEG }, 0)).toHaveLength(0);
    expect(legTruncatedAtM({ direction: 'in', polyline: LEG }, -10)).toHaveLength(0);
  });
});
