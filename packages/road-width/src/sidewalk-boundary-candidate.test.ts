import { describe, expect, it } from 'vitest';
import {
  computeSidewalkBoundaryCandidateCurve,
  CANDIDATE_HIGH_SCORE_MIN,
  CANDIDATE_LOW_SCORE_MAX,
} from './sidewalk-boundary-candidate.js';
import type { Plateau } from './types.js';

function offsetsFrom(minM: number, maxM: number, step = 0.5): number[] {
  const out: number[] = [];
  for (let m = minM; m <= maxM + 1e-6; m += step) out.push(Math.round(m * 100) / 100);
  return out;
}

function plateau(startM: number, endM: number): Plateau {
  return { startM, endM, widthM: endM - startM, meanScore: 0.8 };
}

function hardZero(n: number): number[] {
  return new Array(n).fill(0);
}

describe('computeSidewalkBoundaryCandidateCurve', () => {
  it('detects narrow kerb peaks with outward drop on left/right sides', () => {
    // Dense 5 cm grid models a real kerb: asphalt is low, kerb is a narrow
    // bright peak, beyond the kerb the score drops (veg, asphalt or masks).
    const offsetsM = offsetsFrom(-5, 5, 0.05);
    const n = offsetsM.length;
    const sidewalkBoundaryScore = offsetsM.map((o) => {
      if (o >= -1 && o <= 1) return 0.1;
      if (o <= -3.5 && o >= -3.7) return CANDIDATE_HIGH_SCORE_MIN + 0.15;
      if (o >= 3.5 && o <= 3.7) return CANDIDATE_HIGH_SCORE_MIN + 0.12;
      return 0.12;
    });

    const result = computeSidewalkBoundaryCandidateCurve({
      offsetsM,
      sidewalkBoundaryScore,
      bdtopoBuildingCost: hardZero(n),
      bdtopoVegetationCost: hardZero(n),
      parkingExclusion: hardZero(n),
      bdtopoHardCost: hardZero(n),
      chosenPlateau: plateau(-3, 3.5),
    });

    expect(result.leftOffsetM).toBeCloseTo(-3.5, 5);
    expect(result.rightOffsetM).toBeCloseTo(3.5, 5);
    expect(result.reason).toBe('sidewalk_boundary_candidate_shadow_debug');
    expect(result.note).toContain('L-3.50');
    expect(result.note).toContain('R3.50');
  });

  it('ignores far-off hard-excluded spikes and distant noise', () => {
    const offsetsM = offsetsFrom(-13, 13, 0.05);
    const n = offsetsM.length;
    const sidewalkBoundaryScore = offsetsM.map((o) => {
      if (o >= -0.5 && o <= 0.5) return CANDIDATE_LOW_SCORE_MAX - 0.05;
      // Narrow kerb peaks near the plateau edges
      if (o <= -3.0 && o >= -3.2) return CANDIDATE_HIGH_SCORE_MIN + 0.2;
      if (o >= 3.0 && o <= 3.2) return CANDIDATE_HIGH_SCORE_MIN + 0.18;
      if (o <= -11 || o >= 11) return 0.95;
      return 0.08;
    });
    const bdtopoHardCost = offsetsM.map((o) => (o <= -11 || o >= 11 ? 1 : 0));
    const bdtopoBuildingCost = offsetsM.map((o) => (o <= -11 ? 1 : 0));

    const result = computeSidewalkBoundaryCandidateCurve({
      offsetsM,
      sidewalkBoundaryScore,
      bdtopoBuildingCost,
      bdtopoVegetationCost: hardZero(n),
      parkingExclusion: hardZero(n),
      bdtopoHardCost,
      chosenPlateau: plateau(-3.5, 3),
    });

    expect(result.leftOffsetM).toBeCloseTo(-3, 5);
    expect(result.rightOffsetM).toBeCloseTo(3, 5);
    expect(Math.abs(result.leftOffsetM!)).toBeLessThan(6);
    expect(Math.abs(result.rightOffsetM!)).toBeLessThan(6);
  });

  it('returns empty curve when no sustained high score exists', () => {
    const offsetsM = offsetsFrom(-5, 5);
    const n = offsetsM.length;
    const flatLow = offsetsM.map(() => 0.15);

    const result = computeSidewalkBoundaryCandidateCurve({
      offsetsM,
      sidewalkBoundaryScore: flatLow,
      bdtopoBuildingCost: hardZero(n),
      bdtopoVegetationCost: hardZero(n),
      parkingExclusion: hardZero(n),
      bdtopoHardCost: hardZero(n),
      chosenPlateau: plateau(-3, 3),
    });

    expect(result.leftOffsetM).toBeNull();
    expect(result.rightOffsetM).toBeNull();
    expect(result.note).toBeNull();
    expect(result.reason).toBeNull();
    expect(result.curve.every((v) => v === 0)).toBe(true);
  });

  it('detects borderline bright sidewalk evidence on dense lateral grid', () => {
    // Dense 5 cm grid (matches the runtime sidewalk-specific lateral step).
    // Narrow kerb peak: high on a 3-sample band, score drops outward.
    const offsetsM = offsetsFrom(-3.5, 0.5, 0.05);
    const n = offsetsM.length;
    const sidewalkBoundaryScore = offsetsM.map((o) => {
      if (o >= -1.5) return CANDIDATE_LOW_SCORE_MAX - 0.04;
      if (o <= -2.5 && o >= -2.7) return CANDIDATE_HIGH_SCORE_MIN + 0.02;
      return 0.05;
    });

    const result = computeSidewalkBoundaryCandidateCurve({
      offsetsM,
      sidewalkBoundaryScore,
      bdtopoBuildingCost: hardZero(n),
      bdtopoVegetationCost: hardZero(n),
      parkingExclusion: hardZero(n),
      bdtopoHardCost: hardZero(n),
      chosenPlateau: plateau(-3.75, 4),
    });

    expect(result.leftOffsetM).toBeCloseTo(-2.5, 5);
    expect(result.note).toContain('L-2.50');
  });

  it('rejects continuous bright plateau (apron / light asphalt / hidden cars)', () => {
    // Mimics Creuse incoming R~1.5: score climbs then stays high over >1 m
    // outward, with no significant drop and no near-saturation. Not a kerb.
    const offsetsM = offsetsFrom(-1, 3.5, 0.05);
    const n = offsetsM.length;
    const sidewalkBoundaryScore = offsetsM.map((o) => {
      if (o <= 1.0) return 0.10;
      if (o > 1.0 && o < 1.4) return 0.30;
      return 0.65;
    });

    const result = computeSidewalkBoundaryCandidateCurve({
      offsetsM,
      sidewalkBoundaryScore,
      bdtopoBuildingCost: hardZero(n),
      bdtopoVegetationCost: hardZero(n),
      parkingExclusion: hardZero(n),
      bdtopoHardCost: hardZero(n),
      chosenPlateau: plateau(-3.5, 3.25),
    });

    expect(result.rightOffsetM).toBeNull();
  });

  it('accepts narrow peak followed by near-saturated true sidewalk', () => {
    // Kerb edge (0.7) followed by very bright sidewalk surface (>=0.9).
    const offsetsM = offsetsFrom(-1, 3, 0.05);
    const n = offsetsM.length;
    const sidewalkBoundaryScore = offsetsM.map((o) => {
      if (o <= 1.0) return 0.10;
      if (o > 1.0 && o < 1.3) return 0.55;
      if (o >= 1.3 && o < 1.45) return 0.70;
      return 0.92;
    });

    const result = computeSidewalkBoundaryCandidateCurve({
      offsetsM,
      sidewalkBoundaryScore,
      bdtopoBuildingCost: hardZero(n),
      bdtopoVegetationCost: hardZero(n),
      parkingExclusion: hardZero(n),
      bdtopoHardCost: hardZero(n),
      chosenPlateau: plateau(-3.5, 2.0),
    });

    expect(result.rightOffsetM).not.toBeNull();
  });
});
