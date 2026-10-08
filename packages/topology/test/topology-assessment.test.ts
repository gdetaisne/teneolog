/**
 * The assembled S1 stage, end to end on fixtures.
 *
 * The composition trap this guards: `classifyTerminal` names shapes with an
 * unmeasured turnaround, and only the assembler injects the measurement. If
 * that seam breaks, the engine's original defect — a loop detected, never
 * sized, waved through — comes back wearing new types.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import { preferredMappedTurnaroundAt } from '../src/egress-candidates.js';
import { assessTopology, type TopologyAssessmentInput } from '../src/topology-assessment.js';
import { at, sevremoine, neighbourhood, tagged, way } from './fixtures.js';

// 15 Impasse Voisine TR, 17220 Saint-Vivien (EC-17).
const O: GeoPoint = { lat: 46.075556, lon: -1.011659 };

function input(
  overrides: Pick<TopologyAssessmentInput, 'neighbourhood'> & Partial<TopologyAssessmentInput>,
): TopologyAssessmentInput {
  return {
    surfaces: [],
    deliveryWayId: 'impasse',
    deliveryPoint: O,
    turnaroundSearchRadiusM: 120,
    maxMouthDepth: 2,
    maxDeviationDeg: 40,
    barrierSnapM: 6,
    measurement: {
      defaultTurningCircleDiameterM: null,
      fallbackCarriagewayWidthM: null,
      loopClosureToleranceM: 3,
      observedAt: '2026-08-24T00:00:00Z',
    },
    ...overrides,
  };
}

/** Impasse east of the parent street, stop at the origin, cross at p1. */
function baseWays(widthM: number | null = 5) {
  const impasse = { ...way('impasse', ['mouth', 'tip'], [at(O, 0, -15), at(O, 0, 30)]), declaredWidthM: widthM };
  const parent = way('parent', ['p1', 'mouth', 'p2'], [at(O, 40, -15), at(O, 0, -15), at(O, -40, -15)]);
  const cross = way('cross', ['c1', 'p1', 'c2'], [at(O, 40, -45), at(O, 40, -15), at(O, 40, 15)]);
  return [impasse, parent, cross];
}

