import { describe, expect, it } from 'vitest';
import { buildRoadAxisWithSerial } from './geometry.js';
import { hydrateRoadAxis } from './road-axis-serial.js';

describe('hydrateRoadAxis', () => {
  it('round-trips polyline axis samples', () => {
    const tile = {
      latA: 48.85,
      lngA: 2.35,
      roadPolylines: [
        [
          { lat: 48.8498, lng: 2.3869 },
          { lat: 48.85, lng: 2.35 },
          { lat: 48.8502, lng: 2.3873 },
        ],
      ],
      dx2Px: 0,
      dy2Px: 0,
      dx3Px: 0,
      dy3Px: 0,
    };
    const W = 512;
    const H = 512;
    const pxPerM = 10;
    const { axis, serial } = buildRoadAxisWithSerial(W, H, pxPerM, 45, tile);
    const restored = hydrateRoadAxis(serial);
    const t = 0;
    const a = axis.axisAt(t);
    const b = restored.axisAt(t);
    expect(b.cx).toBeCloseTo(a.cx, 4);
    expect(b.cy).toBeCloseTo(a.cy, 4);
    expect(b.tangentX).toBeCloseTo(a.tangentX, 4);
    expect(serial.kind).toBe('polyline');
  });
});
