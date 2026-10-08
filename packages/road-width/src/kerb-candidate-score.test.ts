import { describe, expect, it } from 'vitest';
import {
  computeWeightedKerbPair,
  findWeightedSideCandidate,
  KERB_BREAK_FLOOR,
  type WeightedKerbInput,
} from './kerb-candidate-score.js';
import { BDTOPO_V2_BAND_HALF_M } from './d10v2-banded-width.js';
import type { Plateau } from './types.js';

function offsetsFrom(minM: number, maxM: number, step = 0.05): number[] {
  const out: number[] = [];
  for (let m = minM; m <= maxM + 1e-6; m += step) out.push(Math.round(m * 100) / 100);
  return out;
}

function plateau(startM: number, endM: number): Plateau {
  return { startM, endM, widthM: endM - startM, meanScore: 0.8 };
}

function zeros(n: number): number[] {
  return new Array(n).fill(0);
}

/**
 * Builds a clean LM-like cross-section: high asphalt match near the axis,
 * dropping outward; a bright kerb break near ±2 m with a clean sidewalk beyond.
 */
function buildInput(
  offsetsM: number[],
  kerbLeftM: number,
  kerbRightM: number,
  bdtopoWidthM: number | null,
  overrides: Partial<WeightedKerbInput> = {},
): WeightedKerbInput {
  const n = offsetsM.length;
  const sidewalkBoundaryScore = offsetsM.map((o) => {
    if (o >= -1 && o <= 1) return 0.1; // carriageway: low break
    const nearLeft = o <= kerbLeftM + 0.2 && o >= kerbLeftM - 0.2;
    const nearRight = o >= kerbRightM - 0.2 && o <= kerbRightM + 0.2;
    if (nearLeft || nearRight) return 0.7; // kerb break = bright peak at the edge
    if (o < kerbLeftM - 0.2 || o > kerbRightM + 0.2) return 0.45; // sidewalk beyond, dimmer than kerb
    return 0.12;
  });
  const roadMatchProfile = offsetsM.map((o) => {
    if (o >= kerbLeftM && o <= kerbRightM) return 0.9; // carriageway asphalt
    return 0.1; // sidewalk: low road match
  });
  return {
    offsetsM,
    sidewalkBoundaryScore,
    roadMatchProfile,
    bdtopoBuildingCost: zeros(n),
    bdtopoVegetationCost: zeros(n),
    parkingExclusion: zeros(n),
    bdtopoHardCost: zeros(n),
    chosenPlateau: plateau(kerbLeftM, kerbRightM),
    bdtopoWidthM,
    bdtopoBandHalfM: BDTOPO_V2_BAND_HALF_M,
    ...overrides,
  };
}

describe('findWeightedSideCandidate', () => {
  it('picks the kerb break with asphalt drop and clean sidewalk beyond', () => {
    const offsetsM = offsetsFrom(-5, 5);
    const input = buildInput(offsetsM, -2, 2, 4);
    const right = findWeightedSideCandidate(input, 'right');
    expect(right).not.toBeNull();
    expect(right!.offsetM).toBeCloseTo(2, 1);
    expect(right!.score).toBeGreaterThanOrEqual(0.45);
    expect(right!.terms.asphaltDrop).toBeGreaterThan(0.5);
    expect(right!.terms.sidewalkBeyond).toBeGreaterThan(0.3);
  });

  it('does not count parked vehicles beyond the edge as clean sidewalk', () => {
    const offsetsM = offsetsFrom(-5, 5);
    const parkingExclusion = offsetsM.map((o) => (o > 2.2 && o <= 3.0 ? 1 : 0));
    const input = buildInput(offsetsM, -2, 2, 4, { parkingExclusion });
    const right = findWeightedSideCandidate(input, 'right');

    expect(right).not.toBeNull();
    expect(right!.offsetM).toBeCloseTo(2, 1);
    expect(right!.terms.sidewalkBeyond).toBe(0);
  });

  it('returns null when no offset clears the accept threshold', () => {
    const offsetsM = offsetsFrom(-5, 5);
    const flat = buildInput(offsetsM, -2, 2, 4, {
      sidewalkBoundaryScore: offsetsM.map(() => 0.05),
    });
    expect(findWeightedSideCandidate(flat, 'right')).toBeNull();
  });
});

describe('LEVEL 0 hard gates', () => {
  it('rejects offsets under a parked vehicle (parking is blocking)', () => {
    const offsetsM = offsetsFrom(-5, 5);
    const n = offsetsM.length;
    const parkingExclusion = offsetsM.map((o) => (o >= 1.5 && o <= 2.5 ? 1 : 0));
    const input = buildInput(offsetsM, -2, 2, 4, { parkingExclusion });
    const right = findWeightedSideCandidate(input, 'right');
    // The kerb at +2 sits under the parking band → blocked.
    if (right) expect(right.offsetM).not.toBeCloseTo(2, 1);
    expect(input.parkingExclusion.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    void n;
  });

  it('rejects a sub-floor colour break even with strong other terms', () => {
    const offsetsM = offsetsFrom(-5, 5);
    const weak = buildInput(offsetsM, -2, 2, 4, {
      sidewalkBoundaryScore: offsetsM.map((o) =>
        o >= 1.8 && o <= 2.2 ? KERB_BREAK_FLOOR - 0.05 : 0.1,
      ),
    });
    expect(findWeightedSideCandidate(weak, 'right')).toBeNull();
  });
});

describe('computeWeightedKerbPair', () => {
  it('pairs left/right kerbs and reports confidence', () => {
    const offsetsM = offsetsFrom(-5, 5);
    const input = buildInput(offsetsM, -2, 2, 4);
    const pair = computeWeightedKerbPair(input);
    expect(pair.leftOffsetM).toBeCloseTo(-2, 1);
    expect(pair.rightOffsetM).toBeCloseTo(2, 1);
    expect(pair.pairScore).not.toBeNull();
    expect(pair.confidence).toBeGreaterThan(0.45);
    expect(pair.needsReview).toBe(false);
    expect(pair.note).toContain('kerb_weighted');
  });

  it('renormalises weights and still pairs without BDTOPO width', () => {
    const offsetsM = offsetsFrom(-5, 5);
    const input = buildInput(offsetsM, -2, 2, null);
    const pair = computeWeightedKerbPair(input);
    expect(pair.leftOffsetM).toBeCloseTo(-2, 1);
    expect(pair.rightOffsetM).toBeCloseTo(2, 1);
    expect(pair.confidence).toBeGreaterThan(0.45);
  });

  it('flags needs_review and no pair on a flat profile', () => {
    const offsetsM = offsetsFrom(-5, 5);
    const flat = buildInput(offsetsM, -2, 2, 4, {
      sidewalkBoundaryScore: offsetsM.map(() => 0.05),
    });
    const pair = computeWeightedKerbPair(flat);
    expect(pair.leftOffsetM).toBeNull();
    expect(pair.rightOffsetM).toBeNull();
    expect(pair.needsReview).toBe(true);
    expect(pair.reasonCodes).toContain('kerb_w:no_candidate');
  });
});
