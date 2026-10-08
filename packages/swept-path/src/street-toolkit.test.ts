import { describe, expect, it } from 'vitest';
import { PL_19T_TRUCK } from './kinematics.js';
import {
  buildStreetAxisToolkit,
  closestPointOnAxisPolyline,
  lateralOffsetMFromPointerDelta,
} from './street-toolkit.js';

describe('buildStreetAxisToolkit', () => {
  const axis: Array<[number, number]> = [
    [100, 200],
    [300, 200],
  ];

  it('centers the truck on the axis at zero lateral offset', () => {
    const result = buildStreetAxisToolkit({
      axisPolylinePx: axis,
      anchorPx: [200, 200],
      lateralOffsetM: 0,
      pxpm: 10,
      truck: PL_19T_TRUCK,
    });
    expect(result).not.toBeNull();
    expect(result!.referenceAxisPx).toEqual(axis);
    expect(result!.mobileAxisPx).toEqual(axis);
    expect(result!.truckFootprintPx).toHaveLength(4);
    const centerOffsetPx =
      ((PL_19T_TRUCK.wheelbaseM + PL_19T_TRUCK.frontOverhangM - PL_19T_TRUCK.rearOverhangM) / 2) * 10;
    expect(result!.truckCenterPx[0]).toBeCloseTo(200, 0);
    expect(result!.truckCenterPx[1]).toBeCloseTo(200, 0);
    expect(result!.rearAxlePx[0]).toBeCloseTo(200 - centerOffsetPx, 0);
  });

  it('translates axis and truck together when offset laterally', () => {
    const base = buildStreetAxisToolkit({
      axisPolylinePx: axis,
      anchorPx: [200, 200],
      lateralOffsetM: 0,
      pxpm: 10,
      truck: PL_19T_TRUCK,
    })!;
    const shifted = buildStreetAxisToolkit({
      axisPolylinePx: axis,
      anchorPx: [200, 200],
      lateralOffsetM: 1,
      pxpm: 10,
      truck: PL_19T_TRUCK,
    })!;
    expect(shifted.mobileAxisPx[0]![0]).toBeCloseTo(base.mobileAxisPx[0]![0], 0);
    expect(shifted.mobileAxisPx[0]![1]).toBeCloseTo(base.mobileAxisPx[0]![1] + 10, 0);
    expect(shifted.truckFootprintPx[0]![1]).toBeCloseTo(base.truckFootprintPx[0]![1] + 10, 0);
  });
});

describe('closestPointOnAxisPolyline', () => {
  it('projects onto the nearest segment', () => {
    const hit = closestPointOnAxisPolyline(
      [
        [0, 0],
        [100, 0],
      ],
      [40, 10],
    );
    expect(hit.point[0]).toBeCloseTo(40, 1);
    expect(hit.point[1]).toBeCloseTo(0, 1);
  });
});

describe('lateralOffsetMFromPointerDelta', () => {
  it('projects pointer delta onto the perpendicular axis', () => {
    const next = lateralOffsetMFromPointerDelta({
      deltaPx: [0, -20],
      perpUnitPx: [0, -1],
      pxpm: 10,
      baseOffsetM: 0,
    });
    expect(next).toBeCloseTo(2, 3);
  });
});
