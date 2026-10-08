/**
 * S7 — the scene builder over minimal inputs. The package had no test at all
 * (audit 2026-09): these pin the contract the API relies on — frame
 * passthrough, one marker per point, the polygon kinds each point type emits,
 * and the three attack-angle variants of a turn on its route spine.
 */
import type { CriticalPoint, Fact, TruckProfile, Width } from '@teneolog/domain';
import { describe, expect, it } from 'vitest';

import {
  anticipatedSpine,
  buildReviewScene,
  buildTurnApproachVariants,
  type StitchedFrameInput,
} from '../src/index.js';

const AT = { lat: 46.0735, lon: -0.9635 };

const TRUCK: TruckProfile = {
  id: 'pl-19t',
  label: 'Porteur 19 t',
  family: 'rigid',
  envelope: {
    lengthM: 10.5,
    widthM: 2.55,
    heightM: 3.8,
    gvwT: 19,
    turnRadiusM: 10.3,
    wheelbaseM: 5.6,
    frontOverhangM: 1.4,
    rearOverhangM: 3.5,
  },
  equipment: { tailLift: true, crane: false, refrigerated: false },
};

// A single 512 px tile centred on AT, 10 px per metre.
const FRAME: StitchedFrameInput = {
  tile: { latA: AT.lat, lngA: AT.lon, dx2Px: 0, dy2Px: 0, dx3Px: 0, dy3Px: 0 },
  pxPerM: 10,
  bearingDeg: 0,
  pngBase64: 'iVBORw0KGgo=',
  widthPx: 512,
  heightPx: 512,
};

// Local metres, image convention (y down): 30 m due north then 30 m east,
// the corner at the origin (the reviewed point).
const SPINE = [
  { x: 0, y: 30 },
  { x: 0, y: 15 },
  { x: 0, y: 0 },
  { x: 15, y: 0 },
  { x: 30, y: 0 },
];

function width(freeM: number): Fact<Width> {
  return {
    known: true,
    value: { freeM, structuralM: freeM, measuredAt: AT, offsetFromAnchorM: 0 },
    provenance: { source: 'ign-ortho', method: 'd10-stitched', fetchedAt: 'x' },
    reliability: { confidence: 0.7, basis: 'measured', reasonCodes: [] },
  };
}

function turnPoint(): CriticalPoint {
  return {
    ref: 'TURN@46.0735,-0.9635',
    type: 'TURN',
    at: AT,
    geometry: {
      known: true,
      value: {
        type: 'TURN',
        geometry: {
          apex: AT,
          deflectionDeg: 90,
          approachBearingDeg: 90,
          exitBearingDeg: 180,
          kind: 'junction',
          arcLengthM: 20,
          radiusM: null,
          chainedWithPreviousM: null,
          approachWidth: width(6),
          exitWidth: width(6),
        },
      },
      provenance: { source: 'osrm', method: 'route-geometry', fetchedAt: 'x' },
      reliability: { confidence: 0.7, basis: 'derived', reasonCodes: [] },
    },
    evidence: [],
  };
}

function turnaroundPoint(): CriticalPoint {
  return {
    ref: 'TURNAROUND@46.0735,-0.9635',
    type: 'TURNAROUND',
    at: AT,
    geometry: {
      known: true,
      value: {
        type: 'TURNAROUND',
        geometry: {
          surface: { usableDiameterM: 16, areaM2: null, polygon: null, occupancy: 'unassessed' },
          requiresReversingM: 0,
          beyondStop: false,
          distanceFromStopM: 12,
          provenTopology: true,
        },
      },
      provenance: { source: 'bdtopo-postgis', method: 'dead-end', fetchedAt: 'x' },
      reliability: { confidence: 0.7, basis: 'derived', reasonCodes: [] },
    },
    evidence: [],
  };
}

const kinds = (scene: ReturnType<typeof buildReviewScene>) =>
  new Set(scene.polygons.map((p) => p.kind));

