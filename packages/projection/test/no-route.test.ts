/**
 * le garde-fou de portée : `detectNoLegReachesRing` ne juge rien,
 * il mesure. Le corpus (la note de conception interne) ne contient
 * pas d'adresse qui vide `retained`, donc chaque cas ici est une fixture
 * synthétique, pas un run réel — exactement ce que le brief demande.
 */
import { describe, expect, it } from 'vitest';
import type { Discovery, GateSearch } from '@teneolog/domain';

import { detectNoLegReachesRing } from '../src/no-route.js';

const STOP = { lat: 46.0, lon: -1.0 };

function gateSearch(overrides: Partial<GateSearch> = {}): GateSearch {
  return {
    stop: STOP,
    searchRadiusM: 2000,
    minDistanceM: 500,
    minReachM: 1800,
    gateCount: 5,
    minSeparationDeg: 36,
    retained: [],
    shortOfRing: [],
    considered: [],
    discovery: null,
    axes: null,
    uncontrolledApproaches: [],
    ...overrides,
  };
}

function discovery(overrides: Partial<Discovery> = {}): Discovery {
  return {
    windowM: 60,
    minReachM: 1800,
    rounds: [],
    approaches: [],
    approachesOut: [],
    shortOfRing: [],
    coverageByR0: { approachesTotal: 0, coveredByR0: 0, r0CandidatesUncovered: [] },
    stopCriterion: { evaluatedOn: 'R0', satisfied: false, atRound: null, reasons: [] },
    obviousStop: false,
    budget: { maxRounds: 3, playedRounds: 3, settingKind: null },
    cost: { routingCalls: 0, durationMs: 0 },
    byWidth: null,
    fetchedAt: '2026-09-14T00:00:00Z',
    ...overrides,
  };
}

const AIGREFEUILLE_RETAINED = [
  { at: { lat: 46.01, lon: -1.01 }, wayId: 'w-aigrefeuille', azimuthDeg: 90, distanceM: 1963, rank: 1 },
];

describe('detectNoLegReachesRing', () => {
  it('a retained R0 anchor: null — the ring guard has nothing to say', () => {
    const search = gateSearch({ retained: AIGREFEUILLE_RETAINED });
    expect(detectNoLegReachesRing(search)).toBeNull();
  });

  it('no R0 anchor but the discovery kept an inbound approach: null — a leg does reach', () => {
    const search = gateSearch({
      retained: [],
      discovery: discovery({
        approaches: [
          {
            key: 'r1@45',
            direction: 'in',
            firstRound: 1,
            originAzimuthDeg: 45,
            distanceM: 1900,
            durationS: 180,
            polyline: [],
            coveredByCandidateId: null,
            widthProfile: null,
            gateByWidth: null,
          },
        ],
      }),
    });
    expect(detectNoLegReachesRing(search)).toBeNull();
  });

  it('no R0 anchor, no discovered leg, only R0 ways short of the ring: the motif names the way', () => {
    const search = gateSearch({
      retained: [],
      shortOfRing: [
        { wayId: 'w-far', name: 'Route de la Forêt', at: { lat: 46.02, lon: -1.02 }, azimuthDeg: 10, reachM: 900 },
        { wayId: 'w-d113', name: 'D 113', at: { lat: 46.03, lon: -1.0 }, azimuthDeg: 45, reachM: 1312 },
      ],
    });
    expect(detectNoLegReachesRing(search)).toEqual({
      minReachM: 1800,
      bestReachM: 1312,
      bestWayId: 'w-d113',
      bestWayName: 'D 113',
      bestAzimuthDeg: 45,
    });
  });

  it('the discovery beats R0 on reach: the winner carries no way — absent, not borrowed', () => {
    const search = gateSearch({
      retained: [],
      shortOfRing: [
        { wayId: 'w-d113', name: 'D 113', at: { lat: 46.03, lon: -1.0 }, azimuthDeg: 45, reachM: 1312 },
      ],
      discovery: discovery({
        shortOfRing: [{ key: 'r2@200:out:alt1', direction: 'out', reachM: 1499, routedDistanceM: 1510 }],
      }),
    });
    expect(detectNoLegReachesRing(search)).toEqual({
      minReachM: 1800,
      bestReachM: 1499,
      bestWayId: null,
      bestWayName: null,
      bestAzimuthDeg: null,
    });
  });

  it('an unnamed R0 way: bestWayName is null, bestWayId still names it', () => {
    const search = gateSearch({
      retained: [],
      shortOfRing: [
        { wayId: 'w-anon', name: null, at: { lat: 46.02, lon: -1.02 }, azimuthDeg: 200, reachM: 1100 },
      ],
    });
    expect(detectNoLegReachesRing(search)).toEqual({
      minReachM: 1800,
      bestReachM: 1100,
      bestWayId: 'w-anon',
      bestWayName: null,
      bestAzimuthDeg: 200,
    });
  });

  it('nothing measured at all under the floor: null — no best vertex to report', () => {
    const search = gateSearch({ retained: [], shortOfRing: [], discovery: discovery({ shortOfRing: [] }) });
    expect(detectNoLegReachesRing(search)).toBeNull();
  });
});
