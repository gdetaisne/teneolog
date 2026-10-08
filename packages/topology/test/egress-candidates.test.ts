/**
 * Egress-candidate enumeration against the corpus.
 *
 * The traps: an on-site U-turn proposed silently instead of measured
 * (BUG-001), a long thin car park passing an area gate (TAF-01), a parking
 * node with no polygon acquiring a size (TAF-02), and private ground filtered
 * out instead of labelled (Q4).
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import { findEgressCandidates, preferredMappedTurnaroundAt, type EgressSearchInput } from '../src/egress-candidates.js';
import { haversineM, pointInPolygon } from '../src/geometry.js';
import type { Surface } from '../src/ports.js';
import { measureTurnaround } from '../src/turnaround.js';
import { at, sevremoine, neighbourhood, tagged, way } from './fixtures.js';

// 10 allée Voisine LM, 36330 Le Poinçonnet (EC-18 / EC-01).
const O: GeoPoint = { lat: 46.773049, lon: 1.7491 };

function search(
  overrides: Pick<EgressSearchInput, 'neighbourhood' | 'surfaces'> & Partial<EgressSearchInput>,
): EgressSearchInput {
  return {
    deliveryWayId: 'street',
    deliveryPoint: O,
    searchRadiusM: 120,
    measurement: {
      defaultTurningCircleDiameterM: null,
      fallbackCarriagewayWidthM: null,
      loopClosureToleranceM: 3,
      observedAt: '2026-08-24T00:00:00Z',
    },
    ...overrides,
  };
}

/** The delivery street: mouth 20 m west of the stop, tip 40 m east. */
function deliveryStreet(widthM: number | null = 5) {
  const w = way('street', ['mouth', 'tip'], [at(O, 0, -20), at(O, 0, 40)]);
  return { ...w, declaredWidthM: widthM };
}

