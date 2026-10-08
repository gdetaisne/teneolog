import type { Plateau } from './types.js';
import type { RoadAxis } from './geometry.js';
import { pixelSaturation, sampleRGB } from './color-utils.js';

/** Same threshold as D10 lateral scan (`profile.ts`). */
export const SOLID_LINE_T = 0.4;
export const SOLID_MIN_DIST_M = 2.5;

/** Minimum width of a renewed road plateau beyond a marking (bike lane, apron). */
export const MARKING_CONTINUATION_MIN_M = 1.0;

/** Longitudinal stripe spacing for perpendicular crosswalks (m). */
const CROSSWALK_STRIPE_SPACING_MIN_M = 0.35;
const CROSSWALK_STRIPE_SPACING_MAX_M = 1.2;
const CROSSWALK_MIN_STRIPES = 3;
const CROSSWALK_STRIPE_ALONG_ROAD_MIN_M = 0.35;
const CROSSWALK_PERP_ELONGATION_RATIO = 1.5;

const WHITE_LUM_T = 200;
const WHITE_SAT_MAX = 40;

function isWhiteMarkingPixel(c: [number, number, number]): boolean {
  const lum = (c[0] + c[1] + c[2]) / 3;
  return lum > WHITE_LUM_T && pixelSaturation(c) < WHITE_SAT_MAX;
}

function wlMaxAt(whiteLineProfile: readonly number[], idx: number): number {
  return Math.max(
    whiteLineProfile[Math.max(0, idx - 1)]!,
    whiteLineProfile[idx]!,
    whiteLineProfile[Math.min(whiteLineProfile.length - 1, idx + 1)]!,
  );
}

/**
 * Outward from a marking: true when profile dips then rises again for at least
 * {@link MARKING_CONTINUATION_MIN_M} — e.g. bike lane beyond a lane marking.
 * Continuous high score (emergency strip, same asphalt) → false → trim allowed.
 */
export function hasDistinctPlateauBeyondMarking(
  profile: readonly number[],
  markingIdx: number,
  direction: -1 | 1,
  enterT: number,
  exitT: number,
  lateralStepM: number,
): boolean {
  const n = profile.length;
  let sawDip = false;
  let highRunM = 0;

  for (let idx = markingIdx + direction; idx >= 0 && idx < n; idx += direction) {
    const v = profile[idx]!;
    if (v < exitT) {
      sawDip = true;
      highRunM = 0;
      continue;
    }
    if (v >= enterT) {
      highRunM += lateralStepM;
      if (sawDip && highRunM >= MARKING_CONTINUATION_MIN_M) {
        return true;
      }
    } else {
      highRunM = 0;
    }
  }
  return false;
}

interface LongitudinalStripeScan {
  stripeCount: number;
  /** Stripe centres along road axis (m from axis origin). */
  stripeCentersM: number[];
}

