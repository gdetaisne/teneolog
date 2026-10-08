/**
 * l'arrêt de repli : la rue d'avant, la distance à pied le long de
 * la voie, les deux bandes, et ce qui n'est pas une réponse.
 *
 * Le croquis est celui de la Sèvremoine (`fixtures.ts`) : l'allée part de la
 * bouche 20 m à l'ouest de l'arrêt ; la parente (Rue Voisine MA) la croise à
 * la bouche et file 200 m de chaque côté, au-delà du fetch.
 */
import { describe, expect, it } from 'vitest';
import type { Fact, GeoPoint, Mouth } from '@teneolog/domain';

import { computeFallbackStop, type FallbackStopInput } from '../src/fallback-stop.js';
import { haversineM } from '../src/geometry.js';
import { resolveHandoff, resolveHandoffWalk } from '../src/handoff.js';
import { handoffPathOf } from '../src/reversing.js';
import type { RoadNeighbourhood, RoadWay } from '../src/ports.js';
import { assessTopology } from '../src/topology-assessment.js';
import { at, sevremoine, neighbourhood, tagged, way } from './fixtures.js';

const O: GeoPoint = { lat: 47.125714, lon: -0.946111 };
const PARAMS = { plainWalkMaxM: 50, portageWalkMaxM: 150, stopOffsetM: 15 };
const FETCHED_AT = '2026-09-24T10:00:00Z';

function sevremoineHood(): RoadNeighbourhood {
  const [allee, parent, other, stub] = sevremoine(O) as [RoadWay, RoadWay, RoadWay, RoadWay];
  const voisineMa: RoadWay = { ...parent, name: 'Rue Voisine MA', declaredWidthM: 5.5 };
  return neighbourhood(O, 120, [allee, voisineMa, other, stub]);
}

function handoffOf(hood: RoadNeighbourhood, deliveryWayId = 'allee'): Fact<Mouth> {
  return resolveHandoff({
    neighbourhood: hood,
    deliveryWayId,
    deliveryPoint: O,
    maxDepth: 2,
    maxDeviationDeg: 40,
    fetchedAt: FETCHED_AT,
  });
}

function input(hood: RoadNeighbourhood, overrides: Partial<FallbackStopInput> = {}): FallbackStopInput {
  const walk = resolveHandoffWalk({
    neighbourhood: hood,
    deliveryWayId: 'allee',
    deliveryPoint: O,
    maxDepth: 2,
    maxDeviationDeg: 40,
    fetchedAt: FETCHED_AT,
  });
  return {
    neighbourhood: hood,
    deliveryWayId: 'allee',
    deliveryPoint: O,
    topologyKind: 'DEAD_END',
    handoff: handoffOf(hood),
    handoffPath: handoffPathOf(walk),
    params: PARAMS,
    barriersAlong: () => [],
    fetchedAt: FETCHED_AT,
    ...overrides,
  };
}

/** An impasse whose mouth sits `mouthWestM` west of the stop, on a parent running north–south. */
function longImpasse(mouthWestM: number): RoadNeighbourhood {
  const allee = way('allee', ['mouth', 'tip'], [at(O, 0, -mouthWestM), at(O, 0, 40)], {
    tags: { highway: 'residential' },
  });
  const parent = way(
    'parent',
    ['p1', 'mouth', 'p2'],
    [at(O, 300, -mouthWestM), at(O, 0, -mouthWestM), at(O, -300, -mouthWestM)],
    { name: 'Rue Amont', declaredWidthM: 6, tags: { highway: 'residential' } },
  );
  return neighbourhood(O, mouthWestM + 60, [allee, parent]);
}

