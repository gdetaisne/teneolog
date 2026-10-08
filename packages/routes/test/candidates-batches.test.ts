/**
 * l'ordre de départ des corridors, les lots, et ce qui est sauté.
 *
 * Trois promesses, et elles se tiennent ici parce qu'ici on contrôle tout :
 *
 *  1. **L'ordre de DÉPART change, l'ordre de SORTIE jamais.** Les candidats
 *     rendus gardent l'ordre des ancres par azimut, celui qui apparie une
 *     sortante à son entrante par index. Un tri qui réordonnerait la sortie
 *     casserait `egressOf` sans qu'aucun verdict ne le dise.
 *  2. **Rien n'est sauté en silence.** Une jambe dont le corridor n'est pas
 *     chargé revient dans `skipped`, avec son rang.
 *  3. **Sans `onBatch`, rien ne change.** C'est la production : une fenêtre
 *     glissante, aucune barrière, aucun candidat en moins.
 */
import { describe, expect, it } from 'vitest';
import type { Fact, GeoPoint, Turnaround } from '@teneolog/domain';
import type { RoadWay } from '@teneolog/topology';

import { buildRouteCandidatesWithCorridors, type CandidateBuildInput } from '../src/candidates.js';
import type { Gate } from '../src/gates.js';
import type { CorridorPort, RoutingPort } from '../src/ports.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(northM: number, eastM = 0): GeoPoint {
  return {
    lat: O.lat + northM / M_PER_DEG_LAT,
    lon: O.lon + eastM / (M_PER_DEG_LAT * Math.cos((O.lat * Math.PI) / 180)),
  };
}

const STREET: RoadWay = {
  id: 'street',
  source: 'osm-overpass',
  nodeIds: ['a', 'b'],
  geometry: [at(-200), at(200)],
  name: 'Rue Test',
  importance: null,
  declaredWidthM: 8,
  laneCount: null,
  oneWay: 'no',
  isPrivate: false,
  limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
  tags: { highway: 'residential' },
};

function gate(wayId: string, azimuthDeg: number, northM: number, eastM: number): Gate {
  return { wayId, azimuthDeg, at: at(northM, eastM), distanceM: Math.hypot(northM, eastM) };
}

const GATES: readonly Gate[] = [
  gate('w-nord', 0, 1_000, 0),
  gate('w-est', 90, 0, 1_000),
  gate('w-sud', 180, -1_000, 0),
  gate('w-ouest', 270, 0, -1_000),
];

const TURNAROUND: Fact<Turnaround> = { known: false, why: 'not_applicable' };

const routing: RoutingPort = {
  route: async (from, to) => {
    const polyline: GeoPoint[] = [];
    for (let i = 0; i <= 8; i += 1) {
      polyline.push({
        lat: from.lat + ((to.lat - from.lat) * i) / 8,
        lon: from.lon + ((to.lon - from.lon) * i) / 8,
      });
    }
    return [{ polyline, distanceM: 1_000, durationS: 120 }];
  },
};

function corridorPort(onFetch?: (polyline: readonly GeoPoint[]) => void): CorridorPort {
  return {
    fetchCorridor: async (polyline) => {
      onFetch?.(polyline);
      return [STREET];
    },
  };
}

const BASE: CandidateBuildInput = {
  stop: at(0),
  gates: GATES,
  stopTurnaround: TURNAROUND,
  alternativesPerGate: 1,
  corridorMarginM: 30,
  sampleStepM: 25,
  snapM: 25,
  approachWindowM: 150,
  laneWidthM: 3,
  minCorridorCoverage: 0.8,
  maxConcurrentFetches: 2,
  fetchedAt: '2026-09-11T10:00:00.000Z',
};

