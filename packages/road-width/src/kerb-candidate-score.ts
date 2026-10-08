import type { Plateau } from './types.js';
import {
  CANDIDATE_LOW_SCORE_MAX,
  CANDIDATE_HIGH_SCORE_MIN,
  CANDIDATE_MAX_EDGE_DISTANCE_M,
  CANDIDATE_PLATEAU_OUTSIDE_MARGIN_M,
} from './sidewalk-boundary-candidate.js';

/**
 * Weighted kerb / road-edge candidate scoring (D10v2 only, non-canonical).
 *
 * Design: la note de conception interne
 *
 * 3 strict levels:
 *  - LEVEL 0 hard gates (boolean) — eliminate an offset.
 *  - LEVEL 1 weighted score S in [0,1] — argmax per side.
 *  - LEVEL 2 pair + confidence — L/R pairing and width coherence.
 *
 * The legacy boolean cascade (`computeSidewalkBoundaryCandidateCurve`) stays the
 * canonical D10 path; this module only feeds D10v2 structural width.
 */

/** LEVEL 1 weights (sum to 1 when BDTOPO width is present). */
export const KERB_W_KERB_BREAK = 0.35;
export const KERB_W_ASPHALT_DROP = 0.25;
export const KERB_W_SIDEWALK_BEYOND = 0.25;
export const KERB_W_BDTOPO_AGREEMENT = 0.15;

/** Soft prerequisite — no visible colour break ⇒ no detectable kerb. */
export const KERB_BREAK_FLOOR = 0.15;
/** Minimum weighted score to accept a side candidate. */
export const KERB_S_ACCEPT = 0.45;
/** Minimum pair confidence before flagging needs_review. */
export const KERB_PAIR_CONFIDENCE_FLOOR = 0.4;

/** Road-likelihood drop reference (full term at this center→outward delta). */
export const KERB_ASPHALT_DROP_REF = 0.5;
/** Inward window (m) used as the carriageway road-match baseline. */
export const KERB_ASPHALT_INNER_WINDOW_M = 1.0;
/** Outward window (m) scanned for a clean continuing sidewalk. */
export const KERB_SIDEWALK_BEYOND_WINDOW_M = 1.0;
/** Sustained colour-break run (m) — grid-step agnostic. */
export const KERB_SUSTAINED_RUN_M = 0.15;

export interface WeightedKerbInput {
  readonly offsetsM: readonly number[];
  readonly sidewalkBoundaryScore: readonly number[];
  readonly roadMatchProfile: readonly number[];
  readonly bdtopoBuildingCost: readonly number[];
  readonly bdtopoVegetationCost: readonly number[];
  readonly parkingExclusion: readonly number[];
  readonly bdtopoHardCost: readonly number[];
  readonly chosenPlateau: Plateau;
  readonly bdtopoWidthM: number | null;
  /** Half-band tolerance for BDTOPO width agreement (m). */
  readonly bdtopoBandHalfM: number;
}

export interface WeightedKerbTermBreakdown {
  readonly kerbBreak: number;
  readonly asphaltDrop: number;
  readonly sidewalkBeyond: number;
  readonly bdtopoAgreement: number;
}

export interface WeightedKerbSideCandidate {
  readonly index: number;
  readonly offsetM: number;
  readonly score: number;
  readonly terms: WeightedKerbTermBreakdown;
}

