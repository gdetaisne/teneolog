import { describe, expect, it } from 'vitest';
import { buildBearingFallbackAxis } from './geometry.js';
import { buildSpatialMasksWithTiming } from './masks.js';

describe('buildSpatialMasksWithTiming', () => {
  it('returns sub-phase timings (sequential when parallel disabled)', () => {
    const prev = process.env.D10_MASK_PARALLEL;
    process.env.D10_MASK_PARALLEL = '0';
    try {
      const W = 512;
      const H = 512;
      const pxPerM = 4.5;
      const rgb = new Uint8ClampedArray(W * H * 4);
      const roadAxis = buildBearingFallbackAxis(W, H, pxPerM, 45);
      const built = buildSpatialMasksWithTiming(rgb, W, H, roadAxis, pxPerM, [], {});
      const t = built.spatialMasksTiming;
      expect(t.parallelized).toBe(false);
      expect(t.wallMs).toBeGreaterThanOrEqual(0);
      expect(t.buildingMs + t.vegRasterMs + t.vegetationMassMs + t.canopyMs).toBe(t.wallMs);
      expect(built.masks.buildingMask.width).toBe(W);
    } finally {
      if (prev === undefined) delete process.env.D10_MASK_PARALLEL;
      else process.env.D10_MASK_PARALLEL = prev;
    }
  });
});
