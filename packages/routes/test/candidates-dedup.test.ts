/**
 * le dédoublonnage vu du jeu de candidats, bout à bout.
 *
 * Deux promesses, et c'est tout ce que la tâche livre en production :
 *
 *  1. **Drapeau baissé, RIEN NE BOUGE.** Mêmes jambes, mêmes corridors, mêmes
 *     annotations — seulement, chaque doublon dit de qui il est la copie.
 *     Retirer les trois champs additifs rend le candidat d'avant la tâche.
 *  2. **Drapeau levé, le doublon part AVANT son corridor.** C'est là qu'est le
 *     gain (0,8 s par corridor) : une jambe écartée après coup aurait déjà
 *     coûté sa requête.
 */
import { describe, expect, it } from 'vitest';
import type { Fact, GeoPoint, RouteCandidate, Turnaround } from '@teneolog/domain';
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
  geometry: [at(-200), at(2_200)],
  name: 'Rue Test',
  importance: null,
  declaredWidthM: 8,
  laneCount: null,
  oneWay: 'no',
  isPrivate: false,
  limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
  tags: { highway: 'residential' },
};

const GATE: Gate = { wayId: 'nord', azimuthDeg: 0, at: at(1_900), distanceM: 1_900 };
const TURNAROUND: Fact<Turnaround> = { known: false, why: 'not_applicable' };

/** Le routeur rend DEUX chemins identiques : le principal et son alternative. */
const routing: RoutingPort = {
  route: async (from, to) => {
    const polyline: GeoPoint[] = [];
    for (let i = 0; i <= 19; i += 1) {
      polyline.push({
        lat: from.lat + ((to.lat - from.lat) * i) / 19,
        lon: from.lon + ((to.lon - from.lon) * i) / 19,
      });
    }
    const path = { polyline, distanceM: 1_900, durationS: 200 };
    return [path, path];
  },
};

function corridorPort(fetched: string[]): CorridorPort {
  return {
    fetchCorridor: async (polyline) => {
      fetched.push(`${polyline.length}`);
      return [STREET];
    },
  };
}

const BASE: CandidateBuildInput = {
  stop: at(0),
  gates: [GATE],
  stopTurnaround: TURNAROUND,
  alternativesPerGate: 1,
  corridorMarginM: 30,
  sampleStepM: 25,
  snapM: 25,
  approachWindowM: 150,
  laneWidthM: 3,
  minCorridorCoverage: 0.8,
  maxConcurrentFetches: 2,
  fetchedAt: '2026-09-14T10:00:00.000Z',
};

function values(fact: Fact<readonly RouteCandidate[]>): readonly RouteCandidate[] {
  return fact.known ? fact.value : [];
}

/** Le candidat d'avant sans les trois champs additifs. */
function withoutMarks(candidate: RouteCandidate): Record<string, unknown> {
  const { duplicateOf, duplicatesRemoved, passesThroughGate, ...rest } = candidate as RouteCandidate &
    Record<string, unknown>;
  void duplicateOf;
  void duplicatesRemoved;
  void passesThroughGate;
  return rest;
}

describe('drapeau baissé : la marque, et rien d’autre', () => {
  it('les quatre jambes restent, et les deux alternatives se disent doublons', async () => {
    const fetched: string[] = [];
    const built = await buildRouteCandidatesWithCorridors(BASE, {
      routing,
      corridor: corridorPort(fetched),
    });
    const candidates = values(built.candidates);
    expect(candidates.map((c) => c.id)).toEqual([
      'nord@0:in',
      'nord@0:in:alt1',
      'nord@0:out',
      'nord@0:out:alt1',
    ]);
    expect(fetched.length).toBe(4);
    expect(candidates[1]?.duplicateOf).toEqual({ candidateId: 'nord@0:in', on: 'geometry' });
    expect(candidates[3]?.duplicateOf).toEqual({ candidateId: 'nord@0:out', on: 'geometry' });
    // L'original ne nomme rien : rien n'a été écarté en son nom.
    expect(candidates[0]?.duplicateOf ?? null).toBeNull();
    expect(candidates[0]?.duplicatesRemoved ?? []).toEqual([]);
  });

  it('sans réglage du tout, le résultat est celui d’avant la tâche', async () => {
    const sansRéglage = await buildRouteCandidatesWithCorridors(BASE, {
      routing,
      corridor: corridorPort([]),
    });
    const baissé = await buildRouteCandidatesWithCorridors(
      { ...BASE, dedup: { enabled: false, approach: false } },
      { routing, corridor: corridorPort([]) },
    );
    expect(values(baissé.candidates)).toEqual(values(sansRéglage.candidates));
  });
});

describe('drapeau levé : le doublon part avant son corridor', () => {
  it('deux jambes au lieu de quatre, deux corridors au lieu de quatre', async () => {
    const fetched: string[] = [];
    const built = await buildRouteCandidatesWithCorridors(
      { ...BASE, dedup: { enabled: true, approach: false } },
      { routing, corridor: corridorPort(fetched) },
    );
    const candidates = values(built.candidates);
    expect(candidates.map((c) => c.id)).toEqual(['nord@0:in', 'nord@0:out']);
    expect(fetched.length).toBe(2);
  });

  it('l’original nomme ce qui a disparu — rien n’est sauté en silence', async () => {
    const built = await buildRouteCandidatesWithCorridors(
      { ...BASE, dedup: { enabled: true, approach: false } },
      { routing, corridor: corridorPort([]) },
    );
    const [inbound] = values(built.candidates);
    expect(inbound?.duplicatesRemoved).toEqual(['nord@0:in:alt1']);
  });

  it('la jambe qui reste est LA MÊME qu’avant, champs additifs retirés', async () => {
    const baissé = await buildRouteCandidatesWithCorridors(BASE, {
      routing,
      corridor: corridorPort([]),
    });
    const levé = await buildRouteCandidatesWithCorridors(
      { ...BASE, dedup: { enabled: true, approach: false } },
      { routing, corridor: corridorPort([]) },
    );
    const avant = values(baissé.candidates).find((c) => c.id === 'nord@0:in');
    const après = values(levé.candidates).find((c) => c.id === 'nord@0:in');
    expect(avant).toBeDefined();
    expect(après).toBeDefined();
    expect(withoutMarks(après as RouteCandidate)).toEqual(withoutMarks(avant as RouteCandidate));
  });
});
