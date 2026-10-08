import type { AsphaltModel } from './types.js';
import type { RoadAxis } from './geometry.js';
import { boundedScanHalfM } from './geometry.js';

export function sampleRGB(
  rgb: Uint8ClampedArray,
  W: number,
  H: number,
  x: number,
  y: number,
): [number, number, number] | null {
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  const idx = (y * W + x) * 4;
  const r = rgb[idx]!;
  const g = rgb[idx + 1]!;
  const b = rgb[idx + 2]!;
  const a = rgb[idx + 3]!;
  if (a < 30 || (r < 25 && g < 25 && b < 25)) return null;
  return [r, g, b];
}

export function colorDelta(a: [number, number, number], b: [number, number, number]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

export function luma(c: [number, number, number]): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

export function chromaDelta(c: [number, number, number], ref: [number, number, number]): number {
  const y1 = luma(c);
  const y2 = luma(ref);
  const cb1 = c[2] - y1;
  const cb2 = ref[2] - y2;
  const cr1 = c[0] - y1;
  const cr2 = ref[0] - y2;
  return Math.hypot(cb1 - cb2, cr1 - cr2);
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

export function pixelSaturation(c: [number, number, number]): number {
  const maxC = Math.max(c[0], c[1], c[2]);
  const minC = Math.min(c[0], c[1], c[2]);
  return maxC - minC;
}

export function isVegetationPixel(c: [number, number, number]): boolean {
  const [r, g, b] = c;
  if (g < 35) return false;
  const excess = g - Math.min(r, b);
  if (g > r * 1.08 && g > b * 1.05 && excess > 12) return true;
  if (g > r * 1.03 && g > b * 1.02 && excess > 8) return true;
  return false;
}

/**
 * Stricter green test for aerial treetops (orthophoto canopy proxy).
 * Looser {@link isVegetationPixel} is used for BDTOPO lateral veg mass.
 */
export function isAerialCanopyPixel(c: [number, number, number]): boolean {
  const [r, g, b] = c;
  if (g < 45) return false;
  const excess = g - Math.min(r, b);
  return g > r * 1.14 && g > b * 1.12 && excess > 16;
}

function isRoadPixelLegacy(
  pixel: [number, number, number],
  road: [number, number, number],
  threshold: number,
): boolean {
  if (colorDelta(pixel, road) < threshold) return true;
  const SHADOW_CHROMA_T = 35;
  const pixLum = luma(pixel);
  const roadLum = luma(road);
  if (pixLum < 20 || pixLum >= roadLum * 0.9) return false;
  if (pixLum >= roadLum * 0.35 && chromaDelta(pixel, road) <= SHADOW_CHROMA_T) return true;
  const scale = roadLum / pixLum;
  const resc: [number, number, number] = [
    Math.min(255, pixel[0] * scale),
    Math.min(255, pixel[1] * scale),
    Math.min(255, pixel[2] * scale),
  ];
  const rescMax = Math.max(resc[0], resc[1], resc[2]);
  const rescMin = Math.min(resc[0], resc[1], resc[2]);
  const rescSat = rescMax > 0 ? (rescMax - rescMin) / rescMax : 0;
  if (rescSat > 0.2) return false;
  return colorDelta(resc, road) < threshold * 1.5;
}

export function isRoadPixelModel(
  pixel: [number, number, number],
  model: AsphaltModel,
  opts: { allowBrightAsphalt?: boolean } = {},
): boolean {
  const allowBrightAsphalt = opts.allowBrightAsphalt ?? true;
  const lum = luma(pixel);
  const sat = pixelSaturation(pixel);
  const medLum = luma(model.medianColour);
  const spreadT = Math.max(
    model.rgbMax[0] - model.rgbMin[0],
    model.rgbMax[1] - model.rgbMin[1],
    model.rgbMax[2] - model.rgbMin[2],
    15,
  );

  const inRgbRange =
    pixel[0] >= model.rgbMin[0] && pixel[0] <= model.rgbMax[0] &&
    pixel[1] >= model.rgbMin[1] && pixel[1] <= model.rgbMax[1] &&
    pixel[2] >= model.rgbMin[2] && pixel[2] <= model.rgbMax[2];

  if (inRgbRange && lum >= model.lumaMin && lum <= model.lumaMax && sat <= model.maxSat) {
    return true;
  }

  if (
    allowBrightAsphalt &&
    lum <= 220 &&
    sat <= model.maxSat + 12 &&
    colorDelta(pixel, model.medianColour) < spreadT * 1.5
  ) {
    return true;
  }

  const SHADOW_CHROMA_T = 35;
  if (lum < 20 || lum >= medLum * 0.9) return false;
  if (sat > model.maxSat + 8) return false;

  if (lum >= model.lumaMin * 0.35 && chromaDelta(pixel, model.medianColour) <= SHADOW_CHROMA_T) {
    return true;
  }

  const scale = medLum / lum;
  const resc: [number, number, number] = [
    Math.min(255, pixel[0] * scale),
    Math.min(255, pixel[1] * scale),
    Math.min(255, pixel[2] * scale),
  ];
  const rescMax = Math.max(resc[0], resc[1], resc[2]);
  const rescMin = Math.min(resc[0], resc[1], resc[2]);
  const rescSat = rescMax > 0 ? (rescMax - rescMin) / rescMax : 0;
  if (rescSat > 0.2) return false;

  const rescInRange =
    resc[0] >= model.rgbMin[0] && resc[0] <= model.rgbMax[0] &&
    resc[1] >= model.rgbMin[1] && resc[1] <= model.rgbMax[1] &&
    resc[2] >= model.rgbMin[2] && resc[2] <= model.rgbMax[2];

  return rescInRange || colorDelta(resc, model.medianColour) < spreadT * 1.5;
}

export function isRoadPixel(
  pixel: [number, number, number],
  ref: [number, number, number] | AsphaltModel,
  threshold?: number,
): boolean {
  if (!Array.isArray(ref)) return isRoadPixelModel(pixel, ref);
  return isRoadPixelLegacy(pixel, ref, threshold ?? 20);
}

export const ASPHALT_MODEL_SCAN_HALF_M = 12;

export interface BuildAsphaltModelOptions {
  /** When set, pixels where mask > 0 are not used for the reference (e.g. BDTOPO exclusion). */
  excludeMask?: Uint8Array;
}

const ASPHALT_MODEL_FALLBACK: AsphaltModel = {
  medianColour: [100, 100, 100],
  rgbMin: [70, 70, 70],
  rgbMax: [130, 130, 130],
  lumaMin: 40,
  lumaMax: 160,
  maxSat: 35,
  sampleCount: 0,
};

function collectAsphaltReferenceSamples(
  rgb: Uint8ClampedArray,
  W: number,
  H: number,
  pxPerM: number,
  roadAxis: RoadAxis,
  tMinM: number,
  tMaxM: number,
  lateralHalfM: number,
  excludeMask?: Uint8Array,
): Array<[number, number, number]> {
  const halfPerpPx = Math.round(lateralHalfM * pxPerM);
  const alongStepM = 2 / pxPerM;
  const rawSamples: Array<[number, number, number]> = [];

  for (let tM = tMinM; tM <= tMaxM + alongStepM * 0.001; tM += alongStepM) {
    const ax = roadAxis.axisAt(tM);
    for (let sPx = -halfPerpPx; sPx <= halfPerpPx; sPx += 3) {
      const sM = sPx / pxPerM;
      const x = Math.round(ax.cx + sM * pxPerM * ax.perpX);
      const y = Math.round(ax.cy + sM * pxPerM * ax.perpY);
      if (excludeMask && excludeMask[y * W + x]! > 0) continue;
      const c = sampleRGB(rgb, W, H, x, y);
      if (c) rawSamples.push(c);
    }
  }
  return rawSamples;
}

function asphaltModelFromSamples(rawSamples: readonly [number, number, number][]): AsphaltModel {
  if (rawSamples.length === 0) return { ...ASPHALT_MODEL_FALLBACK };

  const filtered = rawSamples.filter(c => {
    if (isVegetationPixel(c)) return false;
    const lum = (c[0] + c[1] + c[2]) / 3;
    const sat = pixelSaturation(c);
    return lum > 60 && lum < 200 && sat < 35;
  });
  const use = filtered.length >= 30 ? filtered : [...rawSamples];

  const rs = use.map(c => c[0]).sort((a, b) => a - b);
  const gs = use.map(c => c[1]).sort((a, b) => a - b);
  const bs = use.map(c => c[2]).sort((a, b) => a - b);
  const lumas = use.map(luma).sort((a, b) => a - b);
  const sats = use.map(pixelSaturation).sort((a, b) => a - b);

  const RGB_PAD = 8;
  const LUMA_PAD = 12;

  return {
    medianColour: [quantile(rs, 0.5), quantile(gs, 0.5), quantile(bs, 0.5)],
    rgbMin: [
      Math.max(0, quantile(rs, 0.2) - RGB_PAD),
      Math.max(0, quantile(gs, 0.2) - RGB_PAD),
      Math.max(0, quantile(bs, 0.2) - RGB_PAD),
    ],
    rgbMax: [
      Math.min(255, quantile(rs, 0.8) + RGB_PAD),
      Math.min(255, quantile(gs, 0.8) + RGB_PAD),
      Math.min(255, quantile(bs, 0.8) + RGB_PAD),
    ],
    lumaMin: Math.max(20, quantile(lumas, 0.1) - LUMA_PAD),
    lumaMax: Math.min(200, quantile(lumas, 0.9) + LUMA_PAD),
    maxSat: Math.min(45, quantile(sats, 0.85) + 10),
    sampleCount: use.length,
  };
}

/**
 * Asphalt reference from a local window along the road axis (e.g. parking probe near a vehicle).
 */
export function buildAsphaltModelNearAlongM(
  rgb: Uint8ClampedArray,
  W: number,
  H: number,
  pxPerM: number,
  roadAxis: RoadAxis,
  centerAlongM: number,
  alongHalfM: number,
  lateralHalfM = 1,
  opts: BuildAsphaltModelOptions = {},
): AsphaltModel {
  const samples = collectAsphaltReferenceSamples(
    rgb,
    W,
    H,
    pxPerM,
    roadAxis,
    centerAlongM - alongHalfM,
    centerAlongM + alongHalfM,
    lateralHalfM,
    opts.excludeMask,
  );
  return asphaltModelFromSamples(samples);
}

export function buildAsphaltModel(
  rgb: Uint8ClampedArray,
  W: number,
  H: number,
  pxPerM: number,
  roadAxis: RoadAxis,
  scanHalfM: number,
  opts: BuildAsphaltModelOptions = {},
): AsphaltModel {
  const rawSamples = collectAsphaltReferenceSamples(
    rgb,
    W,
    H,
    pxPerM,
    roadAxis,
    -scanHalfM,
    scanHalfM,
    1,
    opts.excludeMask,
  );
  return asphaltModelFromSamples(rawSamples);
}

export function adaptiveThreshold(
  roadColour: [number, number, number],
  rgb: Uint8ClampedArray,
  W: number,
  H: number,
  bearingRad: number,
  pxPerM: number,
): number {
  const roadX = Math.sin(bearingRad);
  const roadY = -Math.cos(bearingRad);
  const perpX = Math.cos(bearingRad);
  const perpY = Math.sin(bearingRad);
  const cx = W / 2;
  const cy = H / 2;
  const stripHalf = Math.round(1.0 * pxPerM);
  const deltas: number[] = [];
  for (let t = -10; t <= 10; t += 2) {
    for (let s = -stripHalf; s <= stripHalf; s += 3) {
      const x = Math.round(cx + t * pxPerM * roadX + s * perpX);
      const y = Math.round(cy + t * pxPerM * roadY + s * perpY);
      const c = sampleRGB(rgb, W, H, x, y);
      if (!c) continue;
      const lum = (c[0] + c[1] + c[2]) / 3;
      if (lum > 200 || lum < 40) continue;
      deltas.push(colorDelta(c, roadColour));
    }
  }
  if (deltas.length < 10) return 20;
  deltas.sort((a, b) => a - b);
  const p75 = deltas[Math.floor(deltas.length * 0.75)]!;
  return Math.max(15, Math.min(45, p75 * 2));
}

export function asphaltScanHalfM(roadAxis: RoadAxis): number {
  return boundedScanHalfM(roadAxis, ASPHALT_MODEL_SCAN_HALF_M);
}
