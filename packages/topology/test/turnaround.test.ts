/**
 * Field cases for `measureTurnaround`, one test per corpus id.
 *
 * Every fixture is hand-built at real coordinates from the corpus row it
 * covers, so a failure names a street rather than a number.
 */
import { describe, expect, it } from 'vitest';

import type { Fact, GeoPoint, Turnaround } from '@teneolog/domain';

import { haversineM } from '../src/geometry.js';
import type { RoadNode, RoadWay, Surface } from '../src/ports.js';
import {
  measureTurnaround,
  type TurnaroundMeasurementOptions,
  type TurnaroundSource,
} from '../src/turnaround.js';

const M_PER_DEG_LAT = 111_320;
const metresToLat = (m: number): number => m / M_PER_DEG_LAT;
const metresToLon = (m: number, lat: number): number =>
  m / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));

/** Refuse every guess by default; each test opts into a fallback explicitly. */
const REFUSE_ALL: TurnaroundMeasurementOptions = {
  defaultTurningCircleDiameterM: null,
  fallbackCarriagewayWidthM: null,
  loopClosureToleranceM: 2,
  observedAt: '2026-08-24T09:00:00.000Z',
};

function assertKnown(fact: Fact<Turnaround>): Extract<Fact<Turnaround>, { known: true }> {
  if (!fact.known) throw new Error(`expected a known turnaround, got ${fact.why}`);
  return fact;
}

function assertUnknown(fact: Fact<Turnaround>): Extract<Fact<Turnaround>, { known: false }> {
  if (fact.known) throw new Error('expected an unknown turnaround, got a measurement');
  return fact;
}

function node(id: string, at: GeoPoint, tags: Record<string, string>): RoadNode {
  return { id, at, wayIds: ['w-1'], tags };
}

