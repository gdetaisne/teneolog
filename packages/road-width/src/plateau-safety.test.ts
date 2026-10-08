import { describe, expect, it } from 'vitest';
import {
  assessFlatSaturatedPlateau,
  FLAT_SATURATED_PLATEAU_REASON,
  isPlateauWidthSuspicious,
} from './plateau-safety.js';

function offsetsFrom(minM: number, maxM: number, stepM = 0.25): number[] {
  const offsets: number[] = [];
  for (let s = minM; s <= maxM + 1e-9; s += stepM) {
    offsets.push(Math.round(s * 100) / 100);
  }
  return offsets;
}

describe('assessFlatSaturatedPlateau', () => {
  it('flags a wide saturated plateau with no lateral gradient', () => {
    const offsetsM = offsetsFrom(-10, 10);
    const profile = offsetsM.map(() => 0.97);

    const assessment = assessFlatSaturatedPlateau({
      offsetsM,
      profile,
      plateau: { startM: -9.25, endM: 9.25, widthM: 18.5, meanScore: 0.97 },
      expectedWidthM: 3,
    });

    expect(assessment.unsafe).toBe(true);
    expect(assessment.reasonCodes).toContain(FLAT_SATURATED_PLATEAU_REASON);
    expect(assessment.maxGradientPerM).toBe(0);
  });

  it('flags a wide saturated plateau with small local ripple', () => {
    const offsetsM = offsetsFrom(-10, 10);
    const profile = offsetsM.map((_, i) => (i % 4 === 0 ? 0.93 : 1));

    const assessment = assessFlatSaturatedPlateau({
      offsetsM,
      profile,
      plateau: { startM: -9.25, endM: 9.25, widthM: 18.5, meanScore: 0.98 },
      expectedWidthM: 3,
    });

    expect(assessment.unsafe).toBe(true);
    expect(assessment.reasonCodes).toContain(FLAT_SATURATED_PLATEAU_REASON);
  });

  it('does not flag a plausible narrow saturated road plateau', () => {
    const offsetsM = offsetsFrom(-3, 3);
    const profile = offsetsM.map(() => 0.95);

    const assessment = assessFlatSaturatedPlateau({
      offsetsM,
      profile,
      plateau: { startM: -1.5, endM: 1.5, widthM: 3, meanScore: 0.95 },
      expectedWidthM: 3,
    });

    expect(assessment.unsafe).toBe(false);
    expect(assessment.reasonCodes).toHaveLength(0);
  });
});

describe('isPlateauWidthSuspicious', () => {
  it('flags moderate over-read on narrow streets', () => {
    expect(isPlateauWidthSuspicious(4, 3)).toBe(true);
  });

  it('flags too-narrow plateaux against the prior', () => {
    expect(isPlateauWidthSuspicious(2, 7)).toBe(true);
    expect(isPlateauWidthSuspicious(1.5, 5)).toBe(true);
  });

  it('keeps plausible small deltas accepted', () => {
    expect(isPlateauWidthSuspicious(3.6, 3)).toBe(false);
    expect(isPlateauWidthSuspicious(3.25, 3.5)).toBe(false);
  });
});
