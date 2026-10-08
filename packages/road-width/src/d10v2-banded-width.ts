import {
  CANDIDATE_DROP_MIN_FRAC,
  CANDIDATE_HIGH_SCORE_MIN,
  CANDIDATE_LOW_SCORE_MAX,
  CANDIDATE_SUSTAINED_RUN,
  CANDIDATE_TRUE_SIDEWALK_MIN,
} from './sidewalk-boundary-candidate.js';

/** Total acceptable spread for structural width vs BDTOPO (m). */
export const BDTOPO_V2_BAND_TOTAL_M = 1.5;

/** Half-band applied on each side of BDTOPO width (m). */
export const BDTOPO_V2_BAND_HALF_M = BDTOPO_V2_BAND_TOTAL_M / 2;

export interface BdtopoV2WidthBand {
  readonly bandLoM: number;
  readonly bandHiM: number;
  /** Outermost left kerb search bound (−bandHi/2). */
  readonly leftEdgeOuterM: number;
  /** Innermost left kerb search bound (−bandLo/2). */
  readonly leftEdgeInnerM: number;
  /** Innermost right kerb search bound (+bandLo/2). */
  readonly rightEdgeInnerM: number;
  /** Outermost right kerb search bound (+bandHi/2). */
  readonly rightEdgeOuterM: number;
}

export interface KerbCandidate {
  readonly offsetM: number;
  readonly side: 'left' | 'right';
  readonly score: number;
  readonly index: number;
}

export type D10v2StructuralSource = 'kerb_pair' | 'bdtopo_fallback' | 'unavailable';

export interface ResolveD10v2StructuralInput {
  readonly bdtopoWidthM: number | null;
  readonly offsetsM: readonly number[];
  readonly sidewalkBoundaryScore: readonly number[];
  readonly roadMatchProfile?: readonly number[];
}

