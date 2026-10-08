/**
 * Reach by road. The trap it closes: two loops, the nearer as the
 * crow flies and the first in the list belonging to the NEXT street — the
 * list order picked it at Sèvremoine (run bf60317d), and a radius would too.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import { computeRoadReach, reachOf, roadDistanceOf } from '../src/reach.js';
import { at, sevremoine, neighbourhood, way } from './fixtures.js';

const O: GeoPoint = { lat: 47.125714, lon: -0.946111 };

describe('computeRoadReach', () => {
  it('measures by road, not as the crow flies', () => {
    const hood = neighbourhood(O, 150, sevremoine(O));

    const reach = computeRoadReach({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: O, mouth: null, maxDistanceM: 480 });

    // stop → j 10 m, j → loopIn 45 m.
    expect(roadDistanceOf(reach, 'loopIn')).toBeCloseTo(55, 0);
    // stop → mouth 20 m, mouth → q 40 m, q → loopOut 40 m.
    expect(roadDistanceOf(reach, 'loopOut')).toBeCloseTo(100, 0);
    expect(roadDistanceOf(reach, 'tip')).toBeCloseTo(40, 0);
  });

  it('with the mouth, the stub loop is inside and the next street\'s loop is via the mouth', () => {
    const hood = neighbourhood(O, 150, sevremoine(O));

    const reach = computeRoadReach({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: O, mouth: at(O, 0, -20), maxDistanceM: 480 });

    expect(reachOf(reach, 'loopIn')).toBe('inside');
    expect(reachOf(reach, 'tip')).toBe('inside');
    expect(reachOf(reach, 'mouth')).toBe('inside');
    expect(reachOf(reach, 'loopOut')).toBe('via_mouth');
    expect(reachOf(reach, 'p1')).toBe('via_mouth');
  });

  it('without a mouth nothing is inside or outside: every reached node is unknown', () => {
    const hood = neighbourhood(O, 150, sevremoine(O));

    const reach = computeRoadReach({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: O, mouth: null, maxDistanceM: 480 });

    expect(reach.why).toBe('no_mouth');
    expect(reachOf(reach, 'loopIn')).toBe('unknown');
    expect(reachOf(reach, 'loopOut')).toBe('unknown');
  });

  it('a node only a footway reaches has no road distance', () => {
    const path = way('path', ['tip', 'bench'], [at(O, 0, 40), at(O, 20, 40)], { tags: { highway: 'footway' } });
    const hood = neighbourhood(O, 150, [...sevremoine(O), path]);

    const reach = computeRoadReach({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: O, mouth: at(O, 0, -20), maxDistanceM: 480 });

    expect(roadDistanceOf(reach, 'bench')).toBeNull();
    expect(reachOf(reach, 'bench')).toBe('unknown');
  });

  it('a delivery way that carries on past the mouth does not leak its far side inside', () => {
    // The allée is one OSM way through the junction: `far` lies beyond the
    // mouth, and a loop hangs off it. Without cutting the seeds at the mouth,
    // `loopFar` would be reached from `far` without ever crossing the mouth.
    const allee = way('allee', ['far', 'mouth', 'j', 'tip'], [at(O, 0, -80), at(O, 0, -20), at(O, 0, 10), at(O, 0, 40)]);
    const farStub = way('farStub', ['far', 'loopFar'], [at(O, 0, -80), at(O, -20, -80)], { tags: { highway: 'service' } });
    const parent = way('parent', ['p1', 'mouth', 'p2'], [at(O, 200, -20), at(O, 0, -20), at(O, -200, -20)]);
    const hood = neighbourhood(O, 150, [allee, farStub, parent]);

    const reach = computeRoadReach({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: O, mouth: at(O, 0, -20), maxDistanceM: 480 });

    expect(reachOf(reach, 'tip')).toBe('inside');
    expect(reachOf(reach, 'far')).toBe('via_mouth');
    expect(reachOf(reach, 'loopFar')).toBe('via_mouth');
    expect(roadDistanceOf(reach, 'loopFar')).toBeCloseTo(100, 0);
  });

  it('beyond the bound, nothing is walked', () => {
    const hood = neighbourhood(O, 150, sevremoine(O));

    const reach = computeRoadReach({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: O, mouth: at(O, 0, -20), maxDistanceM: 60 });

    expect(roadDistanceOf(reach, 'loopIn')).toBeCloseTo(55, 0);
    expect(roadDistanceOf(reach, 'loopOut')).toBeNull();
  });

  it('a mouth that matches no graph node leaves every reach unknown, and says why', () => {
    const hood = neighbourhood(O, 150, sevremoine(O));

    const reach = computeRoadReach({ neighbourhood: hood, deliveryWayId: 'allee', deliveryPoint: O, mouth: at(O, 7, -20), maxDistanceM: 480 });

    expect(reach.why).toBe('no_mouth');
    expect(reachOf(reach, 'loopOut')).toBe('unknown');
  });
});