describe('findEgressCandidates', () => {
  it('BUG-001: the on-site reversal is always enumerated as a measured candidate, never proposed silently', () => {
    const hood = neighbourhood(O, 150, [deliveryStreet(5)]);

    const fact = findEgressCandidates(search({ neighbourhood: hood, surfaces: [] }));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    const reversal = fact.value.find((c) => c.kind === 'junction');
    expect(reversal).toBeDefined();
    if (reversal === undefined) return;
    // Its diameter is the carriageway width — the number S5 will reject a 19 t
    // on. The manoeuvre is in the answer as a measurement, not as a route.
    expect(reversal.geometry.known).toBe(true);
    if (!reversal.geometry.known) return;
    expect(reversal.geometry.value.usableDiameterM).toBe(5);
    expect(reversal.geometry.value.occupancy).toBe('unassessed');
  });

  it('a street with no declared width and a null policy fallback yields an unknown reversal, not a guessed one', () => {
    const hood = neighbourhood(O, 150, [deliveryStreet(null)]);

    const fact = findEgressCandidates(search({ neighbourhood: hood, surfaces: [] }));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    const reversal = fact.value.find((c) => c.kind === 'junction');
    expect(reversal?.geometry.known).toBe(false);
  });

  it('TAF-01: a long thin car park is sized by its inscribed circle, not its area', () => {
    // 100 m x 6 m = 600 m² — clears any area gate, swings nothing.
    const strip: Surface = {
      id: 'strip',
      kind: 'parking',
      polygon: [at(O, 3, -50), at(O, 3, 50), at(O, 9, 50), at(O, 9, -50)],
      isPrivate: false,
      source: 'osm-overpass',
    };
    const hood = neighbourhood(O, 150, [deliveryStreet()]);

    const fact = findEgressCandidates(search({ neighbourhood: hood, surfaces: [strip] }));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    const parking = fact.value.find((c) => c.kind === 'parking');
    expect(parking?.geometry.known).toBe(true);
    if (parking === undefined || !parking.geometry.known) return;
    expect(parking.geometry.value.areaM2).toBeGreaterThan(500);
    // The usable circle is bounded by the 6 m width, whatever the area says.
    expect(parking.geometry.value.usableDiameterM).toBeLessThan(8);
  });

  it('Q4: private ground is enumerated and labelled, never filtered', () => {
    const parvis: Surface = {
      id: 'parvis',
      kind: 'square',
      polygon: [at(O, 20, 10), at(O, 20, 40), at(O, 50, 40), at(O, 50, 10)],
      isPrivate: true,
      source: 'osm-overpass',
    };
    const hood = neighbourhood(O, 150, [deliveryStreet()]);

    const fact = findEgressCandidates(search({ neighbourhood: hood, surfaces: [parvis] }));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    const square = fact.value.find((c) => c.kind === 'square');
    expect(square).toBeDefined();
    expect(square?.ground).toBe('private');
  });

  it('B5: a candidate past the stop, deeper into the dead end, carries beyondStop', () => {
    const hood = neighbourhood(O, 150, [deliveryStreet()]);
    // The stop is at alongM 20 of a 60 m way whose tip is east. A surface
    // near the tip is beyond; one near the mouth is not.
    const nearTip: Surface = {
      id: 'near-tip',
      kind: 'parking',
      polygon: [at(O, 3, 30), at(O, 3, 38), at(O, 11, 38), at(O, 11, 30)],
      isPrivate: false,
      source: 'osm-overpass',
    };
    const nearMouth: Surface = {
      id: 'near-mouth',
      kind: 'parking',
      polygon: [at(O, 3, -18), at(O, 3, -10), at(O, 11, -10), at(O, 11, -18)],
      isPrivate: false,
      source: 'osm-overpass',
    };

    const fact = findEgressCandidates(
      search({ neighbourhood: hood, surfaces: [nearTip, nearMouth] }),
    );

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    const tipSide = fact.value.find((c) => c.kind === 'parking' && c.at.lon > O.lon);
    const mouthSide = fact.value.find((c) => c.kind === 'parking' && c.at.lon < O.lon);
    expect(tipSide?.beyondStop).toBe(true);
    expect(mouthSide?.beyondStop).toBe(false);
  });

  it('a candidate outside the search radius is not reported', () => {
    const far: Surface = {
      id: 'far',
      kind: 'parking',
      polygon: [at(O, 300, 0), at(O, 300, 30), at(O, 330, 30), at(O, 330, 0)],
      isPrivate: false,
      source: 'osm-overpass',
    };
    const hood = neighbourhood(O, 500, [deliveryStreet()]);

    const fact = findEgressCandidates(search({ neighbourhood: hood, surfaces: [far] }));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.some((c) => c.kind === 'parking')).toBe(false);
  });

  it('a delivery way absent from the payload cannot be searched: known false, not an empty success', () => {
    const hood = neighbourhood(O, 150, [way('other', ['a', 'b'], [at(O, 30, 0), at(O, -30, 0)])]);

    const fact = findEgressCandidates(search({ neighbourhood: hood, surfaces: [] }));

    expect(fact.known).toBe(false);
  });

  it('EC-18: a turning loop touching the search area is enumerated with its measured ring', () => {
    const loop = way(
      'loop',
      ['tip', 'l1', 'l2', 'tip'],
      [at(O, 0, 40), at(O, 12, 52), at(O, -12, 52), at(O, 0, 40)],
      { tags: { junction: 'turning_loop' } },
    );
    const hood = neighbourhood(O, 150, [deliveryStreet(), loop]);

    const fact = findEgressCandidates(search({ neighbourhood: hood, surfaces: [] }));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    const found = fact.value.find((c) => c.kind === 'turning_loop');
    expect(found).toBeDefined();
    if (found === undefined) return;
    expect(found.geometry.known).toBe(true);
    expect(found.beyondStop).toBe(true);
  });

  it('the centre the diameter was measured on travels with the candidate — not its first vertex', () => {
    const loop = way(
      'loop',
      ['tip', 'l1', 'l2', 'tip'],
      [at(O, 0, 40), at(O, 12, 52), at(O, -12, 52), at(O, 0, 40)],
      { tags: { junction: 'turning_loop' } },
    );
    const strip: Surface = {
      id: 'strip',
      kind: 'parking',
      polygon: [at(O, 3, -50), at(O, 3, 50), at(O, 9, 50), at(O, 9, -50)],
      isPrivate: false,
      source: 'osm-overpass',
    };
    const input = search({ neighbourhood: neighbourhood(O, 150, [deliveryStreet(), loop]), surfaces: [strip] });

    const fact = findEgressCandidates(input);

    if (!fact.known) throw new Error('expected candidates');
    const ring = fact.value.find((c) => c.id === 'way:loop');
    const park = fact.value.find((c) => c.id === 'surface:strip');
    if (!ring?.geometry.known || !park?.geometry.known) throw new Error('expected two measured places');
    // One source: the measurement's own centre, carried as it is.
    const measured = measureTurnaround({ kind: 'loop_way', way: loop }, input.measurement);
    if (!measured.known) throw new Error('expected a measured ring');
    expect(ring.geometry.value.centre).toEqual(measured.value.centre);
    // `at` is the ring's first vertex; the circle is inside it, metres away.
    expect(haversineM(ring.at, ring.geometry.value.centre ?? ring.at)).toBeGreaterThan(5);
    expect(pointInPolygon(ring.geometry.value.centre ?? ring.at, loop.geometry)).toBe(true);
    expect(pointInPolygon(park.geometry.value.centre ?? park.at, strip.polygon)).toBe(true);
  });

  it('a highway=turning_loop node is a place, not the carriageway at the stop', () => {
    const stub = way('stub', ['mid', 'loop'], [at(O, 0, 20), at(O, 8, 56)]);
    const hood = neighbourhood(O, 150, [deliveryStreet(), stub]);
    const tagged = {
      ...hood,
      nodes: hood.nodes.map((n) =>
        n.id === 'loop' ? { ...n, tags: { highway: 'turning_loop' } } : n,
      ),
    };

    const fact = findEgressCandidates(search({ neighbourhood: tagged, surfaces: [] }));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    const found = fact.value.find((c) => c.kind === 'turning_loop');
    expect(found?.at).toEqual(at(O, 8, 56));
    expect(found?.geometry.known).toBe(false);
  });
});

