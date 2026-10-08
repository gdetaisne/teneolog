/**
 * Corpus fixtures for delivery-street selection.
 *
 * Every case is a hand-built neighbourhood: the module is pure, so a field case
 * is a fixture and nothing here needs a network.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';
import type { OneWay, RoadNeighbourhood, RoadNode, RoadWay } from '../src/ports.js';
import { selectDeliveryStreet, type StreetSelectionInput } from '../src/street-selection.js';

// ---------------------------------------------------------------- fixtures --

/** Metres per degree of latitude on the sphere `geometry.ts` measures with. */
const LAT_M_PER_DEG = 111_194.93;

function offset(origin: GeoPoint, eastM: number, northM: number): GeoPoint {
  const lonScale = LAT_M_PER_DEG * Math.cos((origin.lat * Math.PI) / 180);
  return { lat: origin.lat + northM / LAT_M_PER_DEG, lon: origin.lon + eastM / lonScale };
}

interface WaySpec {
  readonly id: string;
  readonly nodeIds: readonly string[];
  readonly geometry: readonly GeoPoint[];
  readonly name?: string | null;
  readonly importance?: number | null;
  readonly declaredWidthM?: number | null;
  readonly oneWay?: OneWay;
  readonly isPrivate?: boolean;
  readonly tags?: Readonly<Record<string, string>>;
}

function makeWay(spec: WaySpec): RoadWay {
  return {
    id: spec.id,
    source: 'osm-overpass',
    nodeIds: spec.nodeIds,
    geometry: spec.geometry,
    name: spec.name ?? null,
    importance: spec.importance ?? null,
    declaredWidthM: spec.declaredWidthM ?? null,
    laneCount: null,
    oneWay: spec.oneWay ?? 'no',
    isPrivate: spec.isPrivate ?? false,
    limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    tags: spec.tags ?? { highway: 'residential' },
  };
}

function makeNode(id: string, at: GeoPoint, wayIds: readonly string[]): RoadNode {
  return { id, at, wayIds, tags: {} };
}

function neighbourhood(centre: GeoPoint, ways: readonly RoadWay[], nodes: readonly RoadNode[]): RoadNeighbourhood {
  return { centre, radiusM: 50, ways, nodes };
}

function input(
  point: GeoPoint,
  hood: RoadNeighbourhood,
  overrides: Partial<StreetSelectionInput> = {},
): StreetSelectionInput {
  return {
    point,
    neighbourhood: hood,
    maxSnapM: 25,
    ambiguityWindowM: 6,
    minWidthAdvantageM: 0.5,
    tipInteriorMarginM: 2,
    continuationDeviationDeg: 25,
    fetchedAt: '2026-07-09T10:00:00.000Z',
    confidence: { unambiguous: 0.9, resolvedByRank: 0.75 },
    ...overrides,
  };
}

/**
 * Auxerre. The N77 frontage runs 6.7 m south of the geocode; a same-name
 * unclassified spur runs 5.6 m north of it, branching off the N77 to the west
 * and dead-ending 40 m east. Nearest-segment snapping picks the spur.
 */
