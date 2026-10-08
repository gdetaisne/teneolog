import { describe, expect, it } from 'vitest';
import { buildBearingFallbackAxis } from './geometry.js';
import {
  computeCorridorPixelBounds,
  corridorPixelCount,
  corridorSignificantlySmallerThanCanvas,
} from './mask-corridor.js';

describe('mask-corridor', () => {
  it('corridor is smaller than full 1536×512 stitch canvas', () => {
    const W = 1536;
    const H = 512;
    const pxPerM = 4.5;
    const axis = buildBearingFallbackAxis(W, H, pxPerM, 45);
    const bounds = computeCorridorPixelBounds(axis, W, H, pxPerM);
    expect(corridorSignificantlySmallerThanCanvas(bounds, W, H)).toBe(true);
    expect(corridorPixelCount(bounds)).toBeLessThan(W * H * 0.5);
    expect(bounds.x0).toBeGreaterThanOrEqual(0);
    expect(bounds.y1).toBeLessThan(H);
  });
});
