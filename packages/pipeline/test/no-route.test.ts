/**
 *, élargi par le garde-fou du run SANS
 * CANDIDAT, côté pipeline : `noCandidateProjection` construit la même
 * conclusion qu'un run à zéro candidat (`concludePairs` sur `legs: []`,
 * principe 23) et lui attache le motif quand il y en a un.
 *
 * Ce qui a changé le 2026-09-18 : la fonction rendait `null` dès que
 * `detectNoLegReachesRing` ne trouvait pas de motif de PORTÉE — et l'appelant
 * reposait alors `projection: null`, que le fil traduit en `reasonCodes: []`
 * à côté d'`itineraries: []`. Elle rend désormais toujours une conclusion, et
 * c'est `concludePairs` qui nomme la cause : `no_leg_reaches_ring` avec son
 * motif, `router_unavailable` quand le routeur a perdu les jambes,
 * `no_viable_pair` sinon.
 */
import { describe, expect, it } from 'vitest';
import type { Discovery, GateSearch, TerminalTopology, TruckProfile } from '@teneolog/domain';
import type { CollectPointsParams } from '@teneolog/points';
import type { ProjectionPolicy } from '@teneolog/projection';

import type { S0S2Facts } from '../src/analyse.js';
import { reprojectTruck, type FullAnalysis, type FullParams } from '../src/full.js';
import { noCandidateProjection, type NoRoutePolicyParams } from '../src/no-route.js';

const STOP = { lat: 46.0, lon: -1.0 };

const TRUCK: TruckProfile = {
  id: 'pl-19t',
  label: 'Porteur 19 t',
  family: 'rigid',
  envelope: {
    lengthM: 9,
    widthM: 2.5,
    heightM: 3.5,
    gvwT: 19,
    turnRadiusM: 11,
    wheelbaseM: 6.1,
    frontOverhangM: 1.2,
    rearOverhangM: 1.7,
  },
  equipment: { tailLift: true, crane: false, refrigerated: false },
};

const PROJECTION_POLICY: ProjectionPolicy = {
  lateralClearanceM: 0.8,
  turnSweptClearanceM: 1.0,
  roundaboutSweptClearanceM: 1.0,
  turnaroundClearanceM: 2.0,
  comfortMarginM: 0.4,
  publishableConfidence: 0.55,
  hgvThresholdT: 3.5,
  passingLaneWidthM: 2.75,
};

const POINTS_PARAMS: CollectPointsParams = {
  turns: {
    windowM: 40,
    minDeflectionDeg: 45,
    bearingOffsetM: 10,
    mergeWithinM: 25,
    geometryConfidence: 0.7,
    curveIgnoreRadiusM: 60,
    junction: { nodeSnapM: 6, apexShare: 0.8 },
  },
  roundabouts: { ringSnapM: 8, ringMergeM: 40, geometryConfidence: 0.7, declaredWidthConfidence: 0.55 },
  narrowMaxFreeM: 5,
  dedupeWithinM: 15,
  chainedWithinM: 40,
};

/** Le fait « aucun candidat », tel que `buildRouteCandidatesWithCorridors` le pose. */
const NO_DATA = { known: false, why: 'no_data' } as const;
const PROVIDER_ERROR = { known: false, why: 'provider_error' } as const;

const PARAMS: NoRoutePolicyParams = {
  points: POINTS_PARAMS,
  projection: PROJECTION_POLICY,
  policyVersion: 'test',
  reportShelfLifeDays: 30,
};

/** `reprojectTruck` prend `FullParams` ; ce garde-fou ne lit que le sous-ensemble ci-dessus. */
const FULL_PARAMS = PARAMS as unknown as FullParams;

/** `trucks[0]` du catalogue produit (`compat.ts:197`) — le premier camion analysé. */
const VUL_FOURGON: TruckProfile = { ...TRUCK, id: 'vul-fourgon', label: 'Fourgon' };

// A through street: `collectCriticalPoints` reads only `.kind` on it once the
// candidate set is empty (packages/points/src/collect.ts, `stopPoints`).
const THROUGH_TOPOLOGY = { kind: 'THROUGH' } as unknown as TerminalTopology;