function auxerre(options: { readonly withImportance: boolean }): {
  readonly hood: RoadNeighbourhood;
  readonly geocode: GeoPoint;
  readonly insideSpur: GeoPoint;
} {
  const o: GeoPoint = { lat: 47.80365833824555, lon: 3.6194400562899033 };
  const n77Geometry = [offset(o, -48, -6.7), offset(o, -20, -6.7), offset(o, 48, -6.7)];
  const spurGeometry = [offset(o, -20, -6.7), offset(o, -14, 5.6), offset(o, 40, 5.6)];

  const n77 = makeWay({
    id: '419782065',
    nodeIds: ['n77-west', 'junction', 'n77-east'],
    geometry: n77Geometry,
    name: 'Avenue de l’Essai',
    importance: options.withImportance ? 3 : null,
    declaredWidthM: 7,
    tags: { highway: 'primary', ref: 'N 77' },
  });
  const spur = makeWay({
    id: '67002480',
    nodeIds: ['junction', 'spur-bend', 'spur-tip'],
    geometry: spurGeometry,
    name: 'Avenue de l’Essai',
    importance: options.withImportance ? 5 : null,
    declaredWidthM: 5,
    tags: { highway: 'unclassified' },
  });

  const nodes = [
    // Clipped at the fetch circle: not evidence of an end of road.
    makeNode('n77-west', offset(o, -48, -6.7), ['419782065']),
    makeNode('n77-east', offset(o, 48, -6.7), ['419782065']),
    makeNode('junction', offset(o, -20, -6.7), ['419782065', '67002480']),
    makeNode('spur-bend', offset(o, -14, 5.6), ['67002480']),
    // The real spur tip, 40 m out — inside the fetch and provably so.
    makeNode('spur-tip', offset(o, 40, 5.6), ['67002480']),
  ];

  return {
    hood: neighbourhood(o, [n77, spur], nodes),
    geocode: o,
    insideSpur: offset(o, 30, 5.6),
  };
}

// ------------------------------------------------------------------- tests --