describe('assessTopology', () => {
  it('EC-17: a dead end with no street furniture gets the carriageway reversal as its measured turnaround', () => {
    const hood = neighbourhood(O, 100, baseWays(5));

    const result = assessTopology(input({ neighbourhood: hood }));

    expect(result.topology.kind).toBe('DEAD_END');
    if (result.topology.kind !== 'DEAD_END') return;
    // The seam: the shape arrived unmeasured, the assembler injected the floor
    // measurement. A 5 m carriageway is the whole turnaround this address has.
    expect(result.topology.turnaround.known).toBe(true);
    if (!result.topology.turnaround.known) return;
    expect(result.topology.turnaround.value.surface).toBe('carriageway');
    expect(result.topology.turnaround.value.usableDiameterM).toBe(5);
    // The mouth resolved alongside it.
    expect(result.handoff.known).toBe(true);
    if (!result.handoff.known) return;
    expect(result.handoff.value.parentSegmentId).toBe('parent');
  });

  it('a turning_loop node nearby is the place; the 5 m carriageway is not', () => {
    const stub = way('stub', ['mid', 'loop'], [at(O, 0, 10), at(O, 8, 56)]);
    const hood = neighbourhood(O, 150, [...baseWays(5), stub]);
    const tagged = {
      ...hood,
      nodes: hood.nodes.map((n) =>
        n.id === 'loop' ? { ...n, tags: { highway: 'turning_loop' } } : n,
      ),
    };

    const result = assessTopology(input({ neighbourhood: tagged }));

    expect(result.topology.kind).toBe('DEAD_END');
    if (result.topology.kind !== 'DEAD_END') return;
    expect(result.topology.turnaround.known).toBe(false);
    const place = result.egressCandidates.known
      ? result.egressCandidates.value.find((c) => c.kind === 'turning_loop')
      : undefined;
    expect(place?.at).toEqual(at(O, 8, 56));
  });

  it('EC-17: with no declared width and a null policy fallback, the turnaround stays honestly unknown', () => {
    const hood = neighbourhood(O, 100, baseWays(null));

    const result = assessTopology(input({ neighbourhood: hood }));

    expect(result.topology.kind).toBe('DEAD_END');
    if (result.topology.kind !== 'DEAD_END') return;
    expect(result.topology.turnaround.known).toBe(false);
  });

  it('EC-18: a terminal loop gets its ring measured, not its tag believed', () => {
    const impasse = way('impasse', ['mouth', 'tip'], [at(O, 0, -15), at(O, 0, 30)]);
    // A generous bulb ~30 m across, tagged or not — the ring geometry decides.
    const bulb = way(
      'bulb',
      ['tip', 'b1', 'b2', 'b3', 'tip'],
      [at(O, 0, 30), at(O, 16, 46), at(O, 0, 62), at(O, -16, 46), at(O, 0, 30)],
      { tags: { junction: 'turning_loop' } },
    );
    const parent = way('parent', ['p1', 'mouth', 'p2'], [at(O, 40, -15), at(O, 0, -15), at(O, -40, -15)]);
    const cross = way('cross', ['c1', 'p1', 'c2'], [at(O, 40, -45), at(O, 40, -15), at(O, 40, 15)]);
    const hood = neighbourhood(O, 150, [impasse, bulb, parent, cross]);

    const result = assessTopology(input({ neighbourhood: hood }));

    expect(result.topology.kind).toBe('TERMINAL_LOOP');
    if (result.topology.kind !== 'TERMINAL_LOOP') return;
    expect(result.topology.turnaround.known).toBe(true);
    if (!result.topology.turnaround.known) return;
    expect(result.topology.turnaround.value.surface).toBe('loop');
    // Measured from the ring, and plainly finite: the trap was a tag standing
    // in for a size, and EC-17's too-small circle passing as adequate.
    expect(result.topology.turnaround.value.usableDiameterM).toBeGreaterThan(5);
    expect(result.topology.turnaround.value.usableDiameterM).toBeLessThan(40);
  });

  it('A7: a plain bollard on the delivery way surfaces as an impassable barrier', () => {
    const ways = baseWays(5);
    const hood = neighbourhood(O, 100, ways);
    // A surveyed bollard mid-way along the impasse.
    const withBollard = {
      ...hood,
      nodes: [
        ...hood.nodes,
        { id: 'bollard-1', at: at(O, 0, 10), wayIds: ['impasse'], tags: { barrier: 'bollard' } },
      ],
    };

    const result = assessTopology(input({ neighbourhood: withBollard }));

    expect(result.barriers).toHaveLength(1);
    const barrier = result.barriers[0];
    expect(barrier?.known).toBe(true);
    if (barrier === undefined || !barrier.known) return;
    expect(barrier.value.kind).toBe('bollard');
    expect(barrier.value.passable).toBe('no');
  });

  it('A7: a rising bollard is conditional, and a gate with no access statement is unknown — never assumed open', () => {
    const hood = neighbourhood(O, 100, baseWays(5));
    const withFurniture = {
      ...hood,
      nodes: [
        ...hood.nodes,
        {
          id: 'post',
          at: at(O, 0, 5),
          wayIds: ['impasse'],
          tags: { barrier: 'bollard', bollard: 'rising' },
        },
        { id: 'gate', at: at(O, 0, 20), wayIds: ['impasse'], tags: { barrier: 'gate' } },
      ],
    };

    const result = assessTopology(input({ neighbourhood: withFurniture }));

    const kinds = result.barriers
      .filter((b): b is typeof b & { known: true } => b.known)
      .map((b) => `${b.value.kind}:${b.value.passable}`)
      .sort();
    expect(kinds).toEqual(['gate:unknown', 'retractable_post:conditional']);
  });

  it('a barrier on another street does not attach to this one', () => {
    const hood = neighbourhood(O, 100, baseWays(5));
    const withRemote = {
      ...hood,
      nodes: [
        ...hood.nodes,
        { id: 'far-bollard', at: at(O, 60, 60), wayIds: [], tags: { barrier: 'bollard' } },
      ],
    };

    const result = assessTopology(input({ neighbourhood: withRemote }));

    expect(result.barriers).toHaveLength(0);
  });

  it('the egress candidates ride along, wrapped as a fact', () => {
    const hood = neighbourhood(O, 100, baseWays(5));

    const result = assessTopology(input({ neighbourhood: hood }));

    expect(result.egressCandidates.known).toBe(true);
    if (!result.egressCandidates.known) return;
    // At minimum the on-street reversal is enumerated.
    expect(result.egressCandidates.value.length).toBeGreaterThanOrEqual(1);
  });

  it('a delivery way absent from the payload leaves every part honestly unknown', () => {
    const hood = neighbourhood(O, 100, [way('other', ['a', 'b'], [at(O, 30, 0), at(O, -30, 0)])]);

    const result = assessTopology(input({ neighbourhood: hood }));

    expect(result.topology.kind).toBe('DEAD_END');
    if (result.topology.kind !== 'DEAD_END') return;
    expect(result.topology.turnaround.known).toBe(false);
    expect(result.handoff.known).toBe(false);
    expect(result.egressCandidates.known).toBe(false);
    expect(result.terminalNodeInterior).toBe(false);
    expect(result.resolvedWithinM).toBe(0);
  });
});

