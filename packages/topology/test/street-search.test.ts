/**
 * The grey layer of S0: everything the street search looked at.
 *
 * Two things are under test, and only two:
 *
 *  - the search does not change the choice. `selectDeliveryStreetWithSearch`
 *    and `selectDeliveryStreet` must return the SAME fact, deep-equal, on every
 *    fixture of the corpus. That is the whole safety argument for the change:
 *    an observation that alters what it observes is not an observation.
 *  - nothing is dropped. Every way of the neighbourhood has exactly one entry,
 *    carrying the stage it fell at, its distance when one was measured, and its
 *    line. The Auxerre spur used to vanish between `collectCandidates` and
 *    `pickBest` with no name, no distance and no count; it may not any more.
 *
 * The fixtures mirror `street-selection.test.ts` — same corpus cases, same
 * shapes — so the golden check runs on the neighbourhoods the module was
 * actually designed against, not on invented ones.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import type { OneWay, RoadNeighbourhood, RoadNode, RoadWay } from '../src/ports.js';
import {
  selectDeliveryStreet,
  selectDeliveryStreetWithSearch,
  type StreetSelectionInput,
} from '../src/street-selection.js';

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

function neighbourhood(
  centre: GeoPoint,
  ways: readonly RoadWay[],
  nodes: readonly RoadNode[],
): RoadNeighbourhood {
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

/** Auxerre — the N77 frontage and the same-name unclassified spur (BUG-068). */
function auxerre(): { readonly hood: RoadNeighbourhood; readonly geocode: GeoPoint } {
  const o: GeoPoint = { lat: 47.80365833824555, lon: 3.6194400562899033 };
  const n77 = makeWay({
    id: '419782065',
    nodeIds: ['n77-west', 'junction', 'n77-east'],
    geometry: [offset(o, -48, -6.7), offset(o, -20, -6.7), offset(o, 48, -6.7)],
    name: 'Avenue de l’Essai',
    importance: 3,
    declaredWidthM: 7,
    tags: { highway: 'primary', ref: 'N 77' },
  });
  const spur = makeWay({
    id: '67002480',
    nodeIds: ['junction', 'spur-bend', 'spur-tip'],
    geometry: [offset(o, -20, -6.7), offset(o, -14, 5.6), offset(o, 40, 5.6)],
    name: 'Avenue de l’Essai',
    importance: 5,
    declaredWidthM: 5,
    tags: { highway: 'unclassified' },
  });
  const nodes = [
    makeNode('n77-west', offset(o, -48, -6.7), ['419782065']),
    makeNode('n77-east', offset(o, 48, -6.7), ['419782065']),
    makeNode('junction', offset(o, -20, -6.7), ['419782065', '67002480']),
    makeNode('spur-bend', offset(o, -14, 5.6), ['67002480']),
    makeNode('spur-tip', offset(o, 40, 5.6), ['67002480']),
  ];
  return { hood: neighbourhood(o, [n77, spur], nodes), geocode: o };
}

/**
 * Auxerre plus the three shapes that used to leave no trace at all: a footway
 * over the pavement, a street beyond the snap radius, and a street inside the
 * snap radius but behind the ambiguity window.
 */
function auxerreWithGreyLayer(): { readonly hood: RoadNeighbourhood; readonly geocode: GeoPoint } {
  const { hood, geocode } = auxerre();
  const o = geocode;
  const footway = makeWay({
    id: 'pavement',
    nodeIds: ['f1', 'f2'],
    geometry: [offset(o, -30, 2), offset(o, 30, 2)],
    name: 'trottoir',
    tags: { highway: 'footway' },
  });
  const backStreet = makeWay({
    id: 'back-street',
    nodeIds: ['b1', 'b2'],
    geometry: [offset(o, -30, 18), offset(o, 30, 18)],
    name: 'Rue de Derrière',
  });
  const farStreet = makeWay({
    id: 'far-street',
    nodeIds: ['x1', 'x2'],
    geometry: [offset(o, -30, 42), offset(o, 30, 42)],
    name: 'Rue du Loin',
  });
  const nodes = [
    ...hood.nodes,
    makeNode('f1', offset(o, -30, 2), ['pavement']),
    makeNode('f2', offset(o, 30, 2), ['pavement']),
    makeNode('b1', offset(o, -30, 18), ['back-street']),
    makeNode('b2', offset(o, 30, 18), ['back-street']),
    makeNode('x1', offset(o, -30, 42), ['far-street']),
    makeNode('x2', offset(o, 30, 42), ['far-street']),
  ];
  return {
    hood: neighbourhood(o, [...hood.ways, footway, backStreet, farStreet], nodes),
    geocode: o,
  };
}

