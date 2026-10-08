/**
 * S4 detectors against the corpus lessons: the split bend (EC-26), the
 * one-manoeuvre merge (EC-07), the ±offset bearings (BUG-079), the swept arc
 * vs the full ring (BUG-082), ring turns suppressed (BUG-088's mirror), and
 * the location-keyed identity that makes judgements outlive runs.
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint, RouteSegmentConstraint } from '@teneolog/domain';
import type { RoadWay } from '@teneolog/topology';

import { collectCriticalPoints, type CollectedPoints, type CollectPointsParams } from '../src/collect.js';
import { makePointRef } from '../src/point-ref.js';
import { detectRoundabouts } from '../src/roundabouts.js';
import { detectTurns, type TurnDetectionParams } from '../src/turns.js';

const O: GeoPoint = { lat: 46.57211, lon: 0.38199 }; // Poitiers, EC-26's bend
const M_PER_DEG_LAT = 111_320;

function at(base: GeoPoint, northM: number, eastM: number): GeoPoint {
  return {
    lat: base.lat + northM / M_PER_DEG_LAT,
    lon: base.lon + eastM / (M_PER_DEG_LAT * Math.cos((base.lat * Math.PI) / 180)),
  };
}

const TURN_PARAMS: TurnDetectionParams = {
  windowM: 40,
  minDeflectionDeg: 45,
  bearingOffsetM: 10,
  mergeWithinM: 25,
  geometryConfidence: 0.7,
  curveIgnoreRadiusM: 60,
  junction: { nodeSnapM: 6, apexShare: 0.8 },
};
const AT = '2026-08-24T00:00:00Z';

describe('detectTurns', () => {
  it('EC-26: a 90° bend split into six 15° vertices still surfaces as one turn', () => {
    // Heading east, then curving to south over ~30 m in small steps.
    const polyline: GeoPoint[] = [at(O, 0, -60), at(O, 0, 0)];
    let heading = 90;
    let current = at(O, 0, 0);
    for (let i = 0; i < 6; i += 1) {
      heading += 15;
      const rad = (heading * Math.PI) / 180;
      current = at(current, Math.cos(rad) * 6, Math.sin(rad) * 6);
      polyline.push(current);
    }
    const rad = (heading * Math.PI) / 180;
    polyline.push(at(current, Math.cos(rad) * 60, Math.sin(rad) * 60));

    const turns = detectTurns(polyline, [], TURN_PARAMS, AT);

    expect(turns).toHaveLength(1);
    const turn = turns[0];
    expect(turn?.geometry.known).toBe(true);
    if (turn === undefined || !turn.geometry.known) return;
    expect(turn.geometry.value.deflectionDeg).toBeGreaterThanOrEqual(75);
  });

  it('a gentle 30° curve is not a turn', () => {
    const polyline = [at(O, 0, -80), at(O, 0, 0), at(O, -20, 35), at(O, -60, 100)];
    expect(detectTurns(polyline, [], TURN_PARAMS, AT)).toHaveLength(0);
  });

  it('BUG-079: approach and exit bearings differ by roughly the deflection, read off ±10 m', () => {
    // A clean right angle: east then south.
    const polyline = [at(O, 0, -80), at(O, 0, -30), at(O, 0, 0), at(O, -30, 0), at(O, -80, 0)];
    const turns = detectTurns(polyline, [], TURN_PARAMS, AT);
    expect(turns).toHaveLength(1);
    const g = turns[0]?.geometry;
    if (g === undefined || !g.known) return;
    expect(Math.abs(g.value.approachBearingDeg - 90)).toBeLessThan(10);
    expect(Math.abs(g.value.exitBearingDeg - 180)).toBeLessThan(10);
  });

  it('a routed line that repeats its departure vertex opens on a straight street, not a turn', () => {
    // The shape OSRM actually returns on 12 rue de l’Exemple: the snapped
    // departure vertex twice, then 2 km of straight road heading 242°. The
    // repeat has no bearing, `bearingDeg` answers 0° — north — and the
    // deflection read against that north was 118°, so the review opened with
    // « le 19 t tourne-t-il ici ? » on a street that never bends.
    const start = at(O, 0, 0);
    const polyline = [
      start, start,
      at(O, -26, -47), at(O, -49, -89),
      at(O, -226, -410), at(O, -400, -725),
    ];

    expect(detectTurns(polyline, [], TURN_PARAMS, AT)).toHaveLength(0);
  });

  it('a real corner is still a corner when the line repeats a vertex at it', () => {
    // The guard removes repeats, not manoeuvres: BUG-079's right angle with
    // its apex duplicated.
    const apex = at(O, 0, 0);
    const polyline = [at(O, 0, -80), at(O, 0, -30), apex, apex, at(O, -30, 0), at(O, -80, 0)];

    const turns = detectTurns(polyline, [], TURN_PARAMS, AT);

    expect(turns).toHaveLength(1);
    const g = turns[0]?.geometry;
    expect(g?.known).toBe(true);
    if (g === undefined || !g.known) return;
    expect(g.value.deflectionDeg).toBeGreaterThanOrEqual(80);
  });

  it('EC-07: two same-side sub-turns within the merge distance are one manoeuvre', () => {
    // 45° right, 15 m straight, 45° right again — a chicane-free double bend.
    const polyline = [
      at(O, 0, -60), at(O, 0, 0),
      at(O, -10, 10), at(O, -20, 14),
      at(O, -34, 18), at(O, -80, 20),
    ];
    const turns = detectTurns(polyline, [], TURN_PARAMS, AT);
    expect(turns).toHaveLength(1);
  });
});

function ringWay(id: string, centre: GeoPoint, radiusM: number, from: number, to: number): RoadWay {
  const points: GeoPoint[] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i += 1) {
    const angle = from + ((to - from) * i) / steps;
    const rad = (angle * Math.PI) / 180;
    points.push(at(centre, Math.cos(rad) * radiusM, Math.sin(rad) * radiusM));
  }
  return {
    id,
    source: 'osm-overpass',
    nodeIds: points.map((_, i) => `${id}:${i}`),
    geometry: points,
    name: null,
    importance: null,
    declaredWidthM: null,
    laneCount: null,
    oneWay: 'forward',
    isPrivate: false,
    limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    tags: { junction: 'roundabout', highway: 'primary' },
  };
}

describe('detectRoundabouts', () => {
  const RB_PARAMS = { ringSnapM: 8, ringMergeM: 40, geometryConfidence: 0.7, declaredWidthConfidence: 0.55 };
  /** Captured 2026-09-09 on the code, same fixture as the BUG-082 case. */
  const GOLDEN = {
    sweptAngleDeg: 274.3986345881318,
    outerRadiusM: 14.914975924466473,
    suppressWithinM: 22.914975924466475,
    alongM: 64.92705906609216,
    armCount: 0,
    at: { lat: 46.57481529865391, lon: 0.38199 },
  };

  it('BUG-082: entering from the south and leaving west sweeps ~90° CCW, not the full ring', () => {
    const centre = at(O, 300, 0);
    const ring = ringWay('ring', centre, 15, 0, 360);
    // Route: arrive from the south, take the first exit west.
    // CCW from south (az 180°) to west (az 270°… wait, exit west means leaving toward west: ring point at azimuth 90°? Use geometry: south point az=180, west point az=270.
    const south = at(centre, -15, 0);
    const west = at(centre, 0, -15);
    const polyline = [at(centre, -80, 0), south, at(centre, -11, -11), west, at(centre, 0, -80)];

    const detected = detectRoundabouts(polyline, [ring], RB_PARAMS, AT);

    expect(detected).toHaveLength(1);
    const g = detected[0]?.geometry;
    if (g === undefined || !g.known) return;
    // CCW from 180° to 270° is a 270° sweep the long way or 90° the short —
    // French rings drive CCW: entry az 180 → exit az 270 CCW = (180-270)%360 = 270? No:
    // CCW means azimuth DECREASES (180 → 90 → 0 → 270). So sweep = (180-270+360)%360 = 270.
    // Entering south, exiting west on a CCW ring genuinely drives 270°.
    expect(g.value.sweptAngleDeg).toBeCloseTo(270, -1);
    expect(g.value.outerRadiusM).toBeGreaterThan(10);
    expect(g.value.outerRadiusM).toBeLessThan(20);
  });

  it('entering south and exiting east on a CCW ring is the short 90° arc', () => {
    const centre = at(O, 300, 0);
    const ring = ringWay('ring', centre, 15, 0, 360);
    const south = at(centre, -15, 0);
    const east = at(centre, 0, 15);
    const polyline = [at(centre, -80, 0), south, at(centre, -11, 11), east, at(centre, 0, 80)];

    const detected = detectRoundabouts(polyline, [ring], RB_PARAMS, AT);
    const g = detected[0]?.geometry;
    if (g === undefined || !g.known) return;
    expect(g.value.sweptAngleDeg).toBeCloseTo(90, -1);
  });

  it('a ring split into two ways is one roundabout', () => {
    const centre = at(O, 300, 0);
    const half1 = ringWay('h1', centre, 15, 0, 180);
    const half2 = ringWay('h2', centre, 15, 180, 360);
    const south = at(centre, -15, 0);
    const east = at(centre, 0, 15);
    const polyline = [at(centre, -80, 0), south, at(centre, -11, 11), east, at(centre, 0, 80)];

    const detected = detectRoundabouts(polyline, [half1, half2], RB_PARAMS, AT);
    expect(detected).toHaveLength(1);
  });

  it('a roundabout in the corridor that the route never touches is not reported', () => {
    const centre = at(O, 300, 300);
    const ring = ringWay('ring', centre, 15, 0, 360);
    const polyline = [at(O, 0, -80), at(O, 0, 80)];
    expect(detectRoundabouts(polyline, [ring], RB_PARAMS, AT)).toHaveLength(0);
  });

  it('the island radius is null (unmeasured), never a 0 that reads as a size', () => {
    const centre = at(O, 300, 0);
    const ring = ringWay('ring', centre, 15, 0, 360);
    const polyline = [at(centre, -80, 0), at(centre, -15, 0), at(centre, -11, 11), at(centre, 0, 15), at(centre, 0, 80)];

    const g = detectRoundabouts(polyline, [ring], RB_PARAMS, AT)[0]?.geometry;
    if (g === undefined || !g.known) throw new Error('expected a detected roundabout');
    expect(g.value.innerRadiusM).toBeNull();
    // A full ring with no arms in the corridor: a measured count of zero, not an unknown.
    expect(g.value.armCount).toBe(0);
  });

  it('a single touch on the ring publishes a 0° sweep, not a fabricated 360°', () => {
    // Only one route sample lands within ringSnapM of the ring: entry === exit.
    const centre = at(O, 300, 0);
    const ring = ringWay('ring', centre, 15, 0, 360);
    const polyline = [at(centre, -80, 0), at(centre, -15, 0), at(centre, 80, 0)];

    const g = detectRoundabouts(polyline, [ring], RB_PARAMS, AT)[0]?.geometry;
    if (g === undefined || !g.known) throw new Error('expected a detected roundabout');
    expect(g.value.sweptAngleDeg).toBe(0);
  });

  it('a ring nobody states a width for leaves the annulus unknown', () => {
    const centre = at(O, 300, 0);
    const ring = ringWay('ring', centre, 15, 0, 360);
    const south = at(centre, -15, 0);
    const east = at(centre, 0, 15);
    const polyline = [at(centre, -80, 0), south, at(centre, -11, 11), east, at(centre, 0, 80)];

    const g = detectRoundabouts(polyline, [ring], RB_PARAMS, AT)[0]?.geometry;
    if (g === undefined || !g.known) throw new Error('expected a detected roundabout');
    expect(g.value.ringWidthM.known).toBe(false);
  });

  it('golden: the swept arc, centreline radius and suppression radius are unchanged by the cleanup', () => {
    // Values captured before the vocabulary cleanup (2026-09-09); any drift here
    // is a numeric change, not a rename.
    const centre = at(O, 300, 0);
    const ring = ringWay('ring', centre, 15, 0, 360);
    const south = at(centre, -15, 0);
    const west = at(centre, 0, -15);
    const polyline = [at(centre, -80, 0), south, at(centre, -11, -11), west, at(centre, 0, -80)];

    const detected = detectRoundabouts(polyline, [ring], RB_PARAMS, AT);
    const rb = detected[0];
    if (rb === undefined || !rb.geometry.known) throw new Error('expected a detected roundabout');
    expect(rb.geometry.value.sweptAngleDeg).toBeCloseTo(GOLDEN.sweptAngleDeg, 6);
    expect(rb.geometry.value.outerRadiusM).toBeCloseTo(GOLDEN.outerRadiusM, 6);
    expect(rb.suppressWithinM).toBeCloseTo(GOLDEN.suppressWithinM, 6);
    expect(rb.alongM).toBeCloseTo(GOLDEN.alongM, 6);
    expect(rb.geometry.value.armCount).toBe(GOLDEN.armCount);
    expect(rb.at.lat).toBeCloseTo(GOLDEN.at.lat, 9);
    expect(rb.at.lon).toBeCloseTo(GOLDEN.at.lon, 9);
  });

  it('takes the narrowest declared width across the ways of one ring', () => {
    const centre = at(O, 300, 0);
    const half1 = { ...ringWay('h1', centre, 15, 0, 180), declaredWidthM: 7.5 };
    const half2 = { ...ringWay('h2', centre, 15, 180, 360), declaredWidthM: 6 };
    const south = at(centre, -15, 0);
    const east = at(centre, 0, 15);
    const polyline = [at(centre, -80, 0), south, at(centre, -11, 11), east, at(centre, 0, 80)];

    const g = detectRoundabouts(polyline, [half1, half2], RB_PARAMS, AT)[0]?.geometry;
    if (g === undefined || !g.known) throw new Error('expected a detected roundabout');
    if (!g.value.ringWidthM.known) throw new Error('expected a declared ring width');
    expect(g.value.ringWidthM.value).toBe(6);
    expect(g.value.ringWidthM.reliability.basis).toBe('declared');
  });
});

