/**
 * L'ÉCRAN NOMME : le `ref` puis le `name` de la voie OSM
 * la plus proche de la porte.
 *
 * La BD TOPO n'a pas de colonne nom, donc l'étage axes étiquette ses portes
 * « BD TOPO 12345678 × BD TOPO 87654321 », qu'un opérateur ne peut pas lire.
 * Le voisinage structurant OSM de R0, lui, porte `ref` (« D 939 ») et `name`.
 * Ce que ce cas juge : le nom se pose là où le graphe OSM existe, il ne se pose
 * PAS ailleurs (une ancre à 4 km n'est dans aucun disque chargé), et il ne se
 * pose QUE sous la règle du jour — la règle de secteurs reste au bit près celle
 * du 2026-09-14, libellés compris (principe 17).
 */
import { describe, expect, it } from 'vitest';
import type { AxisSearch, GeoPoint } from '@teneolog/domain';
import type { AxisSourcePort, AxisStageParams } from '@teneolog/routes';
import { closestPointOnPolyline, type RoadNeighbourhood, type RoadWay } from '@teneolog/topology';

import { runGateStage, sealAxes, type GateStageParams } from '../src/gate-stage.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };
const M_PER_DEG_LAT = 111_320;

function at(northM: number, eastM: number): GeoPoint {
  return {
    lat: O.lat + northM / M_PER_DEG_LAT,
    lon: O.lon + eastM / (M_PER_DEG_LAT * Math.cos((O.lat * Math.PI) / 180)),
  };
}

function wayOf(
  id: string,
  geometry: readonly GeoPoint[],
  overrides: Partial<RoadWay> = {},
): RoadWay {
  return {
    id,
    source: 'bdtopo-postgis',
    nodeIds: geometry.map((_, i) => `${id}:v${i}`),
    geometry,
    name: null,
    importance: null,
    declaredWidthM: null,
    laneCount: null,
    oneWay: 'no',
    isPrivate: false,
    limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    tags: {},
    ...overrides,
  };
}

/** Le monde BD TOPO : un axe au nord, un à l'ouest, et leurs rues locales. */
const BDTOPO: readonly RoadWay[] = [
  wayOf('AX-nord', [at(400, -600), at(400, 200)], { importance: 3 }),
  wayOf('L-nord', [at(400, 0), at(150, 0)], { importance: 4 }),
  wayOf('AX-ouest', [at(-600, -400), at(600, -400)], { importance: 3 }),
  wayOf('L-ouest', [at(0, -400), at(0, -150)], { importance: 4 }),
];

/**
 * Le même terrain vu par OSM : la voie du nord porte un `ref` de
 * départementale, celle de l'ouest n'a qu'un `name`. Les deux passent sous les
 * portes BD TOPO, à quelques mètres — comme deux numérisations d'une même
 * route.
 */
const OSM: readonly RoadWay[] = [
  wayOf('osm-nord', [at(403, -600), at(403, 200)], {
    source: 'osm-overpass',
    name: 'Route de Paris',
    tags: { highway: 'primary', ref: 'D 939' },
  }),
  wayOf('osm-ouest', [at(-600, -397), at(600, -397)], {
    source: 'osm-overpass',
    name: 'Avenue du Moulin',
    tags: { highway: 'secondary' },
  }),
];

function hoodOf(ways: readonly RoadWay[]): RoadNeighbourhood {
  const nodes = ways.flatMap((way) =>
    way.geometry.map((point, i) => ({
      id: `${way.id}:v${i}`,
      at: point,
      wayIds: [way.id],
      tags: {},
    })),
  );
  return { centre: O, radiusM: 2_000, ways, nodes };
}

function sourceOf(ways: readonly RoadWay[]): AxisSourcePort {
  return {
    fetchByImportance: async (centre, radiusM, range, limit) => {
      const kept = ways.filter((way) => {
        const importance = way.importance ?? 99;
        if (importance < range.min || importance > range.max) return false;
        const closest = closestPointOnPolyline(way.geometry, centre);
        return closest !== null && closest.distanceM <= radiusM;
      });
      return { ways: kept.slice(0, limit), truncated: kept.length >= limit };
    },
  };
}

const AXES: AxisStageParams = {
  enabled: false,
  importanceMin: 2,
  importanceMax: 3,
  localImportance: { min: 4, max: 5 },
  ringsM: [50, 250, 500, 2_000, 5_000, 10_000, 15_000],
  fetchRadiiM: [500, 5_000, 15_000],
  sectorCount: 12,
  minGateDirections: 2,
  minDirectionSeparationDeg: 60,
  circleFallbackImportanceMax: 4,
  escalationBoundM: 2_000,
  maxAxisSegmentsPerFetch: 2_000,
  maxLocalSegmentsPerFetch: 500,
  stageTimeoutMs: 60_000,
  localFetchRadiusM: 1_500,
  localFetchSpacingM: 3_500,
  localFetchMaxPointsPerAxis: 6,
  localFetchMaxPoints: 48,
  gateCount: 5,
  minReachM: 0,
};

function paramsOf(axes: AxisStageParams): GateStageParams {
  return {
    gates: { searchRadiusM: 2_000, gateCount: 5, minDistanceM: 500, minReachM: 0, axes },
  };
}

async function axesOf(
  axes: AxisStageParams,
  osm: readonly RoadWay[] = OSM,
): Promise<AxisSearch> {
  const stage = await runGateStage(
    O,
    {
      structuring: { fetchStructuring: async () => hoodOf(osm) },
      axes: sourceOf(BDTOPO),
    },
    paramsOf(axes),
  );
  const sealed = await sealAxes(stage.gateSearch, stage.pendingAxes);
  const search = sealed.axes ?? null;
  if (search === null) throw new Error('l’étage axes n’a rien publié');
  return search;
}

describe('les ancres portent le nom de la route', () => {
  it('le `ref` d’abord, le `name` quand il n’y a pas de `ref`', async () => {
    const axes = await axesOf({ ...AXES, selection: 'axes' });

    expect(axes.retained).toHaveLength(2);
    expect(axes.retained.map((gate) => gate.label).sort()).toEqual([
      'Avenue du Moulin',
      'D 939',
    ]);
    // Et l'axe lui-même, pas seulement sa porte.
    expect(axes.axes.map((axis) => axis.label).sort()).toEqual(['Avenue du Moulin', 'D 939']);
  });

  it('sans voisinage OSM, le libellé BD TOPO reste — une donnée absente reste absente', async () => {
    const axes = await axesOf({ ...AXES, selection: 'axes' }, []);
    expect(axes.retained).toHaveLength(2);
    expect(axes.retained.every((gate) => gate.label.includes('BD TOPO'))).toBe(true);
  });

  it('la règle de secteurs ne renomme rien : elle est inchangée au bit près', async () => {
    const axes = await axesOf(AXES);
    expect(axes.selection).toBe('sectors');
    expect(axes.retained.every((gate) => gate.label.includes('BD TOPO'))).toBe(true);
  });
});
