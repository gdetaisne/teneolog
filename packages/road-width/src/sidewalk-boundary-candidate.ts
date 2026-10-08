import type { Plateau } from './types.js';

/** Low shadow score expected on carriageway near axis centre. */
export const CANDIDATE_LOW_SCORE_MAX = 0.28;
/** Sustained break evidence above this counts as sidewalk-side. */
export const CANDIDATE_HIGH_SCORE_MIN = 0.35;
/**
 * Consecutive high-score offsets required to accept a boundary.
 * Calibrated for the dense sidewalk grid (`SIDEWALK_LATERAL_STEP_M=0.05`):
 * 3 × 5 cm = 15 cm of continuous bright signal, robust to single bright pixels.
 */
export const CANDIDATE_SUSTAINED_RUN = 3;
/** Search may extend this far beyond the chosen plateau edge (m). */
export const CANDIDATE_PLATEAU_OUTSIDE_MARGIN_M = 1.5;
/** Ignore candidate offsets farther than this from the nearest plateau edge (m). */
export const CANDIDATE_MAX_EDGE_DISTANCE_M = 2.75;
/** Outward window scanned after the candidate to verify it is a narrow peak. */
export const CANDIDATE_PEAK_WINDOW_M = 1.0;
/** A real kerb's score must drop by at least this fraction within the outward window. */
export const CANDIDATE_DROP_MIN_FRAC = 0.30;
/** Or the score must stay near-saturated, signalling a bright sidewalk beyond the kerb. */
export const CANDIDATE_TRUE_SIDEWALK_MIN = 0.85;

export const SIDEWALK_CANDIDATE_DEBUG_REASON = 'sidewalk_boundary_candidate_shadow_debug';

export interface SidewalkBoundaryCandidateInput {
  readonly offsetsM: readonly number[];
  readonly sidewalkBoundaryScore: readonly number[];
  readonly profile?: readonly number[];
  readonly roadMatchProfile?: readonly number[];
  readonly bdtopoBuildingCost: readonly number[];
  readonly bdtopoVegetationCost: readonly number[];
  readonly parkingExclusion: readonly number[];
  readonly bdtopoHardCost: readonly number[];
  readonly chosenPlateau: Plateau;
}

export interface SidewalkBoundaryCandidateResult {
  readonly curve: number[];
  readonly leftOffsetM: number | null;
  readonly rightOffsetM: number | null;
  readonly note: string | null;
  readonly reason: string | null;
}

function isHardExcluded(input: SidewalkBoundaryCandidateInput, k: number): boolean {
  return (
    (input.bdtopoBuildingCost[k] ?? 0) > 0 ||
    (input.bdtopoVegetationCost[k] ?? 0) > 0 ||
    (input.parkingExclusion[k] ?? 0) > 0 ||
    (input.bdtopoHardCost[k] ?? 0) > 0
  );
}

function inSideSearchWindow(
  side: 'left' | 'right',
  offsetM: number,
  plateau: Plateau,
): boolean {
  const { startM, endM } = plateau;
  const margin = CANDIDATE_PLATEAU_OUTSIDE_MARGIN_M;
  if (side === 'left') {
    const lo = startM - margin;
    const hi = Math.min(0, endM);
    return offsetM >= lo && offsetM <= hi;
  }
  const lo = Math.max(0, startM);
  const hi = endM + margin;
  return offsetM >= lo && offsetM <= hi;
}

function nearPlateauEdge(
  side: 'left' | 'right',
  offsetM: number,
  plateau: Plateau,
): boolean {
  const edge = side === 'left' ? plateau.startM : plateau.endM;
  return Math.abs(offsetM - edge) <= CANDIDATE_MAX_EDGE_DISTANCE_M;
}

function indicesOutwardFromCenter(
  offsetsM: readonly number[],
  side: 'left' | 'right',
): number[] {
  const centerIdx = offsetsM.findIndex((o) => o >= 0);
  const start = centerIdx >= 0 ? centerIdx : Math.floor(offsetsM.length / 2);
  const out: number[] = [];
  if (side === 'left') {
    for (let k = start; k >= 0; k--) out.push(k);
  } else {
    for (let k = start; k < offsetsM.length; k++) out.push(k);
  }
  return out;
}

