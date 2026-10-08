/**
 * Continuity fixtures.
 *
 * Every case is a hand-built `RoadNeighbourhood`, so each corpus row is a value
 * rather than an integration run. Coordinates are real enough to be recognised
 * (Clamart, Plougoumelen, Auxerre, Le Poinçonnet) and are offset in metres from
 * the stop so the bearings in the assertions are readable.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import { assessContinuity } from '../src/continuity.js';
import type { RoadNeighbourhood, RoadWay } from '../src/ports.js';

const M_PER_DEG_LAT = 111_320;

/** `northM`/`eastM` metres from `base`, so a fixture reads as a sketch. */
function at(base: GeoPoint, northM: number, eastM: number): GeoPoint {
  return {
    lat: base.lat + northM / M_PER_DEG_LAT,
    lon: base.lon + eastM / (M_PER_DEG_LAT * Math.cos((base.lat * Math.PI) / 180)),
  };
}

interface WayOverrides {
  readonly name?: string | null;
  readonly importance?: number | null;
  readonly oneWay?: RoadWay['oneWay'];
  readonly isPrivate?: boolean;
  readonly tags?: Record<string, string>;
}

function way(
  id: string,
  nodeIds: readonly string[],
  geometry: readonly GeoPoint[],
  overrides: WayOverrides = {},
): RoadWay {
  return {
    id,
    source: 'osm-overpass',
    nodeIds,
    geometry,
    name: overrides.name ?? null,
    importance: overrides.importance ?? null,
    declaredWidthM: null,
    laneCount: null,
    oneWay: overrides.oneWay ?? 'no',
    isPrivate: overrides.isPrivate ?? false,
    limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    tags: overrides.tags ?? {},
  };
}

/** Node records are built from the ways so a fixture cannot contradict itself. */
function neighbourhood(
  centre: GeoPoint,
  radiusM: number,
  ways: readonly RoadWay[],
): RoadNeighbourhood {
  const positions = new Map<string, GeoPoint>();
  const wayIds = new Map<string, string[]>();
  for (const w of ways) {
    w.nodeIds.forEach((nodeId, index) => {
      const point = w.geometry[index];
      if (point !== undefined) positions.set(nodeId, point);
      const owners = wayIds.get(nodeId) ?? [];
      if (!owners.includes(w.id)) owners.push(w.id);
      wayIds.set(nodeId, owners);
    });
  }
  return {
    centre,
    radiusM,
    ways,
    nodes: [...positions].map(([id, point]) => ({
      id,
      at: point,
      wayIds: wayIds.get(id) ?? [],
      tags: {},
    })),
  };
}

// 8 Rue du Prototype, 92140 Clamart.
const CLAMART: GeoPoint = { lat: 48.80236, lon: 2.30104 };
// 6 Rue Voisine LB, 56400 Plougoumelen.
const PLOUGOUMELEN: GeoPoint = { lat: 47.6551, lon: -2.8893 };
// 14 Avenue de l’Essai, 89000 Auxerre — the N77 frontage point.
const AUXERRE: GeoPoint = { lat: 47.80365833824555, lon: 3.6194400562899033 };
// 10 allée Voisine LM, 36330 Le Poinçonnet.
const POINCONNET: GeoPoint = { lat: 46.773049, lon: 1.7491 };
// 2 Rue Voisine LBE, 75002 Paris.
const PARIS_2E: GeoPoint = { lat: 48.867, lon: 2.3806 };

/**
 * Clamart: the delivery way runs south and stops at the Rue Voisine T junction
 * node `n-mouth`. Callers vary what continues past it.
 */
function clamartWith(continuation: readonly RoadWay[]): RoadNeighbourhood {
  const prototypeStreet = way(
    'pvc',
    ['n-north', 'n-stop', 'n-mouth'],
    [at(CLAMART, 40, 0), CLAMART, at(CLAMART, -40, 0)],
    { name: 'Rue du Prototype', importance: 5, oneWay: 'no' },
  );
  return neighbourhood(CLAMART, 50, [prototypeStreet, ...continuation]);
}