describe('selectDeliveryStreet', () => {
  it('BUG-068a / EC-29: the N77 frontage beats the same-name spur the point is nearer to', () => {
    const { hood, geocode } = auxerre({ withImportance: true });

    const fact = selectDeliveryStreet(input(geocode, hood));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.segmentId).toBe('419782065');
    expect(fact.value.importance).toBe(3);
    expect(fact.value.declaredWidthM).toBe(7);
    expect(fact.value.alternativesConsidered).toHaveLength(1);
    const [rejected] = fact.value.alternativesConsidered;
    expect(rejected?.segmentId).toBe('67002480');
    expect(rejected?.name).toBe('Avenue de l’Essai');
    expect(rejected?.reason).toBe('lower_importance');
    expect(rejected?.distanceFromPointM).toBeCloseTo(5.6, 0);
    expect(fact.reliability.reasonCodes).toContain('street_resolved_by_lower_importance');
    expect(fact.reliability.confidence).toBe(0.75);
  });

  it('EC-29: with no BDTOPO importance, the OSM highway class still separates frontage from spur', () => {
    const { hood, geocode } = auxerre({ withImportance: false });

    const fact = selectDeliveryStreet(input(geocode, hood));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.segmentId).toBe('419782065');
    expect(fact.value.alternativesConsidered[0]?.reason).toBe('lower_importance');
  });

  it('EC-29: a point inside the spur keeps the spur, with the spur’s own attributes', () => {
    const { hood, insideSpur } = auxerre({ withImportance: true });

    const fact = selectDeliveryStreet(input(insideSpur, hood));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    // Object identity: the spur must not inherit importance 3 / width 7 from a
    // merged "Avenue de l’Essai", nor the N77 the spur's dead end.
    expect(fact.value.segmentId).toBe('67002480');
    expect(fact.value.importance).toBe(5);
    expect(fact.value.declaredWidthM).toBe(5);
    expect(fact.value.alternativesConsidered).toEqual([]);
    expect(fact.reliability.confidence).toBe(0.9);
  });

  it('BUG-048a: an interior shape point of a through street is not a dead-end tip', () => {
    const o: GeoPoint = { lat: 47.66, lon: -2.9 };
    // Rue Voisine LB: clipped at both fetched ends, with a shape point 0.3 m
    // from the delivery point that is degree-1 by construction.
    const through = makeWay({
      id: '180628513',
      nodeIds: ['clip-west', '266147484', 'side-junction', 'clip-east'],
      geometry: [offset(o, -49, 0), offset(o, 0.3, 0), offset(o, 4, 0), offset(o, 49, 0)],
      name: 'Rue Voisine LB',
    });
    const impasse = makeWay({
      id: 'side-impasse',
      nodeIds: ['side-junction', 'impasse-tip'],
      geometry: [offset(o, 4, 0), offset(o, 4, 25)],
      name: 'Impasse Voisine AJ',
    });
    const hood = neighbourhood(
      o,
      [through, impasse],
      [
        makeNode('clip-west', offset(o, -49, 0), ['180628513']),
        makeNode('266147484', offset(o, 0.3, 0), ['180628513']),
        makeNode('side-junction', offset(o, 4, 0), ['180628513', 'side-impasse']),
        makeNode('clip-east', offset(o, 49, 0), ['180628513']),
        makeNode('impasse-tip', offset(o, 4, 25), ['side-impasse']),
      ],
    );

    const fact = selectDeliveryStreet(input(o, hood));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.segmentId).toBe('180628513');
    expect(fact.value.alternativesConsidered[0]).toEqual({
      segmentId: 'side-impasse',
      name: 'Impasse Voisine AJ',
      distanceFromPointM: expect.closeTo(4, 0) as unknown as number,
      reason: 'dead_end_spur',
    });
  });

  it('BUG-003: a degree-1 tip at the fetch boundary is where we stopped looking, not an end of road', () => {
    const o: GeoPoint = { lat: 48.5, lon: 2.5 };
    // Same class, same width, same privacy: only the end-of-road axis can decide.
    const clipped = makeWay({
      id: 'clipped-through',
      nodeIds: ['cross-junction', 'clipped-tip'],
      geometry: [offset(o, -6, 3), offset(o, 49.5, 3)],
    });
    const stub = makeWay({
      id: 'real-stub',
      nodeIds: ['stub-root', 'stub-tip'],
      geometry: [offset(o, -6, -6), offset(o, 20, -6)],
    });
    const crossing = makeWay({
      id: 'crossing',
      nodeIds: ['cross-junction', 'cross-far'],
      geometry: [offset(o, -6, 3), offset(o, -45, 3)],
    });
    const hood = neighbourhood(
      o,
      [clipped, stub, crossing],
      [
        makeNode('cross-junction', offset(o, -6, 3), ['clipped-through', 'crossing']),
        makeNode('clipped-tip', offset(o, 49.5, 3), ['clipped-through']),
        makeNode('stub-root', offset(o, -6, -6), ['real-stub']),
        makeNode('stub-tip', offset(o, 20, -6), ['real-stub']),
        makeNode('cross-far', offset(o, -45, 3), ['crossing']),
      ],
    );

    const fact = selectDeliveryStreet(input(o, hood));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.segmentId).toBe('clipped-through');
    expect(fact.value.alternativesConsidered[0]?.reason).toBe('dead_end_spur');
  });

  it('BUG-037a: a carriageway split at an attribute change is one street, not two rivals', () => {
    const o: GeoPoint = { lat: 48.80236, lon: 2.30104 };
    const northHalf = makeWay({
      id: 'pvc-north',
      nodeIds: ['pvc-top', 'pvc-break'],
      geometry: [offset(o, -50, 3), offset(o, 0, 3)],
      name: 'Rue du Prototype',
      importance: 5,
    });
    // Same carriageway, new name, new importance, now one-way: the split node is
    // a degree-2 junction between two collinear ways, never an end of road.
    const southHalf = makeWay({
      id: 'pvc-south',
      nodeIds: ['pvc-break', 'pvc-bottom'],
      geometry: [offset(o, 0, 3), offset(o, 50, 3)],
      name: 'Rue Voisine T',
      importance: 4,
      oneWay: 'forward',
    });
    const hood = neighbourhood(
      o,
      [northHalf, southHalf],
      [
        makeNode('pvc-top', offset(o, -50, 3), ['pvc-north']),
        makeNode('pvc-break', offset(o, 0, 3), ['pvc-north', 'pvc-south']),
        makeNode('pvc-bottom', offset(o, 50, 3), ['pvc-south']),
      ],
    );

    const fact = selectDeliveryStreet(input(offset(o, -5, 0), hood));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    // The frontage is the stretch the point stands beside, not the more
    // structuring half of the same road.
    expect(fact.value.segmentId).toBe('pvc-north');
    expect(fact.value.importance).toBe(5);
    expect(fact.value.alternativesConsidered).toEqual([]);
    expect(fact.reliability.reasonCodes).toContain('street_continuation_merged');
  });

  it('EC-29: two roads that merely meet at a junction stay two objects', () => {
    const o: GeoPoint = { lat: 48.8, lon: 2.3 };
    const avenue = makeWay({
      id: 'avenue',
      nodeIds: ['avenue-west', 'corner'],
      geometry: [offset(o, -40, -4), offset(o, 6, -4)],
      importance: 3,
      tags: { highway: 'secondary' },
    });
    const sideStreet = makeWay({
      id: 'side-street',
      nodeIds: ['corner', 'side-end'],
      geometry: [offset(o, 6, -4), offset(o, 6, 40)],
      importance: 5,
      tags: { highway: 'residential' },
    });
    const hood = neighbourhood(
      o,
      [avenue, sideStreet],
      [
        makeNode('avenue-west', offset(o, -40, -4), ['avenue']),
        makeNode('corner', offset(o, 6, -4), ['avenue', 'side-street']),
        makeNode('side-end', offset(o, 6, 40), ['side-street']),
      ],
    );

    const fact = selectDeliveryStreet(input(o, hood));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.segmentId).toBe('avenue');
    expect(fact.value.alternativesConsidered).toHaveLength(1);
    expect(fact.value.alternativesConsidered[0]?.segmentId).toBe('side-street');
    expect(fact.reliability.reasonCodes).not.toContain('street_continuation_merged');
  });

  it('BUG-036: a nearer local stub does not steal the delivery street from the avenue', () => {
    const o: GeoPoint = { lat: 46.773049, lon: 1.7491 };
    const avenue = makeWay({
      id: 'avenue-de-la-foret',
      nodeIds: ['a1', 'a2'],
      geometry: [offset(o, -45, -6), offset(o, 45, -6)],
      name: 'Avenue de la Forêt',
      importance: 3,
      tags: { highway: 'secondary' },
    });
    const stub = makeWay({
      id: 'stub',
      nodeIds: ['s1', 's2'],
      geometry: [offset(o, -10, 3), offset(o, 12, 3)],
      importance: 5,
      tags: { highway: 'service' },
    });
    const hood = neighbourhood(
      o,
      [avenue, stub],
      [
        makeNode('a1', offset(o, -45, -6), ['avenue-de-la-foret']),
        makeNode('a2', offset(o, 45, -6), ['avenue-de-la-foret']),
        makeNode('s1', offset(o, -10, 3), ['stub']),
        makeNode('s2', offset(o, 12, 3), ['stub']),
      ],
    );

    const fact = selectDeliveryStreet(input(o, hood));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.segmentId).toBe('avenue-de-la-foret');
    expect(fact.value.alternativesConsidered[0]?.reason).toBe('lower_importance');
  });

  it('EC-22: a private path is selected when it is the frontage, never disqualified', () => {
    const o: GeoPoint = { lat: 48.897224, lon: 2.192521 };
    const path = makeWay({
      id: 'private-path',
      nodeIds: ['p1', 'p2'],
      geometry: [offset(o, -1, 0), offset(o, 30, 0)],
      isPrivate: true,
      tags: { highway: 'service' },
    });
    const hood = neighbourhood(
      o,
      [path],
      [makeNode('p1', offset(o, -1, 0), ['private-path']), makeNode('p2', offset(o, 30, 0), ['private-path'])],
    );

    const fact = selectDeliveryStreet(input(o, hood));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.segmentId).toBe('private-path');
    expect(fact.value.isPrivate).toBe(true);
    expect(fact.reliability.reasonCodes).toContain('street_is_private');
  });

  it('EC-22: privacy only breaks a tie against an equally plausible public frontage', () => {
    const o: GeoPoint = { lat: 48.897224, lon: 2.192521 };
    const path = makeWay({
      id: 'private-path',
      nodeIds: ['p1', 'p2'],
      geometry: [offset(o, -20, 0.5), offset(o, 20, 0.5)],
      isPrivate: true,
    });
    const street = makeWay({
      id: 'public-street',
      nodeIds: ['s1', 's2'],
      geometry: [offset(o, -20, -4), offset(o, 20, -4)],
      name: 'Rue Voisine BG',
    });
    const hood = neighbourhood(
      o,
      [path, street],
      [
        makeNode('p1', offset(o, -20, 0.5), ['private-path']),
        makeNode('p2', offset(o, 20, 0.5), ['private-path']),
        makeNode('s1', offset(o, -20, -4), ['public-street']),
        makeNode('s2', offset(o, 20, -4), ['public-street']),
      ],
    );

    const fact = selectDeliveryStreet(input(o, hood));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.segmentId).toBe('public-street');
    expect(fact.value.alternativesConsidered[0]?.reason).toBe('private');
  });

  it('a width advantage above the declared-width tolerance decides, below it does not', () => {
    const o: GeoPoint = { lat: 45, lon: 5 };
    const build = (widthA: number, widthB: number): RoadNeighbourhood => {
      const wide = makeWay({
        id: 'wide',
        nodeIds: ['w1', 'w2'],
        geometry: [offset(o, -20, -4), offset(o, 20, -4)],
        declaredWidthM: widthA,
      });
      const narrow = makeWay({
        id: 'narrow',
        nodeIds: ['n1', 'n2'],
        geometry: [offset(o, -20, 2), offset(o, 20, 2)],
        declaredWidthM: widthB,
      });
      return neighbourhood(
        o,
        [wide, narrow],
        [
          makeNode('w1', offset(o, -20, -4), ['wide']),
          makeNode('w2', offset(o, 20, -4), ['wide']),
          makeNode('n1', offset(o, -20, 2), ['narrow']),
          makeNode('n2', offset(o, 20, 2), ['narrow']),
        ],
      );
    };

    const decided = selectDeliveryStreet(input(o, build(7, 4.5)));
    expect(decided.known).toBe(true);
    if (decided.known) {
      expect(decided.value.segmentId).toBe('wide');
      expect(decided.value.alternativesConsidered[0]?.reason).toBe('narrower');
    }

    const undecided = selectDeliveryStreet(input(o, build(7, 6.8)));
    expect(undecided.known).toBe(false);
    if (!undecided.known) expect(undecided.why).toBe('below_confidence');
  });

  it('two indistinguishable frontages are reported as ambiguous, never guessed', () => {
    const o: GeoPoint = { lat: 44.1, lon: 3.1 };
    const north = makeWay({
      id: 'north',
      nodeIds: ['n1', 'n2'],
      geometry: [offset(o, -20, 5), offset(o, 20, 5)],
      name: 'Rue du Nord',
    });
    const south = makeWay({
      id: 'south',
      nodeIds: ['s1', 's2'],
      geometry: [offset(o, -20, -5.5), offset(o, 20, -5.5)],
      name: 'Rue du Sud',
    });
    const hood = neighbourhood(
      o,
      [north, south],
      [
        makeNode('n1', offset(o, -20, 5), ['north']),
        makeNode('n2', offset(o, 20, 5), ['north']),
        makeNode('s1', offset(o, -20, -5.5), ['south']),
        makeNode('s2', offset(o, 20, -5.5), ['south']),
      ],
    );

    const fact = selectDeliveryStreet(input(o, hood));

    expect(fact.known).toBe(false);
    if (fact.known) return;
    expect(fact.why).toBe('below_confidence');
    expect(fact.provenance?.method).toBe('street-selection');
    expect(fact.provenance?.fetchedAt).toBe('2026-07-09T10:00:00.000Z');
  });

  it('a candidate outside the ambiguity window is not an alternative — an empty list means no ambiguity', () => {
    const o: GeoPoint = { lat: 44.1, lon: 3.1 };
    const near = makeWay({
      id: 'near',
      nodeIds: ['n1', 'n2'],
      geometry: [offset(o, -20, 2), offset(o, 20, 2)],
    });
    const far = makeWay({
      id: 'far',
      nodeIds: ['f1', 'f2'],
      geometry: [offset(o, -20, -18), offset(o, 20, -18)],
      importance: 2,
      tags: { highway: 'primary' },
    });
    const hood = neighbourhood(
      o,
      [near, far],
      [
        makeNode('n1', offset(o, -20, 2), ['near']),
        makeNode('n2', offset(o, 20, 2), ['near']),
        makeNode('f1', offset(o, -20, -18), ['far']),
        makeNode('f2', offset(o, 20, -18), ['far']),
      ],
    );

    const fact = selectDeliveryStreet(input(o, hood));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.segmentId).toBe('near');
    expect(fact.value.alternativesConsidered).toEqual([]);
    expect(fact.reliability.reasonCodes).toContain('street_unambiguous');
  });

  it('a footway is never a frontage, and a way tagged pedestrian still is (BUG-037b)', () => {
    const o: GeoPoint = { lat: 48.8673, lon: 2.3809 };
    const footway = makeWay({
      id: 'footway',
      nodeIds: ['f1', 'f2'],
      geometry: [offset(o, -20, 1), offset(o, 20, 1)],
      tags: { highway: 'footway' },
    });
    const street = makeWay({
      id: 'bellan',
      nodeIds: ['b1', 'b2'],
      geometry: [offset(o, -20, -8), offset(o, 20, -8)],
      name: 'Rue Voisine LBE',
      oneWay: 'forward',
      tags: { highway: 'pedestrian' },
    });
    const hood = neighbourhood(
      o,
      [footway, street],
      [
        makeNode('f1', offset(o, -20, 1), ['footway']),
        makeNode('f2', offset(o, 20, 1), ['footway']),
        makeNode('b1', offset(o, -20, -8), ['bellan']),
        makeNode('b2', offset(o, 20, -8), ['bellan']),
      ],
    );

    const fact = selectDeliveryStreet(input(o, hood));

    expect(fact.known).toBe(true);
    if (!fact.known) return;
    expect(fact.value.segmentId).toBe('bellan');
    expect(fact.value.alternativesConsidered).toEqual([]);
  });

  it('BUG-048d: an empty neighbourhood is a coverage gap, not a street', () => {
    const o: GeoPoint = { lat: 43.3, lon: 5.5 };

    const fact = selectDeliveryStreet(input(o, neighbourhood(o, [], [])));

    expect(fact.known).toBe(false);
    if (fact.known) return;
    expect(fact.why).toBe('out_of_coverage');
    expect(fact.provenance).toBeUndefined();
  });

  it('BUG-048d: roads that are all beyond the snap radius resolve to no frontage', () => {
    const o: GeoPoint = { lat: 43.3, lon: 5.5 };
    const far = makeWay({
      id: 'far',
      nodeIds: ['f1', 'f2'],
      geometry: [offset(o, -20, 40), offset(o, 20, 40)],
    });
    const hood = neighbourhood(
      o,
      [far],
      [makeNode('f1', offset(o, -20, 40), ['far']), makeNode('f2', offset(o, 20, 40), ['far'])],
    );

    const fact = selectDeliveryStreet(input(o, hood));

    expect(fact.known).toBe(false);
    if (fact.known) return;
    expect(fact.why).toBe('no_data');
  });
});