describe('buildReviewScene', () => {
  it('carries the frame through and anchors the point marker at the tile centre', () => {
    const scene = buildReviewScene(turnPoint(), TRUCK, FRAME);
    expect(scene.pointRef).toBe('TURN@46.0735,-0.9635');
    expect(scene.truckId).toBe('pl-19t');
    expect(scene.imagePngBase64).toBe(FRAME.pngBase64);
    expect(scene.frame).toMatchObject({ pxPerM: 10, widthPx: 512, heightPx: 512, latA: AT.lat });
    const marker = scene.markers.find((m) => m.kind === 'point');
    expect(marker).toBeDefined();
    expect(marker?.x).toBeCloseTo(256, 5);
    expect(marker?.y).toBeCloseTo(256, 5);
  });

  it('a TURN without a route spine sweeps the frozen turn simulation and reports its verdict', () => {
    const scene = buildReviewScene(turnPoint(), TRUCK, FRAME);
    expect(kinds(scene).has('swept_envelope')).toBe(true);
    expect(kinds(scene).has('truck_footprint')).toBe(true);
    expect(scene.polygons.filter((p) => p.kind === 'truck_footprint')).toHaveLength(3);
    expect(scene.simulated).not.toBeNull();
    expect(typeof scene.simulated?.minClearanceM).toBe('number');
    // Every polygon lands in pixel space of the frame, around the anchor.
    for (const polygon of scene.polygons) {
      expect(polygon.points.length).toBeGreaterThanOrEqual(3);
      for (const q of polygon.points) {
        expect(Number.isFinite(q.x)).toBe(true);
        expect(Number.isFinite(q.y)).toBe(true);
      }
    }
  });

  it('a TURN with a route spine follows the spine instead of the synthetic turn', () => {
    const scene = buildReviewScene(turnPoint(), TRUCK, FRAME, [], SPINE);
    expect(kinds(scene).has('swept_envelope')).toBe(true);
    // The spine sweep is a playback: many frames, not the three key poses.
    expect(scene.polygons.filter((p) => p.kind === 'truck_footprint').length).toBeGreaterThan(3);
    // The synthetic simulation's opinion is not reported when the spine drives.
    expect(scene.simulated).toBeNull();
  });

  it('a TURNAROUND is two circles: the ring on offer and the circle the truck needs', () => {
    // the required circle is drawn at HALF THE REQUIRED
    // DIAMETER the caller passes (2 R + clearance = 2 × 10,3 + 2,0 = 22,6 m),
    // not at the turning radius: the drawn circle is the judged requirement.
    const scene = buildReviewScene(turnaroundPoint(), TRUCK, FRAME, [], [], 22.6);
    const ring = scene.polygons.find((p) => p.kind === 'ring');
    const required = scene.polygons.find((p) => p.kind === 'required_circle');
    expect(ring).toBeDefined();
    expect(required).toBeDefined();
    expect(ring?.points).toHaveLength(48);
    // Radii in px (10 px/m): usable diameter 16 m → 8 m → 80 px; required
    // 22,6 m → 11,3 m → 113 px — and no longer the turn radius, 103 px.
    const radiusOf = (pts: readonly { x: number; y: number }[]) =>
      Math.hypot((pts[0]?.x ?? 0) - 256, (pts[0]?.y ?? 0) - 256);
    expect(radiusOf(ring?.points ?? [])).toBeCloseTo(80, 5);
    expect(radiusOf(required?.points ?? [])).toBeCloseTo(113, 5);
    expect(radiusOf(required?.points ?? [])).not.toBeCloseTo(TRUCK.envelope.turnRadiusM * 10, 1);
    expect(scene.simulated).toBeNull();
  });

  it('a TURNAROUND without a required diameter draws the ring alone — never a wrong circle', () => {
    const scene = buildReviewScene(turnaroundPoint(), TRUCK, FRAME);
    expect(kinds(scene).has('ring')).toBe(true);
    expect(kinds(scene).has('required_circle')).toBe(false);
  });

  it('an unknown geometry yields the marker alone, no polygon', () => {
    const point: CriticalPoint = {
      ...turnPoint(),
      geometry: { known: false, why: 'no_data' },
    };
    const scene = buildReviewScene(point, TRUCK, FRAME);
    expect(scene.polygons).toEqual([]);
    expect(scene.markers).toHaveLength(1);
    expect(scene.simulated).toBeNull();
  });

  it('extra markers are projected onto the same frame', () => {
    const scene = buildReviewScene(turnPoint(), TRUCK, FRAME, [
      { kind: 'delivery', at: { lat: AT.lat + 0.0001, lon: AT.lon }, label: 'Livraison' },
    ]);
    const delivery = scene.markers.find((m) => m.kind === 'delivery');
    expect(delivery?.label).toBe('Livraison');
    // 0.0001° of latitude ≈ 11.1 m north → 111 px above the centre (y down).
    expect(delivery?.y).toBeCloseTo(256 - 111.32, 1);
    expect(delivery?.x).toBeCloseTo(256, 5);
  });
});