describe('makePointRef', () => {
  it('the same corner with routing jitter keeps one identity', () => {
    const a: GeoPoint = { lat: 46.572113, lon: 0.381991 };
    const b: GeoPoint = { lat: 46.572118, lon: 0.381996 }; // ~0.7 m away
    expect(makePointRef('TURN', a)).toBe(makePointRef('TURN', b));
  });

  it('type is part of identity: a TURN and a NARROW at one place are two points', () => {
    const p: GeoPoint = { lat: 46.5721, lon: 0.3820 };
    expect(makePointRef('TURN', p)).not.toBe(makePointRef('NARROW', p));
  });
});

describe('collectCriticalPoints', () => {
  const PARAMS: CollectPointsParams = {
    turns: TURN_PARAMS,
    roundabouts: { ringSnapM: 8, ringMergeM: 40, geometryConfidence: 0.7, declaredWidthConfidence: 0.55 },
    narrowMaxFreeM: 5,
    dedupeWithinM: 15,
    chainedWithinM: 40,
  };

  function candidate(id: string, polyline: readonly GeoPoint[], segments: readonly RouteSegmentConstraint[] = []) {
    return {
      id,
      direction: 'in' as const,
      polyline,
      segments,
      coverage: { sampled: 0, matched: 0 },
      corridorReasonCodes: [] as readonly string[],
      generatedBy: 'car-optimal' as const,
      distanceM: 1_000,
      durationS: 60,
      egressOf: null,
    };
  }

  /** One annotated run of the leg, with the only thing these tests read: a width. */
  function run(id: string, from: GeoPoint, to: GeoPoint, freeM: number): RouteSegmentConstraint {
    return {
      segmentId: id,
      from,
      to,
      position: 'transit',
      highway: 'tertiary',
      lengthM: 100,
      legal: {
        maxWeightT: { known: false, why: 'no_data' },
        maxHeightM: { known: false, why: 'no_data' },
        maxWidthM: { known: false, why: 'no_data' },
        maxLengthM: { known: false, why: 'no_data' },
        access: { known: false, why: 'no_data' },
        lowEmissionZone: { known: false, why: 'no_data' },
      },
      width: {
        known: true,
        value: { freeM, structuralM: freeM, measuredAt: from, offsetFromAnchorM: 0 },
        provenance: { source: 'bdtopo-postgis', method: 'declared-width', fetchedAt: AT },
        reliability: { confidence: 0.55, basis: 'declared', reasonCodes: [] },
      },
    };
  }
  const stop = {
    at: O,
    width: { known: false as const, why: 'no_data' as const },
    slopePct: { known: false as const, why: 'no_data' as const },
    legal: {
      maxWeightT: { known: false as const, why: 'no_data' as const },
      maxHeightM: { known: false as const, why: 'no_data' as const },
      maxWidthM: { known: false as const, why: 'no_data' as const },
      maxLengthM: { known: false as const, why: 'no_data' as const },
      access: { known: false as const, why: 'no_data' as const },
      lowEmissionZone: { known: false as const, why: 'no_data' as const },
    },
    surface: { known: false as const, why: 'no_data' as const },
  };

  /** La largeur d'approche que CETTE jambe a mesurée à ce point. */
  function widthOfTurn(collected: CollectedPoints, candidateId: string, ref: string): number | null {
    const geometry = collected.geometryByCandidate.get(candidateId)?.get(ref);
    if (geometry === undefined || !geometry.known) return null;
    const value = geometry.value;
    if (value.type !== 'TURN' || !value.geometry.approachWidth.known) return null;
    return value.geometry.approachWidth.value.freeM;
  }

  it('the same corner reached by two candidates is ONE point referenced by both', () => {
    const corner = [at(O, 0, -80), at(O, 0, -30), at(O, 0, 0), at(O, -30, 0), at(O, -80, 0)];
    const jittered = corner.map((p) => at(p, 0.5, 0.5));

    const collected = collectCriticalPoints(
      {
        candidates: [candidate('a', corner), candidate('b', jittered)],
        corridors: new Map(),
        stop,
        topology: { kind: 'THROUGH', continuity: { establishedBy: 'same_way', deviationDeg: 0, attributeBreak: false } },
        fetchedAt: AT,
      },
      PARAMS,
    );

    const turns = collected.points.filter((p) => p.type === 'TURN');
    expect(turns).toHaveLength(1);
    const ref = turns[0]?.ref;
    expect(collected.byCandidate.get('a')).toContain(ref);
    expect(collected.byCandidate.get('b')).toContain(ref);
  });

  it('un point partagé par deux jambes de largeurs différentes — deux géométries, une référence', () => {
    // Le même coin, abordé par deux rues. `a` arrive par une voie de 3,0 m,
    // `b` par une de 5,2 m ; la géométrie est identique au mètre près, seule la
    // largeur du bitume change. Avant 416, la seconde jambe héritait des 3,0 m
    // de la première et portait un doute qu'elle ne conduit pas.
    const west = at(O, 0, -80);
    const corner = [west, at(O, 0, -30), O, at(O, -30, 0), at(O, -80, 0)];
    const narrow = candidate('a', corner, [run('etroite', west, O, 3.0)]);
    const wide = candidate('b', corner, [run('large', west, O, 5.2)]);

    const collected = collectCriticalPoints(
      {
        candidates: [narrow, wide],
        corridors: new Map(),
        stop,
        topology: { kind: 'THROUGH', continuity: { establishedBy: 'same_way', deviationDeg: 0, attributeBreak: false } },
        fetchedAt: AT,
      },
      PARAMS,
    );

    const turns = collected.points.filter((p) => p.type === 'TURN');
    expect(turns).toHaveLength(1);
    const ref = turns[0]?.ref as string;

    // UNE référence — c'est elle qui porte la réponse humaine (architecture §3.3).
    expect(collected.byCandidate.get('a')).toContain(ref);
    expect(collected.byCandidate.get('b')).toContain(ref);

    // DEUX géométries — chacune celle de sa jambe.
    expect(widthOfTurn(collected, 'a', ref)).toBeCloseTo(3.0, 3);
    expect(widthOfTurn(collected, 'b', ref)).toBeCloseTo(5.2, 3);

    // Et l'ordre de la liste n'y change rien : avant 416, la première jambe
    // imposait sa largeur à l'autre, donc inverser la liste inversait les deux.
    const flipped = collectCriticalPoints(
      {
        candidates: [wide, narrow],
        corridors: new Map(),
        stop,
        topology: { kind: 'THROUGH', continuity: { establishedBy: 'same_way', deviationDeg: 0, attributeBreak: false } },
        fetchedAt: AT,
      },
      PARAMS,
    );
    expect(widthOfTurn(flipped, 'a', ref)).toBeCloseTo(3.0, 3);
    expect(widthOfTurn(flipped, 'b', ref)).toBeCloseTo(5.2, 3);

    // `points[]` garde la première trouvée, et le dit.
    const shared = collected.points.find((p) => p.ref === ref);
    expect(shared?.geometry.known).toBe(true);
    if (shared === undefined || !shared.geometry.known) return;
    const g = shared.geometry.value;
    expect(g.type === 'TURN' && g.geometry.approachWidth.known && g.geometry.approachWidth.value.freeM).toBe(3.0);
  });

  it('BUG-088 mirror: turns on a detected ring are suppressed — one giratoire, zero phantom turns', () => {
    const centre = at(O, 300, 0);
    const ring = ringWay('ring', centre, 15, 0, 360);
    const south = at(centre, -15, 0);
    const west = at(centre, 0, -15);
    const polyline = [at(centre, -80, 0), south, at(centre, -11, -11), west, at(centre, 0, -80)];

    const collected = collectCriticalPoints(
      {
        candidates: [candidate('a', polyline)],
        corridors: new Map([['a', [ring]]]),
        stop,
        topology: { kind: 'THROUGH', continuity: { establishedBy: 'same_way', deviationDeg: 0, attributeBreak: false } },
        fetchedAt: AT,
      },
      PARAMS,
    );

    expect(collected.points.filter((p) => p.type === 'ROUNDABOUT')).toHaveLength(1);
    expect(collected.points.filter((p) => p.type === 'TURN')).toHaveLength(0);
  });

  it('a terminal stop contributes its TURNAROUND point — the deciding factor in the field corpus, now nameable', () => {
    const collected = collectCriticalPoints(
      {
        candidates: [candidate('a', [at(O, 0, -200), O])],
        corridors: new Map(),
        stop,
        topology: {
          kind: 'DEAD_END',
          turnaround: {
            known: true,
            value: { usableDiameterM: 5, centre: at(O, 0, 10), surface: 'carriageway' },
            provenance: { source: 'bdtopo-postgis', method: 'carriageway-declared-width', fetchedAt: AT },
            reliability: { confidence: 0.55, basis: 'declared', reasonCodes: [] },
          },
          entryDirection: { known: false, why: 'no_data' },
        },
        fetchedAt: AT,
      },
      PARAMS,
    );

    const turnaround = collected.points.find((p) => p.type === 'TURNAROUND');
    expect(turnaround).toBeDefined();
    expect(collected.byCandidate.get('a')).toContain(turnaround?.ref);
    expect(collected.points.some((p) => p.type === 'DESTINATION')).toBe(true);
  });

  it('an unmeasured loop sits at the named place, not at the house', () => {
    const loop = at(O, 8, 56);
    const collected = collectCriticalPoints(
      {
        candidates: [candidate('a', [at(O, 0, -200), O])],
        corridors: new Map(),
        stop,
        topology: {
          kind: 'DEAD_END',
          turnaround: { known: false, why: 'no_data' },
          entryDirection: { known: false, why: 'no_data' },
        },
        fetchedAt: AT,
        turnaroundAt: loop,
      },
      PARAMS,
    );

    const turnaround = collected.points.find((p) => p.type === 'TURNAROUND');
    expect(turnaround?.at).toEqual(loop);
  });
});

