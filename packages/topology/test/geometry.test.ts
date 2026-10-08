import { describe, expect, it } from 'vitest';
import { haversineM, offsetPoint } from '../src/geometry.js';

const ORIGIN = { lat: 47.0, lon: 1.0 };

describe('offsetPoint', () => {
  it('100 m due east keeps latitude and advances longitude', () => {
    const east = offsetPoint(ORIGIN, 90, 100);
    expect(haversineM(ORIGIN, east)).toBeCloseTo(100, 0);
    expect(east.lon).toBeGreaterThan(ORIGIN.lon);
    expect(Math.abs(east.lat - ORIGIN.lat)).toBeLessThan(0.00001);
  });

  it('the reverse bearing of a 50 m step lands back on the origin', () => {
    const north = offsetPoint(ORIGIN, 0, 50);
    const back = offsetPoint(north, 180, 50);
    expect(haversineM(ORIGIN, back)).toBeLessThan(0.05);
  });
});

