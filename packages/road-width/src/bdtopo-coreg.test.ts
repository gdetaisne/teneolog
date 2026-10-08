import { describe, expect, it } from 'vitest';
import { estimateLateralBdtopoOffset } from './bdtopo-coreg.js';

/** Build a sorted offsets grid. */
function grid(minM: number, maxM: number, step = 0.25): number[] {
  const out: number[] = [];
  for (let m = minM; m <= maxM + 1e-9; m += step) out.push(Math.round(m * 100) / 100);
  return out;
}

/** Box road profile: roadMatch = 1 inside [aM, bM], 0 outside. */
function boxProfile(offsetsM: number[], aM: number, bM: number): number[] {
  return offsetsM.map((s) => (s >= aM && s <= bM ? 1 : 0));
}

describe('estimateLateralBdtopoOffset', () => {
  it('returns ~0 for a road centred on the BDTOPO axis', () => {
    const offsetsM = grid(-6, 6);
    const roadMatch = boxProfile(offsetsM, -2.5, 2.5); // 5 m road centred at 0
    const est = estimateLateralBdtopoOffset(offsetsM, roadMatch, { bdtopoWidthM: 5 });
    expect(Math.abs(est.offsetM)).toBeLessThanOrEqual(0.3);
    expect(est.confidence).toBeGreaterThan(0.8);
  });

  it('detects a positive lateral offset when the road sits right of the axis', () => {
    const offsetsM = grid(-6, 6);
    const roadMatch = boxProfile(offsetsM, -0.5, 4.5); // 5 m road centred at +2.0
    const est = estimateLateralBdtopoOffset(offsetsM, roadMatch, { bdtopoWidthM: 5 });
    expect(est.offsetM).toBeGreaterThan(1.5);
    expect(est.offsetM).toBeLessThan(2.5);
  });

  it('detects a negative offset symmetrically', () => {
    const offsetsM = grid(-6, 6);
    const roadMatch = boxProfile(offsetsM, -4.5, 0.5); // 5 m road centred at -2.0
    const est = estimateLateralBdtopoOffset(offsetsM, roadMatch, { bdtopoWidthM: 5 });
    expect(est.offsetM).toBeLessThan(-1.5);
    expect(est.offsetM).toBeGreaterThan(-2.5);
  });

  it('recovers the real offset on the 92 m peri-urban turn profile (GT 5.2 m)', () => {
    // Measured roadMatch (texture) from the live D10 dump at 46.07458,-1.00248.
    // Road texture spans ~[-2.0, +3.5] (centre ~+0.75) but BDTOPO masks clipped it to 2.5 m.
    const offsetsM = [
      -3.0, -2.75, -2.5, -2.25, -2.0, -1.75, -1.5, -1.25, -1.0, -0.75, -0.5, -0.25, 0.0, 0.25,
      0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.25, 3.5, 3.75, 4.0,
    ];
    const roadMatch = [
      0, 0, 0.15, 0.2, 0.86, 0.86, 0.86, 0.91, 1, 1, 1, 1, 1, 1, 1, 0.99, 0.99, 0.94, 0.95,
      0.99, 0.98, 0.99, 0.97, 0.97, 1, 1, 0.87, 0.34, 0.22,
    ];
    const est = estimateLateralBdtopoOffset(offsetsM, roadMatch, { bdtopoWidthM: 5.2 });
    // Detected road centre is clearly to the positive side of the BDTOPO axis.
    expect(est.offsetM).toBeGreaterThan(0.3);
    expect(est.offsetM).toBeLessThan(1.6);
    // Road (~5.5 m) is wider than the 5.2 m prior, so the flanks legitimately
    // hold road texture and damp the confidence — still a usable, confident shift.
    expect(est.confidence).toBeGreaterThan(0.45);
  });

  it('is neutral on degenerate input', () => {
    expect(estimateLateralBdtopoOffset([], []).offsetM).toBe(0);
    expect(estimateLateralBdtopoOffset([0, 1], [1, 1]).confidence).toBe(0);
  });
});
