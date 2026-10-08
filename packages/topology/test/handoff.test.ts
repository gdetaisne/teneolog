/**
 * Handoff resolution against the field corpus.
 *
 * The mouth is where the truck rejoins a street that goes somewhere. The traps
 * these fixtures reproduce: an attribute break mistaken for the junction
 * (BUG-037a), a footway dressing a tip up as a junction (EC-24), an unbounded
 * recursive walk (A5), and crow-flies distance where the road curves.
 *
 * Fixture discipline: a parent street must be seen to go somewhere — a cross
 * street at one end, or geometry leaving the fetch. A miniature "parent" closed
 * at both interior tips is a pocket, and the module rightly refuses to hand off
 * onto a street that leads nowhere. Early drafts of these fixtures fell into
 * exactly that trap.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import { resolveHandoff, type HandoffInput } from '../src/handoff.js';
import { at, neighbourhood, way } from './fixtures.js';

// Impasse Voisine SC, 85250 Saint-Fulgent (EC-24).
const SAINT_FULGENT: GeoPoint = { lat: 46.856414, lon: -1.145828 };
// 8 Rue du Prototype, 92140 Clamart (BUG-037a).
const CLAMART: GeoPoint = { lat: 48.80236, lon: 2.30104 };

function input(
  overrides: Pick<HandoffInput, 'neighbourhood' | 'deliveryWayId' | 'deliveryPoint'> &
    Partial<HandoffInput>,
): HandoffInput {
  return {
    maxDepth: 2,
    maxDeviationDeg: 40,
    fetchedAt: '2026-08-24T00:00:00Z',
    ...overrides,
  };
}

describe('resolveHandoff', () => {
  it('EC-24: a plain impasse hands off at its junction with the parent street, at depth 0', () => {
    const o = SAINT_FULGENT;
    const impasse = way('impasse', ['mouth', 'tip'], [at(o, 0, -10), at(o, 0, 30)]);
    const parent = way(
      'parent',
      ['p1', 'mouth', 'p2'],
      [at(o, 40, -10), at(o, 0, -10), at(o, -40, -10)],
    );
    // The parent is seen to reach a junction, so it provably goes somewhere.
    const cross = way('cross', ['c1', 'p1', 'c2'], [at(o, 40, -40), at(o, 40, -10), at(o, 40, 20)]);
    const hood = neighbourhood(o, 80, [impasse, parent, cross]);

    const fact = resolveHandoff(input({ neighbourhood: hood, deliveryWayId: 'impasse', deliveryPoint: o }));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.parentSegmentId).toBe('parent');
    expect(fact.value.depth).toBe(0);
    expect(fact.value.distanceFromStopM).toBeCloseTo(10, 0);
    expect(fact.reliability.confidence).toBe(1);
  });

  it('distance is measured along the road, not as the crow flies', () => {
    const o = SAINT_FULGENT;
    // An L-shaped impasse: 30 m east then 40 m north to the mouth. The road
    // distance is 70 m; the crow flies 50 m. A crow-flies answer under-reports
    // how far the parcel must travel and would pass a policy gate it should fail.
    const impasse = way(
      'impasse',
      ['tip', 'corner', 'mouth'],
      [o, at(o, 0, 30), at(o, 40, 30)],
    );
    const parent = way(
      'parent',
      ['p1', 'mouth', 'p2'],
      [at(o, 40, -10), at(o, 40, 30), at(o, 40, 70)],
    );
    const cross = way('cross', ['c1', 'p1', 'c2'], [at(o, 80, -10), at(o, 40, -10), at(o, 0, -10)]);
    const hood = neighbourhood(o, 120, [impasse, parent, cross]);

    const fact = resolveHandoff(input({ neighbourhood: hood, deliveryWayId: 'impasse', deliveryPoint: o }));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.distanceFromStopM).toBeGreaterThan(65);
    expect(fact.value.distanceFromStopM).toBeLessThan(75);
  });

  it('A5: a pocket between the impasse and the network is walked through, and the depth says so', () => {
    const o = SAINT_FULGENT;
    // The impasse opens onto a street that is itself closed at its far end — a
    // true pocket — but a through street crosses that pocket mid-length. The
    // mouth is at that mid-pocket junction: one nested street deep.
    const inner = way('inner', ['j1', 'tip'], [at(o, 0, -10), at(o, 0, 25)]);
    const pocket = way(
      'pocket',
      ['pocket-tip', 'j2', 'j1'],
      [at(o, 70, -10), at(o, 35, -10), at(o, 0, -10)],
    );
    const through = way(
      'through',
      ['t1', 'j2', 't2'],
      [at(o, 35, -60), at(o, 35, -10), at(o, 35, 40)],
    );
    const crossT = way('cross-t', ['x1', 't1', 'x2'], [at(o, 70, -60), at(o, 35, -60), at(o, 0, -60)]);
    const hood = neighbourhood(o, 120, [inner, pocket, through, crossT]);

    const fact = resolveHandoff(input({ neighbourhood: hood, deliveryWayId: 'inner', deliveryPoint: o }));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.parentSegmentId).toBe('through');
    expect(fact.value.depth).toBe(1);
    expect(fact.reliability.reasonCodes).toContain('mouth_through_nested_dead_end');
  });

  it('A5: the walk stops at maxDepth instead of drifting arbitrarily far from the address', () => {
    const o = SAINT_FULGENT;
    // Identical topology to the nested case: the mouth exists at depth 1, but
    // the budget forbids stepping into the pocket at all.
    const inner = way('inner', ['j1', 'tip'], [at(o, 0, -10), at(o, 0, 25)]);
    const pocket = way(
      'pocket',
      ['pocket-tip', 'j2', 'j1'],
      [at(o, 70, -10), at(o, 35, -10), at(o, 0, -10)],
    );
    const through = way(
      'through',
      ['t1', 'j2', 't2'],
      [at(o, 35, -60), at(o, 35, -10), at(o, 35, 40)],
    );
    const crossT = way('cross-t', ['x1', 't1', 'x2'], [at(o, 70, -60), at(o, 35, -60), at(o, 0, -60)]);
    const hood = neighbourhood(o, 120, [inner, pocket, through, crossT]);

    const fact = resolveHandoff(
      input({ neighbourhood: hood, deliveryWayId: 'inner', deliveryPoint: o, maxDepth: 0 }),
    );

    // Refusing to name a mouth is the correct answer under the budget — never
    // a mouth invented further out.
    expect(fact.known).toBe(false);
    if (fact.known) return;
    expect(fact.why).toBe('no_data');
  });

  it('BUG-037a: an attribute break on the delivery street is traversed, not mistaken for the mouth', () => {
    const o = CLAMART;
    // The dead-end street changes name mid-length (pvc → voisineT), then reaches
    // the real junction. The mouth must be at the junction with the through
    // street, and the distance must span BOTH halves.
    const half1 = way('pvc', ['tip', 'break'], [o, at(o, 0, 40)], {
      name: 'Rue du Prototype',
      importance: 5,
    });
    const half2 = way('voisineT', ['break', 'mouth'], [at(o, 0, 40), at(o, 0, 80)], {
      name: 'Rue Voisine T',
      importance: 4,
    });
    const through = way(
      'through',
      ['t1', 'mouth', 't2'],
      [at(o, 40, 80), at(o, 0, 80), at(o, -40, 80)],
    );
    const cross = way('cross', ['c1', 't1', 'c2'], [at(o, 40, 40), at(o, 40, 80), at(o, 40, 120)]);
    const hood = neighbourhood(o, 160, [half1, half2, through, cross]);

    const fact = resolveHandoff(input({ neighbourhood: hood, deliveryWayId: 'pvc', deliveryPoint: o }));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.parentSegmentId).toBe('through');
    // Depth 0: the break is the same street, not a nested dead end.
    expect(fact.value.depth).toBe(0);
    expect(fact.value.distanceFromStopM).toBeCloseTo(80, 0);
    expect(fact.reliability.reasonCodes).toContain('delivery_street_attribute_break_traversed');
  });

  it('EC-24: a footway at the tip neither makes a junction nor receives the handoff', () => {
    const o = SAINT_FULGENT;
    const impasse = way('impasse', ['mouth', 'tip'], [at(o, 0, -10), at(o, 0, 30)]);
    // A footpath continues from the tip — for pedestrians the impasse "goes
    // through", for the truck it does not.
    const footpath = way('footpath', ['tip', 'f1'], [at(o, 0, 30), at(o, 0, 60)], {
      tags: { highway: 'footway' },
    });
    const parent = way(
      'parent',
      ['p1', 'mouth', 'p2'],
      [at(o, 40, -10), at(o, 0, -10), at(o, -40, -10)],
    );
    const cross = way('cross', ['c1', 'p1', 'c2'], [at(o, 40, -40), at(o, 40, -10), at(o, 40, 20)]);
    const hood = neighbourhood(o, 100, [impasse, footpath, parent, cross]);

    const fact = resolveHandoff(input({ neighbourhood: hood, deliveryWayId: 'impasse', deliveryPoint: o }));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.parentSegmentId).toBe('parent');
  });

  it('a parent street only seen to leave the fetch is reported at degraded confidence', () => {
    const o = SAINT_FULGENT;
    const impasse = way('impasse', ['mouth', 'tip'], [at(o, 0, -10), at(o, 0, 30)]);
    // The parent runs to the fetch boundary in one direction and ends in a tip
    // in the other: its only evidence of going anywhere is that it left the view.
    const parent = way(
      'parent',
      ['p-closed', 'mouth', 'p-cut'],
      [at(o, 25, -10), at(o, 0, -10), at(o, -85, -10)],
    );
    const hood = neighbourhood(o, 80, [impasse, parent]);

    const fact = resolveHandoff(input({ neighbourhood: hood, deliveryWayId: 'impasse', deliveryPoint: o }));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.reliability.confidence).toBeLessThan(1);
    expect(fact.reliability.reasonCodes).toContain('parent_continuity_beyond_fetch');
  });

  it('a delivery way absent from the payload yields no mouth, never an invented one', () => {
    const o = SAINT_FULGENT;
    const other = way('other', ['a', 'b'], [at(o, 30, 0), at(o, -30, 0)]);
    const hood = neighbourhood(o, 80, [other]);

    const fact = resolveHandoff(input({ neighbourhood: hood, deliveryWayId: 'missing', deliveryPoint: o }));

    expect(fact.known).toBe(false);
  });

  it('a street whose every reachable branch is a pocket yields no mouth', () => {
    const o = SAINT_FULGENT;
    // The impasse meets only another closed stub: nothing in reach goes anywhere.
    const impasse = way('impasse', ['j', 'tip'], [at(o, 0, -10), at(o, 0, 30)]);
    const stub = way('stub', ['j', 'stub-tip'], [at(o, 0, -10), at(o, 30, -10)]);
    const hood = neighbourhood(o, 80, [impasse, stub]);

    const fact = resolveHandoff(
      input({ neighbourhood: hood, deliveryWayId: 'impasse', deliveryPoint: o, maxDepth: 0 }),
    );

    expect(fact.known).toBe(false);
  });
});
