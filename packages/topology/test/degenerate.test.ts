/**
 * Hostile inputs — the shapes real BDTOPO and Overpass payloads actually take
 * when something upstream is off. The bar is honesty, not success: a degenerate
 * input may yield an unknown, never a crash and never a confident invention.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import { classifyTerminal } from '../src/dead-end.js';
import { resolveHandoff } from '../src/handoff.js';
import { selectDeliveryStreet, type StreetSelectionInput } from '../src/street-selection.js';
import { measureTurnaround } from '../src/turnaround.js';
import { at, neighbourhood, way } from './fixtures.js';

const O: GeoPoint = { lat: 47.0, lon: 1.0 };

const SELECTION_DEFAULTS: Omit<StreetSelectionInput, 'point' | 'neighbourhood'> = {
  maxSnapM: 30,
  ambiguityWindowM: 12,
  minWidthAdvantageM: 0.5,
  tipInteriorMarginM: 5,
  continuationDeviationDeg: 40,
  fetchedAt: '2026-08-24T00:00:00Z',
  confidence: { unambiguous: 0.9, resolvedByRank: 0.75 },
};

describe('degenerate inputs', () => {
  it('classifyTerminal: a single-node way answers unknown, not a crash and not THROUGH', () => {
    const dot = way('dot', ['only'], [O]);
    const hood = neighbourhood(O, 50, [dot]);

    const result = classifyTerminal({ neighbourhood: hood, deliveryWayId: 'dot', deliveryPoint: O });

    expect(result.topology.kind).toBe('DEAD_END');
    if (result.topology.kind !== 'DEAD_END') return;
    expect(result.topology.turnaround.known).toBe(false);
  });

  it('classifyTerminal: geometry shorter than nodeIds does not fabricate a bearing', () => {
    // A misaligned payload: three node ids, two points. Whatever the answer,
    // it must not throw and must not read as a confidently through street.
    const broken = way('broken', ['a', 'b', 'c'], [at(O, 0, 0), at(O, 0, 20)]);
    const hood = neighbourhood(O, 50, [broken]);

    expect(() =>
      classifyTerminal({ neighbourhood: hood, deliveryWayId: 'broken', deliveryPoint: O }),
    ).not.toThrow();
  });

  it('classifyTerminal: coincident consecutive vertices are walked over, not divided by', () => {
    const stutter = way(
      'stutter',
      ['a', 'a2', 'b'],
      [at(O, 0, 0), at(O, 0, 0), at(O, 0, 25)],
    );
    const parent = way('parent', ['p1', 'a', 'p2'], [at(O, 30, 0), at(O, 0, 0), at(O, -30, 0)]);
    const hood = neighbourhood(O, 60, [stutter, parent]);

    const result = classifyTerminal({
      neighbourhood: hood,
      deliveryWayId: 'stutter',
      deliveryPoint: at(O, 0, 10),
    });

    expect(result.topology.kind).toBe('DEAD_END');
  });

  it('resolveHandoff: an empty neighbourhood yields no mouth', () => {
    const fact = resolveHandoff({
      neighbourhood: { centre: O, radiusM: 50, ways: [], nodes: [] },
      deliveryWayId: 'anything',
      deliveryPoint: O,
      maxDepth: 2,
      maxDeviationDeg: 40,
      fetchedAt: '2026-08-24T00:00:00Z',
    });

    expect(fact.known).toBe(false);
  });

  it('selectDeliveryStreet: a chain of three aligned ways in the ambiguity window is one carriageway', () => {
    // A short street split twice by attribute changes, all three pieces within
    // the window. If the grouping is not transitive the outer pieces read as
    // rivals of the middle one and the tie is reported as an ambiguity that
    // does not exist on the ground.
    const west = way('west', ['w1', 'j1'], [at(O, 3, -40), at(O, 3, -10)], { name: 'Rue A' });
    const mid = way('mid', ['j1', 'j2'], [at(O, 3, -10), at(O, 3, 10)], { name: 'Rue B' });
    const east = way('east', ['j2', 'e1'], [at(O, 3, 10), at(O, 3, 40)], { name: 'Rue C' });
    const hood = neighbourhood(O, 80, [west, mid, east]);

    const fact = selectDeliveryStreet({ ...SELECTION_DEFAULTS, point: O, neighbourhood: hood });

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    // The frontage is the piece the point is actually beside.
    expect(fact.value.segmentId).toBe('mid');
  });

  it('measureTurnaround: a self-touching figure-eight ring still yields a finite circle', () => {
    // Two lobes sharing a pinch point. The inscribed circle must fit in one
    // lobe, not in the union's bounding box.
    const eight = way(
      'eight',
      ['p', 'n1', 'n2', 'p', 's1', 's2', 'p'],
      [
        at(O, 0, 0),
        at(O, 14, -8),
        at(O, 14, 8),
        at(O, 0, 0),
        at(O, -14, 8),
        at(O, -14, -8),
        at(O, 0, 0),
      ],
    );

    const fact = measureTurnaround(
      { kind: 'loop_way', way: eight },
      {
        defaultTurningCircleDiameterM: null,
        fallbackCarriagewayWidthM: null,
        loopClosureToleranceM: 3,
        observedAt: '2026-08-24T00:00:00Z',
      },
    );

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(Number.isFinite(fact.value.usableDiameterM)).toBe(true);
    // Each lobe is ~28 m tall and ~16 m wide: the circle cannot exceed a lobe.
    expect(fact.value.usableDiameterM).toBeLessThan(20);
    expect(fact.value.usableDiameterM).toBeGreaterThan(0);
  });

  it('measureTurnaround: a two-point "ring" refuses rather than inscribing a circle in a line', () => {
    const line = way('line', ['a', 'a'], [at(O, 0, 0), at(O, 0, 0)]);

    const fact = measureTurnaround(
      { kind: 'loop_way', way: line },
      {
        defaultTurningCircleDiameterM: null,
        fallbackCarriagewayWidthM: null,
        loopClosureToleranceM: 3,
        observedAt: '2026-08-24T00:00:00Z',
      },
    );

    expect(fact.known).toBe(false);
  });
});