/** Clichy — one carriageway split at a name / importance / one-way change. */
function splitCarriageway(): { readonly hood: RoadNeighbourhood; readonly point: GeoPoint } {
  const o: GeoPoint = { lat: 48.80236, lon: 2.30104 };
  const north = makeWay({
    id: 'pvc-north',
    nodeIds: ['pvc-top', 'pvc-break'],
    geometry: [offset(o, -50, 3), offset(o, 0, 3)],
    name: 'Rue du Prototype',
    importance: 5,
  });
  const south = makeWay({
    id: 'pvc-south',
    nodeIds: ['pvc-break', 'pvc-bottom'],
    geometry: [offset(o, 0, 3), offset(o, 50, 3)],
    name: 'Rue Voisine T',
    importance: 4,
    oneWay: 'forward',
  });
  return {
    hood: neighbourhood(
      o,
      [north, south],
      [
        makeNode('pvc-top', offset(o, -50, 3), ['pvc-north']),
        makeNode('pvc-break', offset(o, 0, 3), ['pvc-north', 'pvc-south']),
        makeNode('pvc-bottom', offset(o, 50, 3), ['pvc-south']),
      ],
    ),
    point: offset(o, -5, 0),
  };
}

/** Two frontages nothing separates: the module answers `below_confidence`. */
function indistinguishable(): { readonly hood: RoadNeighbourhood; readonly point: GeoPoint } {
  const o: GeoPoint = { lat: 44.1, lon: 3.1 };
  const north = makeWay({
    id: 'north',
    nodeIds: ['n1', 'n2'],
    geometry: [offset(o, -20, 3), offset(o, 20, 3)],
  });
  const south = makeWay({
    id: 'south',
    nodeIds: ['s1', 's2'],
    geometry: [offset(o, -20, -3), offset(o, 20, -3)],
  });
  return {
    hood: neighbourhood(
      o,
      [north, south],
      [
        makeNode('n1', offset(o, -20, 3), ['north']),
        makeNode('n2', offset(o, 20, 3), ['north']),
        makeNode('s1', offset(o, -20, -3), ['south']),
        makeNode('s2', offset(o, 20, -3), ['south']),
      ],
    ),
    point: o,
  };
}

/** A private frontage beside an equally plausible public street. */
function privacyTieBreak(): { readonly hood: RoadNeighbourhood; readonly point: GeoPoint } {
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
  return {
    hood: neighbourhood(
      o,
      [path, street],
      [
        makeNode('p1', offset(o, -20, 0.5), ['private-path']),
        makeNode('p2', offset(o, 20, 0.5), ['private-path']),
        makeNode('s1', offset(o, -20, -4), ['public-street']),
        makeNode('s2', offset(o, 20, -4), ['public-street']),
      ],
    ),
    point: o,
  };
}

/** The whole corpus, as inputs — one entry per shape the module answers. */
function corpus(): readonly { readonly name: string; readonly input: StreetSelectionInput }[] {
  const aux = auxerre();
  const grey = auxerreWithGreyLayer();
  const split = splitCarriageway();
  const tie = indistinguishable();
  const privacy = privacyTieBreak();
  const empty: GeoPoint = { lat: 43.3, lon: 5.5 };
  const farOnly = makeWay({
    id: 'far',
    nodeIds: ['f1', 'f2'],
    geometry: [offset(empty, -20, 40), offset(empty, 20, 40)],
  });

  return [
    { name: 'Auxerre — N77 against the same-name spur', input: input(aux.geocode, aux.hood) },
    { name: 'Auxerre — inside the spur, 30 m east', input: input(offset(aux.geocode, 30, 5.6), aux.hood) },
    { name: 'Auxerre — with the grey layer around it', input: input(grey.geocode, grey.hood) },
    { name: 'Clichy — a carriageway split at an attribute change', input: input(split.point, split.hood) },
    { name: 'two frontages nothing separates', input: input(tie.point, tie.hood) },
    { name: 'a private frontage against a public one', input: input(privacy.point, privacy.hood) },
    {
      name: 'every road beyond the snap radius',
      input: input(
        empty,
        neighbourhood(
          empty,
          [farOnly],
          [
            makeNode('f1', offset(empty, -20, 40), ['far']),
            makeNode('f2', offset(empty, 20, 40), ['far']),
          ],
        ),
      ),
    },
    { name: 'an empty neighbourhood', input: input(empty, neighbourhood(empty, [], [])) },
  ];
}