const CLAMART_INPUT = { wayId: 'pvc', atNodeId: 'n-mouth', maxDeviationDeg: 35 } as const;

describe('assessContinuity', () => {
  it('BUG-037a — continues across a name, importance and one-way change (Clamart / Voisine T)', () => {
    const voisineT = way(
      'voisineT',
      ['n-mouth', 'n-south'],
      [at(CLAMART, -40, 0), at(CLAMART, -90, 0)],
      { name: 'Rue Voisine T', importance: 4, oneWay: 'forward' },
    );

    const result = assessContinuity({ ...CLAMART_INPUT, neighbourhood: clamartWith([voisineT]) });

    expect(result).not.toBeNull();
    expect(result?.establishedBy).toBe('geometric_continuation');
    expect(result?.deviationDeg).toBeCloseTo(0, 3);
    // The whole point: the attribute break is reported, not treated as the end
    // of the road.
    expect(result?.attributeBreak).toBe(true);
  });

  it('BUG-037a — a side arm at the mouth makes it a junction traversal, not a terminus', () => {
    const voisineT = way(
      'voisineT',
      ['n-mouth', 'n-south'],
      [at(CLAMART, -40, 0), at(CLAMART, -90, 0)],
      { name: 'Rue Voisine T', importance: 4 },
    );
    const sideStreet = way(
      'side',
      ['n-mouth', 'n-east'],
      [at(CLAMART, -40, 0), at(CLAMART, -40, 60)],
      { name: 'Rue Latérale', importance: 5 },
    );

    const result = assessContinuity({
      ...CLAMART_INPUT,
      neighbourhood: clamartWith([voisineT, sideStreet]),
    });

    expect(result?.establishedBy).toBe('junction_traversal');
    expect(result?.deviationDeg).toBeCloseTo(0, 3);
  });

  it('BUG-037a — picks the straightest arm, and reads the attribute break off that arm', () => {
    // The turning arm is listed first and carries the same name; a resolver that
    // took the first match, or matched on name, would report the wrong street.
    const turningArm = way(
      'turn',
      ['n-mouth', 'n-west'],
      [at(CLAMART, -40, 0), at(CLAMART, -40, -60)],
      { name: 'Rue du Prototype', importance: 5 },
    );
    const voisineT = way(
      'voisineT',
      ['n-mouth', 'n-south'],
      [at(CLAMART, -40, 0), at(CLAMART, -90, 0)],
      { name: 'Rue Voisine T', importance: 4 },
    );

    const result = assessContinuity({
      ...CLAMART_INPUT,
      neighbourhood: clamartWith([turningArm, voisineT]),
    });

    expect(result?.deviationDeg).toBeCloseTo(0, 3);
    expect(result?.attributeBreak).toBe(true);
  });

  it('BUG-037b — a one-way flip on an otherwise identical street is a break, not a stop (Voisine LBE)', () => {
    const upstream = way(
      'paris2e-upstream',
      ['b1', 'b-split'],
      [at(PARIS_2E, 0, -40), PARIS_2E],
      { name: 'Rue Voisine LBE', importance: 5, oneWay: 'forward' },
    );
    const downstream = way(
      'paris2e-downstream',
      ['b-split', 'b3'],
      [PARIS_2E, at(PARIS_2E, 0, 45)],
      { name: 'Rue Voisine LBE', importance: 5, oneWay: 'backward' },
    );

    const result = assessContinuity({
      neighbourhood: neighbourhood(PARIS_2E, 50, [upstream, downstream]),
      wayId: 'paris2e-upstream',
      atNodeId: 'b-split',
      maxDeviationDeg: 35,
    });

    expect(result?.establishedBy).toBe('geometric_continuation');
    expect(result?.attributeBreak).toBe(true);
  });

  it('BUG-037b / BUG-067 — a pedestrian-tagged continuation still carries the road', () => {
    const upstream = way('paris2e-upstream', ['b1', 'b-split'], [at(PARIS_2E, 0, -40), PARIS_2E], {
      name: 'Rue Voisine LBE',
      tags: { highway: 'residential' },
    });
    const downstream = way('paris2e-downstream', ['b-split', 'b3'], [PARIS_2E, at(PARIS_2E, 0, 45)], {
      name: 'Rue Voisine LBE',
      // OSM calls it a pedestrian zone; G. confirmed it is circulable, so this
      // must not be a Phase 1 hard NO.
      tags: { highway: 'pedestrian' },
    });

    const result = assessContinuity({
      neighbourhood: neighbourhood(PARIS_2E, 50, [upstream, downstream]),
      wayId: 'paris2e-upstream',
      atNodeId: 'b-split',
      maxDeviationDeg: 35,
    });

    expect(result).not.toBeNull();
    expect(result?.attributeBreak).toBe(false);
  });

  it('BUG-048a — an interior shape point is same_way, though it is degree-1 by construction', () => {
    // Way 180628513: node 266147484 is an interior vertex 0.3 m from the stop,
    // referenced by exactly one way. Node degree calls it a tip; it is not.
    const josephLeBrix = way(
      '180628513',
      ['1910645658', '266147484', '331788646'],
      [at(PLOUGOUMELEN, 60, 0), PLOUGOUMELEN, at(PLOUGOUMELEN, -60, 0)],
      { name: 'Rue Voisine LB', importance: 5 },
    );
    const sideImpasse = way(
      'impasse',
      ['1910645658', 'i2'],
      [at(PLOUGOUMELEN, 60, 0), at(PLOUGOUMELEN, 60, 25)],
      { name: 'Impasse Voisine AJ', importance: 5 },
    );

    const result = assessContinuity({
      neighbourhood: neighbourhood(PLOUGOUMELEN, 50, [josephLeBrix, sideImpasse]),
      wayId: '180628513',
      atNodeId: '266147484',
      maxDeviationDeg: 35,
    });

    expect(result?.establishedBy).toBe('same_way');
    expect(result?.deviationDeg).toBeCloseTo(0, 3);
    expect(result?.attributeBreak).toBe(false);
  });

  it('BUG-048a — a bend inside one way is still the same carriageway', () => {
    const bent = way(
      'bent',
      ['a', 'b', 'c'],
      [at(PLOUGOUMELEN, 40, 0), PLOUGOUMELEN, at(PLOUGOUMELEN, -30, 30)],
      { name: 'Rue Coudée' },
    );

    const result = assessContinuity({
      neighbourhood: neighbourhood(PLOUGOUMELEN, 50, [bent]),
      wayId: 'bent',
      atNodeId: 'b',
      // Tighter than the bend: a way does not stop being itself at a corner.
      maxDeviationDeg: 10,
    });

    expect(result?.establishedBy).toBe('same_way');
    expect(result?.deviationDeg).toBeGreaterThan(10);
  });

  it('EC-29 — a same-name spur that turns away does not continue the frontage (Auxerre)', () => {
    // Ways 419782065 (N77 frontage) and 67002480 (spur) share the name
    // `Avenue de l’Essai`. Only geometry separates them.
    const n77 = way(
      '419782065',
      ['a1', 'a-junction'],
      [at(AUXERRE, 0, -60), AUXERRE],
      { name: 'Avenue de l’Essai', importance: 3, tags: { highway: 'primary', ref: 'N 77' } },
    );
    const spur = way(
      '67002480',
      ['a-junction', 'a-tip'],
      [AUXERRE, at(AUXERRE, -46, 0)],
      { name: 'Avenue de l’Essai', importance: 5, tags: { highway: 'unclassified' } },
    );

    const result = assessContinuity({
      neighbourhood: neighbourhood(AUXERRE, 50, [n77, spur]),
      wayId: '419782065',
      atNodeId: 'a-junction',
      maxDeviationDeg: 35,
    });

    // The spur leaves at 90° to the frontage: identical names buy it nothing.
    expect(result).toBeNull();
  });

  it('EC-29 — the same-name spur reaching its own tip has nothing beyond it', () => {
    const spur = way('67002480', ['a-junction', 'a-tip'], [AUXERRE, at(AUXERRE, -46, 0)], {
      name: 'Avenue de l’Essai',
      importance: 5,
    });
    const n77 = way('419782065', ['a1', 'a-junction'], [at(AUXERRE, 0, -60), AUXERRE], {
      name: 'Avenue de l’Essai',
      importance: 3,
    });

    const result = assessContinuity({
      neighbourhood: neighbourhood(AUXERRE, 50, [n77, spur]),
      wayId: '67002480',
      atNodeId: 'a-tip',
      maxDeviationDeg: 35,
    });

    expect(result).toBeNull();
  });

  it('EC-18 / BUG-037c — an exit loop is found from connectivity, with no turning_loop tag', () => {
    const allee = way(
      'louise-michel',
      ['l0', 'l-loop'],
      [at(POINCONNET, 45, 0), POINCONNET],
      { name: 'Allée Voisine LM', importance: 5 },
    );
    // A closed residential way meeting itself at the pocket. No `junction`
    // tag — the common mapping reality the tag-driven detector missed.
    const loop = way(
      'pocket',
      ['l-loop', 'p1', 'p2', 'p3', 'l-loop'],
      [
        POINCONNET,
        at(POINCONNET, -14, 14),
        at(POINCONNET, -28, 0),
        at(POINCONNET, -14, -14),
        POINCONNET,
      ],
      { name: 'Allée Voisine LM', importance: 5 },
    );

    const result = assessContinuity({
      neighbourhood: neighbourhood(POINCONNET, 50, [allee, loop]),
      wayId: 'louise-michel',
      atNodeId: 'l-loop',
      maxDeviationDeg: 50,
    });

    expect(result).not.toBeNull();
    expect(result?.establishedBy).toBe('geometric_continuation');
    expect(result?.deviationDeg).toBeCloseTo(45, 0);
  });

  it('EC-18 — a closed way passes through the node it meets itself at', () => {
    const loop = way(
      'pocket',
      ['l-loop', 'p1', 'p2', 'p3', 'l-loop'],
      [
        POINCONNET,
        at(POINCONNET, -20, 20),
        at(POINCONNET, -40, 0),
        at(POINCONNET, -20, -20),
        POINCONNET,
      ],
      { name: 'Allée Voisine LM' },
    );

    const result = assessContinuity({
      neighbourhood: neighbourhood(POINCONNET, 50, [loop]),
      wayId: 'pocket',
      atNodeId: 'l-loop',
      maxDeviationDeg: 100,
    });

    expect(result?.establishedBy).toBe('same_way');
    expect(result?.attributeBreak).toBe(false);
  });

  it('BUG-065 — continuity is decided at the node, not by where the arm eventually goes', () => {
    // A Paris block loop: the legal one-way continuation curls back towards the
    // stop. Rejecting it here is the over-correction that breaks deliverable
    // addresses.
    const bucherie = way('bucherie', ['p0', 'p-corner'], [at(PARIS_2E, 0, -40), PARIS_2E], {
      name: 'Rue Voisine BU',
      oneWay: 'forward',
    });
    const blockLoop = way(
      'block',
      ['p-corner', 'q1', 'q2', 'q3'],
      [PARIS_2E, at(PARIS_2E, 0, 35), at(PARIS_2E, 35, 35), at(PARIS_2E, 35, -40)],
      { name: 'Rue Voisine FS', oneWay: 'forward' },
    );

    const result = assessContinuity({
      neighbourhood: neighbourhood(PARIS_2E, 60, [bucherie, blockLoop]),
      wayId: 'bucherie',
      atNodeId: 'p-corner',
      maxDeviationDeg: 35,
    });

    expect(result).not.toBeNull();
    expect(result?.deviationDeg).toBeCloseTo(0, 3);
  });

  it('EC-17 / LIG-01 — a genuine cul-de-sac tip with nothing beyond it returns null', () => {
    const impasse = way(
      'treilles',
      ['t0', 't-tip'],
      [{ lat: 46.075556, lon: -1.011659 }, at({ lat: 46.075556, lon: -1.011659 }, -55, 0)],
      { name: 'Impasse Voisine TR', importance: 5, tags: { access: 'destination' } },
    );

    const result = assessContinuity({
      neighbourhood: neighbourhood({ lat: 46.075556, lon: -1.011659 }, 50, [impasse]),
      wayId: 'treilles',
      atNodeId: 't-tip',
      maxDeviationDeg: 35,
    });

    expect(result).toBeNull();
  });

  it('EC-24 — a tip that only continues into a non-drivable way is not a through street', () => {
    for (const highway of ['footway', 'steps', 'path', 'cycleway']) {
      const street = way('street', ['s0', 's-tip'], [at(CLAMART, 45, 0), CLAMART], {
        name: 'Rue Bouchée',
        tags: { highway: 'residential' },
      });
      const onward = way('onward', ['s-tip', 's2'], [CLAMART, at(CLAMART, -45, 0)], {
        tags: { highway },
      });

      const result = assessContinuity({
        neighbourhood: neighbourhood(CLAMART, 50, [street, onward]),
        wayId: 'street',
        atNodeId: 's-tip',
        maxDeviationDeg: 35,
      });

      expect(result, `highway=${highway} must not carry a delivery vehicle`).toBeNull();
    }
  });

  it('TAF-03 — an arm with no highway tag still continues the road (BDTOPO has no OSM class)', () => {
    const street = way('street', ['s0', 's-tip'], [at(CLAMART, 45, 0), CLAMART], {
      name: 'Rue Amont',
      tags: { highway: 'residential' },
    });
    const bdtopoArm = way('TRONROUT0000000042055335', ['s-tip', 's2'], [
      CLAMART,
      at(CLAMART, -45, 0),
    ]);

    const result = assessContinuity({
      neighbourhood: neighbourhood(CLAMART, 50, [street, bdtopoArm]),
      wayId: 'street',
      atNodeId: 's-tip',
      maxDeviationDeg: 35,
    });

    expect(result).not.toBeNull();
    expect(result?.establishedBy).toBe('geometric_continuation');
  });

  it("BUG-003 — a tip clipped at the fetch boundary returns null; interiority is the caller's call", () => {
    // Way 180628513 clipped at 50 m: nothing continues it *in this payload*, and
    // this function cannot and must not invent a continuation. Whether the tip
    // is interior to the fetch is decided with the radius, elsewhere.
    const clipped = way(
      '180628513',
      ['clip-north', '1910645658', 'clip-south'],
      [at(PLOUGOUMELEN, 48, 0), PLOUGOUMELEN, at(PLOUGOUMELEN, -48, 0)],
      { name: 'Rue Voisine LB' },
    );
    const fetched = neighbourhood(PLOUGOUMELEN, 50, [clipped]);

    expect(
      assessContinuity({
        neighbourhood: fetched,
        wayId: '180628513',
        atNodeId: 'clip-north',
        maxDeviationDeg: 35,
      }),
    ).toBeNull();
    expect(
      assessContinuity({
        neighbourhood: fetched,
        wayId: '180628513',
        atNodeId: 'clip-south',
        maxDeviationDeg: 35,
      }),
    ).toBeNull();
  });

  it("maxDeviationDeg is the caller's parameter, not a constant in here", () => {
    const street = way('street', ['s0', 's-bend'], [at(CLAMART, 45, 0), CLAMART], {
      name: 'Rue Amont',
    });
    // Leaves 40° off the arrival heading.
    const onward = way('onward', ['s-bend', 's2'], [CLAMART, at(CLAMART, -38.3, -32.1)], {
      name: 'Rue Aval',
    });
    const fixture = neighbourhood(CLAMART, 50, [street, onward]);

    const generous = assessContinuity({
      neighbourhood: fixture,
      wayId: 'street',
      atNodeId: 's-bend',
      maxDeviationDeg: 45,
    });
    const strict = assessContinuity({
      neighbourhood: fixture,
      wayId: 'street',
      atNodeId: 's-bend',
      maxDeviationDeg: 30,
    });

    expect(generous?.deviationDeg).toBeCloseTo(40, 0);
    expect(strict).toBeNull();
  });

  it('reports an importance-only change as an attribute break', () => {
    const upstream = way('up', ['u0', 'u-split'], [at(CLAMART, 45, 0), CLAMART], {
      name: 'Avenue Continue',
      importance: 4,
    });
    const downstream = way('down', ['u-split', 'u2'], [CLAMART, at(CLAMART, -45, 0)], {
      name: 'Avenue Continue',
      importance: 3,
    });

    const result = assessContinuity({
      neighbourhood: neighbourhood(CLAMART, 50, [upstream, downstream]),
      wayId: 'up',
      atNodeId: 'u-split',
      maxDeviationDeg: 35,
    });

    expect(result?.attributeBreak).toBe(true);
  });

  it('treats case and diacritics as transcription, and an unknown importance as no statement', () => {
    const upstream = way('up', ['u0', 'u-split'], [at(AUXERRE, 0, -45), AUXERRE], {
      name: 'Avenue de l’Été',
      importance: 3,
    });
    const downstream = way('down', ['u-split', 'u2'], [AUXERRE, at(AUXERRE, 0, 45)], {
      name: 'AVENUE DE L’ETE',
      importance: null,
    });

    const result = assessContinuity({
      neighbourhood: neighbourhood(AUXERRE, 50, [upstream, downstream]),
      wayId: 'up',
      atNodeId: 'u-split',
      maxDeviationDeg: 35,
    });

    expect(result?.attributeBreak).toBe(false);
  });

  it('reports no attribute break when both ways are anonymous', () => {
    const upstream = way('up', ['u0', 'u-split'], [at(CLAMART, 45, 0), CLAMART]);
    const downstream = way('down', ['u-split', 'u2'], [CLAMART, at(CLAMART, -45, 0)]);

    const result = assessContinuity({
      neighbourhood: neighbourhood(CLAMART, 50, [upstream, downstream]),
      wayId: 'up',
      atNodeId: 'u-split',
      maxDeviationDeg: 35,
    });

    expect(result?.attributeBreak).toBe(false);
  });

  it('returns null for a way or a node the payload does not contain', () => {
    const fixture = clamartWith([]);

    expect(
      assessContinuity({ ...CLAMART_INPUT, neighbourhood: fixture, wayId: 'absent' }),
    ).toBeNull();
    expect(
      assessContinuity({ ...CLAMART_INPUT, neighbourhood: fixture, atNodeId: 'absent' }),
    ).toBeNull();
  });

  it('returns null when the delivery way has no direction to continue', () => {
    const degenerate = way('point', ['only'], [CLAMART], { name: 'Rue Ponctuelle' });
    const onward = way('onward', ['only', 'o2'], [CLAMART, at(CLAMART, -45, 0)]);

    const result = assessContinuity({
      neighbourhood: neighbourhood(CLAMART, 50, [degenerate, onward]),
      wayId: 'point',
      atNodeId: 'only',
      maxDeviationDeg: 35,
    });

    expect(result).toBeNull();
  });
});
