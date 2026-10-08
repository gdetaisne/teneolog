import { describe, expect, it } from 'vitest';
import { buildRoadAxis } from './geometry.js';
import {
  applyYoloClampingToProfile,
  applyParkedVehicleScoresToProfile,
  carZoneEligibleForParkedBarrier,
  carZoneIntersectsPlateau,
  lateralOffsetInCarZone,
  yoloCarBboxesForMask,
  yoloBboxesToCarZones,
} from './yolo-clamp.js';
import type { ProfileResultView } from './types.js';
import type { ParkingClassification } from './parking-classify.js';
import type { CarZone } from './car-zone.js';
import type { YoloBbox } from './yolo.js';

function zone(side: 'left' | 'right', inner: number, outer: number): CarZone {
  return {
    side,
    innerEdgeM: inner,
    outerEdgeM: outer,
    widthM: Math.abs(outer - inner),
    level: 'certain',
    confidence: 0.9,
    notes: [],
  };
}

describe('carZoneIntersectsPlateau', () => {
  it('includes kerb parking that extends outside the asphalt plateau (LR courbe case)', () => {
    const plateauLeft = -3.5;
    const plateauRight = 2.0;
    const kerbCar = zone('left', -1.5, -4.5);
    expect(carZoneIntersectsPlateau(kerbCar, plateauLeft, plateauRight)).toBe(true);
    expect(kerbCar.outerEdgeM).toBeLessThan(plateauLeft);
  });

  it('rejects cars fully beyond the plateau on the right', () => {
    const kerbCar = zone('right', 8.0, 10.0);
    expect(carZoneIntersectsPlateau(kerbCar, -3.5, 2.0)).toBe(false);
  });

  it('keeps parked barriers within the marginal asphalt gap', () => {
    const nearKerbCar = zone('right', 2.8, 5.2);
    const farKerbCar = zone('right', 8.0, 10.0);
    expect(carZoneIntersectsPlateau(nearKerbCar, -3.5, 2.0)).toBe(false);
    expect(carZoneEligibleForParkedBarrier(nearKerbCar, -3.5, 2.0)).toBe(true);
    expect(carZoneEligibleForParkedBarrier(farKerbCar, -3.5, 2.0)).toBe(false);
  });
});

describe('yoloBboxesToCarZones', () => {
  const roadAxis = buildRoadAxis(800, 400, 10, 90, {
    latA: 48.85,
    lngA: 2.35,
    roadPolylines: [],
    dx2Px: 0,
    dy2Px: 0,
    dx3Px: 0,
    dy3Px: 0,
  });
  const bbox: YoloBbox = {
    x: 365,
    y: 200,
    w: 22,
    h: 12,
    angle: 0,
    conf: 0.5,
    class_name: 'small-vehicle',
  };

  it('does not build car zones from circulating classifications', () => {
    const circulating: ParkingClassification = {
      status: 'circulating',
      reason: 'vehicle_circulation_probe',
      bbox,
      geometry: {
        bbox,
        side: 'left',
        alongM: 0,
        lateralM: -2.5,
        innerEdgeM: -1.5,
        outerEdgeM: -4.0,
        halfAlongM: 2,
      },
    };
    expect(yoloBboxesToCarZones([bbox], roadAxis, 10, 0.1, [circulating])).toHaveLength(0);
  });

  it('builds car zones from parked large vehicles', () => {
    const largeBbox = { ...bbox, class_name: 'large-vehicle' };
    const parkedLarge: ParkingClassification = {
      status: 'parked',
      reason: 'large_vehicle_bdtopo_parking',
      bbox: largeBbox,
      geometry: {
        bbox: largeBbox,
        side: 'right',
        alongM: 0,
        lateralM: 3,
        innerEdgeM: 2.2,
        outerEdgeM: 4,
        halfAlongM: 3,
      },
    };

    const zones = yoloBboxesToCarZones([largeBbox], roadAxis, 10, 0.1, [parkedLarge]);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.notes).toContain('yolo:large-vehicle');
    expect(zones[0]!.notes).toContain('large_vehicle_bdtopo_parking');
  });
});

describe('yoloCarBboxesForMask', () => {
  it('keeps small and large vehicles for asphalt masking', () => {
    const boxes: YoloBbox[] = [
      { x: 0, y: 0, w: 10, h: 10, angle: 0, conf: 0.2, class_name: 'small-vehicle' },
      { x: 0, y: 0, w: 10, h: 10, angle: 0, conf: 0.2, class_name: 'large-vehicle' },
    ];
    expect(yoloCarBboxesForMask(boxes).map(b => b.class_name)).toEqual([
      'small-vehicle',
      'large-vehicle',
    ]);
  });
});

