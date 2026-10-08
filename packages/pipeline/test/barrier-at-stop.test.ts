/**
 *, constat L4-3 — UNE BARRIÈRE SUR LA RUE DE LIVRAISON ATTEINT
 * L'ÉCRAN, ET UN VERDICT.
 *
 * `assessTopology` classait déjà les barrières (`barrier=bollard` fixe →
 * `passable: 'no'`, un portail sans mention d'accès → `'unknown'`) et personne
 * ne les lisait : ni le fil, ni un verdict, et `assessObviousStop` déclarait
 * « arrêt évident » par-dessus — rue traversante, large, sans bande légale, et
 * fermée. Le module le dit lui-même : « worse than a false dead end, because
 * the truck arrives and the report said it would pass. »
 *
 * CE QUE LE TEST VÉRIFIE, de bout en bout du chemin de la donnée :
 *
 *  1. la barrière classée par S1 arrive dans `StopConstraints.barriers` —
 *     c'est par là que le fil pourra la servir ;
 *  2. elle arrive sur le point DESTINATION, accroché à toutes les jambes ;
 *  3. le verdict de l'arrêt devient une QUESTION avec ses codes, et non un
 *     refus : une barrière issue d'un tag OSM est DÉCLARÉE, et on ne refuse
 *     pas sur du non-mesuré (principe 5 ; l'engine dit la même chose, son
 *     `OSM_BARRIER_PHYSICAL` porte `hardNo: false`). Mesurée, elle refuse ;
 *  4. l'arrêt n'est plus « évident » ;
 *  5. une barrière `conditional` — borne escamotable, chicane, gabarit — ne
 *     change RIEN : le camion passe sous condition.
 */
import { describe, expect, it } from 'vitest';
import type { Fact, GeoPoint, PhysicalBarrier, TruckProfile } from '@teneolog/domain';
import { readBarrierClosure } from '@teneolog/domain';
import { assembleStopConstraints } from '@teneolog/constraints';
import { collectCriticalPoints, type CollectPointsParams } from '@teneolog/points';
import { evaluatePoint, type ProjectionPolicy } from '@teneolog/projection';
import { assessTopology, type RoadNeighbourhood, type RoadNode, type RoadWay } from '@teneolog/topology';

import type { S0S2Facts } from '../src/analyse.js';
import { assessObviousStop, type ObviousStopThresholds } from '../src/obvious-stop.js';

const AT = '2026-09-18T00:00:00Z';
const STOP: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(northM: number, eastM: number): GeoPoint {
  return {
    lat: STOP.lat + northM / M_PER_DEG_LAT,
    lon: STOP.lon + eastM / (M_PER_DEG_LAT * Math.cos((STOP.lat * Math.PI) / 180)),
  };
}

/** La rue de livraison : traversante, 12 m déclarés — un arrêt évident, sauf si… */
const STREET: RoadWay = {
  id: 'street',
  source: 'osm-overpass',
  nodeIds: ['a', 'stop', 'b'],
  geometry: [at(0, -170), STOP, at(0, 170)],
  name: 'Rue Test',
  importance: null,
  declaredWidthM: 12,
  laneCount: null,
  oneWay: 'no',
  isPrivate: false,
  limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
  tags: { highway: 'residential' },
};

function nodes(barrierTags: Record<string, string> | null): readonly RoadNode[] {
  return [
    { id: 'a', at: at(0, -170), wayIds: ['street'], tags: {} },
    { id: 'stop', at: STOP, wayIds: ['street'], tags: barrierTags ?? {} },
    { id: 'b', at: at(0, 170), wayIds: ['street'], tags: {} },
  ];
}

function hood(barrierTags: Record<string, string> | null): RoadNeighbourhood {
  return { centre: STOP, radiusM: 160, ways: [STREET], nodes: nodes(barrierTags) };
}

/** Les barrières telles que S1 les classe — jamais écrites à la main ici. */
function barriersFrom(barrierTags: Record<string, string> | null): readonly Fact<PhysicalBarrier>[] {
  return assessTopology({
    deliveryPoint: STOP,
    deliveryWayId: 'street',
    surfaces: [],
    neighbourhood: hood(barrierTags),
    maxMouthDepth: 2,
    maxDeviationDeg: 40,
    barrierSnapM: 6,
    turnaroundSearchRadiusM: 120,
    measurement: {
      observedAt: AT,
      defaultTurningCircleDiameterM: null,
      fallbackCarriagewayWidthM: null,
      loopClosureToleranceM: 3,
    },
  }).barriers;
}