function searchOf(i: StreetSelectionInput) {
  return selectDeliveryStreetWithSearch(i).search;
}

// ------------------------------------------------------------------- tests --

describe('selectDeliveryStreetWithSearch — the choice does not move', () => {
  for (const { name, input: i } of corpus()) {
    it(`golden: ${name}`, () => {
      // Deep-equal, not merely "same street": the confidence, the provenance
      // and the reason codes are the parts a silent drift would corrupt first.
      expect(selectDeliveryStreetWithSearch(i).street).toEqual(selectDeliveryStreet(i));
    });
  }
});

describe('selectDeliveryStreetWithSearch — nothing is dropped', () => {
  it('one entry per way of the neighbourhood, whatever became of it', () => {
    for (const { name, input: i } of corpus()) {
      const search = searchOf(i);
      expect(search.considered.length, name).toBe(i.neighbourhood.ways.length);
    }
  });

  it('the stages partition the neighbourhood: they sum back to the way count', () => {
    const { hood, geocode } = auxerreWithGreyLayer();
    const search = searchOf(input(geocode, hood));

    const byStage = new Map<string, number>();
    for (const way of search.considered) {
      byStage.set(way.stage, (byStage.get(way.stage) ?? 0) + 1);
    }
    const total = [...byStage.values()].reduce((a, b) => a + b, 0);

    expect(total).toBe(hood.ways.length);
    expect(total).toBe(5);
    expect(byStage.get('retained')).toBe(1); // the N77
    expect(byStage.get('compared')).toBe(1); // the spur
    expect(byStage.get('non_vehicular')).toBe(1); // the pavement
    expect(byStage.get('outside_window')).toBe(1); // Rue de Derrière
    expect(byStage.get('beyond_snap')).toBe(1); // Rue du Loin
  });

  it('the search carries the thresholds it filtered with', () => {
    const { hood, geocode } = auxerreWithGreyLayer();
    const search = searchOf(input(geocode, hood));

    expect(search.centre).toEqual(geocode);
    expect(search.fetchRadiusM).toBe(hood.radiusM);
    expect(search.maxSnapM).toBe(25);
    expect(search.ambiguityWindowM).toBe(6);
  });

  it('a way filtered on its class is never measured, and says so', () => {
    const { hood, geocode } = auxerreWithGreyLayer();
    const pavement = searchOf(input(geocode, hood)).considered.find(
      (w) => w.segmentId === 'pavement',
    );

    expect(pavement?.stage).toBe('non_vehicular');
    expect(pavement?.outcome).toBe('filtered');
    expect(pavement?.highway).toBe('footway');
    // Never measured is not zero metres away: the distance stays unknown.
    expect(pavement?.distanceM).toBeNull();
    expect(pavement?.endsInsideFetch).toBeNull();
  });

  it('a way beyond the snap radius keeps the distance that disqualified it', () => {
    const { hood, geocode } = auxerreWithGreyLayer();
    const far = searchOf(input(geocode, hood)).considered.find((w) => w.segmentId === 'far-street');

    expect(far?.stage).toBe('beyond_snap');
    expect(far?.outcome).toBe('filtered');
    expect(far?.distanceM).toBeGreaterThan(25);
    // the end-of-road test runs on every MEASURED way, snapped or
    // not — the avoidance rule looks for a through street a hundred metres
    // out, well past the snap radius. Only a way that was never measured at
    // all (non-vehicular, or lineless) still reads null.
    expect(far?.endsInsideFetch).toBe(false);
  });

  it('a way inside the snap radius but behind the window is measured and named', () => {
    const { hood, geocode } = auxerreWithGreyLayer();
    const back = searchOf(input(geocode, hood)).considered.find(
      (w) => w.segmentId === 'back-street',
    );

    expect(back?.stage).toBe('outside_window');
    expect(back?.outcome).toBe('filtered');
    expect(back?.name).toBe('Rue de Derrière');
    expect(back?.distanceM).toBeGreaterThan(6);
    expect(back?.distanceM).toBeLessThan(25);
    expect(back?.endsInsideFetch).not.toBeNull();
  });
});

