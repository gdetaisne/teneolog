/**
 * S2 bis : l'arrêt de repli avec ses contraintes, dans `analyseAddress`.
 *
 * Deux choses à prouver. Que le bloc de policy absent laisse les faits EXACTEMENT
 * comme avant (pas de champ, rien d'autre qui bouge) ; et que, présent, il rend
 * un arrêt de repli sur la rue amont avec la largeur déclarée de cette rue, ses
 * bandes légales, ses barrières, la ZFE lue au bon point — sans un fetch de plus.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import { analyseAddress, type PipelineParams, type PipelinePorts } from '../src/analyse.js';
import { fallbackStopFacts } from '../src/fallback-stop.js';

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

/**
 * L'impasse : une villa de 4 m, d'ouest en est, qui part en T d'une rue amont
 * nord-sud de 5,5 m limitée à 7,5 t, et finit en cul-de-sac. Le point est à
 * 4 m de l'axe de la villa et à 25 m de celui de la rue amont — hors de la
 * fenêtre d'ambiguïté de S0 (4 + 12 m), sans quoi la rue amont, plus large,
 * serait retenue à la place de la villa.
 */
const VILLA = way('villa', ['j', 'tip'], [at(-4, -25), at(-4, 45)], { name: 'Villa Test', declaredWidthM: 4 });
const FEEDER = way('feeder', ['f0', 'j', 'f1'], [at(-300, -25), at(-4, -25), at(300, -25)], {
  name: 'Rue Amont',
  declaredWidthM: 5.5,
  limits: { maxWeightT: 7.5, maxHeightM: null, maxWidthM: null, maxLengthM: null },
});
const WORLD = [VILLA, FEEDER];

function ports(options: { lezThrows?: boolean } = {}): PipelinePorts {
  return {
    geocode: {
      geocode: async () => [
        { source: 'ban', point: O, score: 0.95, formatted: '1 Villa Test', banId: null, positionType: null },
      ],
    },
    graph: { fetchNeighbourhood: async (_c, r) => hoodOf(O, r, WORLD) },
    surfaces: { fetchSurfaces: async () => [] },
    lowEmissionZones: {
      zoneAt: async () => {
        if (options.lezThrows) throw new Error('bnzfe down');
        return null;
      },
    },
  };
}

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
  },
  declaredWidthConfidence: 0.55,
  secondaryDescriptionSnapM: 25,
  geocoding: { minBanScore: 0.6 },
};
const WITH_FALLBACK: PipelineParams = {
  ...BASE,
  assessment: { ...BASE.assessment, fallbackStop: { plainWalkMaxM: 50, portageWalkMaxM: 150, stopOffsetM: 15 } },
};
const frozen = () => '2026-09-24T10:00:00.000Z';

async function facts(params: PipelineParams, p = ports()) {
  const outcome = await analyseAddress({ kind: 'address', address: '1 Villa Test' }, p, params, frozen);
  if (!outcome.ok) throw new Error(`${outcome.stage}/${outcome.why}`);
  return outcome.facts;
}

describe('S2 bis dans analyseAddress', () => {
  it('sans le bloc de policy : aucun arrêt de repli, et les faits sont ceux d’avant', async () => {
    const before = await facts(BASE);
    expect(before.fallbackStop).toBeUndefined();
    expect('fallbackStop' in before.topology).toBe(false);
    expect(before.topology.topology.kind).toBe('DEAD_END');
  });

  it('avec le bloc : le même run, plus l’arrêt de repli sur la rue amont — et rien d’autre ne bouge', async () => {
    const before = await facts(BASE);
    const after = await facts(WITH_FALLBACK);

    const { fallbackStop: place, ...afterTopology } = after.topology;
    expect(afterTopology).toEqual(before.topology);
    expect(after.anchor).toEqual(before.anchor);
    expect(after.stop).toEqual(before.stop);
    expect(after.streetDoubt).toEqual(before.streetDoubt);
    expect(after.resolvedAtRadiusM).toBe(before.resolvedAtRadiusM);

    expect(place?.known).toBe(true);
    expect(after.fallbackStop?.known).toBe(true);
    if (!after.fallbackStop?.known) return;
    const { place: p, stop } = after.fallbackStop.value;
    expect(p.street.name).toBe('Rue Amont');
    expect(p.band).toBe('plain');
    // S2 bis, from the parent street's own description: its width, its bands.
    expect(stop.at).toEqual(p.stopAt);
    expect(stop.width.known && stop.width.value.freeM).toBe(5.5);
    expect(stop.width.known && stop.width.reliability.basis).toBe('declared');
    expect(stop.legal.maxWeightT.known && stop.legal.maxWeightT.value.value).toBe(7.5);
    expect(stop.legal.lowEmissionZone).toEqual(expect.objectContaining({ known: true, value: null }));
    expect(stop.barriers).toEqual([]);
    expect(stop.slopePct).toEqual({ known: false, why: 'no_data' });
  });

  it('une ZFE qui tombe en panne au point de repli laisse une inconnue dite, jamais un silence', async () => {
    const after = await facts(WITH_FALLBACK, ports({ lezThrows: true }));
    if (!after.fallbackStop?.known) throw new Error('expected a fallback stop');
    expect(after.fallbackStop.value.stop.legal.lowEmissionZone).toEqual({ known: false, why: 'provider_error' });
  });

  it('le voisinage lu est celui du barreau : sans lui, out_of_coverage, avec la provenance du fait', async () => {
    const after = await facts(WITH_FALLBACK);
    const gone = await fallbackStopFacts(after.topology, null, ports(), WITH_FALLBACK, frozen());
    expect(gone).toEqual({ known: false, why: 'out_of_coverage', provenance: expect.objectContaining({ method: 'fallback-stop-at-mouth' }) });
    const none = await fallbackStopFacts({ ...after.topology, fallbackStop: { known: false, why: 'no_data' } }, null, ports(), WITH_FALLBACK, frozen());
    expect(none).toEqual({ known: false, why: 'no_data' });
  });
});