export interface D10v2StructuralResult {
  /** Phase A output — carriageway width excluding parked vehicles. */
  readonly largeurRueM: number | null;
  readonly source: D10v2StructuralSource;
  readonly leftEdgeM: number | null;
  readonly rightEdgeM: number | null;
  readonly bandLoM: number | null;
  readonly bandHiM: number | null;
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function bdtopoV2WidthBand(bdtopoWidthM: number): BdtopoV2WidthBand {
  const bandLoM = bdtopoWidthM - BDTOPO_V2_BAND_HALF_M;
  const bandHiM = bdtopoWidthM + BDTOPO_V2_BAND_HALF_M;
  return {
    bandLoM,
    bandHiM,
    leftEdgeOuterM: -bandHiM / 2,
    leftEdgeInnerM: -bandLoM / 2,
    rightEdgeInnerM: bandLoM / 2,
    rightEdgeOuterM: bandHiM / 2,
  };
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

function inBandEdgeWindow(
  side: 'left' | 'right',
  offsetM: number,
  band: BdtopoV2WidthBand,
): boolean {
  if (side === 'left') {
    return offsetM >= band.leftEdgeOuterM && offsetM <= band.leftEdgeInnerM;
  }
  return offsetM >= band.rightEdgeInnerM && offsetM <= band.rightEdgeOuterM;
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
  const windowM = 1.0;

  let minOut = peak;
  let countOut = 0;
  for (let i = 1; i < scores.length; i++) {
    const idx = k + dir * i;
    if (idx < 0 || idx >= scores.length) break;
    const off = offsetsM[idx]!;
    if (Math.abs(off - peakOffsetM) > windowM) break;
    const v = scores[idx] ?? 0;
    if (v < minOut) minOut = v;
    countOut++;
  }

  if (countOut === 0) return true;
  if (minOut >= CANDIDATE_TRUE_SIDEWALK_MIN) return true;
  const dropFrac = (peak - minOut) / Math.max(peak, 0.001);
  return dropFrac >= CANDIDATE_DROP_MIN_FRAC;
}

/** Kerb candidates on one side within the BDTOPO band edge window (no BDTOPO hard masks). */
export function findBandKerbCandidates(
  side: 'left' | 'right',
  input: {
    readonly offsetsM: readonly number[];
    readonly sidewalkBoundaryScore: readonly number[];
    readonly band: BdtopoV2WidthBand;
  },
): KerbCandidate[] {
  const { offsetsM, sidewalkBoundaryScore, band } = input;
  const order = indicesOutwardFromCenter(offsetsM, side);
  const candidates: KerbCandidate[] = [];
  let seenLowNearCenter = false;

  for (let p = 0; p < order.length; p++) {
    const k = order[p]!;
    const offsetM = offsetsM[k]!;
    if (!inBandEdgeWindow(side, offsetM, band)) continue;

    const score = sidewalkBoundaryScore[k] ?? 0;
    if (!seenLowNearCenter) {
      if (score <= CANDIDATE_LOW_SCORE_MAX) seenLowNearCenter = true;
      continue;
    }
    if (score < CANDIDATE_HIGH_SCORE_MIN) continue;
    if (!sustainedHighRun(sidewalkBoundaryScore, order, p)) continue;
    if (!isLocalPeakNotPlateau(sidewalkBoundaryScore, offsetsM, k, side)) continue;

    candidates.push({ offsetM, side, score, index: k });
  }

  return candidates;
}

function meanRoadMatchBetween(
  roadMatch: readonly number[] | undefined,
  leftIdx: number,
  rightIdx: number,
): number {
  if (!roadMatch || roadMatch.length === 0) return 0.5;
  const lo = Math.min(leftIdx, rightIdx);
  const hi = Math.max(leftIdx, rightIdx);
  let sum = 0;
  let n = 0;
  for (let k = lo; k <= hi; k++) {
    sum += roadMatch[k] ?? 0;
    n++;
  }
  return n > 0 ? sum / n : 0.5;
}

function scoreKerbPair(
  left: KerbCandidate,
  right: KerbCandidate,
  widthM: number,
  bdtopoWidthM: number,
  roadMatch?: readonly number[],
): number {
  const kerbStrength = (left.score + right.score) / 2;
  const roadQuality = meanRoadMatchBetween(roadMatch, left.index, right.index);
  const widthPenalty = 1 - Math.min(1, Math.abs(widthM - bdtopoWidthM) / BDTOPO_V2_BAND_HALF_M);
  return kerbStrength * 0.5 + roadQuality * 0.3 + widthPenalty * 0.2;
}

export interface KerbPairPick {
  readonly left: KerbCandidate;
  readonly right: KerbCandidate;
  readonly widthM: number;
  readonly pairScore: number;
}

/** Best (left, right) kerb pair with width inside the BDTOPO band. */
export function pickBestKerbPair(
  leftCandidates: readonly KerbCandidate[],
  rightCandidates: readonly KerbCandidate[],
  band: BdtopoV2WidthBand,
  bdtopoWidthM: number,
  roadMatch?: readonly number[],
): KerbPairPick | null {
  let best: KerbPairPick | null = null;

  for (const left of leftCandidates) {
    for (const right of rightCandidates) {
      const widthM = right.offsetM - left.offsetM;
      if (widthM < band.bandLoM - 0.01 || widthM > band.bandHiM + 0.01) continue;
      const pairScore = scoreKerbPair(left, right, widthM, bdtopoWidthM, roadMatch);
      if (!best || pairScore > best.pairScore) {
        best = { left, right, widthM, pairScore };
      }
    }
  }

  return best;
}

/**
 * D10v2 Phase A — structural carriageway width from BDTOPO-banded kerb search.
 */
export function resolveD10v2StructuralWidth(
  input: ResolveD10v2StructuralInput,
): D10v2StructuralResult {
  if (input.bdtopoWidthM == null || input.bdtopoWidthM <= 0) {
    return {
      largeurRueM: null,
      source: 'unavailable',
      leftEdgeM: null,
      rightEdgeM: null,
      bandLoM: null,
      bandHiM: null,
      confidence: 0,
      reasonCodes: ['d10v2:no_bdtopo_width'],
    };
  }

  if (input.offsetsM.length === 0 || input.sidewalkBoundaryScore.length === 0) {
    return {
      largeurRueM: round2(input.bdtopoWidthM),
      source: 'bdtopo_fallback',
      leftEdgeM: null,
      rightEdgeM: null,
      bandLoM: null,
      bandHiM: null,
      confidence: 0.35,
      reasonCodes: ['d10v2:no_profile_scores', 'd10v2:bdtopo_fallback'],
    };
  }

  const bdtopo = input.bdtopoWidthM;
  const band = bdtopoV2WidthBand(bdtopo);
  const reasonCodes = [
    `d10v2:band_total=${BDTOPO_V2_BAND_TOTAL_M}m`,
    `d10v2:bdtopo=${round2(bdtopo)}`,
    `d10v2:band_lo=${round2(band.bandLoM)}`,
    `d10v2:band_hi=${round2(band.bandHiM)}`,
    `d10v2:left_window=${round2(band.leftEdgeOuterM)}..${round2(band.leftEdgeInnerM)}`,
    `d10v2:right_window=${round2(band.rightEdgeInnerM)}..${round2(band.rightEdgeOuterM)}`,
  ];

  const leftCandidates = findBandKerbCandidates('left', {
    offsetsM: input.offsetsM,
    sidewalkBoundaryScore: input.sidewalkBoundaryScore,
    band,
  });
  const rightCandidates = findBandKerbCandidates('right', {
    offsetsM: input.offsetsM,
    sidewalkBoundaryScore: input.sidewalkBoundaryScore,
    band,
  });

  reasonCodes.push(
    `d10v2:kerb_candidates:L=${leftCandidates.length},R=${rightCandidates.length}`,
  );

  const best = pickBestKerbPair(
    leftCandidates,
    rightCandidates,
    band,
    bdtopo,
    input.roadMatchProfile,
  );

  if (best) {
    const confidence = Math.min(
      0.95,
      0.45 + best.pairScore * 0.5,
    );
    reasonCodes.push(
      `d10v2:kerb_pair:L${round2(best.left.offsetM)}R${round2(best.right.offsetM)}`,
      `d10v2:width=${round2(best.widthM)}`,
      `d10v2:pair_score=${best.pairScore.toFixed(3)}`,
    );
    return {
      largeurRueM: round2(best.widthM),
      source: 'kerb_pair',
      leftEdgeM: round2(best.left.offsetM),
      rightEdgeM: round2(best.right.offsetM),
      bandLoM: round2(band.bandLoM),
      bandHiM: round2(band.bandHiM),
      confidence: round2(confidence),
      reasonCodes,
    };
  }

  reasonCodes.push('d10v2:bdtopo_fallback');
  return {
    largeurRueM: round2(bdtopo),
    source: 'bdtopo_fallback',
    leftEdgeM: round2(-bdtopo / 2),
    rightEdgeM: round2(bdtopo / 2),
    bandLoM: round2(band.bandLoM),
    bandHiM: round2(band.bandHiM),
    confidence: 0.4,
    reasonCodes,
  };
}