const PARAMS: CollectPointsParams = {
  turns: { windowM: 40, minDeflectionDeg: 45, bearingOffsetM: 10, mergeWithinM: 25, geometryConfidence: 0.7, curveIgnoreRadiusM: 60, junction: { nodeSnapM: 6, apexShare: 0.8 } },
  roundabouts: { ringSnapM: 8, ringMergeM: 40, geometryConfidence: 0.7, declaredWidthConfidence: 0.55 },
  narrowMaxFreeM: 5,
  dedupeWithinM: 15,
  chainedWithinM: 40,
};

const POLICY: ProjectionPolicy = {
  lateralClearanceM: 0.8,
  turnSweptClearanceM: 1.0,
  roundaboutSweptClearanceM: 1.0,
  turnaroundClearanceM: 2.0,
  comfortMarginM: 0.4,
  publishableConfidence: 0.55,
  hgvThresholdT: 3.5,
  passingLaneWidthM: 2.75,
};

const PL19 = {
  id: 'pl-19t',
  label: 'Porteur 19 t',
  family: 'rigid',
  envelope: { lengthM: 9, widthM: 2.5, heightM: 3.5, gvwT: 19, turnRadiusM: 11, wheelbaseM: 6.1, frontOverhangM: 1.2, rearOverhangM: 1.7 },
  equipment: { tailLift: true, crane: false, refrigerated: false },
} as TruckProfile;

const THRESHOLDS: ObviousStopThresholds = {
  declaredWidthMinM: 10,
  measuredWidthMinM: 6.5,
  publishableConfidence: 0.55,
};

/** L'arrêt, assemblé par S2 — avec les barrières que S1 a classées. */
function stopWith(barrierTags: Record<string, string> | null) {
  return assembleStopConstraints({
    at: STOP,
    barriers: barriersFrom(barrierTags),
    descriptions: [STREET],
    fetchedAt: AT,
    declaredWidthConfidence: 0.55,
  });
}

/** Le verdict du point DESTINATION, tel que S5 le rend. */
function destinationVerdict(barrierTags: Record<string, string> | null) {
  const collected = collectCriticalPoints(
    {
      candidates: [],
      corridors: new Map(),
      stop: stopWith(barrierTags),
      topology: { kind: 'THROUGH', continuity: { establishedBy: 'same_way', deviationDeg: 0, attributeBreak: false } },
      fetchedAt: AT,
    },
    PARAMS,
  );
  const destination = collected.points.find((point) => point.type === 'DESTINATION');
  if (destination === undefined) throw new Error('pas de point DESTINATION');
  return evaluatePoint(destination, PL19, POLICY);
}

function factsWith(barrierTags: Record<string, string> | null): S0S2Facts {
  return {
    topology: { topology: { kind: 'THROUGH' }, barriers: barriersFrom(barrierTags) },
    stop: {
      width: {
        known: true,
        value: { freeM: 12, structuralM: 12 },
        reliability: { confidence: 0.55, basis: 'declared', reasonCodes: [] },
      },
      legal: {
        maxWeightT: { known: false, why: 'no_data' },
        maxHeightM: { known: false, why: 'no_data' },
        maxWidthM: { known: false, why: 'no_data' },
        access: { known: true, value: { kind: 'open' } },
      },
    },
  } as unknown as S0S2Facts;
}

describe('la barrière voyage de S1 jusqu’au verdict de l’arrêt', () => {
  it('S1 la classe, S2 la porte : `StopConstraints.barriers`', () => {
    const closed = stopWith({ barrier: 'bollard' });
    expect(closed.barriers).toHaveLength(1);
    expect(closed.barriers?.[0]?.known).toBe(true);
    // Sans barrière, le champ est une ABSENCE mesurée : la liste est vide,
    // parce que S1 a cherché et n'a rien trouvé.
    expect(stopWith(null).barriers).toEqual([]);
  });

  it('elle arrive sur le point DESTINATION, celui de toutes les jambes', () => {
    const collected = collectCriticalPoints(
      {
        candidates: [],
        corridors: new Map(),
        stop: stopWith({ barrier: 'bollard' }),
        topology: { kind: 'THROUGH', continuity: { establishedBy: 'same_way', deviationDeg: 0, attributeBreak: false } },
        fetchedAt: AT,
      },
      PARAMS,
    );
    const destination = collected.points.find((point) => point.type === 'DESTINATION');
    const geometry = destination?.geometry;
    if (geometry === undefined || !geometry.known || geometry.value.type !== 'DESTINATION') {
      throw new Error('pas de géométrie de destination');
    }
    expect(geometry.value.barriers).toHaveLength(1);
  });
});