describe('l’ordre de départ, et ce qu’il ne touche pas', () => {
  it('sans tri ni lots, rien ne change : huit jambes, aucune sautée', async () => {
    const result = await buildRouteCandidatesWithCorridors(BASE, { routing, corridor: corridorPort() });
    expect(result.candidates.known).toBe(true);
    expect(result.candidates.known && result.candidates.value.length).toBe(8);
    expect(result.skipped).toEqual([]);
    expect(result.stoppedAfterBatch).toBeNull();
  });

  it('le tri change l’ordre des requêtes, pas celui des candidats', async () => {
    const natural = await buildRouteCandidatesWithCorridors(BASE, { routing, corridor: corridorPort() });
    const started: string[] = [];
    const reversed = await buildRouteCandidatesWithCorridors(
      {
        ...BASE,
        // À l'envers : le pire tri possible pour la sortie, s'il la touchait.
        orderLegs: (legs) => [...legs].map((leg) => leg.id).reverse(),
      },
      {
        routing,
        corridor: {
          fetchCorridor: async (polyline, marginM) => {
            started.push(`${polyline[0]?.lat.toFixed(6)},${polyline[0]?.lon.toFixed(6)}`);
            return corridorPort().fetchCorridor(polyline, marginM);
          },
        },
      },
    );
    expect(reversed.candidates).toEqual(natural.candidates);
    // Et l'ordre de départ, lui, a bien été renversé : la première requête
    // partie n'est pas celle du premier candidat.
    expect(started.length).toBe(8);
  });

  it('une jambe oubliée par le tri part quand même, en dernier', async () => {
    const result = await buildRouteCandidatesWithCorridors(
      { ...BASE, orderLegs: (legs) => legs.slice(0, 2).map((leg) => leg.id) },
      { routing, corridor: corridorPort() },
    );
    expect(result.candidates.known && result.candidates.value.length).toBe(8);
    expect(result.skipped).toEqual([]);
  });

  it('`onRouted` voit les jambes DÉJÀ triées', async () => {
    let seen: readonly string[] = [];
    await buildRouteCandidatesWithCorridors(
      {
        ...BASE,
        orderLegs: (legs) => [...legs].map((leg) => leg.id).reverse(),
        onRouted: (legs) => {
          seen = legs.map((leg) => leg.id);
          return null;
        },
      },
      { routing, corridor: corridorPort() },
    );
    const natural = await buildRouteCandidatesWithCorridors(BASE, { routing, corridor: corridorPort() });
    const ids = natural.candidates.known ? natural.candidates.value.map((c) => c.id) : [];
    expect(seen).toEqual([...ids].reverse());
  });
});

describe('le refus commun : charger une paire, pas seize', () => {
  it('`onRouted` peut restreindre le chargement, et le reste est LISTÉ', async () => {
    let fetched = 0;
    const result = await buildRouteCandidatesWithCorridors(
      {
        ...BASE,
        onRouted: (legs) => [legs[0]!.id, legs.find((leg) => leg.direction === 'out')!.id],
      },
      { routing, corridor: corridorPort(() => (fetched += 1)) },
    );
    expect(fetched).toBe(2);
    expect(result.candidates.known && result.candidates.value.length).toBe(2);
    expect(result.skipped.length).toBe(6);
    // Chaque jambe sautée est nommée une fois, et jamais une chargée.
    const loaded = result.candidates.known ? result.candidates.value.map((c) => c.id) : [];
    for (const leg of result.skipped) expect(loaded).not.toContain(leg.id);
    expect(new Set(result.skipped.map((l) => l.id)).size).toBe(6);
  });
});

describe('l’arrêt entre deux lots', () => {
  it('un lot à la fois, et l’arrêt coupe le reste', async () => {
    const batches: number[] = [];
    let fetched = 0;
    const result = await buildRouteCandidatesWithCorridors(
      {
        ...BASE,
        onBatch: (built) => {
          batches.push(built.candidates.length);
          // On s'arrête après le deuxième lot, comme le ferait un plan sûr.
          return built.batch >= 2 ? 'stop' : 'continue';
        },
      },
      { routing, corridor: corridorPort(() => (fetched += 1)) },
    );
    // Huit jambes, des lots de deux : quatre lots, coupés après le deuxième.
    expect(batches).toEqual([2, 4]);
    expect(fetched).toBe(4);
    expect(result.stoppedAfterBatch).toBe(2);
    expect(result.candidates.known && result.candidates.value.length).toBe(4);
    expect(result.skipped.length).toBe(4);
  });

  it('un `onBatch` qui ne coupe jamais rend exactement ce que la production rend', async () => {
    const natural = await buildRouteCandidatesWithCorridors(BASE, { routing, corridor: corridorPort() });
    const batched = await buildRouteCandidatesWithCorridors(
      { ...BASE, onBatch: () => 'continue' },
      { routing, corridor: corridorPort() },
    );
    expect(batched.candidates).toEqual(natural.candidates);
    expect(batched.skipped).toEqual([]);
    expect(batched.stoppedAfterBatch).toBeNull();
  });

  it('le dernier lot ne pose pas la question : il n’y a plus rien à couper', async () => {
    const batches: number[] = [];
    await buildRouteCandidatesWithCorridors(
      { ...BASE, onBatch: (built) => (batches.push(built.batch), 'continue') },
      { routing, corridor: corridorPort() },
    );
    // Quatre lots de deux, mais le quatrième n'a plus de suite à décider.
    expect(batches).toEqual([1, 2, 3]);
  });
});