export interface WeightedKerbPairResult {
  readonly leftOffsetM: number | null;
  readonly rightOffsetM: number | null;
  readonly leftScore: number | null;
  readonly rightScore: number | null;
  readonly pairScore: number | null;
  readonly confidence: number;
  readonly needsReview: boolean;
  readonly reasonCodes: readonly string[];
  readonly note: string | null;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function gridStepM(offsetsM: readonly number[]): number {
  if (offsetsM.length < 2) return 0.25;
  return Math.abs(offsetsM[1]! - offsetsM[0]!) || 0.25;
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

function isHardExcluded(input: WeightedKerbInput, k: number): boolean {
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
  const margin = CANDIDATE_PLATEAU_OUTSIDE_MARGIN_M;
  if (side === 'left') {
    const lo = plateau.startM - margin;
    const hi = Math.min(0, plateau.endM);
    return offsetM >= lo && offsetM <= hi;
  }
  const lo = Math.max(0, plateau.startM);
  const hi = plateau.endM + margin;
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

/**
 * When BDTOPO width is known, the kerb can only sit within the BDTOPO band edge
 * window (±bandHalf around the expected half-width). This prevents the argmax
 * from drifting outward onto a brighter sidewalk plateau far past the kerb.
 */
function inBdtopoEdgeWindow(
  side: 'left' | 'right',
  offsetM: number,
  bdtopoWidthM: number,
  bandHalfM: number,
): boolean {
  const expectedEdge = bdtopoWidthM / 2;
  if (side === 'left') {
    return offsetM >= -(expectedEdge + bandHalfM) && offsetM <= -(expectedEdge - bandHalfM);
  }
  return offsetM >= expectedEdge - bandHalfM && offsetM <= expectedEdge + bandHalfM;
}

function sustainedRunSamples(stepM: number): number {
  return Math.max(1, Math.round(KERB_SUSTAINED_RUN_M / stepM));
}

/** True when at least `runSamples` consecutive outward offsets stay above the break floor. */
function hasSustainedBreak(
  scores: readonly number[],
  order: readonly number[],
  startPos: number,
  runSamples: number,
): boolean {
  let run = 0;
  for (let p = startPos; p < order.length; p++) {
    const k = order[p]!;
    if ((scores[k] ?? 0) >= CANDIDATE_HIGH_SCORE_MIN) {
      run++;
      if (run >= runSamples) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

/** LEVEL 1 term — road-likelihood falling from the carriageway baseline to the offset. */
function asphaltDropTerm(
  input: WeightedKerbInput,
  k: number,
  side: 'left' | 'right',
  stepM: number,
): number {
  const innerSamples = Math.max(1, Math.round(KERB_ASPHALT_INNER_WINDOW_M / stepM));
  const dir = side === 'left' ? +1 : -1; // inward = toward center
  let sum = 0;
  let n = 0;
  for (let i = 1; i <= innerSamples; i++) {
    const idx = k + dir * i;
    if (idx < 0 || idx >= input.roadMatchProfile.length) break;
    sum += input.roadMatchProfile[idx] ?? 0;
    n++;
  }
  const baseline = n > 0 ? sum / n : (input.roadMatchProfile[k] ?? 0);
  const at = input.roadMatchProfile[k] ?? 0;
  return clamp01((baseline - at) / KERB_ASPHALT_DROP_REF);
}

/** LEVEL 1 term — clean, car-free sidewalk continuing beyond the break. */
function sidewalkBeyondTerm(
  input: WeightedKerbInput,
  k: number,
  side: 'left' | 'right',
  stepM: number,
): number {
  const outSamples = Math.max(1, Math.round(KERB_SIDEWALK_BEYOND_WINDOW_M / stepM));
  const dir = side === 'left' ? -1 : +1; // outward = away from center
  let sum = 0;
  let n = 0;
  for (let i = 1; i <= outSamples; i++) {
    const idx = k + dir * i;
    if (idx < 0 || idx >= input.sidewalkBoundaryScore.length) break;
    // Strict: any vehicle/parking in the outward band voids the clean-sidewalk reward.
    if ((input.parkingExclusion[idx] ?? 0) > 0) return 0;
    sum += clamp01(input.sidewalkBoundaryScore[idx] ?? 0);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

/** LEVEL 1 term — kerb offset consistent with the expected BDTOPO half-width. */
function bdtopoAgreementTerm(
  offsetM: number,
  bdtopoWidthM: number,
  bandHalfM: number,
): number {
  const expectedEdge = bdtopoWidthM / 2;
  const deviation = Math.abs(Math.abs(offsetM) - expectedEdge);
  return 1 - Math.min(1, deviation / Math.max(0.01, bandHalfM));
}

/** LEVEL 2 — pair width consistent with the full BDTOPO carriageway width. */
function widthCoherenceTerm(
  widthM: number,
  bdtopoWidthM: number,
  bandHalfM: number,
): number {
  const deviation = Math.abs(widthM - bdtopoWidthM);
  return 1 - Math.min(1, deviation / Math.max(0.01, bandHalfM));
}

function weightedScore(
  terms: WeightedKerbTermBreakdown,
  hasBdtopo: boolean,
): number {
  if (hasBdtopo) {
    return (
      KERB_W_KERB_BREAK * terms.kerbBreak +
      KERB_W_ASPHALT_DROP * terms.asphaltDrop +
      KERB_W_SIDEWALK_BEYOND * terms.sidewalkBeyond +
      KERB_W_BDTOPO_AGREEMENT * terms.bdtopoAgreement
    );
  }
  // Drop bdtopoAgreement and renormalise the remaining three weights to sum 1.
  const sum = KERB_W_KERB_BREAK + KERB_W_ASPHALT_DROP + KERB_W_SIDEWALK_BEYOND;
  return (
    (KERB_W_KERB_BREAK * terms.kerbBreak +
      KERB_W_ASPHALT_DROP * terms.asphaltDrop +
      KERB_W_SIDEWALK_BEYOND * terms.sidewalkBeyond) /
    sum
  );
}

/** LEVEL 1 — best-scoring kerb candidate on one side (argmax, not first-pass). */
export function findWeightedSideCandidate(
  input: WeightedKerbInput,
  side: 'left' | 'right',
): WeightedKerbSideCandidate | null {
  const { offsetsM, sidewalkBoundaryScore, chosenPlateau } = input;
  const stepM = gridStepM(offsetsM);
  const runSamples = sustainedRunSamples(stepM);
  const order = indicesOutwardFromCenter(offsetsM, side);
  const hasBdtopo = input.bdtopoWidthM != null && input.bdtopoWidthM > 0;

  let seenLowNearCenter = false;
  let best: WeightedKerbSideCandidate | null = null;

  for (let p = 0; p < order.length; p++) {
    const k = order[p]!;
    const offsetM = offsetsM[k]!;

    // LEVEL 0 — hard gates.
    if (isHardExcluded(input, k)) continue;
    if (hasBdtopo) {
      // BDTOPO known → restrict to the band edge window (anti-drift).
      if (!inBdtopoEdgeWindow(side, offsetM, input.bdtopoWidthM!, input.bdtopoBandHalfM)) {
        continue;
      }
    } else {
      // No BDTOPO → fall back to the plateau-relative window.
      if (!inSideSearchWindow(side, offsetM, chosenPlateau)) continue;
      if (!nearPlateauEdge(side, offsetM, chosenPlateau)) continue;
    }

    const rawScore = clamp01(sidewalkBoundaryScore[k] ?? 0);
    // The "left the carriageway" preamble only applies to the plateau-relative
    // search; the BDTOPO band window already positions the candidate near the
    // expected edge, so do not require a low score near the (out-of-window) axis.
    if (!hasBdtopo && !seenLowNearCenter) {
      if (rawScore <= CANDIDATE_LOW_SCORE_MAX) seenLowNearCenter = true;
      continue;
    }
    const kerbBreak = rawScore;
    if (kerbBreak < KERB_BREAK_FLOOR) continue;
    if (!hasSustainedBreak(sidewalkBoundaryScore, order, p, runSamples)) continue;

    // LEVEL 1 — weighted score.
    const terms: WeightedKerbTermBreakdown = {
      kerbBreak,
      asphaltDrop: asphaltDropTerm(input, k, side, stepM),
      sidewalkBeyond: sidewalkBeyondTerm(input, k, side, stepM),
      bdtopoAgreement: hasBdtopo
        ? bdtopoAgreementTerm(offsetM, input.bdtopoWidthM!, input.bdtopoBandHalfM)
        : 0,
    };
    const score = weightedScore(terms, hasBdtopo);
    if (score < KERB_S_ACCEPT) continue;

    if (!best || score > best.score) {
      best = { index: k, offsetM, score: Math.round(score * 1000) / 1000, terms };
    }
  }

  return best;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** LEVEL 2 — pair the best left/right candidates and score width coherence. */
export function computeWeightedKerbPair(
  input: WeightedKerbInput,
): WeightedKerbPairResult {
  const left = findWeightedSideCandidate(input, 'left');
  const right = findWeightedSideCandidate(input, 'right');
  const hasBdtopo = input.bdtopoWidthM != null && input.bdtopoWidthM > 0;

  const reasonCodes: string[] = [
    `kerb_w:break=${KERB_W_KERB_BREAK},drop=${KERB_W_ASPHALT_DROP},sidewalk=${KERB_W_SIDEWALK_BEYOND},bdtopo=${KERB_W_BDTOPO_AGREEMENT}`,
    `kerb_w:accept=${KERB_S_ACCEPT},floor=${KERB_BREAK_FLOOR}`,
  ];

  if (left === null && right === null) {
    return {
      leftOffsetM: null,
      rightOffsetM: null,
      leftScore: null,
      rightScore: null,
      pairScore: null,
      confidence: 0,
      needsReview: true,
      reasonCodes: [...reasonCodes, 'kerb_w:no_candidate'],
      note: null,
    };
  }

  const leftOffsetM = left ? round2(left.offsetM) : null;
  const rightOffsetM = right ? round2(right.offsetM) : null;
  const leftScore = left ? left.score : null;
  const rightScore = right ? right.score : null;

  let pairScore: number | null = null;
  if (left && right) {
    const sideMean = (left.score + right.score) / 2;
    const widthM = right.offsetM - left.offsetM;
    const widthCoherence = hasBdtopo
      ? widthCoherenceTerm(widthM, input.bdtopoWidthM!, input.bdtopoBandHalfM * 2)
      : sideMean;
    pairScore = hasBdtopo
      ? Math.round((0.5 * sideMean + 0.5 * widthCoherence) * 1000) / 1000
      : Math.round(sideMean * 1000) / 1000;
  } else {
    pairScore = leftScore ?? rightScore;
  }

  const confidence = pairScore ?? 0;
  const needsReview = confidence < KERB_PAIR_CONFIDENCE_FLOOR;

  const parts: string[] = [];
  if (leftOffsetM !== null) parts.push(`L${leftOffsetM}(${leftScore})`);
  if (rightOffsetM !== null) parts.push(`R${rightOffsetM}(${rightScore})`);
  reasonCodes.push(`kerb_w:pair=${parts.join('/')}`, `kerb_w:conf=${confidence}`);
  if (needsReview) reasonCodes.push('kerb_w:needs_review');

  return {
    leftOffsetM,
    rightOffsetM,
    leftScore,
    rightScore,
    pairScore,
    confidence,
    needsReview,
    reasonCodes,
    note: `kerb_weighted:${parts.join('/')}`,
  };
}