describe('computeFallbackStop — Sèvremoine', () => {
  it('names Rue Voisine MA, 15 m before the junction, 35 m of walk along the road, band plain', () => {
    const hood = sevremoineHood();
    const fact = computeFallbackStop(input(hood));
    expect(fact.known).toBe(true);
    if (!fact.known) return;
    const { value } = fact;
    expect(value.street.name).toBe('Rue Voisine MA');
    expect(value.street.declaredWidthM).toBe(5.5);
    expect(value.street.highway).toBe('residential');
    expect(value.street.oneWay).toBe(false);
    // A = 15 m along the parent, B = 20 m along the allée (the handoff's own
    // number), C = 0 (the point sits on the axis).
    expect(value.walk.stopToMouthM).toBeCloseTo(15, 0);
    expect(value.walk.mouthToPointM).toBeCloseTo(20, 0);
    expect(value.walk.pointToAxisM).toBeCloseTo(0, 0);
    expect(value.walk.totalM).toBeCloseTo(35, 0);
    expect(value.band).toBe('plain');
    expect(value.bandsM).toEqual({ plainMaxM: 50, portageMaxM: 150 });
    // The stop is on the parent, 15 m from the mouth node, not on the node.
    expect(haversineM(value.stopAt, value.mouth)).toBeCloseTo(15, 0);
    expect(haversineM(value.stopAt, at(O, -15, -20))).toBeLessThan(0.5);
    expect(value.depth).toBe(0);
  });

  it('carries the handoff proof verbatim: the parent only leaves the fetch, so 0.5 and its code', () => {
    const fact = computeFallbackStop(input(sevremoineHood()));
    if (!fact.known) throw new Error('expected a fallback stop');
    expect(fact.reliability.confidence).toBe(0.5);
    expect(fact.reliability.reasonCodes).toContain('parent_continuity_beyond_fetch');
    expect(fact.reliability.reasonCodes).toContain('walk_along_carriageway_axis');
    expect(fact.provenance.method).toBe('fallback-stop-at-mouth');
  });

  it('reads the barriers ALONG THE WALKED PATH, junction first, stop last, through the injected reader', () => {
    const seen: GeoPoint[][] = [];
    const fact = computeFallbackStop(
      input(sevremoineHood(), {
        barriersAlong: (path) => {
          seen.push([...path]);
          return [];
        },
      }),
    );
    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(seen).toHaveLength(1);
    const path = seen[0]!;
    expect(haversineM(path[0]!, fact.value.mouth)).toBeLessThan(0.5);
    expect(haversineM(path[path.length - 1]!, fact.value.stopAt)).toBeLessThan(0.5);
  });

  it('through assessTopology: a bollard at the impasse mouth is the impasse’s, one on the walked path is the parent’s, one further up is nobody’s', () => {
    const hood = sevremoineHood();
    const withBarriers = {
      ...tagged(hood, { mouth: { barrier: 'bollard' } }),
    };
    // Two loose survey nodes (no way of their own): one on the path 8 m south
    // of the junction, one 60 m north — beyond the 15 m walked.
    withBarriers.nodes = [
      ...withBarriers.nodes,
      { id: 'onPath', at: at(O, -8, -20), wayIds: [], tags: { barrier: 'gate' } },
      { id: 'farNorth', at: at(O, 60, -20), wayIds: [], tags: { barrier: 'gate' } },
    ];
    const assessed = assessTopology({
      neighbourhood: withBarriers,
      surfaces: [],
      deliveryWayId: 'allee',
      deliveryPoint: O,
      turnaroundSearchRadiusM: 120,
      maxMouthDepth: 2,
      maxDeviationDeg: 40,
      barrierSnapM: 6,
      measurement: {
        defaultTurningCircleDiameterM: null,
        fallbackCarriagewayWidthM: null,
        loopClosureToleranceM: 3,
        observedAt: FETCHED_AT,
      },
      fallbackStop: PARAMS,
    });
    // The impasse keeps its bollard…
    expect(assessed.barriers.map((b) => (b.known ? b.value.kind : 'unknown'))).toEqual(['bollard']);
    // …and the fallback stop sees only the gate on its own 15 m.
    expect(assessed.fallbackStop?.known).toBe(true);
    if (!assessed.fallbackStop?.known) return;
    const kinds = assessed.fallbackStop.value.barriers.map((b) => (b.known ? `${b.value.kind}@${b.value.at.lat.toFixed(5)}` : 'unknown'));
    expect(kinds).toEqual([`gate@${at(O, -8, -20).lat.toFixed(5)}`]);
  });

  it('comes out of assessTopology under the same name when the params are given, and not otherwise', () => {
    const hood = sevremoineHood();
    const base = {
      neighbourhood: hood,
      surfaces: [],
      deliveryWayId: 'allee',
      deliveryPoint: O,
      turnaroundSearchRadiusM: 120,
      maxMouthDepth: 2,
      maxDeviationDeg: 40,
      barrierSnapM: 6,
      measurement: {
        defaultTurningCircleDiameterM: null,
        fallbackCarriagewayWidthM: null,
        loopClosureToleranceM: 3,
        observedAt: FETCHED_AT,
      },
    };
    const without = assessTopology(base);
    expect('fallbackStop' in without).toBe(false);
    const withParams = assessTopology({ ...base, fallbackStop: PARAMS });
    expect(withParams.fallbackStop?.known).toBe(true);
    if (withParams.fallbackStop?.known) {
      expect(withParams.fallbackStop.value.street.name).toBe('Rue Voisine MA');
    }
  });
});

