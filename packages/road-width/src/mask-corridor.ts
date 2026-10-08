import type { RoadAxis } from './geometry.js';
import { boundedScanHalfM } from './geometry.js';

/** Inclusive pixel bounds for corridor-limited mask scans. */
export interface PixelBounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Lateral half-width (m) aligned with profile scoring (`LATERAL_HALF_M`). */
export const MASK_CORRIDOR_LATERAL_HALF_M = 15;

/** Extra margin (m) beyond scoring window for raster / canopy. */
export const MASK_CORRIDOR_MARGIN_M = 2;

const WIDTH_SCAN_HALF_M = 12;

/**
 * Axis-aligned bounding box covering the road analysis corridor
 * (longitudinal scan × lateral profile window + margin).
 */
export function computeCorridorPixelBounds(
  roadAxis: RoadAxis,
  W: number,
  H: number,
  pxPerM: number,
  opts: {
    readonly alongHalfM?: number;
    readonly lateralHalfM?: number;
    readonly marginM?: number;
  } = {},
): PixelBounds {
  const alongHalfM = opts.alongHalfM ?? boundedScanHalfM(roadAxis, WIDTH_SCAN_HALF_M);
  const lateralHalfM = opts.lateralHalfM ?? MASK_CORRIDOR_LATERAL_HALF_M;
  const marginM = opts.marginM ?? MASK_CORRIDOR_MARGIN_M;
  const latM = lateralHalfM + marginM;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let tM = -alongHalfM; tM <= alongHalfM + 1e-6; tM += 1) {
    const ax = roadAxis.axisAt(tM);
    for (let sM = -latM; sM <= latM + 1e-6; sM += 0.5) {
      const x = ax.cx + sM * pxPerM * ax.perpX;
      const y = ax.cy + sM * pxPerM * ax.perpY;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (!Number.isFinite(minX)) {
    return { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };
  }

  return {
    x0: Math.max(0, Math.floor(minX)),
    y0: Math.max(0, Math.floor(minY)),
    x1: Math.min(W - 1, Math.ceil(maxX)),
    y1: Math.min(H - 1, Math.ceil(maxY)),
  };
}

export function corridorPixelCount(bounds: PixelBounds): number {
  return Math.max(0, bounds.x1 - bounds.x0 + 1) * Math.max(0, bounds.y1 - bounds.y0 + 1);
}

/** True when corridor covers less than ~80% of the canvas (ROI active). */
export function corridorSignificantlySmallerThanCanvas(
  bounds: PixelBounds,
  W: number,
  H: number,
): boolean {
  return corridorPixelCount(bounds) < W * H * 0.8;
}

export function intersectPixelBounds(
  a: PixelBounds,
  b: PixelBounds,
): PixelBounds | null {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  if (x0 > x1 || y0 > y1) return null;
  return { x0, y0, x1, y1 };
}