function way(overrides: Partial<RoadWay> & Pick<RoadWay, 'id' | 'nodeIds' | 'geometry'>): RoadWay {
  return {
    source: 'osm-overpass',
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

/** A closed ring of `vertices` points, first point repeated last. */
function ringAround(centre: GeoPoint, radiusM: number, vertices: number): readonly GeoPoint[] {
  const points: GeoPoint[] = [];
  for (let i = 0; i < vertices; i += 1) {
    const angle = (2 * Math.PI * i) / vertices;
    points.push({
      lat: centre.lat + metresToLat(radiusM * Math.cos(angle)),
      lon: centre.lon + metresToLon(radiusM * Math.sin(angle), centre.lat),
    });
  }
  const first = points[0];
  if (first !== undefined) points.push(first);
  return points;
}

/** Axis-aligned rectangle, `lonM` east-west by `latM` north-south, not closed. */
function rectangleAround(centre: GeoPoint, lonM: number, latM: number): readonly GeoPoint[] {
  const dLat = metresToLat(latM / 2);
  const dLon = metresToLon(lonM / 2, centre.lat);
  return [
    { lat: centre.lat - dLat, lon: centre.lon - dLon },
    { lat: centre.lat - dLat, lon: centre.lon + dLon },
    { lat: centre.lat + dLat, lon: centre.lon + dLon },
    { lat: centre.lat + dLat, lon: centre.lon - dLon },
  ];
}

function closed(polygon: readonly GeoPoint[]): readonly GeoPoint[] {
  const first = polygon[0];
  return first === undefined ? polygon : [...polygon, first];
}

// 15 Impasse Voisine TR, 17220 Saint-Vivien.
const TREILLES: GeoPoint = { lat: 46.075556, lon: -1.011659 };
// 10 allée Voisine LM, 36330 Le Poinçonnet.
const LOUISE_MICHEL: GeoPoint = { lat: 46.773049, lon: 1.7491 };
// 21 Avenue Voisine PH, 59500 Douai.
const PAUL_HENIN: GeoPoint = { lat: 50.36059, lon: 3.12538 };
// 19 Rue Voisine BG, 78400 Chatou.
const BEAUGENDRE: GeoPoint = { lat: 48.897224, lon: 2.192521 };

describe('EC-17 — turning circle at 15 Impasse Voisine TR', () => {
  const bareCircle = node('n-treilles', TREILLES, { highway: 'turning_circle' });

  it('EC-17: an untagged turning circle is unknown, never a turnaround by presence', () => {
    const fact = measureTurnaround({ kind: 'turning_circle_node', node: bareCircle }, REFUSE_ALL);

    const unknown = assertUnknown(fact);
    expect(unknown.why).toBe('no_data');
    expect(unknown.provenance?.method).toBe('turning-circle-unmeasured');
  });

  it('EC-17: a tagged diameter is measured through, small values included', () => {
    const tagged = node('n-treilles', TREILLES, {
      highway: 'turning_circle',
      'turning_circle:diameter': '8',
    });

    const known = assertKnown(
      measureTurnaround({ kind: 'turning_circle_node', node: tagged }, REFUSE_ALL),
    );
    expect(known.value.usableDiameterM).toBe(8);
    expect(known.value.surface).toBe('turning_circle');
    expect(known.value.centre).toEqual(TREILLES);
    expect(known.reliability.basis).toBe('declared');
  });

  it('EC-17: a diameter tag carrying its unit is read, and the namespaced tag wins', () => {
    const tagged = node('n-treilles', TREILLES, {
      highway: 'turning_circle',
      'turning_circle:diameter': '12.5 m',
      diameter: '30',
    });

    const known = assertKnown(
      measureTurnaround({ kind: 'turning_circle_node', node: tagged }, REFUSE_ALL),
    );
    expect(known.value.usableDiameterM).toBe(12.5);
  });

  it('EC-17: an unreadable diameter tag is no reading, not a zero-sized circle', () => {
    const tagged = node('n-treilles', TREILLES, {
      highway: 'turning_circle',
      'turning_circle:diameter': 'large',
    });

    expect(
      assertUnknown(measureTurnaround({ kind: 'turning_circle_node', node: tagged }, REFUSE_ALL))
        .why,
    ).toBe('no_data');
  });

  it('EC-24: a policy default is allowed but ranks below a stated dimension', () => {
    const assumed = assertKnown(
      measureTurnaround(
        { kind: 'turning_circle_node', node: bareCircle },
        { ...REFUSE_ALL, defaultTurningCircleDiameterM: 15 },
      ),
    );
    const stated = assertKnown(
      measureTurnaround(
        {
          kind: 'turning_circle_node',
          node: node('n-treilles', TREILLES, { 'turning_circle:diameter': '15' }),
        },
        REFUSE_ALL,
      ),
    );

    expect(assumed.value.usableDiameterM).toBe(15);
    expect(assumed.reliability.basis).toBe('derived');
    expect(assumed.provenance.method).toBe('turning-circle-policy-default');
    // Same number, different worth: the projection stage must be able to tell them apart.
    expect(assumed.reliability.confidence).toBeLessThan(stated.reliability.confidence);
  });
});

describe('EC-18 / BUG-037c — exit loop at 10 allée Voisine LM', () => {
  it('EC-18: a closed ring yields the circle traceable inside its own footprint', () => {
    const loop = way({
      id: 'w-louise-michel-loop',
      nodeIds: ['a', 'b', 'c', 'd', 'e', 'f', 'a'],
      geometry: ringAround(LOUISE_MICHEL, 10, 36),
      name: 'Allée Voisine LM',
      tags: { highway: 'residential', junction: 'turning_loop' },
    });

    const known = assertKnown(measureTurnaround({ kind: 'loop_way', way: loop }, REFUSE_ALL));
    expect(known.value.surface).toBe('loop');
    expect(known.value.usableDiameterM).toBeGreaterThan(19);
    expect(known.value.usableDiameterM).toBeLessThan(20.2);
    expect(haversineM(known.value.centre, LOUISE_MICHEL)).toBeLessThan(1);
    expect(known.reliability.basis).toBe('measured');
    expect(known.reliability.reasonCodes).toContain('ring_closed_by_node_identity');
  });

  it('EC-18: a loop that is closed but hairpin-thin measures thin, it does not measure "present"', () => {
    const hairpin = way({
      id: 'w-hairpin',
      nodeIds: ['a', 'b', 'c', 'a'],
      geometry: closed(rectangleAround(LOUISE_MICHEL, 40, 4)),
      tags: { highway: 'residential', junction: 'turning_loop' },
    });

    const known = assertKnown(measureTurnaround({ kind: 'loop_way', way: hairpin }, REFUSE_ALL));
    // The tag says turning_loop; the geometry says four metres across.
    expect(known.value.usableDiameterM).toBeLessThan(5);
  });

  it('EC-18: a ring whose ends only meet geometrically still counts, and says so', () => {
    const ring = [...ringAround(LOUISE_MICHEL, 10, 36)].slice(0, -1);
    const nearlyClosed = way({
      id: 'w-split-ring',
      // Two ways joined across a seam: no shared node id at the ends.
      nodeIds: ring.map((_, i) => `n-${String(i)}`),
      geometry: ring,
    });

    const known = assertKnown(measureTurnaround({ kind: 'loop_way', way: nearlyClosed }, REFUSE_ALL));
    expect(known.reliability.reasonCodes).toContain('ring_closed_by_geometry');
  });

  it('LIG-01: an open way is a street, so it supplies no turnaround at all', () => {
    const impasse = way({
      id: 'w-etang-machard',
      nodeIds: ['t-1', 't-2', 't-3'],
      geometry: [
        { lat: 46.2, lon: 5.05 },
        { lat: 46.2005, lon: 5.05 },
        { lat: 46.201, lon: 5.05 },
      ],
      name: "Impasse Voisine EM",
    });

    const unknown = assertUnknown(measureTurnaround({ kind: 'loop_way', way: impasse }, REFUSE_ALL));
    expect(unknown.why).toBe('not_applicable');
    expect(unknown.provenance?.method).toBe('loop-ring-not-closed');
  });
});

describe('TAF-01 / TAF-02 — open areas', () => {
  it('TAF-01: a square car park measures its inscribed circle, centred on the free space', () => {
    const parking: Surface = {
      id: 's-parking-square',
      kind: 'parking',
      polygon: rectangleAround(BEAUGENDRE, 25, 25),
      isPrivate: false,
      source: 'osm-overpass',
    };

    const known = assertKnown(measureTurnaround({ kind: 'surface', surface: parking }, REFUSE_ALL));
    expect(known.value.surface).toBe('open_area');
    expect(known.value.usableDiameterM).toBeGreaterThan(24);
    expect(known.value.usableDiameterM).toBeLessThan(25.5);
    expect(known.reliability.basis).toBe('measured');
  });

  it('TAF-01: a long thin strip clears every area gate and still measures unusable', () => {
    const strip: Surface = {
      id: 's-parking-strip',
      kind: 'parking',
      // 100 m x 5 m = 500 m2, above the 484 m2 bounding-square gate for a 19 t.
      polygon: rectangleAround(BEAUGENDRE, 100, 5),
      isPrivate: false,
      source: 'osm-overpass',
    };

    const known = assertKnown(measureTurnaround({ kind: 'surface', surface: strip }, REFUSE_ALL));
    expect(known.value.usableDiameterM).toBeLessThan(6);
  });

  it('TAF-01: private ground is measured like any other, ownership is a separate question', () => {
    const yard: Surface = {
      id: 's-yard',
      kind: 'yard',
      polygon: rectangleAround(BEAUGENDRE, 25, 25),
      isPrivate: true,
      source: 'bdtopo-postgis',
    };

    const known = assertKnown(measureTurnaround({ kind: 'surface', surface: yard }, REFUSE_ALL));
    expect(known.value.usableDiameterM).toBeGreaterThan(24);
    expect(known.provenance.source).toBe('bdtopo-postgis');
  });

  it('TAF-02: a car park with no polygon has no measurable area and stays unknown', () => {
    const nodeOnly: Surface = {
      id: 's-parking-node',
      kind: 'parking',
      polygon: [{ lat: 46.5, lon: 1.5 }],
      isPrivate: false,
      source: 'osm-overpass',
    };

    const unknown = assertUnknown(
      measureTurnaround(
        { kind: 'surface', surface: nodeOnly },
        // Even with both fallbacks funded, a missing polygon buys nothing here.
        { ...REFUSE_ALL, defaultTurningCircleDiameterM: 15, fallbackCarriagewayWidthM: 6 },
      ),
    );
    expect(unknown.why).toBe('no_data');
    expect(unknown.provenance?.method).toBe('surface-no-measurable-polygon');
  });
});

describe('BUG-074 / EC-01 — reversal on the carriageway itself', () => {
  const paulHenin = way({
    id: 'w-paul-henin',
    nodeIds: ['ph-1', 'ph-2'],
    geometry: [
      { lat: PAUL_HENIN.lat, lon: PAUL_HENIN.lon - metresToLon(60, PAUL_HENIN.lat) },
      { lat: PAUL_HENIN.lat, lon: PAUL_HENIN.lon + metresToLon(60, PAUL_HENIN.lat) },
    ],
    name: 'Avenue Voisine PH',
    declaredWidthM: 6,
    tags: { highway: 'residential' },
  });

  it('BUG-074: an on-site U-turn is expressible as a width-bounded measurement', () => {
    const known = assertKnown(
      measureTurnaround({ kind: 'carriageway', way: paulHenin, at: PAUL_HENIN }, REFUSE_ALL),
    );
    expect(known.value.surface).toBe('carriageway');
    expect(known.value.usableDiameterM).toBe(6);
    expect(known.reliability.basis).toBe('declared');
  });

  it('BUG-074: the centre lands on the road axis, not on the offset reversal point', () => {
    const offAxis: GeoPoint = {
      lat: PAUL_HENIN.lat + metresToLat(4),
      lon: PAUL_HENIN.lon,
    };

    const known = assertKnown(
      measureTurnaround({ kind: 'carriageway', way: paulHenin, at: offAxis }, REFUSE_ALL),
    );
    expect(haversineM(known.value.centre, PAUL_HENIN)).toBeLessThan(0.5);
    expect(haversineM(known.value.centre, offAxis)).toBeGreaterThan(3);
  });

  it('EC-01: an undeclared carriageway width refuses rather than assuming room to turn', () => {
    const undeclared = way({
      id: 'w-coteau',
      nodeIds: ['c-1', 'c-2'],
      geometry: [
        { lat: LOUISE_MICHEL.lat, lon: LOUISE_MICHEL.lon },
        { lat: LOUISE_MICHEL.lat + metresToLat(40), lon: LOUISE_MICHEL.lon },
      ],
    });

    const unknown = assertUnknown(
      measureTurnaround(
        { kind: 'carriageway', way: undeclared, at: LOUISE_MICHEL },
        REFUSE_ALL,
      ),
    );
    expect(unknown.why).toBe('no_data');
    expect(unknown.provenance?.method).toBe('carriageway-width-undeclared');
  });

  it('EC-01: a funded fallback width is used, and is marked as the assumption it is', () => {
    const undeclared = way({
      id: 'w-coteau',
      nodeIds: ['c-1', 'c-2'],
      geometry: [
        { lat: LOUISE_MICHEL.lat, lon: LOUISE_MICHEL.lon },
        { lat: LOUISE_MICHEL.lat + metresToLat(40), lon: LOUISE_MICHEL.lon },
      ],
    });

    const known = assertKnown(
      measureTurnaround(
        { kind: 'carriageway', way: undeclared, at: LOUISE_MICHEL },
        { ...REFUSE_ALL, fallbackCarriagewayWidthM: 5.5 },
      ),
    );
    expect(known.value.usableDiameterM).toBe(5.5);
    expect(known.reliability.basis).toBe('derived');
    expect(known.reliability.reasonCodes).toContain('carriageway_width_assumed');
  });
});

describe('measurement contract', () => {
  const sources: readonly { readonly id: string; readonly source: TurnaroundSource }[] = [
    {
      id: 'turning_circle_node',
      source: {
        kind: 'turning_circle_node',
        node: node('n', TREILLES, { 'turning_circle:diameter': '9' }),
      },
    },
    {
      id: 'loop_way',
      source: {
        kind: 'loop_way',
        way: way({
          id: 'w-loop',
          nodeIds: ['a', 'b', 'c', 'a'],
          geometry: ringAround(LOUISE_MICHEL, 8, 24),
        }),
      },
    },
    {
      id: 'surface',
      source: {
        kind: 'surface',
        surface: {
          id: 's',
          kind: 'square',
          polygon: rectangleAround(BEAUGENDRE, 30, 30),
          isPrivate: false,
          source: 'osm-overpass',
        },
      },
    },
    {
      id: 'carriageway',
      source: {
        kind: 'carriageway',
        way: way({
          id: 'w-c',
          nodeIds: ['1', '2'],
          geometry: [PAUL_HENIN, { lat: PAUL_HENIN.lat + metresToLat(30), lon: PAUL_HENIN.lon }],
          declaredWidthM: 7,
        }),
        at: PAUL_HENIN,
      },
    },
  ];

  it.each(sources)('$id: is pure — the same input returns the same value', ({ source }) => {
    expect(measureTurnaround(source, REFUSE_ALL)).toEqual(measureTurnaround(source, REFUSE_ALL));
  });

  it.each(sources)('$id: stamps the branch that produced it and the supplied clock', ({ source }) => {
    const known = assertKnown(measureTurnaround(source, REFUSE_ALL));
    expect(known.provenance.method).not.toBe('');
    expect(known.provenance.fetchedAt).toBe(REFUSE_ALL.observedAt);
    expect(known.reliability.confidence).toBeGreaterThan(0);
    expect(known.reliability.confidence).toBeLessThanOrEqual(1);
  });

  it('a measured polygon outranks a defaulted tag value', () => {
    const measured = assertKnown(
      measureTurnaround(
        {
          kind: 'surface',
          surface: {
            id: 's',
            kind: 'parking',
            polygon: rectangleAround(BEAUGENDRE, 30, 30),
            isPrivate: false,
            source: 'osm-overpass',
          },
        },
        REFUSE_ALL,
      ),
    );
    const defaulted = assertKnown(
      measureTurnaround(
        { kind: 'turning_circle_node', node: node('n', TREILLES, {}) },
        { ...REFUSE_ALL, defaultTurningCircleDiameterM: 20 },
      ),
    );

    expect(measured.reliability.confidence).toBeGreaterThan(defaulted.reliability.confidence);
  });
});
