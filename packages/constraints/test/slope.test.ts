/**
 * Slope is sampled along the delivery-street axis, never north/south
 * (Montée des Balmes: a perpendicular window invented 18 % on a 5 % street).
 */
import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';
import type { RoadWay } from '@teneolog/topology';
import { bearingDeg, haversineM } from '@teneolog/topology';

import {
  deliveryAxisBearingDeg,
  slopePctFromElevations,
  slopeSamplePoints,
  SLOPE_HALF_WINDOW_M,
} from '../src/slope.js';
import { assembleStopConstraints } from '../src/stop-constraints.js';

const AT = { lat: 47.0, lon: 1.0 };

function way(geometry: readonly GeoPoint[]): RoadWay {
  return {
    id: 'street',
    source: 'osm-overpass',
    nodeIds: geometry.map((_, i) => String(i)),
    geometry,
    name: 'Rue Test',
    importance: null,
    declaredWidthM: null,
    laneCount: null,
    oneWay: 'no',
    isPrivate: false,
    limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    tags: {},
  };
}

describe('deliveryAxisBearingDeg', () => {
  it('reads the local segment at the stop, not a distant chord', () => {
    const onEastWest = { lat: 47.0, lon: 0.999 };
    const street = way([
      { lat: 47.0, lon: 0.998 },
      { lat: 47.0, lon: 1.0 },
      { lat: 47.001, lon: 1.0 },
    ]);
    const bearing = deliveryAxisBearingDeg(onEastWest, street);
    expect(bearing).not.toBeNull();
    expect(bearing as number).toBeGreaterThan(80);
    expect(bearing as number).toBeLessThan(100);
  });

  it('returns null on a degenerate point-geometry', () => {
    expect(deliveryAxisBearingDeg(AT, way([AT]))).toBeNull();
  });
});

describe('slopeSamplePoints', () => {
  it('opens a symmetric window along an east-west street, not north-south', () => {
    const sample = slopeSamplePoints(AT, 90);
    expect(haversineM(sample.from, AT)).toBeCloseTo(SLOPE_HALF_WINDOW_M, 0);
    expect(haversineM(sample.to, AT)).toBeCloseTo(SLOPE_HALF_WINDOW_M, 0);
    expect(sample.from.lon).toBeLessThan(AT.lon);
    expect(sample.to.lon).toBeGreaterThan(AT.lon);
    expect(Math.abs(sample.from.lat - AT.lat)).toBeLessThan(0.00001);
    expect(Math.abs(sample.to.lat - AT.lat)).toBeLessThan(0.00001);
    expect(bearingDeg(sample.from, sample.to)).toBeCloseTo(90, 0);
  });
});

describe('slopePctFromElevations', () => {
  it('is the unsigned grade over the run', () => {
    const from = { lat: 47.0, lon: 1.0 };
    const to = { lat: 47.0, lon: 1.0 + 100 / (111_320 * Math.cos((47 * Math.PI) / 180)) };
    const pct = slopePctFromElevations(from, to, 10, 15);
    expect(pct).not.toBeNull();
    expect(pct as number).toBeCloseTo(5, 0);
  });

  it('returns null when the two points collapse', () => {
    expect(slopePctFromElevations(AT, AT, 10, 20)).toBeNull();
  });
});

describe('assembleStopConstraints slope', () => {
  it('publishes a measured grade instead of the honest unknown', () => {
    const stop = assembleStopConstraints({
      at: AT,
      descriptions: [way([{ lat: 47.0, lon: 0.999 }, { lat: 47.0, lon: 1.001 }])],
      fetchedAt: '2026-09-07T00:00:00Z',
      declaredWidthConfidence: 0.55,
      measuredSlope: {
        known: true,
        value: 3.2,
        provenance: { source: 'elevation', method: 'google-elevation-delivery-axis', fetchedAt: '2026-09-07T00:00:00Z' },
        reliability: { confidence: 0.8, basis: 'measured', reasonCodes: ['slope_along_delivery_axis'] },
      },
    });
    expect(stop.slopePct.known).toBe(true);
    if (!stop.slopePct.known) return;
    expect(stop.slopePct.value).toBe(3.2);
  });
});