describe('anticipatedSpine', () => {
  it('0 m is the spine itself, by reference', () => {
    expect(anticipatedSpine(SPINE, 0)).toBe(SPINE);
  });

  it('3 m leaves the incoming leg 3 m before the corner and rejoins 3 m after, dropping the vertex', () => {
    const spine = anticipatedSpine(SPINE, 3);
    expect(spine).not.toBeNull();
    const pts = spine ?? [];
    expect(pts[0]).toEqual({ x: 0, y: 30 });
    expect(pts[pts.length - 1]).toEqual({ x: 30, y: 0 });
    expect(pts.some((p) => p.x === 0 && p.y === 0)).toBe(false);
    // Curve endpoints sit exactly on the legs; the curve stays inside the corner.
    expect(pts.some((p) => Math.abs(p.x) < 1e-9 && Math.abs(p.y - 3) < 1e-9)).toBe(true);
    expect(pts.some((p) => Math.abs(p.y) < 1e-9 && Math.abs(p.x - 3) < 1e-9)).toBe(true);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-9);
      expect(p.y).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('walks across vertices when the anticipation is longer than a segment, and clamps at the ends', () => {
    const dense = [
      { x: 0, y: 4 },
      { x: 0, y: 2 },
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 4, y: 0 },
    ];
    // 3 m upstream of the corner crosses the (0,2) vertex and lands at (0,3).
    const spine = anticipatedSpine(dense, 3) ?? [];
    expect(spine[0]).toEqual({ x: 0, y: 4 });
    expect(spine[1]).toEqual({ x: 0, y: 3 });
    expect(spine.some((p) => p.x === 0 && p.y === 2)).toBe(false);
    // 6 m runs off both legs: the curve spans the whole spine.
    const clamped = anticipatedSpine(dense, 6) ?? [];
    expect(clamped[0]).toEqual({ x: 0, y: 4 });
    expect(clamped[clamped.length - 1]).toEqual({ x: 4, y: 0 });
  });

  it('is null without a corner that has a leg on each side', () => {
    expect(
      anticipatedSpine(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        3,
      ),
    ).toBeNull();
    expect(anticipatedSpine([{ x: 0, y: 0 }], 3)).toBeNull();
  });
});

describe('buildTurnApproachVariants', () => {
  const tuple = (pts: readonly { x: number; y: number }[]) => pts.map((q) => [q.x, q.y]);

  it('returns the three attack angles of a TURN on a route spine, tightest first', () => {
    const variants = buildTurnApproachVariants(turnPoint(), TRUCK, FRAME, SPINE);
    expect(variants.map((v) => v.id)).toEqual(['tight', 'early_3m', 'early_6m']);
    expect(variants.map((v) => v.startEarlierM)).toEqual([0, 3, 6]);
    expect(variants.map((v) => v.label)).toEqual([
      'Approche serrée',
      'Anticipée +3 m',
      'Anticipée +6 m',
    ]);
    for (const variant of variants) {
      expect(variant.framePx).toEqual({ width: 512, height: 512 });
      expect(variant.envelopePolygonPx.length).toBeGreaterThanOrEqual(3);
      // Playback frames, like the main scene — not three key poses.
      expect(variant.bodyFootprintsPx.length).toBeGreaterThan(3);
    }
  });

  it('accepts policy-provided anticipation distances', () => {
    const variants = buildTurnApproachVariants(turnPoint(), TRUCK, FRAME, SPINE, {
      tight: 0,
      early_3m: 2,
      early_6m: 4,
    });
    expect(variants.map((v) => v.startEarlierM)).toEqual([0, 2, 4]);
  });

  it('the 0 m variant is the main scene, bit for bit', () => {
    const scene = buildReviewScene(turnPoint(), TRUCK, FRAME, [], SPINE);
    const [tight] = buildTurnApproachVariants(turnPoint(), TRUCK, FRAME, SPINE);
    const envelope = scene.polygons.find((p) => p.kind === 'swept_envelope');
    const footprints = scene.polygons.filter((p) => p.kind === 'truck_footprint');
    expect(tight?.envelopePolygonPx).toEqual(tuple(envelope?.points ?? []));
    expect(tight?.bodyFootprintsPx).toEqual(footprints.map((f) => tuple(f.points)));
  });

  it('the three envelopes are distinct yet share the frame and overlay each other', () => {
    const variants = buildTurnApproachVariants(turnPoint(), TRUCK, FRAME, SPINE);
    const keys = variants.map((v) => JSON.stringify(v.envelopePolygonPx));
    expect(new Set(keys).size).toBe(3);
    const centroid = (pts: readonly (readonly [number, number])[]) => ({
      x: pts.reduce((s, [x]) => s + x, 0) / pts.length,
      y: pts.reduce((s, [, y]) => s + y, 0) / pts.length,
    });
    const centres = variants.map((v) => centroid(v.envelopePolygonPx));
    // Same anchor, same scale: an anticipation of 6 m cannot move the sweep's
    // centre by more than 6 m (60 px) on the shared frame.
    for (const c of centres) {
      expect(Math.hypot(c.x - (centres[0]?.x ?? 0), c.y - (centres[0]?.y ?? 0))).toBeLessThan(60);
      for (const v of variants) expect(v.framePx).toEqual(variants[0]?.framePx);
    }
  });

  it('returns nothing without a spine, for a non-TURN, or for an unknown geometry', () => {
    expect(buildTurnApproachVariants(turnPoint(), TRUCK, FRAME, [])).toEqual([]);
    expect(buildTurnApproachVariants(turnPoint(), TRUCK, FRAME, [{ x: 0, y: 0 }])).toEqual([]);
    expect(buildTurnApproachVariants(turnaroundPoint(), TRUCK, FRAME, SPINE)).toEqual([]);
    expect(
      buildTurnApproachVariants(
        { ...turnPoint(), geometry: { known: false, why: 'no_data' } },
        TRUCK,
        FRAME,
        SPINE,
      ),
    ).toEqual([]);
  });
});