function scanLongitudinalStripes(
  rgb: Uint8ClampedArray,
  W: number,
  H: number,
  roadAxis: RoadAxis,
  pxPerM: number,
  studyData: Uint8Array,
  sM: number,
  scanHalfM: number,
  sampleStepM: number,
): LongitudinalStripeScan {
  const nSamples = Math.max(1, Math.floor((2 * scanHalfM) / sampleStepM) + 1);
  const whiteFlags: boolean[] = [];
  const tMs: number[] = [];

  for (let j = 0; j < nSamples; j++) {
    const tM = -scanHalfM + j * sampleStepM;
    tMs.push(tM);
    const ax = roadAxis.axisAt(tM);
    const x = Math.round(ax.cx + sM * pxPerM * ax.perpX);
    const y = Math.round(ax.cy + sM * pxPerM * ax.perpY);
    if (x < 0 || y < 0 || x >= W || y >= H || studyData[y * W + x]! === 0) {
      whiteFlags.push(false);
      continue;
    }
    const c = sampleRGB(rgb, W, H, x, y);
    whiteFlags.push(c !== null && isWhiteMarkingPixel(c));
  }

  const stripeCentersM: number[] = [];
  let runStart = -1;
  for (let j = 0; j < whiteFlags.length; j++) {
    if (whiteFlags[j]!) {
      if (runStart < 0) runStart = j;
    } else if (runStart >= 0) {
      const mid = Math.floor((runStart + j - 1) / 2);
      stripeCentersM.push(tMs[mid]!);
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    const mid = Math.floor((runStart + whiteFlags.length - 1) / 2);
    stripeCentersM.push(tMs[mid]!);
  }

  if (stripeCentersM.length < CROSSWALK_MIN_STRIPES) {
    return { stripeCount: stripeCentersM.length, stripeCentersM };
  }

  const spacings: number[] = [];
  for (let i = 1; i < stripeCentersM.length; i++) {
    spacings.push(Math.abs(stripeCentersM[i]! - stripeCentersM[i - 1]!));
  }
  const regular = spacings.filter(
    (s) => s >= CROSSWALK_STRIPE_SPACING_MIN_M && s <= CROSSWALK_STRIPE_SPACING_MAX_M,
  );
  if (regular.length < CROSSWALK_MIN_STRIPES - 1) {
    return { stripeCount: stripeCentersM.length, stripeCentersM };
  }

  return { stripeCount: stripeCentersM.length, stripeCentersM };
}

/**
 * Stripe pixels must extend further along the road tangent than perpendicular —
 * i.e. stripes run along the road, crosswalk runs across it.
 */
function stripesElongatedAlongRoad(
  rgb: Uint8ClampedArray,
  W: number,
  H: number,
  roadAxis: RoadAxis,
  pxPerM: number,
  studyData: Uint8Array,
  sM: number,
  stripeCentersM: readonly number[],
): boolean {
  let elongatedCount = 0;
  const windowAlongM = 0.55;
  const windowPerpM = 0.9;
  const stepPx = Math.max(1, Math.round(0.12 * pxPerM));

  for (const tM of stripeCentersM.slice(0, 4)) {
    const ax = roadAxis.axisAt(tM);
    const tangents: number[] = [];
    const perps: number[] = [];

    for (let dt = -windowAlongM; dt <= windowAlongM; dt += windowAlongM / 4) {
      for (let ds = -windowPerpM; ds <= windowPerpM; ds += windowPerpM / 4) {
        const x = Math.round(ax.cx + (sM + ds) * pxPerM * ax.perpX + dt * pxPerM * ax.tangentX);
        const y = Math.round(ax.cy + (sM + ds) * pxPerM * ax.perpY + dt * pxPerM * ax.tangentY);
        if (x < 0 || y < 0 || x >= W || y >= H || studyData[y * W + x]! === 0) continue;
        const c = sampleRGB(rgb, W, H, x, y);
        if (c === null || !isWhiteMarkingPixel(c)) continue;
        tangents.push(dt);
        perps.push(ds);
      }
    }

    if (tangents.length < stepPx) continue;
    const tSpan = Math.max(...tangents) - Math.min(...tangents);
    const pSpan = Math.max(...perps) - Math.min(...perps);
    if (
      tSpan >= CROSSWALK_STRIPE_ALONG_ROAD_MIN_M &&
      tSpan >= pSpan * CROSSWALK_PERP_ELONGATION_RATIO
    ) {
      elongatedCount++;
    }
  }

  return elongatedCount >= 2;
}

/**
 * Per lateral offset: true when periodic white stripes are perpendicular to the road axis.
 */
export function buildPerpendicularCrosswalkFlags(
  rgb: Uint8ClampedArray,
  W: number,
  H: number,
  roadAxis: RoadAxis,
  pxPerM: number,
  studyData: Uint8Array,
  offsetsM: readonly number[],
  scanHalfM: number,
  sampleStepM: number,
): boolean[] {
  return offsetsM.map((sM) => {
    const scan = scanLongitudinalStripes(
      rgb, W, H, roadAxis, pxPerM, studyData, sM, scanHalfM, sampleStepM,
    );
    if (scan.stripeCount < CROSSWALK_MIN_STRIPES) return false;
    return stripesElongatedAlongRoad(
      rgb, W, H, roadAxis, pxPerM, studyData, sM, scan.stripeCentersM,
    );
  });
}

function firstCrosswalkBoundaryM(
  crosswalkFlags: readonly boolean[],
  offsetsM: readonly number[],
  centerIdx: number,
  direction: -1 | 1,
  minDistM: number,
): number | null {
  const n = offsetsM.length;
  let zoneStart: number | null = null;
  let zoneEnd: number | null = null;

  for (let idx = centerIdx; idx >= 0 && idx < n; idx += direction) {
    if (Math.abs(offsetsM[idx]!) < minDistM) continue;
    if (!crosswalkFlags[idx]) {
      if (zoneStart !== null) break;
      continue;
    }
    if (zoneStart === null) zoneStart = offsetsM[idx]!;
    zoneEnd = offsetsM[idx]!;
  }

  if (zoneStart === null || zoneEnd === null) return null;
  // Inner edge = boundary closest to road centre (conservative trim).
  return direction < 0 ? zoneEnd : zoneStart;
}

export interface MarkingEdgeTrimInput {
  chosen: Plateau;
  profile: readonly number[];
  offsetsM: readonly number[];
  whiteLineProfile: readonly number[];
  crosswalkFlags: readonly boolean[];
  enterT: number;
  exitT: number;
  lateralStepM: number;
}

export interface MarkingEdgeTrimResult {
  chosen: Plateau;
  notes: string[];
}

/**
 * Post-plateau trim for painted markings.
 * - Perpendicular crosswalk zones: always trim (intersecting arm overflow).
 * - Solid edge lines: trim only when no distinct renewed plateau beyond (bike-lane safe).
 */
export function applyMarkingEdgeTrim(input: MarkingEdgeTrimInput): MarkingEdgeTrimResult {
  const {
    chosen,
    profile,
    offsetsM,
    whiteLineProfile,
    crosswalkFlags,
    enterT,
    exitT,
    lateralStepM,
  } = input;

  const notes: string[] = [];
  let next = { ...chosen };
  const centerIdx = offsetsM.findIndex((o) => o >= 0);
  if (centerIdx < 0) return { chosen: next, notes };

  const crossLeftM = firstCrosswalkBoundaryM(
    crosswalkFlags, offsetsM, centerIdx, -1, SOLID_MIN_DIST_M,
  );
  const crossRightM = firstCrosswalkBoundaryM(
    crosswalkFlags, offsetsM, centerIdx, 1, SOLID_MIN_DIST_M,
  );

  if (crossLeftM !== null && crossLeftM > next.startM) {
    next = { ...next, startM: crossLeftM, widthM: next.endM - crossLeftM };
    notes.push(`crosswalk_edge:L${crossLeftM.toFixed(2)}`);
  }
  if (crossRightM !== null && crossRightM < next.endM) {
    next = { ...next, endM: crossRightM, widthM: crossRightM - next.startM };
    notes.push(`crosswalk_edge:R${crossRightM.toFixed(2)}`);
  }

  let solidLeftM: number | null = null;
  for (let idx = centerIdx; idx >= 0; idx--) {
    if (Math.abs(offsetsM[idx]!) < SOLID_MIN_DIST_M) continue;
    if (crosswalkFlags[idx]) continue;
    if (wlMaxAt(whiteLineProfile, idx) <= SOLID_LINE_T) continue;
    if (hasDistinctPlateauBeyondMarking(profile, idx, -1, enterT, exitT, lateralStepM)) {
      notes.push(`marking_keep:L${offsetsM[idx]!.toFixed(2)}`);
      break;
    }
    solidLeftM = offsetsM[idx]!;
    break;
  }

  let solidRightM: number | null = null;
  for (let idx = centerIdx; idx < offsetsM.length; idx++) {
    if (Math.abs(offsetsM[idx]!) < SOLID_MIN_DIST_M) continue;
    if (crosswalkFlags[idx]) continue;
    if (wlMaxAt(whiteLineProfile, idx) <= SOLID_LINE_T) continue;
    if (hasDistinctPlateauBeyondMarking(profile, idx, 1, enterT, exitT, lateralStepM)) {
      notes.push(`marking_keep:R${offsetsM[idx]!.toFixed(2)}`);
      break;
    }
    solidRightM = offsetsM[idx]!;
    break;
  }

  if (solidLeftM !== null && solidLeftM > next.startM) {
    next = { ...next, startM: solidLeftM, widthM: next.endM - solidLeftM };
    notes.push(`solid_edge:L${solidLeftM.toFixed(2)}`);
  }
  if (solidRightM !== null && solidRightM < next.endM) {
    next = { ...next, endM: solidRightM, widthM: solidRightM - next.startM };
    notes.push(`solid_edge:R${solidRightM.toFixed(2)}`);
  }

  return { chosen: next, notes };
}