describe('applyParkedVehicleScoresToProfile', () => {
  const roadAxis = buildRoadAxis(800, 400, 10, 90, {
    latA: 48.85,
    lngA: 2.35,
    roadPolylines: [],
    dx2Px: 0,
    dy2Px: 0,
    dx3Px: 0,
    dy3Px: 0,
  });

  it('does not exclude lateral offsets inside CarZone band but outside OBB', () => {
    const offsetsM = [-3.5, -3.0, -2.5, -2.0, -1.5, 0];
    const carZones: CarZone[] = [
      {
        side: 'left',
        innerEdgeM: -2.0,
        outerEdgeM: -3.5,
        widthM: 1.5,
        level: 'certain',
        confidence: 0.9,
        notes: [],
      },
    ];
    const bbox: YoloBbox = {
      x: 365,
      y: 200,
      w: 22,
      h: 12,
      angle: 0,
      conf: 0.5,
      class_name: 'small-vehicle',
    };
    const raw = {
      offsetsM,
      profile: [0.2, 0.2, 0.2, 0.8, 0.9, 0.9],
      roadMatchProfile: [0.2, 0.2, 0.2, 0.8, 0.9, 0.9],
      parkingExclusion: offsetsM.map(() => 0),
      bdtopoHardCost: offsetsM.map(() => 0),
      notes: [],
    } as unknown as Parameters<typeof applyParkedVehicleScoresToProfile>[0];

    const bandOnly = applyParkedVehicleScoresToProfile(raw, carZones);
    const maskBased = applyParkedVehicleScoresToProfile(raw, carZones, {
      parkedBboxes: [bbox],
      roadAxis,
      pxPerM: 10,
      width: 800,
      height: 400,
    });

    expect(lateralOffsetInCarZone(-3.0, carZones)).toBe(true);
    const bandExcluded = bandOnly.parkingExclusion.filter(v => v > 0).length;
    const maskExcluded = maskBased.parkingExclusion.filter(v => v > 0).length;
    expect(bandExcluded).toBeGreaterThan(2);
    expect(maskExcluded).toBeLessThan(bandExcluded);
    if (maskExcluded > 0) {
      expect(maskBased.notes.some(n => n.includes('parking_profile_obb_mask'))).toBe(true);
    }
  });
});

describe('applyYoloClampingToProfile parked barriers', () => {
  function straightAxis(pxPerM: number) {
    return {
      anchor: { x: 100, y: 100 },
      spanM: 30,
      axisAt(tMeters: number) {
        return {
          cx: 100 + tMeters * pxPerM,
          cy: 100,
          tangentX: 1,
          tangentY: 0,
          perpX: 0,
          perpY: 1,
        };
      },
    };
  }

  function bboxAt(alongM: number, lateralM: number, pxPerM: number): YoloBbox {
    return {
      x: 100 + alongM * pxPerM,
      y: 100 + lateralM * pxPerM,
      w: 20,
      h: 10,
      angle: 0,
      conf: 0.9,
      class_name: 'small-vehicle',
    };
  }

  function profile(): ProfileResultView {
    const offsetsM = [-4, -2, 0, 2, 2.5, 3, 4];
    return {
      widthM: 8,
      confidence: 0.8,
      leftPerpM: -4,
      rightPerpM: 4,
      profile: offsetsM.map(() => 1),
      roadMatchProfile: offsetsM.map(() => 1),
      nonVegProfile: offsetsM.map(() => 0),
      vegProfile: offsetsM.map(() => 0),
      coverageProfile: offsetsM.map(() => 1),
      bdtopoBuildingCost: offsetsM.map(() => 0),
      bdtopoVegetationCost: offsetsM.map(() => 0),
      bdtopoCanopyCost: offsetsM.map(() => 0),
      bdtopoHardCost: offsetsM.map(() => 0),
      parkingExclusion: offsetsM.map(() => 0),
      sidewalkBoundaryScore: offsetsM.map(() => 0),
      sidewalkBoundaryCandidateScore: offsetsM.map(() => 0),
      offsetsM,
      plateaux: [{ startM: -4, endM: 4, widthM: 8, meanScore: 1 }],
      roadColour: [80, 80, 80],
      threshold: 0.5,
      sampleCount: 100,
      asphaltModel: {
        medianColour: [80, 80, 80],
        rgbMin: [70, 70, 70],
        rgbMax: [90, 90, 90],
        lumaMin: 70,
        lumaMax: 90,
        maxSat: 10,
        sampleCount: 100,
      },
      notes: [],
      deltaToGtM: null,
      durationMs: 1,
      plateauVegFrac: 0,
      carZones: [],
      yoloBboxes: [],
      parkedYoloBboxes: [],
      yoloClassifications: [],
      masks: {} as ProfileResultView['masks'],
      tiles: [],
      reasonCodes: [],
      primaryTileIndex: 0,
      yoloStatus: 'empty',
      verdict: { status: 'needs_review', blockingReasons: [], degradedReasons: [] },
    };
  }

  it('uses the median parked inner edge for same-side barriers', () => {
    const pxPerM = 10;
    const clamped = applyYoloClampingToProfile(
      profile(),
      [bboxAt(0, 3, pxPerM), bboxAt(2, 3.4, pxPerM)],
      straightAxis(pxPerM),
      pxPerM,
      null,
      { rgb: new Uint8ClampedArray(4), width: 1, height: 1, bdtopoWidthM: 4 },
    );

    expect(clamped.rightPerpM).toBe(2.7);
    expect(clamped.widthM).toBe(6.7);
    expect(clamped.notes).toContain('car_clamp_R:2.70m→2.70');
    expect(clamped.notes.some(note => note.includes('parking_barrier_median:n=2'))).toBe(true);
  });

  it('extends to median parked barrier when cars are just outside the plateau', () => {
    const pxPerM = 10;
    const raw = {
      ...profile(),
      widthM: 6,
      rightPerpM: 2,
      plateaux: [{ startM: -4, endM: 2, widthM: 6, meanScore: 1 }],
    };
    const clamped = applyYoloClampingToProfile(
      raw,
      [bboxAt(0, 3, pxPerM), bboxAt(2, 3.4, pxPerM)],
      straightAxis(pxPerM),
      pxPerM,
      null,
      { rgb: new Uint8ClampedArray(4), width: 1, height: 1, bdtopoWidthM: 4 },
    );

    expect(clamped.rightPerpM).toBe(2.7);
    expect(clamped.widthM).toBe(6.7);
    expect(clamped.notes).toContain('parking_margin_include:right(gap=0.70m)');
    expect(clamped.notes).toContain('car_margin_R:2.70m→2.70');
    expect(clamped.notes.some(note => note.includes('parking_barrier_median:n=2'))).toBe(true);
  });
});