function facts(): S0S2Facts {
  return {
    stop: {
      at: STOP,
      width: { known: false, why: 'no_data' },
      slopePct: { known: false, why: 'no_data' },
      legal: { access: [], weightLimitT: null, heightLimitM: null },
      surface: { known: false, why: 'no_data' },
    },
    topology: { topology: THROUGH_TOPOLOGY, terminalNodeInterior: true },
    resolvedAtRadiusM: 150,
  } as unknown as S0S2Facts;
}

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

function discoveryOf(overrides: Partial<Discovery> = {}): Discovery {
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

describe('noCandidateProjection', () => {
  it('no R0 anchor, no discovered leg, a way short of the ring: the conclusion names it', () => {
    const search = gateSearch({
      shortOfRing: [
        { wayId: 'w-d113', name: 'D 113', at: { lat: 46.03, lon: -1.0 }, azimuthDeg: 45, reachM: 1312 },
      ],
    });
    const noRoute = noCandidateProjection(search, NO_DATA, facts(), TRUCK, PARAMS, '2026-09-14T00:00:00Z');
    expect(noRoute).not.toBeNull();
    const conclusion = noRoute?.projection.conclusion;
    expect(conclusion?.overall).toBe('HUMAN');
    expect(conclusion?.reasonCodes).toEqual(['no_leg_reaches_ring']);
    expect(conclusion?.noLegReachesRing).toEqual({
      minReachM: 1800,
      bestReachM: 1312,
      bestWayId: 'w-d113',
      bestWayName: 'D 113',
      bestAzimuthDeg: 45,
    });
    // Pas de candidat : pas de paire, donc pas d'itinéraire retenu — le
    // garde-fou ne fabrique aucun itinéraire (principe 5, un inconnu n'est
    // jamais un refus, mais ce n'est pas non plus un OK inventé).
    expect(conclusion?.viaCandidateId).toBeNull();
    // `collected` sort avec la projection : le
    // DESTINATION que `pointVerdicts` cite (le seul point qu'un run à zéro
    // candidat mesure quand même) a bien sa fiche, pas seulement son verdict.
    const destinationRef = conclusion?.pointVerdicts.find((pv) => pv.pointRef.startsWith('DESTINATION@'))
      ?.pointRef;
    expect(destinationRef).toBeDefined();
    expect(noRoute?.collected.points.some((p) => p.ref === destinationRef)).toBe(true);
  });

  /**
   * UNE ANCRE R0 RETENUE DONT IL NE RESTE AUCUN CANDIDAT n'est pas
   * un motif de portée : la voie atteignait bien le cercle, c'est le corridor
   * ou le routeur qui a échoué. Avant, la fonction rendait `null` et l'écran
   * n'avait plus rien à dire ; maintenant `concludePairs` nomme l'absence.
   */
  it('an R0 anchor was retained but nothing survived: no reach motif, and the run still says why', () => {
    const search = gateSearch({
      retained: [{ at: STOP, wayId: 'w1', azimuthDeg: 10, distanceM: 1900, rank: 1 }],
    });
    const noRoute = noCandidateProjection(search, NO_DATA, facts(), TRUCK, PARAMS, '2026-09-14T00:00:00Z');
    const conclusion = noRoute.projection.conclusion;
    expect(conclusion.overall).toBe('HUMAN');
    expect(conclusion.reasonCodes).toEqual(['no_viable_pair']);
    expect(conclusion.noLegReachesRing).toBeNull();
  });

  /** Le routeur, quand c'est lui : une panne, pas une absence mesurée. */
  it('the router lost the legs: `router_unavailable`, read off the candidates fact', () => {
    const search = gateSearch({
      retained: [{ at: STOP, wayId: 'w1', azimuthDeg: 10, distanceM: 1900, rank: 1 }],
    });
    const noRoute = noCandidateProjection(
      search,
      PROVIDER_ERROR,
      facts(),
      TRUCK,
      PARAMS,
      '2026-09-14T00:00:00Z',
    );
    expect(noRoute.projection.conclusion.reasonCodes).toEqual(['router_unavailable']);
    expect(noRoute.projection.conclusion.noLegReachesRing).toBeNull();
  });

  /**
   * UNE JAMBE DÉCOUVERTE QUI ATTEINT LE CERCLE n'est plus un
   * silence. `detectNoLegReachesRing` s'efface toujours devant elle (elle
   * existe, donc aucune voie n'est « trop courte »), mais ce garde-fou-là
   * n'est plus le seul à parler : la conclusion dit `no_viable_pair`, et
   * surtout `analyseWithoutR0` la PROMEUT avant d'arriver ici — c'est
   * `no-r0.test.ts` qui le vérifie.
   */
  it('a discovered leg reaches the ring: no reach motif, but a reason all the same', () => {
    const search = gateSearch({
      discovery: discoveryOf({
        approachesOut: [
          {
            key: 'r1@200',
            direction: 'out',
            firstRound: 1,
            originAzimuthDeg: 200,
            distanceM: 1850,
            durationS: 200,
            polyline: [],
            coveredByCandidateId: null,
            widthProfile: null,
            gateByWidth: null,
          },
        ],
      }),
    });
    const noRoute = noCandidateProjection(search, NO_DATA, facts(), TRUCK, PARAMS, '2026-09-14T00:00:00Z');
    expect(noRoute.projection.conclusion.noLegReachesRing).toBeNull();
    expect(noRoute.projection.conclusion.reasonCodes).toEqual(['no_viable_pair']);
  });
});

describe('reprojectTruck —  (relecture), le garde-fou pour un autre camion', () => {
  const search = gateSearch({
    shortOfRing: [
      { wayId: 'w-d113', name: 'D 113', at: { lat: 46.03, lon: -1.0 }, azimuthDeg: 45, reachM: 1312 },
    ],
  });

  /**
   * L'analyse du premier camion (`vul-fourgon`, `trucks[0]`) — celle que
   * `continueFromFacts` rend pour un run sans ancre R0. C'est cette analyse
   * que `reprojectTruck` rendait TELLE QUELLE pour les deux autres camions
   * avant ce correctif : `byTruck` la récitait trois fois.
   */
  const fourgonNoRoute = noCandidateProjection(
    search,
    NO_DATA,
    facts(),
    VUL_FOURGON,
    PARAMS,
    '2026-09-14T00:00:00Z',
  );
  const fourgonAnalysis: FullAnalysis = {
    facts: facts(),
    candidates: { known: false, why: 'no_data' },
    collected: fourgonNoRoute?.collected ?? null,
    projection: fourgonNoRoute?.projection ?? null,
    summary: null,
    gateSearch: search,
    phase2: null,
  } as unknown as FullAnalysis;

  it('rejoue le motif pour le 19 t : profileId et libellé sont les siens, pas ceux du fourgon', () => {
    const reprojected = reprojectTruck(fourgonAnalysis, TRUCK, FULL_PARAMS, () => '2026-09-14T00:00:00Z');
    expect(reprojected.projection?.conclusion.profileId).toBe('pl-19t');
    expect(reprojected.projection?.conclusion.reasonCodes).toEqual(['no_leg_reaches_ring']);
    expect(reprojected.projection?.conclusion.noLegReachesRing).toEqual({
      minReachM: 1800,
      bestReachM: 1312,
      bestWayId: 'w-d113',
      bestWayName: 'D 113',
      bestAzimuthDeg: 45,
    });
    expect(reprojected.summary?.headline).toBe('Accès en Porteur 19 t non déterminé.');
    // Pas la même conclusion que le fourgon — sinon `byTruck` la récite trois fois.
    expect(reprojected.projection?.conclusion.profileId).not.toBe(
      fourgonAnalysis.projection?.conclusion.profileId,
    );
    // `collected` suit la projection rejouée, pas
    // seulement celle du fourgon : le DESTINATION cité par la conclusion du
    // 19 t a sa fiche dans CE `collected`, pas dans celui d'un autre camion.
    expect(reprojected.collected).not.toBeNull();
    expect(reprojected.collected).not.toBe(fourgonAnalysis.collected);
  });

  it('un run réhydraté sans `gateSearch` : rien à rejouer, `projection` et `summary` retombent à `null`', () => {
    const rehydrated: FullAnalysis = { ...fourgonAnalysis, gateSearch: null };
    const reprojected = reprojectTruck(rehydrated, TRUCK, FULL_PARAMS, () => '2026-09-14T00:00:00Z');
    expect(reprojected.projection).toBeNull();
    expect(reprojected.summary).toBeNull();
  });
});
