import { describe, expect, it } from 'vitest';
import { isAerialCanopyPixel, isVegetationPixel } from './color-utils.js';
import { aerialCanopyScanHit, AERIAL_CANOPY_SCAN_MIN_FRAC } from './masks.js';

describe('aerialCanopyScanHit', () => {
  it('requires a meaningful scan fraction, not a single pixel', () => {
    expect(AERIAL_CANOPY_SCAN_MIN_FRAC).toBeGreaterThan(0.15);
    expect(aerialCanopyScanHit(0)).toBe(false);
    expect(aerialCanopyScanHit(0.05)).toBe(false);
    expect(aerialCanopyScanHit(0.25)).toBe(true);
  });
});

describe('isAerialCanopyPixel', () => {
  it('is stricter than generic vegetation for grey asphalt', () => {
    const greyAsphalt: [number, number, number] = [118, 118, 115];
    expect(isVegetationPixel(greyAsphalt)).toBe(false);
    expect(isAerialCanopyPixel(greyAsphalt)).toBe(false);
  });

  it('still flags strong treetop green', () => {
    const tree: [number, number, number] = [40, 120, 35];
    expect(isAerialCanopyPixel(tree)).toBe(true);
  });
});
