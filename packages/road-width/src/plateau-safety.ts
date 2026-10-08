import type { Plateau } from './types.js';

export const FLAT_SATURATED_PLATEAU_REASON = 'flat_saturated_plateau';

export interface FlatSaturatedPlateauAssessmentInput {
  readonly offsetsM: readonly number[];
  readonly profile: readonly number[];
  readonly plateau: Plateau;
  /** Optional width prior used to catch D10v2 cropped plateau fallbacks. */
  readonly expectedWidthM?: number | null;
}

export interface FlatSaturatedPlateauAssessment {
  readonly unsafe: boolean;
  readonly reasonCodes: readonly string[];
  readonly meanScore: number;
  readonly minScore: number;
  readonly maxScore: number;
  readonly maxGradientPerM: number;
}

const SATURATED_MEAN_MIN = 0.9;
const SATURATED_MIN_MIN = 0.78;
const FLAT_MAX_GRADIENT_PER_M = 0.08;
const FLAT_MAX_SCORE_RANGE = 0.12;
const WIDE_ABSOLUTE_M = 14;
const EXPECTED_WIDTH_EXCESS_M = 2.5;
const EXPECTED_WIDTH_RATIO = 1.6;
const NARROW_EXPECTED_WIDTH_DEFICIT_M = 2;
const NARROW_EXPECTED_WIDTH_RATIO = 0.5;
const NARROW_STREET_WIDTH_M = 3.5;
const NARROW_STREET_EXCESS_M = 1;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function isPlateauWidthSuspicious(
  widthM: number,
  expectedWidthM?: number | null,
): boolean {
  if (widthM > WIDE_ABSOLUTE_M) return true;
  if (expectedWidthM == null || expectedWidthM <= 0) return false;
  if (
    expectedWidthM <= NARROW_STREET_WIDTH_M
    && widthM >= expectedWidthM + NARROW_STREET_EXCESS_M
  ) {
    return true;
  }
  return (
    widthM >= expectedWidthM + EXPECTED_WIDTH_EXCESS_M
    || widthM >= expectedWidthM * EXPECTED_WIDTH_RATIO
    || widthM <= expectedWidthM - NARROW_EXPECTED_WIDTH_DEFICIT_M
    || widthM <= expectedWidthM * NARROW_EXPECTED_WIDTH_RATIO
  );
}

/**
 * Detect the rural failure mode where the full lateral scan looks like road:
 * high profile everywhere, almost no gradient, and a plateau wider than any
 * plausible carriageway/prior. This is a safety guard, not an edge detector.
 */
export function assessFlatSaturatedPlateau(
  input: FlatSaturatedPlateauAssessmentInput,
): FlatSaturatedPlateauAssessment {
  const values: Array<{ offsetM: number; score: number }> = [];
  for (let k = 0; k < input.offsetsM.length; k++) {
    const offsetM = input.offsetsM[k]!;
    if (offsetM < input.plateau.startM || offsetM > input.plateau.endM) continue;
    const score = input.profile[k];
    if (score === undefined) continue;
    values.push({ offsetM, score });
  }

  if (values.length < 3) {
    return {
      unsafe: false,
      reasonCodes: [],
      meanScore: 0,
      minScore: 0,
      maxScore: 0,
      maxGradientPerM: 0,
    };
  }

  let sum = 0;
  let minScore = Infinity;
  let maxScore = -Infinity;
  let maxGradientPerM = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!.score;
    sum += v;
    minScore = Math.min(minScore, v);
    maxScore = Math.max(maxScore, v);
    if (i > 0) {
      const prev = values[i - 1]!;
      const ds = Math.abs(values[i]!.offsetM - prev.offsetM);
      if (ds > 0) {
        maxGradientPerM = Math.max(maxGradientPerM, Math.abs(v - prev.score) / ds);
      }
    }
  }

  const meanScore = sum / values.length;
  const saturated =
    meanScore >= SATURATED_MEAN_MIN
    && minScore >= SATURATED_MIN_MIN
    && (
      maxGradientPerM <= FLAT_MAX_GRADIENT_PER_M
      || maxScore - minScore <= FLAT_MAX_SCORE_RANGE
    );
  const tooWide = isPlateauWidthSuspicious(input.plateau.widthM, input.expectedWidthM);
  const unsafe = saturated && tooWide;
  const reasonCodes = unsafe
    ? [
        FLAT_SATURATED_PLATEAU_REASON,
        `flat_plateau:w=${round2(input.plateau.widthM)},mean=${meanScore.toFixed(2)},grad=${maxGradientPerM.toFixed(2)}`,
      ]
    : [];

  return {
    unsafe,
    reasonCodes,
    meanScore: round2(meanScore),
    minScore: round2(minScore),
    maxScore: round2(maxScore),
    maxGradientPerM: round2(maxGradientPerM),
  };
}
