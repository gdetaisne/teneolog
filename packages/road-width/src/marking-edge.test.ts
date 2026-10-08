import { describe, expect, it } from 'vitest';
import {
  applyMarkingEdgeTrim,
  hasDistinctPlateauBeyondMarking,
  SOLID_LINE_T,
} from './marking-edge.js';
import type { Plateau } from './types.js';

const ENTER_T = 0.75;
const EXIT_T = 0.75;
const STEP = 0.25;

function makeOffsets(fromM: number, toM: number): number[] {
  const out: number[] = [];
  for (let m = fromM; m <= toM + 1e-9; m += STEP) out.push(Math.round(m * 100) / 100);
  return out;
}

function constantProfile(n: number, value: number): number[] {
  return Array.from({ length: n }, () => value);
}

describe('hasDistinctPlateauBeyondMarking', () => {
  it('returns false when score stays high beyond marking (Creuse emergency strip)', () => {
    const profile = constantProfile(40, 0.85);
    profile[20] = 0.2; // marking dip at one sample only — still high after
    const beyond = hasDistinctPlateauBeyondMarking(profile, 20, 1, ENTER_T, EXIT_T, STEP);
    expect(beyond).toBe(false);
  });

  it('returns true after dip then renewed plateau (bike lane)', () => {
    const profile = constantProfile(40, 0.85);
    // marking at idx 20, dip 21-22, bike lane 23+
    profile[20] = 0.2;
    profile[21] = 0.1;
    profile[22] = 0.2;
    profile[23] = 0.82;
    profile[24] = 0.84;
    profile[25] = 0.83;
    profile[26] = 0.81;
    profile[27] = 0.8;
    const beyond = hasDistinctPlateauBeyondMarking(profile, 20, 1, ENTER_T, EXIT_T, STEP);
    expect(beyond).toBe(true);
  });
});

describe('applyMarkingEdgeTrim', () => {
  const offsetsM = makeOffsets(-8, 8);
  const centerIdx = offsetsM.findIndex((o) => o >= 0);

  it('trims solid edge when no renewed plateau (Creuse 2 pattern)', () => {
    const profile = constantProfile(offsetsM.length, 0.85);
    const whiteLineProfile = constantProfile(offsetsM.length, 0.05);
    const leftIdx = offsetsM.indexOf(-3.5);
    const rightIdx = offsetsM.indexOf(3.5);
    expect(leftIdx).toBeGreaterThanOrEqual(0);
    expect(rightIdx).toBeGreaterThanOrEqual(0);
    for (const idx of [leftIdx - 1, leftIdx, leftIdx + 1, rightIdx - 1, rightIdx, rightIdx + 1]) {
      if (idx >= 0 && idx < whiteLineProfile.length) whiteLineProfile[idx] = SOLID_LINE_T + 0.1;
    }

    const chosen: Plateau = {
      startM: -8,
      endM: 8,
      widthM: 16,
      meanScore: 0.85,
    };

    const { chosen: trimmed, notes } = applyMarkingEdgeTrim({
      chosen,
      profile,
      offsetsM,
      whiteLineProfile,
      crosswalkFlags: constantProfile(offsetsM.length, false),
      enterT: ENTER_T,
      exitT: EXIT_T,
      lateralStepM: STEP,
    });

    expect(trimmed.startM).toBeGreaterThanOrEqual(-3.75);
    expect(trimmed.startM).toBeLessThanOrEqual(-3.0);
    expect(trimmed.endM).toBeGreaterThanOrEqual(3.0);
    expect(trimmed.endM).toBeLessThanOrEqual(3.75);
    expect(trimmed.widthM).toBeGreaterThanOrEqual(6);
    expect(trimmed.widthM).toBeLessThanOrEqual(7.5);
    expect(notes.some((n) => n.startsWith('solid_edge:'))).toBe(true);
    expect(centerIdx).toBeGreaterThanOrEqual(0);
  });

  it('keeps width when solid line is followed by a distinct bike-lane plateau', () => {
    const profile = constantProfile(offsetsM.length, 0.85);
    const rightMarkIdx = offsetsM.indexOf(3.5);
    expect(rightMarkIdx).toBeGreaterThanOrEqual(0);
    profile[rightMarkIdx] = 0.15;
    profile[rightMarkIdx + 1] = 0.1;
    profile[rightMarkIdx + 2] = 0.12;
    for (let i = rightMarkIdx + 3; i < rightMarkIdx + 8; i++) profile[i] = 0.82;

    const whiteLineProfile = constantProfile(offsetsM.length, 0.05);
    whiteLineProfile[rightMarkIdx] = SOLID_LINE_T + 0.2;

    const chosen: Plateau = {
      startM: -3.5,
      endM: 5.5,
      widthM: 9,
      meanScore: 0.85,
    };

    const { chosen: trimmed, notes } = applyMarkingEdgeTrim({
      chosen,
      profile,
      offsetsM,
      whiteLineProfile,
      crosswalkFlags: constantProfile(offsetsM.length, false),
      enterT: ENTER_T,
      exitT: EXIT_T,
      lateralStepM: STEP,
    });

    expect(trimmed.endM).toBeCloseTo(5.5, 1);
    expect(notes.some((n) => n.includes('marking_keep:R'))).toBe(true);
    expect(notes.some((n) => n.startsWith('solid_edge:R'))).toBe(false);
  });

  it('trims at perpendicular crosswalk even when asphalt continues beyond', () => {
    const profile = constantProfile(offsetsM.length, 0.85);
    const whiteLineProfile = constantProfile(offsetsM.length, 0.15);
    const crosswalkFlags = constantProfile(offsetsM.length, false);
    const crossIdx = offsetsM.indexOf(5);
    expect(crossIdx).toBeGreaterThanOrEqual(0);
    crosswalkFlags[crossIdx] = true;
    crosswalkFlags[crossIdx + 1] = true;

    const chosen: Plateau = {
      startM: -3,
      endM: 8,
      widthM: 11,
      meanScore: 0.85,
    };

    const { chosen: trimmed, notes } = applyMarkingEdgeTrim({
      chosen,
      profile,
      offsetsM,
      whiteLineProfile,
      crosswalkFlags,
      enterT: ENTER_T,
      exitT: EXIT_T,
      lateralStepM: STEP,
    });

    expect(trimmed.endM).toBeCloseTo(5, 0);
    expect(notes.some((n) => n.startsWith('crosswalk_edge:R'))).toBe(true);
  });
});
