import type { RoadAxis } from './geometry.js';
import {
  chromaDelta,
  colorDelta,
  isVegetationPixel,
  luma,
  pixelSaturation,
  sampleRGB,
} from './color-utils.js';

/** Along-axis half-window for per-t central asphalt reference (total span 6 m). */
export const SIDEWALK_REF_ALONG_HALF_M = 3;
/** Lateral half-band for central reference samples (±1 m). */
export const SIDEWALK_REF_LATERAL_HALF_M = 1;

const WHITE_LUMA = 200;
const DARK_LUMA = 40;
const MIN_REF_SAMPLES = 3;
const WHITE_MARKING_LUMA = 185;
const WHITE_MARKING_EVIDENCE = 1;

export interface SidewalkBoundaryShadowInput {
  readonly rgb: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly pxPerM: number;
  readonly roadAxis: RoadAxis;
  readonly scanHalfM: number;
  readonly scanStepM: number;
  readonly offsetsM: readonly number[];
  readonly studyData: Uint8Array;
  readonly excludeMask?: Uint8Array;
}

function medianRgb(samples: Array<[number, number, number]>): [number, number, number] | null {
  if (samples.length === 0) return null;
  const rs = samples.map((c) => c[0]).sort((a, b) => a - b);
  const gs = samples.map((c) => c[1]).sort((a, b) => a - b);
  const bs = samples.map((c) => c[2]).sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  return [rs[mid]!, gs[mid]!, bs[mid]!];
}

function isRefCandidate(
  c: [number, number, number],
  excludeMask: Uint8Array | undefined,
  W: number,
  x: number,
  y: number,
): boolean {
  if (isVegetationPixel(c)) return false;
  const lum = luma(c);
  if (lum > WHITE_LUMA || lum < DARK_LUMA) return false;
  if (pixelSaturation(c) > 55) return false;
  if (excludeMask && excludeMask[y * W + x]! > 0) return false;
  return true;
}

/**
 * Per-pixel break evidence vs a local central reference colour [0, 1].
 * Higher when hue/luma/chroma diverge from asphalt-like centre band.
 */
export function sidewalkBreakEvidence(
  pixel: [number, number, number],
  ref: [number, number, number],
): number {
  const lumDelta = luma(pixel) - luma(ref);
  if (lumDelta <= 0) return 0;

  const cd = colorDelta(pixel, ref);
  const ch = chromaDelta(pixel, ref);
  const lumScore = Math.min(1, lumDelta / 35);
  const cdScore = Math.min(1, cd / 40);
  const chScore = Math.min(1, ch / 45);
  return Math.max(lumScore, cdScore, chScore * 0.7);
}

export function sidewalkSampleBreakEvidence(
  pixel: [number, number, number],
  ref: [number, number, number],
): number | null {
  if (isVegetationPixel(pixel)) return null;
  const lum = luma(pixel);
  const refLum = luma(ref);
  const lumDelta = lum - refLum;
  const saturation = pixelSaturation(pixel);
  if (
    lum > WHITE_MARKING_LUMA &&
    lumDelta > 0 &&
    saturation <= 55
  ) {
    return WHITE_MARKING_EVIDENCE;
  }
  if (lum < DARK_LUMA) return null;
  if (saturation > 55) return null;
  return sidewalkBreakEvidence(pixel, ref);
}

