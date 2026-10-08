/**
 * BDTOPO mapping — the trap is junction synthesis. BDTOPO segments share no
 * node ids: identity has to be built from coincident endpoints, and both
 * failure directions are fatal. Too strict and every junction dissolves into
 * degree-1 tips (the whole network reads as dead ends); too loose and two
 * parallel street ends fuse into a phantom junction.
 */
import { describe, expect, it } from 'vitest';

import { bboxPaddingDeg } from '../src/bdtopo.js';
import { isNonMotorNature, mapBdtopoNeighbourhood, oneWayFromSens, type BdtopoRoadRow } from '../src/bdtopo-mapping.js';

const CENTRE = { lat: 47.0, lon: 1.0 };

function line(points: readonly (readonly [lon: number, lat: number])[]): string {
  return JSON.stringify({ type: 'LineString', coordinates: points });
}

function row(overrides: Partial<BdtopoRoadRow> & Pick<BdtopoRoadRow, 'id' | 'geom_geojson'>): BdtopoRoadRow {
  return {
    nature: 'Route à 1 chaussée',
    importance: '5',
    lane_count: null,
    width_m: null,
    one_way: null,
    restriction_height_m: null,
    restriction_width_m: null,
    restriction_weight_t: null,
    is_private: null,
    ...overrides,
  };
}

describe('mapBdtopoNeighbourhood', () => {
  it('two segments meeting at a corner share one synthesised junction node', () => {
    const a = row({ id: 'A', geom_geojson: line([[1.0, 47.0], [1.0005, 47.0]]) });
    const b = row({ id: 'B', geom_geojson: line([[1.0005, 47.0], [1.0376, 47.0005]]) });

    const hood = mapBdtopoNeighbourhood([a, b], CENTRE, 100, { junctionSnapM: 2 });

    const junctions = hood.nodes.filter((n) => n.wayIds.length === 2);
    expect(junctions).toHaveLength(1);
    expect(junctions[0]?.wayIds.slice().sort()).toEqual(['A', 'B']);
  });

  it('endpoints further apart than the snap stay two nodes — no phantom junction', () => {
    // ~4.6 m gap between the two street ends, snap 2 m.
    const a = row({ id: 'A', geom_geojson: line([[1.0, 47.0], [1.0005, 47.0]]) });
    const b = row({ id: 'B', geom_geojson: line([[1.00056, 47.0], [1.001, 47.0]]) });

    const hood = mapBdtopoNeighbourhood([a, b], CENTRE, 100, { junctionSnapM: 2 });

    expect(hood.nodes.filter((n) => n.wayIds.length === 2)).toHaveLength(0);
  });

  it('interior vertices stay unique to their way — the BUG-048a property', () => {
    const a = row({ id: 'A', geom_geojson: line([[1.0, 47.0], [1.0002, 47.0], [1.0005, 47.0]]) });
    const b = row({ id: 'B', geom_geojson: line([[1.0373, 47.0001], [1.0373, 47.0005]]) });

    const hood = mapBdtopoNeighbourhood([a, b], CENTRE, 100, { junctionSnapM: 2 });

    // B's endpoint sits ~11 m from A's interior vertex; even a generous snap
    // must not weld a shape point into a junction, because interior vertices
    // are not junction candidates at all.
    const shared = hood.nodes.filter((n) => n.wayIds.length === 2);
    expect(shared).toHaveLength(0);
  });

  it("'Sens inverse' keeps its direction instead of collapsing into a boolean", () => {
    expect(oneWayFromSens('Sens inverse')).toBe('backward');
    expect(oneWayFromSens('Sens direct')).toBe('forward');
    expect(oneWayFromSens('Double sens')).toBe('no');
    expect(oneWayFromSens(null)).toBe('no');
  });

  it('non-motor natures are excluded, accent-insensitively; rural tracks stay', () => {
    expect(isNonMotorNature('Sentier')).toBe(true);
    expect(isNonMotorNature('Piste cyclable')).toBe(true);
    expect(isNonMotorNature('Route empierrée')).toBe(true);
    expect(isNonMotorNature('Escalier')).toBe(true);
    expect(isNonMotorNature('Chemin rural')).toBe(false);
    expect(isNonMotorNature('Route à 1 chaussée')).toBe(false);
  });

  it('restrictions and privacy ride through onto the way', () => {
    const a = row({
      id: 'A',
      geom_geojson: line([[1.0, 47.0], [1.0005, 47.0]]),
      restriction_weight_t: 7.5,
      restriction_height_m: 3.2,
      width_m: 4.5,
      is_private: true,
      importance: '3',
    });

    const hood = mapBdtopoNeighbourhood([a], CENTRE, 100, { junctionSnapM: 2 });
    const way = hood.ways[0];

    expect(way?.limits.maxWeightT).toBe(7.5);
    expect(way?.limits.maxHeightM).toBe(3.2);
    expect(way?.declaredWidthM).toBe(4.5);
    expect(way?.isPrivate).toBe(true);
    expect(way?.importance).toBe(3);
    expect(way?.source).toBe('bdtopo-postgis');
  });

  it('a MultiLineString splits into suffixed simple chains', () => {
    const multi = JSON.stringify({
      type: 'MultiLineString',
      coordinates: [
        [[1.0, 47.0], [1.0005, 47.0]],
        [[1.001, 47.0], [1.0015, 47.0]],
      ],
    });
    const hood = mapBdtopoNeighbourhood([row({ id: 'M', geom_geojson: multi })], CENTRE, 200, {
      junctionSnapM: 2,
    });

    expect(hood.ways.map((w) => w.id).sort()).toEqual(['M#0', 'M#1']);
  });

  it('unparseable geometry drops the row whole, never a half-mapped way', () => {
    const hood = mapBdtopoNeighbourhood(
      [row({ id: 'X', geom_geojson: 'not-json' }), row({ id: 'Y', geom_geojson: '{"type":"Point","coordinates":[1,47]}' })],
      CENTRE,
      100,
      { junctionSnapM: 2 },
    );
    expect(hood.ways).toHaveLength(0);
  });
});

describe('bboxPaddingDeg', () => {
  it('pads a 120 m search by a degree amount the GiST box can use', () => {
    const pad = bboxPaddingDeg(120, 48.86);
    expect(pad).toBeGreaterThan(0.001);
    expect(pad).toBeLessThan(0.002);
  });
});