describe('the retained turnaround is a place of THIS impasse', () => {
  const G: GeoPoint = { lat: 47.125714, lon: -0.946111 };

  it('a dimensioned circle on the next street is not this impasse\'s turnaround', () => {
    const hood = tagged(neighbourhood(G, 150, sevremoine(G)), {
      loopIn: { highway: 'turning_loop' },
      loopOut: { highway: 'turning_loop', 'turning_circle:diameter': '30' },
    });

    const result = assessTopology(input({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: G }));

    expect(result.topology.kind).toBe('DEAD_END');
    if (result.topology.kind !== 'DEAD_END') return;
    // The 30 m loop flies 45 m from the stop and would have been taken by
    // radius; it is reached only through the mouth, so the honest answer is
    // the stub loop, unmeasured.
    expect(result.topology.turnaround.known).toBe(false);
    expect(result.handoff.known).toBe(true);
  });

  it('a dimensioned loop at the end of the allée is taken, at its own centre', () => {
    const hood = tagged(neighbourhood(G, 150, sevremoine(G)), {
      loopIn: { highway: 'turning_loop', 'turning_circle:diameter': '20' },
      loopOut: { highway: 'turning_loop', 'turning_circle:diameter': '30' },
    });

    const result = assessTopology(input({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: G }));

    if (result.topology.kind !== 'DEAD_END') throw new Error('expected a dead end');
    expect(result.topology.turnaround.known).toBe(true);
    if (!result.topology.turnaround.known) return;
    expect(result.topology.turnaround.value.usableDiameterM).toBe(20);
    expect(result.topology.turnaround.value.centre).toEqual(at(G, -45, 10));
  });

  it('the point and the judgement name the same node: the retained centre is the preferred position', () => {
    const hood = tagged(neighbourhood(G, 150, sevremoine(G)), {
      loopIn: { highway: 'turning_loop', 'turning_circle:diameter': '20' },
      loopOut: { highway: 'turning_loop', 'turning_circle:diameter': '30' },
    });

    const result = assessTopology(input({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: G }));

    if (result.topology.kind !== 'DEAD_END' || !result.topology.turnaround.known) throw new Error('expected a measured dead end');
    expect(preferredMappedTurnaroundAt(result.egressCandidates)).toEqual(result.topology.turnaround.value.centre);
  });

  it('a mapped node reached only through the mouth measures nothing AND, as before, still ends the search: the ring is not read', () => {
    // A terminal loop whose own ring is tiny, and a neighbour's circle only
    // reachable through the mouth. HEAD stopped at the neighbour (unknown);
    // reading the ring here would turn that HUMAIN into a measured NON, which
    // is slice 2's A/B, not slice 1's.
    const loop = way('loop', ['tip', 'l1', 'l2', 'tip'], [at(G, 0, 40), at(G, 5, 45), at(G, -5, 45), at(G, 0, 40)]);
    const hood = tagged(neighbourhood(G, 150, [...sevremoine(G), loop]), { loopOut: { highway: 'turning_circle' } });

    const result = assessTopology(input({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: G }));

    expect(result.topology.kind).toBe('TERMINAL_LOOP');
    if (result.topology.kind !== 'TERMINAL_LOOP') return;
    expect(result.topology.turnaround.known).toBe(false);
    expect(preferredMappedTurnaroundAt(result.egressCandidates)).toBeUndefined();
  });

  it('the only mapped place in reach is the next street\'s dimensioned circle: unknown, tags unread, point at the stop', () => {
    // HEAD read the 30 m and answered OK for an impasse the circle does not
    // belong to. This is the écart au principe 17 validated on 2026-09-24:
    // a false OK becomes a question.
    const hood = tagged(neighbourhood(G, 150, sevremoine(G)), {
      loopOut: { highway: 'turning_circle', 'turning_circle:diameter': '30' },
    });

    const result = assessTopology(input({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: G }));

    if (result.topology.kind !== 'DEAD_END') throw new Error('expected a dead end');
    expect(result.topology.turnaround.known).toBe(false);
    expect(preferredMappedTurnaroundAt(result.egressCandidates)).toBeUndefined();
  });

  it('named move, HUMAIN → OK: the allée\'s own 30 m circle beats the neighbour\'s 20 m one that came first in the list', () => {
    // HEAD retained the neighbour's 20 m (first in the list): HUMAIN, a
    // declared width cannot refuse. The allée's own circle is the right
    // measurement; that it reads OK is the second case of the écart.
    const hood = tagged(neighbourhood(G, 150, sevremoine(G)), {
      loopIn: { highway: 'turning_loop', 'turning_circle:diameter': '30' },
      loopOut: { highway: 'turning_loop', 'turning_circle:diameter': '20' },
    });

    const result = assessTopology(input({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: G }));

    if (result.topology.kind !== 'DEAD_END' || !result.topology.turnaround.known) throw new Error('expected a measured dead end');
    expect(result.topology.turnaround.value.usableDiameterM).toBe(30);
  });

  it('named move, two dimensioned circles of the same impasse: the nearer by road, not the first in the list', () => {
    // A second stub off `j`, 20 m north, ends at `loopNear` (30 m by road),
    // listed AFTER `loopIn` (55 m by road). HEAD took the first in the list.
    const near = way('stub2', ['j', 'loopNear'], [at(G, 0, 10), at(G, 20, 10)], { tags: { highway: 'service' } });
    const hood = tagged(neighbourhood(G, 150, [...sevremoine(G), near]), {
      loopIn: { highway: 'turning_loop', 'turning_circle:diameter': '30' },
      loopNear: { highway: 'turning_loop', 'turning_circle:diameter': '20' },
    });

    const result = assessTopology(input({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: G }));

    if (result.topology.kind !== 'DEAD_END' || !result.topology.turnaround.known) throw new Error('expected a measured dead end');
    expect(result.topology.turnaround.value.usableDiameterM).toBe(20);
    expect(result.topology.turnaround.value.centre).toEqual(at(G, 20, 10));
  });
});