describe('ce que la barrière fait du verdict', () => {
  it('une borne fixe DÉCLARÉE : une question, jamais un refus (principe 5)', () => {
    const verdict = destinationVerdict({ barrier: 'bollard' });
    expect(verdict.verdict).toBe('HUMAN');
    expect(verdict.reasonCodes).toEqual([
      'barrier_bollard',
      'barrier_impassable',
      'declared_barrier_cannot_refuse',
    ]);
    expect(verdict.explanation).toContain('borne fixe');
  });

  it('un portail sans mention d’accès : une question aussi, et elle le dit', () => {
    const verdict = destinationVerdict({ barrier: 'gate' });
    expect(verdict.verdict).toBe('HUMAN');
    expect(verdict.reasonCodes).toEqual(['barrier_gate', 'barrier_passability_unknown']);
  });

  it('une borne ESCAMOTABLE ne change rien : le camion passe sous condition', () => {
    const verdict = destinationVerdict({ barrier: 'bollard', bollard: 'rising' });
    // 12 m pour 3,3 m requis : la largeur répond, comme avant la règle.
    expect(verdict.verdict).toBe('OK');
    expect(verdict.reasonCodes).toEqual(['destination_width']);
  });

  it('sans barrière, le verdict est celui d’avant la règle — au bit près', () => {
    expect(destinationVerdict(null)).toEqual(destinationVerdict({ barrier: 'bollard', bollard: 'rising' }));
  });

  /**
   * Le jour où une vision verra la borne, `basis: 'measured'` refusera — c'est
   * `VISION_PHYSICAL_BARRIER` de l'engine, le seul barreau `hardNo: true`.
   * Aucun producteur ne le rend aujourd'hui : la règle est écrite, et testée,
   * sur un fait fabriqué pour ce cas-là et lui seul.
   */
  it('mesurée, elle refuse — et la règle est déjà là', () => {
    const measured: Fact<PhysicalBarrier> = {
      known: true,
      value: { kind: 'bollard', at: STOP, passable: 'no' },
      provenance: { source: 'ign-ortho', method: 'vision', fetchedAt: AT },
      reliability: { confidence: 0.9, basis: 'measured', reasonCodes: ['barrier_bollard'] },
    };
    const closure = readBarrierClosure([measured]);
    expect(closure.kind).toBe('blocked');
    expect(closure.kind === 'blocked' && closure.reasonCodes).toEqual([
      'barrier_bollard',
      'barrier_impassable',
    ]);
  });
});

describe('l’arrêt cesse d’être « évident »', () => {
  it('rue traversante de 12 m, aucune bande légale, et une borne fixe : plus d’évidence', () => {
    expect(assessObviousStop(factsWith({ barrier: 'bollard' }), PL19, THRESHOLDS)).toEqual({
      obvious: false,
      // Le seuil a bien été appliqué : la carte doit pouvoir dire lequel.
      basis: 'declared',
      reasonCodes: ['barrier_bollard', 'barrier_impassable', 'declared_barrier_cannot_refuse'],
    });
  });

  it('un portail sans mention d’accès retire l’évidence aussi', () => {
    expect(assessObviousStop(factsWith({ barrier: 'gate' }), PL19, THRESHOLDS)).toMatchObject({
      obvious: false,
      reasonCodes: ['barrier_gate', 'barrier_passability_unknown'],
    });
  });

  it('le test d’or : sans barrière, et avec une escamotable, l’arrêt reste évident', () => {
    for (const tags of [null, { barrier: 'bollard', bollard: 'foldable' }]) {
      expect(assessObviousStop(factsWith(tags), PL19, THRESHOLDS)).toEqual({
        obvious: true,
        basis: 'declared',
        reasonCodes: ['obvious_stop_declared_width'],
      });
    }
  });
});
