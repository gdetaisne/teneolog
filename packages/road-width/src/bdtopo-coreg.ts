/**
 * BDTOPO ↔ orthophoto lateral co-registration (D10).
 *
 * IGN BD TOPO (vector) and BD ORTHO (raster) can disagree planimetrically by
 * 1-several metres, especially in peri-urban / rural areas. When the BDTOPO road
 * axis (and the building/vegetation footprints rigidly attached to it) are
 * laterally offset from the actual carriageway in the orthophoto, the BDTOPO
 * masks get rasterised on top of road pixels and the width measurement collapses
 * (the study region excludes the real carriageway).
 *
 * This module estimates the *lateral* offset δ (perpendicular to the road axis)
 * between the BDTOPO road prior and the road texture observed in the raster, by
 * sliding a box prior (width = BDTOPO carriageway width) over the measured
 * `roadMatch` lateral profile and picking the shift that best captures the road.
 *
 * The estimate is intentionally 1D (lateral only): for a locally straight road,
 * the perpendicular component is what clips the cross-section; the along-axis
 * component does not change the measured width. Pure, deterministic, no I/O.
 */

export interface LateralOffsetEstimate {
  /** δ: lateral shift (m) of the detected road centre vs the BDTOPO axis (s = 0). */
  readonly offsetM: number;
  /** 0..1 — how confidently the road texture supports this shift. */
  readonly confidence: number;
  /** Mean `roadMatch` captured inside the best-fit window (0..1). */
  readonly capturedRoadFrac: number;
  /** Window width (m) used for the box prior. */
  readonly priorWidthM: number;
}

export interface EstimateLateralOffsetOptions {
  /** Max |δ| searched, metres. Default 3. */
  readonly maxShiftM?: number;
  /** Candidate-centre search step, metres. Default 0.1. */
  readonly stepM?: number;
  /** BDTOPO carriageway width prior (m). Clamped to [minPriorWidthM, maxPriorWidthM]. */
  readonly bdtopoWidthM?: number | null;
  /** Lower clamp for the prior window width. Default 2.5. */
  readonly minPriorWidthM?: number;
  /** Upper clamp for the prior window width. Default 9. */
  readonly maxPriorWidthM?: number;
  /** Flank band (m) just outside the box, penalised to snap onto the true extent. Default 0.75. */
  readonly flankM?: number;
  /** Weight of the flank penalty in the score. Default 0.6. */
  readonly flankWeight?: number;
}

const NEUTRAL: LateralOffsetEstimate = {
  offsetM: 0,
  confidence: 0,
  capturedRoadFrac: 0,
  priorWidthM: 0,
};

/** Linear interpolation of a profile sampled on a sorted `offsetsM` grid. */
function sampleAt(offsetsM: readonly number[], values: readonly number[], s: number): number {
  const n = offsetsM.length;
  if (n === 0) return 0;
  if (s <= offsetsM[0]!) return values[0]!;
  if (s >= offsetsM[n - 1]!) return values[n - 1]!;
  // grid is monotonic increasing; linear scan is fine for D10 profile sizes (~100)
  for (let i = 1; i < n; i++) {
    const x1 = offsetsM[i]!;
    if (s <= x1) {
      const x0 = offsetsM[i - 1]!;
      const t = x1 === x0 ? 0 : (s - x0) / (x1 - x0);
      return values[i - 1]! + t * (values[i]! - values[i - 1]!);
    }
  }
  return values[n - 1]!;
}

/** Mean of a profile over [aM, bM] sampled at `stepM`. */
function meanOver(
  offsetsM: readonly number[],
  values: readonly number[],
  aM: number,
  bM: number,
  stepM: number,
): number {
  if (bM <= aM) return 0;
  let sum = 0;
  let count = 0;
  for (let s = aM; s <= bM + 1e-9; s += stepM) {
    sum += sampleAt(offsetsM, values, s);
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Estimate the lateral BDTOPO↔ortho offset from the measured road-match profile.
 *
 * @param offsetsM lateral offsets (m), sorted ascending; s = 0 is the BDTOPO axis.
 * @param roadMatchProfile road-texture match per offset (0..1), parallel to `offsetsM`.
 *   This must be the *texture* match (asphalt model), NOT a mask-clipped profile.
 */
export function estimateLateralBdtopoOffset(
  offsetsM: readonly number[],
  roadMatchProfile: readonly number[],
  opts: EstimateLateralOffsetOptions = {},
): LateralOffsetEstimate {
  if (
    offsetsM.length < 3 ||
    offsetsM.length !== roadMatchProfile.length ||
    offsetsM.some((v, i) => i > 0 && v <= offsetsM[i - 1]!)
  ) {
    return NEUTRAL;
  }

  const maxShiftM = opts.maxShiftM ?? 3;
  const stepM = opts.stepM ?? 0.1;
  const minPriorWidthM = opts.minPriorWidthM ?? 2.5;
  const maxPriorWidthM = opts.maxPriorWidthM ?? 9;
  const flankM = opts.flankM ?? 0.75;
  const flankWeight = opts.flankWeight ?? 0.6;

  const priorWidthM = Math.min(
    maxPriorWidthM,
    Math.max(minPriorWidthM, opts.bdtopoWidthM ?? minPriorWidthM),
  );
  const half = priorWidthM / 2;

  let bestScore = -Infinity;
  let bestCenter = 0;
  let bestInBox = 0;
  let bestFlank = 0;

  for (let c = -maxShiftM; c <= maxShiftM + 1e-9; c += stepM) {
    const inBox = meanOver(offsetsM, roadMatchProfile, c - half, c + half, stepM);
    const flankLeft = meanOver(offsetsM, roadMatchProfile, c - half - flankM, c - half, stepM);
    const flankRight = meanOver(offsetsM, roadMatchProfile, c + half, c + half + flankM, stepM);
    const flank = (flankLeft + flankRight) / 2;
    const score = inBox - flankWeight * flank;
    // Prefer the smaller |center| on ties (stay close to the BDTOPO axis).
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && Math.abs(c) < Math.abs(bestCenter))) {
      bestScore = score;
      bestCenter = c;
      bestInBox = inBox;
      bestFlank = flank;
    }
  }

  // Confidence: strong when the box is full of road and the flanks are not.
  const confidence = Math.max(0, Math.min(1, bestInBox * (1 - bestFlank)));

  return {
    offsetM: bestCenter,
    confidence,
    capturedRoadFrac: bestInBox,
    priorWidthM,
  };
}