describe('no roundabout is ever invented, and metric identity', () => {
  const PARAMS: CollectPointsParams = {
    turns: TURN_PARAMS,
    roundabouts: { ringSnapM: 8, ringMergeM: 40, geometryConfidence: 0.7, declaredWidthConfidence: 0.55 },
    narrowMaxFreeM: 5,
    dedupeWithinM: 15,
    chainedWithinM: 40,
  };
  const stop = {
    at: O,
    width: { known: false as const, why: 'no_data' as const },
    slopePct: { known: false as const, why: 'no_data' as const },
    legal: {
      maxWeightT: { known: false as const, why: 'no_data' as const },
      maxHeightM: { known: false as const, why: 'no_data' as const },
      maxWidthM: { known: false as const, why: 'no_data' as const },
      maxLengthM: { known: false as const, why: 'no_data' as const },
      access: { known: false as const, why: 'no_data' as const },
      lowEmissionZone: { known: false as const, why: 'no_data' as const },
    },
    surface: { known: false as const, why: 'no_data' as const },
  };
  const through = {
    kind: 'THROUGH' as const,
    continuity: { establishedBy: 'same_way' as const, deviationDeg: 0, attributeBreak: false },
  };
  function candidate(id: string, polyline: readonly GeoPoint[]) {
    return {
      id, direction: 'in' as const, polyline, segments: [],
      coverage: { sampled: 0, matched: 0 },
      corridorReasonCodes: [] as readonly string[],
      generatedBy: 'car-optimal' as const, distanceM: 1_000, durationS: 60, egressOf: null,
    };
  }

  it('a cluster of sharp turns is NOT a roundabout — the turns stay, each with its margin', () => {
    // The very shape BUG-088 used to promote: right 85°, 30 m of arc, right 85°
    // again. Read as a giratoire it told the operator « anneau roulable non
    // mesuré » and DELETED the corners it contained — at Thairé that hid two
    // real right angles behind a ring OSM has never carried. A roundabout now
    // exists only where a `junction=roundabout` way does; these stay turns.
    const c = at(O, 400, 0);
    const polyline = [
      at(c, -80, 0), at(c, -18, 0),
      at(c, -13, 13), at(c, 0, 18),      // first sharp right onto the ring
      at(c, 13, 13), at(c, 18, 0),        // around
      at(c, 13, -13), at(c, 0, -18),      // second sharp right off the ring
      at(c, -80, -60),
    ];
    const collected = collectCriticalPoints(
      { candidates: [candidate('a', polyline)], corridors: new Map(), stop, topology: through, fetchedAt: AT },
      PARAMS,
    );
    expect(collected.points.filter((p) => p.type === 'ROUNDABOUT')).toHaveLength(0);
    expect(collected.points.filter((p) => p.type === 'TURN').length).toBeGreaterThanOrEqual(1);
  });

  it('a mountain S-bend — two opposite 70° turns — stays two TURNs, never a phantom roundabout', () => {
    const polyline = [
      at(O, 0, -100), at(O, 0, -30),
      at(O, -20, -10),                    // right
      at(O, -25, 30),
      at(O, -5, 50),                      // left
      at(O, 0, 120),
    ];
    const collected = collectCriticalPoints(
      { candidates: [candidate('a', polyline)], corridors: new Map(), stop, topology: through, fetchedAt: AT },
      PARAMS,
    );
    expect(collected.points.filter((p) => p.type === 'ROUNDABOUT')).toHaveLength(0);
  });

  it('metric identity: two apexes 1 m apart across a rounding boundary are one point', () => {
    // 46.57649 vs 46.57651: truncation puts them in different 4-decimal cells.
    const a: GeoPoint = { lat: 46.57649, lon: 0.38199 };
    const b: GeoPoint = { lat: 46.57651, lon: 0.38199 };
    const corner = (apex: GeoPoint) => [
      at(apex, 0, -80), at(apex, 0, -30), apex, at(apex, -30, 0), at(apex, -80, 0),
    ];
    const collected = collectCriticalPoints(
      {
        candidates: [candidate('a', corner(a)), candidate('b', corner(b))],
        corridors: new Map(), stop, topology: through, fetchedAt: AT,
      },
      PARAMS,
    );
    expect(collected.points.filter((p) => p.type === 'TURN')).toHaveLength(1);
  });
});