function sustainedHighRun(
  scores: readonly number[],
  indices: readonly number[],
  startPos: number,
): boolean {
  let run = 0;
  for (let p = startPos; p < indices.length; p++) {
    const k = indices[p]!;
    if ((scores[k] ?? 0) >= CANDIDATE_HIGH_SCORE_MIN) {
      run++;
      if (run >= CANDIDATE_SUSTAINED_RUN) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

/**
 * A real kerb shows a narrow peak: asphalt is dark, the kerb edge is bright,
 * and beyond the kerb either a brighter sidewalk continues (saturated score)
 * or the signal drops (kerb is the last evidence before veg/buildings/road).
 * A continuous bright plateau (e.g. apron of an intersection, light asphalt,
 * undetected vehicles in a row) shows neither and must be rejected.
 */
function isLocalPeakNotPlateau(
  scores: readonly number[],
  offsetsM: readonly number[],
  k: number,
  side: 'left' | 'right',
): boolean {
  const peak = scores[k] ?? 0;
  if (peak <= 0) return false;

  const dir = side === 'right' ? +1 : -1;
  const peakOffsetM = offsetsM[k]!;

  let minOut = peak;
  let countOut = 0;
  for (let i = 1; i < scores.length; i++) {
    const idx = k + dir * i;
    if (idx < 0 || idx >= scores.length) break;
    const off = offsetsM[idx]!;
    if (Math.abs(off - peakOffsetM) > CANDIDATE_PEAK_WINDOW_M) break;
    const v = scores[idx] ?? 0;
    if (v < minOut) minOut = v;
    countOut++;
  }

  if (countOut === 0) return true;
  if (minOut >= CANDIDATE_TRUE_SIDEWALK_MIN) return true;
  const dropFrac = (peak - minOut) / Math.max(peak, 0.001);
  return dropFrac >= CANDIDATE_DROP_MIN_FRAC;
}

function findSideCandidate(
  input: SidewalkBoundaryCandidateInput,
  side: 'left' | 'right',
): number | null {
  const { offsetsM, sidewalkBoundaryScore, chosenPlateau } = input;
  const order = indicesOutwardFromCenter(offsetsM, side);
  let seenLowNearCenter = false;

  for (let p = 0; p < order.length; p++) {
    const k = order[p]!;
    const offsetM = offsetsM[k]!;
    if (isHardExcluded(input, k)) continue;
    if (!inSideSearchWindow(side, offsetM, chosenPlateau)) continue;
    if (!nearPlateauEdge(side, offsetM, chosenPlateau)) continue;

    const score = sidewalkBoundaryScore[k] ?? 0;
    if (!seenLowNearCenter) {
      if (score <= CANDIDATE_LOW_SCORE_MAX) seenLowNearCenter = true;
      continue;
    }
    if (score < CANDIDATE_HIGH_SCORE_MIN) continue;
    if (!sustainedHighRun(sidewalkBoundaryScore, order, p)) continue;
    if (!isLocalPeakNotPlateau(sidewalkBoundaryScore, offsetsM, k, side)) continue;
    return k;
  }
  return null;
}

function stampPeak(curve: number[], k: number): void {
  curve[k] = 1;
  if (k > 0) curve[k - 1] = Math.max(curve[k - 1]!, 0.6);
  if (k < curve.length - 1) curve[k + 1] = Math.max(curve[k + 1]!, 0.6);
}

/**
 * Debug-only narrow peaks at the first outward sidewalk-boundary transition per side.
 * Does not affect published width / plateau / verdict.
 */
export function computeSidewalkBoundaryCandidateCurve(
  input: SidewalkBoundaryCandidateInput,
): SidewalkBoundaryCandidateResult {
  const n = input.offsetsM.length;
  const curve = new Array<number>(n).fill(0);
  const leftK = findSideCandidate(input, 'left');
  const rightK = findSideCandidate(input, 'right');

  if (leftK !== null) stampPeak(curve, leftK);
  if (rightK !== null) stampPeak(curve, rightK);

  const leftOffsetM = leftK !== null ? input.offsetsM[leftK]! : null;
  const rightOffsetM = rightK !== null ? input.offsetsM[rightK]! : null;

  if (leftOffsetM === null && rightOffsetM === null) {
    return { curve, leftOffsetM, rightOffsetM, note: null, reason: null };
  }

  const parts: string[] = [];
  if (leftOffsetM !== null) parts.push(`L${leftOffsetM.toFixed(2)}`);
  if (rightOffsetM !== null) parts.push(`R${rightOffsetM.toFixed(2)}`);

  return {
    curve,
    leftOffsetM,
    rightOffsetM,
    note: `sidewalk_boundary_candidate:${parts.join('/')}`,
    reason: SIDEWALK_CANDIDATE_DEBUG_REASON,
  };
}