function collectCentralRefAt(
  input: SidewalkBoundaryShadowInput,
  tM: number,
): [number, number, number] | null {
  const { rgb, width: W, height: H, pxPerM, roadAxis, excludeMask } = input;
  const lateralStepPx = Math.max(2, Math.round(0.25 * pxPerM));
  const alongStepM = input.scanStepM;
  const halfPerpPx = Math.round(SIDEWALK_REF_LATERAL_HALF_M * pxPerM);
  const samples: Array<[number, number, number]> = [];

  for (
    let t2 = tM - SIDEWALK_REF_ALONG_HALF_M;
    t2 <= tM + SIDEWALK_REF_ALONG_HALF_M + alongStepM * 0.001;
    t2 += alongStepM
  ) {
    const ax = roadAxis.axisAt(t2);
    for (let sPx = -halfPerpPx; sPx <= halfPerpPx; sPx += lateralStepPx) {
      const sM = sPx / pxPerM;
      const x = Math.round(ax.cx + sM * pxPerM * ax.perpX);
      const y = Math.round(ax.cy + sM * pxPerM * ax.perpY);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (input.studyData[y * W + x]! === 0) continue;
      const c = sampleRGB(rgb, W, H, x, y);
      if (!c || !isRefCandidate(c, excludeMask, W, x, y)) continue;
      samples.push(c);
    }
  }
  if (samples.length < MIN_REF_SAMPLES) return null;
  return medianRgb(samples);
}

function sampleComparableAt(
  input: SidewalkBoundaryShadowInput,
  tM: number,
  sM: number,
): [number, number, number] | null {
  const { rgb, width: W, height: H, pxPerM, roadAxis, studyData, excludeMask } = input;
  const ax = roadAxis.axisAt(tM);
  const x = Math.round(ax.cx + sM * pxPerM * ax.perpX);
  const y = Math.round(ax.cy + sM * pxPerM * ax.perpY);
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  if (studyData[y * W + x]! === 0) return null;
  const c = sampleRGB(rgb, W, H, x, y);
  if (!c) return null;
  if (excludeMask && excludeMask[y * W + x]! > 0) return null;
  return c;
}

/**
 * Debug-only lateral curve: persistent colour break vs a moving 6 m × ±1 m central reference.
 * Does not affect published width / plateau / verdict.
 */
export function computeSidewalkBoundaryShadowScore(
  input: SidewalkBoundaryShadowInput,
): number[] {
  const nS = input.offsetsM.length;
  const sums = new Array<number>(nS).fill(0);
  const counts = new Array<number>(nS).fill(0);
  const nT = Math.max(1, Math.floor((2 * input.scanHalfM) / input.scanStepM) + 1);

  for (let j = 0; j < nT; j++) {
    const tM = -input.scanHalfM + j * input.scanStepM;
    const ref = collectCentralRefAt(input, tM);
    if (!ref) continue;

    for (let k = 0; k < nS; k++) {
      const pixel = sampleComparableAt(input, tM, input.offsetsM[k]!);
      if (!pixel) continue;
      const ev = sidewalkSampleBreakEvidence(pixel, ref);
      if (ev === null) continue;
      sums[k]! += ev;
      counts[k]! += 1;
    }
  }

  return sums.map((sum, k) =>
    counts[k]! > 0 ? Math.round((sum / counts[k]!) * 1000) / 1000 : 0,
  );
}

export const SIDEWALK_SHADOW_DEBUG_REASON = 'sidewalk_boundary_shadow_debug';
export const SIDEWALK_SHADOW_DEBUG_MIN = 0.35;

export function sidewalkShadowDebugTags(
  scores: readonly number[],
  offsetsM?: readonly number[],
): {
  readonly note: string | null;
  readonly reason: string | null;
} {
  if (scores.length === 0) return { note: null, reason: null };
  let max = 0;
  let maxIdx = 0;
  for (let i = 0; i < scores.length; i++) {
    const v = scores[i]!;
    if (v > max) {
      max = v;
      maxIdx = i;
    }
  }
  if (max < SIDEWALK_SHADOW_DEBUG_MIN) return { note: null, reason: null };
  const atM = offsetsM?.[maxIdx];
  const atSuffix = atM !== undefined ? `@${atM.toFixed(2)}m` : '';
  return {
    note: `sidewalk_boundary_shadow:max=${max.toFixed(2)}${atSuffix}`,
    reason: SIDEWALK_SHADOW_DEBUG_REASON,
  };
}