describe('the place of THIS impasse, nearest by road', () => {
  // 7 Allée des Essais (run bf60317d): the next street's loop came
  // first in the list and is the nearer as the crow flies; HEAD took it.
  const G: GeoPoint = { lat: 47.125714, lon: -0.946111 };
  const loops = { loopIn: { highway: 'turning_loop' }, loopOut: { highway: 'turning_loop' } };

  function sevremoineSearch(mouth: GeoPoint | null) {
    return search({
      neighbourhood: tagged(neighbourhood(G, 150, sevremoine(G)), loops),
      surfaces: [],
      deliveryWayId: 'allee',
      deliveryPoint: G,
      mouth,
    });
  }

  it('the stub loop is inside and first; the next street\'s loop is via the mouth and after', () => {
    const fact = findEgressCandidates(sevremoineSearch(at(G, 0, -20)));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    const inside = fact.value.find((c) => c.id === 'node:loopIn');
    const outside = fact.value.find((c) => c.id === 'node:loopOut');
    expect(inside?.reach).toBe('inside');
    expect(inside?.roadDistanceFromStopM).toBeCloseTo(55, 0);
    expect(outside?.reach).toBe('via_mouth');
    expect(outside?.roadDistanceFromStopM).toBeCloseTo(100, 0);
    expect(fact.value.map((c) => c.id).indexOf('node:loopIn')).toBeLessThan(
      fact.value.map((c) => c.id).indexOf('node:loopOut'),
    );
    expect(preferredMappedTurnaroundAt(fact)).toEqual(at(G, -45, 10));
  });

  it('a place reached only through the mouth never places the review point, even when it is the only mapped one', () => {
    const onlyOutside = tagged(neighbourhood(G, 150, sevremoine(G)), { loopOut: { highway: 'turning_loop' } });
    const fact = findEgressCandidates(
      search({ neighbourhood: onlyOutside, surfaces: [], deliveryWayId: 'allee', deliveryPoint: G, mouth: at(G, 0, -20) }),
    );

    expect(preferredMappedTurnaroundAt(fact)).toBeUndefined();
  });

  it('without a mouth, reach is unknown and the nearest BY ROAD comes first — not the nearest as the crow flies', () => {
    const fact = findEgressCandidates(sevremoineSearch(null));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    const mapped = fact.value.filter((c) => c.kind === 'turning_loop');
    // loopOut flies 45 m, loopIn 46 m; by road they are 100 m and 55 m.
    expect(mapped.map((c) => c.id)).toEqual(['node:loopIn', 'node:loopOut']);
    expect(mapped.every((c) => c.reach === 'unknown')).toBe(true);
  });

  it('a circle the road does not reach ranks after every place it does', () => {
    const path = way('path', ['tip', 'bench'], [at(G, 0, 40), at(G, 20, 40)], { tags: { highway: 'footway' } });
    const hood = tagged(neighbourhood(G, 150, [...sevremoine(G), path]), {
      ...loops,
      bench: { highway: 'turning_circle' },
    });
    const fact = findEgressCandidates(
      search({ neighbourhood: hood, surfaces: [], deliveryWayId: 'allee', deliveryPoint: G, mouth: null }),
    );

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    const ids = fact.value.map((c) => c.id);
    // The bench flies 45 m, nearer than loopIn — and is not on any carriageway.
    expect(ids.indexOf('node:bench')).toBeGreaterThan(ids.indexOf('node:loopOut'));
    expect(preferredMappedTurnaroundAt(fact)).toEqual(at(G, -45, 10));
  });

  it('on a through street the walk is off: every reach unknown, no road distance', () => {
    const fact = findEgressCandidates({ ...sevremoineSearch(null), reachEnabled: false });

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.filter((c) => c.kind === 'turning_loop').every((c) => c.reach === 'unknown' && c.roadDistanceFromStopM === null)).toBe(true);
  });

  it('the on-street reversal ranks last whatever its distance', () => {
    const fact = findEgressCandidates(sevremoineSearch(at(G, 0, -20)));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value[fact.value.length - 1]?.id).toBe('stop:carriageway');
  });
});