describe('computeFallbackStop — the bands', () => {
  it('50–150 m of walk: proposed with the portage in clear', () => {
    const hood = longImpasse(120);
    const fact = computeFallbackStop(input(hood, { handoff: handoffOf(hood) }));
    if (!fact.known) throw new Error('expected a fallback stop');
    expect(fact.value.walk.totalM).toBeCloseTo(135, 0);
    expect(fact.value.band).toBe('portage');
  });

  it('beyond 150 m: the street is said absent, with its distance', () => {
    const hood = longImpasse(200);
    const fact = computeFallbackStop(input(hood, { handoff: handoffOf(hood) }));
    if (!fact.known) throw new Error('expected a fallback stop');
    expect(fact.value.walk.totalM).toBeCloseTo(215, 0);
    expect(fact.value.band).toBe('beyond');
  });

  it('exactly at the plain bound stays plain (the engine compares strictly above 50)', () => {
    const hood = longImpasse(35);
    const fact = computeFallbackStop(input(hood, { handoff: handoffOf(hood) }));
    if (!fact.known) throw new Error('expected a fallback stop');
    expect(fact.value.walk.totalM).toBeCloseTo(50, 0);
    expect(fact.value.band).toBe('plain');
  });
});

describe('computeFallbackStop — what is not an answer', () => {
  it('a through street: not applicable', () => {
    const fact = computeFallbackStop(input(sevremoineHood(), { topologyKind: 'THROUGH' }));
    expect(fact).toEqual({ known: false, why: 'not_applicable' });
  });

  it('no mouth resolved: no data, never a stop invented', () => {
    const fact = computeFallbackStop(
      input(sevremoineHood(), { handoff: { known: false, why: 'no_data' } }),
    );
    expect(fact).toEqual({ known: false, why: 'no_data' });
  });

  it('a mouth naming a parent the fetch does not carry: out of coverage', () => {
    const hood = sevremoineHood();
    const real = handoffOf(hood);
    if (!real.known) throw new Error('fixture must resolve a mouth');
    const elsewhere: Fact<Mouth> = {
      ...real,
      value: { ...real.value, parentSegmentId: 'way-not-fetched' },
    };
    const fact = computeFallbackStop(input(hood, { handoff: elsewhere }));
    expect(fact).toEqual({ known: false, why: 'out_of_coverage' });
  });

  it('the side is where the STREET goes on, not where the OSM way is longer: past a short parent, the walk follows the next way', () => {
    const allee = way('allee', ['mouth', 'tip'], [at(O, 0, -20), at(O, 0, 40)], {
      tags: { highway: 'residential' },
    });
    // The parent way runs 8 m north to a closed tip and 5 m south to a node
    // where `next` carries the street on for 300 m. The longer piece is the
    // pocket; the street is the other way.
    const parent = way('parent', ['p1', 'mouth', 'p2'], [at(O, 8, -20), at(O, 0, -20), at(O, -5, -20)], {
      tags: { highway: 'residential' },
    });
    const next = way('next', ['p2', 'n1'], [at(O, -5, -20), at(O, -300, -20)], {
      tags: { highway: 'residential' },
    });
    const hood = neighbourhood(O, 120, [allee, parent, next]);
    const fact = computeFallbackStop(input(hood, { handoff: handoffOf(hood) }));
    if (!fact.known) throw new Error('expected a fallback stop');
    expect(fact.value.walk.stopToMouthM).toBeCloseTo(15, 0);
    expect(haversineM(fact.value.stopAt, at(O, -15, -20))).toBeLessThan(0.5);
  });

  it('a fork stops the walk short, and the walk says the metres actually there', () => {
    const allee = way('allee', ['mouth', 'tip'], [at(O, 0, -20), at(O, 0, 40)], {
      tags: { highway: 'residential' },
    });
    // 5 m south of the mouth the street splits in two: the walk stops at the fork.
    const parent = way('parent', ['p1', 'mouth', 'p2'], [at(O, 8, -20), at(O, 0, -20), at(O, -5, -20)], {
      tags: { highway: 'residential' },
    });
    const left = way('left', ['p2', 'l1'], [at(O, -5, -20), at(O, -300, -60)], { tags: { highway: 'residential' } });
    const right = way('right', ['p2', 'r1'], [at(O, -5, -20), at(O, -300, 20)], { tags: { highway: 'residential' } });
    const hood = neighbourhood(O, 120, [allee, parent, left, right]);
    const fact = computeFallbackStop(input(hood, { handoff: handoffOf(hood) }));
    if (!fact.known) throw new Error('expected a fallback stop');
    expect(fact.value.walk.stopToMouthM).toBeCloseTo(5, 0);
    expect(haversineM(fact.value.stopAt, at(O, -5, -20))).toBeLessThan(0.5);
  });
});
