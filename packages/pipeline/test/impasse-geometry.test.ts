/**
 * la géométrie de l'impasse dans `analyseAddress` : ADDITIVE (principe 17).
 *
 * Ce qui est prouvé : le bloc de policy `assessment.impasseGeometry` absent, les
 * faits sont EXACTEMENT ceux d'avant (pas de champ) ; présent, le même run
 * porte en plus la géométrie sur `topology.impasseGeometry`, et rien d'autre ne
 * bouge — ni la forme, ni la bouche, ni les lieux de demi-tour, ni l'arrêt, ni
 * l'arrêt de repli, ni la marche arrière. Et la géométrie servie est celle du
 * croquis : l'axe part de la bouche, la rue amont y donne deux bras.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';
import { haversineM, type RoadNeighbourhood, type RoadWay } from '@teneolog/topology';

import { analyseAddress, type PipelineParams, type PipelinePorts } from '../src/analyse.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(northM: number, eastM: number): GeoPoint {
  return {
    lat: O.lat + northM / M_PER_DEG_LAT,
    lon: O.lon + eastM / (M_PER_DEG_LAT * Math.cos((O.lat * Math.PI) / 180)),
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

/** Le croquis de `reversing.test.ts` : une villa de 4 m en T sur une rue amont nord-sud, fermée au bout. */
const VILLA = way('villa', ['j', 'tip'], [at(-4, -25), at(-4, 45)], { name: 'Villa Test', declaredWidthM: 4 });
const FEEDER = way('feeder', ['f0', 'j', 'f1'], [at(-300, -25), at(-4, -25), at(300, -25)], {
  name: 'Rue Amont',
  declaredWidthM: 5.5,
});

const PORTS: PipelinePorts = {
  geocode: {
    geocode: async () => [
      { source: 'ban', point: O, score: 0.95, formatted: '1 Villa Test', banId: null, positionType: null },
    ],
  },
  graph: { fetchNeighbourhood: async (_c, r) => hoodOf(O, r, [VILLA, FEEDER]) },
  surfaces: { fetchSurfaces: async () => [] },
  lowEmissionZones: { zoneAt: async () => null },
};

const BASE: PipelineParams = {
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
    fallbackStop: { plainWalkMaxM: 50, portageWalkMaxM: 150, stopOffsetM: 15 },
    reversing: { straightMaxDeflectionDeg: 15 },
  },
  declaredWidthConfidence: 0.55,
  secondaryDescriptionSnapM: 25,
  geocoding: { minBanScore: 0.6 },
};
const WITH_GEOMETRY: PipelineParams = {
  ...BASE,
  assessment: { ...BASE.assessment, impasseGeometry: { maxBranchAlongM: 120 } },
};
const frozen = () => '2026-09-24T10:00:00.000Z';

async function facts(params: PipelineParams) {
  const outcome = await analyseAddress({ kind: 'address', address: '1 Villa Test' }, PORTS, params, frozen);
  if (!outcome.ok) throw new Error(`${outcome.stage}/${outcome.why}`);
  return outcome.facts;
}

describe('la géométrie de l’impasse dans analyseAddress', () => {
  it('sans le bloc de policy : aucun champ `impasseGeometry`', async () => {
    const before = await facts(BASE);
    expect('impasseGeometry' in before.topology).toBe(false);
    expect(before.topology.topology.kind).toBe('DEAD_END');
  });

  it('avec le bloc : le même run, plus la géométrie — et rien d’autre ne bouge', async () => {
    const before = await facts(BASE);
    const after = await facts(WITH_GEOMETRY);

    const { impasseGeometry, ...afterTopology } = after.topology;
    expect(afterTopology).toEqual(before.topology);
    expect(after.anchor).toEqual(before.anchor);
    expect(after.stop).toEqual(before.stop);
    expect(after.fallbackStop).toEqual(before.fallbackStop);
    expect(after.streetDoubt).toEqual(before.streetDoubt);
    expect(after.resolvedAtRadiusM).toBe(before.resolvedAtRadiusM);

    if (impasseGeometry?.known !== true) throw new Error('expected an impasse geometry');
    const { value } = impasseGeometry;
    // L'axe de la villa, de la bouche (j) au bout ; la porte se projette 25 m après la bouche.
    expect(haversineM(value.axis[0] ?? O, at(-4, -25))).toBeLessThan(0.01);
    expect(haversineM(value.tip ?? O, at(-4, 45))).toBeLessThan(0.01);
    expect(value.stopAlongM).toBeCloseTo(25, 0);
    // La rue amont traverse la bouche : deux bras, en entrant vers l'est le nord à gauche.
    expect(value.branches.map((b) => [b.id, b.side, b.isMouth])).toEqual([
      ['branch:j:feeder@0', 'left', true],
      ['branch:j:feeder@180', 'right', true],
    ]);
    expect(value.branches[0]?.alongFromStopM).toBeCloseTo(-25, 0);
    expect(value.branches[0]?.name).toBe('Rue Amont');
    expect(value.branches[0]?.declaredWidthM).toBe(5.5);
  });
});
