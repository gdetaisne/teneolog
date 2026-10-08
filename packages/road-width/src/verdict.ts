import type { YoloFetchStatus } from './yolo-status.js';

export type RoadWidthVerdictStatus = 'usable' | 'needs_review' | 'unavailable';

export interface RoadWidthVerdict {
  readonly status: RoadWidthVerdictStatus;
  readonly blockingReasons: readonly string[];
  readonly degradedReasons: readonly string[];
}

const MIN_ASPHALT_SAMPLES = 30;
const LOW_CONFIDENCE = 0.5;

/** Max(|Δ|, 12% of BDTOPO tag) with floor 0.5 m — validate on corpus before tightening. */
export function bdtopoWidthCorroborationToleranceM(bdtopoWidthM: number): number {
  return Math.max(0.5, bdtopoWidthM * 0.12);
}

export function widthsCorroborateBdtopo(measuredM: number, bdtopoWidthM: number): boolean {
  return Math.abs(measuredM - bdtopoWidthM) <= bdtopoWidthCorroborationToleranceM(bdtopoWidthM);
}

export interface BuildVerdictInput {
  readonly widthM: number | null;
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly yoloStatus: YoloFetchStatus;
  readonly asphaltSampleCount: number;
  /** When true, YOLO failure blocks automatic acceptance (parking / bilateral corpus). */
  readonly parkingSensitive: boolean;
  /** Nearest aligned BDTOPO `largeur_de_chaussee` when present on fetch. */
  readonly bdtopoWidthM?: number | null;
}

export function buildRoadWidthVerdict(input: BuildVerdictInput): RoadWidthVerdict {
  const blocking: string[] = [];
  const degraded: string[] = [];

  if (input.reasonCodes.includes('study_region_low_coverage')) {
    blocking.push('study_region_low_coverage');
  }
  if (input.reasonCodes.includes('plateau_crosses_exclusion')) {
    blocking.push('plateau_crosses_exclusion');
  }
  if (input.reasonCodes.includes('no_plateau')) {
    blocking.push('no_plateau');
  }
  if (input.widthM === null && blocking.length === 0) {
    blocking.push('measurement_unavailable');
  }

  if (blocking.length > 0) {
    return { status: 'unavailable', blockingReasons: blocking, degradedReasons: degraded };
  }

  if (input.yoloStatus === 'http_error') {
    degraded.push('yolo_http_error');
  } else if (input.yoloStatus === 'timeout') {
    degraded.push('yolo_timeout');
  } else if (input.yoloStatus === 'invalid_response') {
    degraded.push('yolo_invalid_response');
  } else if (input.yoloStatus === 'fallback') {
    degraded.push('yolo_fallback');
  }

  if (input.parkingSensitive && input.yoloStatus !== 'ok' && input.yoloStatus !== 'empty') {
    blocking.push('yolo_unreliable_parking_sensitive');
  }

  if (input.reasonCodes.includes('tile_rejected_low_confidence')) {
    degraded.push('consolidation_fallback_tile');
  }
  if (input.reasonCodes.includes('tile_rejected_outlier')) {
    degraded.push('tile_outlier_rejected');
  }
  if (input.asphaltSampleCount < MIN_ASPHALT_SAMPLES) {
    degraded.push('asphalt_few_samples');
  }
  if (input.reasonCodes.includes('too_narrow') || input.reasonCodes.includes('too_wide')) {
    degraded.push('width_out_of_plausible_range');
  }
  if (input.reasonCodes.includes('building_mask_unavailable')) {
    degraded.push('bdtopo_building_mask_unavailable');
  }

  const yoloDegraded = input.yoloStatus !== 'ok' && input.yoloStatus !== 'empty';
  if (
    degraded.length > 0 ||
    yoloDegraded ||
    input.confidence < LOW_CONFIDENCE
  ) {
    const bdtopoWidthM = input.bdtopoWidthM ?? null;
    if (
      blocking.length === 0 &&
      input.widthM != null &&
      bdtopoWidthM != null &&
      widthsCorroborateBdtopo(input.widthM, bdtopoWidthM)
    ) {
      return {
        status: 'usable',
        blockingReasons: blocking,
        degradedReasons: [...degraded, 'bdtopo_width_corroborated_lift'],
      };
    }
    return { status: 'needs_review', blockingReasons: blocking, degradedReasons: degraded };
  }

  return { status: 'usable', blockingReasons: blocking, degradedReasons: degraded };
}

export function applyVerdictToConfidence(
  confidence: number,
  verdict: RoadWidthVerdict,
  yoloStatus: YoloFetchStatus,
): number {
  let c = confidence;
  if (yoloStatus === 'fallback') c *= 0.75;
  if (yoloStatus === 'http_error' || yoloStatus === 'timeout' || yoloStatus === 'invalid_response') {
    c *= 0.55;
  }
  if (verdict.status === 'unavailable') c = Math.min(c, 0.15);
  if (verdict.status === 'needs_review') c = Math.min(c, 0.55);
  return Math.round(c * 100) / 100;
}

export function entryTagsParkingSensitive(tags: string): boolean {
  const t = tags.toLowerCase();
  return t.includes('parking') || t.includes('bilateral') || t.includes('stationnement');
}