describe('selectDeliveryStreetWithSearch — the log agrees with the decision', () => {
  it('every rival of alternativesConsidered has its compared entry, same reason', () => {
    for (const { name, input: i } of corpus()) {
      const { street, search } = selectDeliveryStreetWithSearch(i);
      if (!street.known) continue;

      for (const rival of street.value.alternativesConsidered) {
        const entry = search.considered.find((w) => w.segmentId === rival.segmentId);
        expect(entry, `${name} — ${rival.segmentId}`).toBeDefined();
        expect(entry?.outcome, name).toBe('compared');
        expect(entry?.stage, name).toBe('compared');
        expect(entry?.reason, name).toBe(rival.reason);
        expect(entry?.distanceM, name).toBe(rival.distanceFromPointM);
      }
    }
  });

  it('the retained street has its entry, with the line the source drew', () => {
    for (const { name, input: i } of corpus()) {
      const { street, search } = selectDeliveryStreetWithSearch(i);
      if (!street.known) continue;

      const retained = search.considered.filter((w) => w.outcome === 'retained');
      expect(retained.length, name).toBe(1);
      expect(retained[0]?.segmentId, name).toBe(street.value.segmentId);
      expect(retained[0]?.stage, name).toBe('retained');

      const way = i.neighbourhood.ways.find((w) => w.id === street.value.segmentId);
      // Referenced, not copied: the same array the neighbourhood holds.
      expect(retained[0]?.geometry, name).toBe(way?.geometry);
      // The winner's own distance — the one `DeliveryStreet` never carried.
      expect(retained[0]?.distanceM, name).not.toBeNull();
    }
  });

  it('a merged stretch is marked as folded into the retained street, not as a rival', () => {
    const { hood, point } = splitCarriageway();
    const { street, search } = selectDeliveryStreetWithSearch(input(point, hood));

    expect(street.known).toBe(true);
    if (!street.known) return;
    expect(street.reliability.reasonCodes).toContain('street_continuation_merged');
    expect(street.value.alternativesConsidered).toEqual([]);

    const north = search.considered.find((w) => w.segmentId === 'pvc-north');
    const south = search.considered.find((w) => w.segmentId === 'pvc-south');
    expect(north?.outcome).toBe('retained');
    expect(south?.outcome).toBe('merged_into_retained');
    expect(south?.stage).toBe('continuation_merged');
    // It was measured: it reached the window before being folded in.
    expect(south?.distanceM).not.toBeNull();
  });

  it('when nothing separates two frontages, neither is retained and both are compared', () => {
    const { hood, point } = indistinguishable();
    const { street, search } = selectDeliveryStreetWithSearch(input(point, hood));

    expect(street.known).toBe(false);
    if (street.known) return;
    expect(street.why).toBe('below_confidence');

    expect(search.considered.filter((w) => w.outcome === 'retained')).toEqual([]);
    expect(search.considered.every((w) => w.outcome === 'compared')).toBe(true);
    // No ground was found to set either aside — saying otherwise would invent one.
    expect(search.considered.every((w) => w.reason === null)).toBe(true);
  });

  it('an empty neighbourhood still reports the thresholds it would have used', () => {
    const o: GeoPoint = { lat: 43.3, lon: 5.5 };
    const search = searchOf(input(o, neighbourhood(o, [], [])));

    expect(search.considered).toEqual([]);
    expect(search.maxSnapM).toBe(25);
    expect(search.fetchRadiusM).toBe(50);
  });

  it('Auxerre: the spur is named, measured and drawn even though it lost', () => {
    const { hood, geocode } = auxerre();
    const { street, search } = selectDeliveryStreetWithSearch(input(geocode, hood));

    expect(street.known).toBe(true);
    if (!street.known) return;
    expect(street.value.segmentId).toBe('419782065');

    const spur = search.considered.find((w) => w.segmentId === '67002480');
    expect(spur?.name).toBe('Avenue de l’Essai');
    expect(spur?.highway).toBe('unclassified');
    expect(spur?.outcome).toBe('compared');
    expect(spur?.reason).toBe('lower_importance');
    expect(spur?.endsInsideFetch).toBe(true);
    expect(spur?.geometry.length).toBe(3);
  });
});
