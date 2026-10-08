import type { Plateau } from './types.js';

function isExcludedAtOffset(
  buildingCost: readonly number[],
  vegCost: readonly number[],
  parkingCost: readonly number[],
  hardCost: readonly number[],
  k: number,
): boolean {
  return (
    (buildingCost[k] ?? 0) > 0 ||
    (vegCost[k] ?? 0) > 0 ||
    (parkingCost[k] ?? 0) > 0 ||
    (hardCost[k] ?? 0) > 0
  );
}

/**
 * Block when too many longitudinal samples fall outside the study region
 * **within the chosen width plateau only** (not the full ±15 m lateral scan).
 */
export const STUDY_REGION_MAX_SKIP_FRAC = 0.4;

/** Minimum mean per-line asphalt coverage inside the plateau band. */
export const STUDY_REGION_MIN_PLATEAU_COVERAGE = 0.4;

/** Block when too many lateral offsets inside the chosen plateau are hard-excluded. */
export const PLATEAU_MAX_EXCLUDED_OFFSET_FRAC = 0.4;

export interface StudyRegionGateInput {
  /** Legacy global skip count (full lateral scan); kept for debug notes only. */
  readonly studyPixelSkipped: number;
  readonly studySkippedPerOffset: readonly number[];
  readonly coverageProfile: readonly number[];
  readonly nSamplesPerLine: number;
  readonly offsetsM: readonly number[];
  readonly chosen: Plateau;
  readonly bdtopoBuildingCost: readonly number[];
  readonly bdtopoVegetationCost: readonly number[];
  readonly parkingExclusion: readonly number[];
  readonly bdtopoHardCost: readonly number[];
}

export interface StudyRegionGateMetrics {
  readonly skipFracGlobal: number;
  readonly skipFracPlateau: number;
  readonly meanCoveragePlateau: number;
}

export function computeStudyRegionGateMetrics(
  input: StudyRegionGateInput,
): StudyRegionGateMetrics {
  const nSteps = input.offsetsM.length;
  const totalGlobal = Math.max(1, nSteps * input.nSamplesPerLine);
  const skipFracGlobal = input.studyPixelSkipped / totalGlobal;

  let skippedPlateau = 0;
  let totalPlateau = 0;
  let coverageSum = 0;
  let coverageCount = 0;

  for (let k = 0; k < nSteps; k++) {
    const o = input.offsetsM[k]!;
    if (o < input.chosen.startM || o > input.chosen.endM) continue;
    skippedPlateau += input.studySkippedPerOffset[k] ?? 0;
    totalPlateau += input.nSamplesPerLine;
    coverageSum += input.coverageProfile[k] ?? 0;
    coverageCount++;
  }

  return {
    skipFracGlobal,
    skipFracPlateau: skippedPlateau / Math.max(1, totalPlateau),
    meanCoveragePlateau: coverageCount > 0 ? coverageSum / coverageCount : 0,
  };
}

export function applyStudyRegionGates(
  input: StudyRegionGateInput,
): {
  readonly blocked: boolean;
  readonly reasonCodes: readonly string[];
  readonly metrics: StudyRegionGateMetrics;
} {
  const reasonCodes: string[] = [];
  const metrics = computeStudyRegionGateMetrics(input);

  const lowCoverageInPlateau =
    metrics.skipFracPlateau > STUDY_REGION_MAX_SKIP_FRAC
    || metrics.meanCoveragePlateau < STUDY_REGION_MIN_PLATEAU_COVERAGE;

  if (lowCoverageInPlateau) {
    reasonCodes.push('study_region_low_coverage');
    return { blocked: true, reasonCodes, metrics };
  }

  let inRange = 0;
  let excluded = 0;
  for (let k = 0; k < input.offsetsM.length; k++) {
    const o = input.offsetsM[k]!;
    if (o < input.chosen.startM || o > input.chosen.endM) continue;
    inRange++;
    if (
      isExcludedAtOffset(
        input.bdtopoBuildingCost,
        input.bdtopoVegetationCost,
        input.parkingExclusion,
        input.bdtopoHardCost,
        k,
      )
    ) {
      excluded++;
    }
  }

  if (inRange > 0 && excluded / inRange > PLATEAU_MAX_EXCLUDED_OFFSET_FRAC) {
    reasonCodes.push('plateau_crosses_exclusion');
    return { blocked: true, reasonCodes, metrics };
  }

  return { blocked: false, reasonCodes, metrics };
}
