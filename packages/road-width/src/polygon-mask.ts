import type { LatLng } from './geometry.js';

export interface SurfacePolygon {
  readonly id: string;
  readonly nature: string;
  readonly rings: ReadonlyArray<ReadonlyArray<LatLng>>;
}

type PxPoint = { x: number; y: number };

function pointInRing(x: number, y: number, ring: readonly PxPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]!.x;
    const yi = ring[i]!.y;
    const xj = ring[j]!.x;
    const yj = ring[j]!.y;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Even-odd fill for polygon with holes (first ring = outer). */
function pointInSurfacePolygon(x: number, y: number, rings: readonly (readonly PxPoint[])[]): boolean {
  let inside = false;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    if (pointInRing(x, y, ring)) inside = !inside;
  }
  return inside;
}

function dilateMask(data: Uint8Array, width: number, height: number, radiusPx: number): void {
  if (radiusPx <= 0) return;
  const copy = Uint8Array.from(data);
  const r = Math.ceil(radiusPx);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (copy[i]! === 0) continue;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
            data[ny * width + nx] = 255;
          }
        }
      }
    }
  }
}

export interface RasterClipBounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * Rasterize WGS84 polygons into a binary mask (even-odd rule, no DOM).
 * When `clipBounds` is set, polygons outside the clip are skipped and fill loops are clamped.
 */
export function rasterizeSurfacePolygons(
  width: number,
  height: number,
  polygons: readonly SurfacePolygon[],
  toPx: (p: LatLng) => { x: number; y: number },
  bufferPx = 0,
  clipBounds: RasterClipBounds | null = null,
): Uint8Array {
  const data = new Uint8Array(width * height);
  if (polygons.length === 0) return data;

  for (const poly of polygons) {
    if (poly.rings.length === 0) continue;
    const pxRings = poly.rings.map(ring =>
      ring.map(p => toPx(p)),
    );
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    for (const ring of pxRings) {
      for (const p of ring) {
        minX = Math.min(minX, Math.floor(p.x));
        minY = Math.min(minY, Math.floor(p.y));
        maxX = Math.max(maxX, Math.ceil(p.x));
        maxY = Math.max(maxY, Math.ceil(p.y));
      }
    }
    minX = Math.max(0, minX - bufferPx - 2);
    minY = Math.max(0, minY - bufferPx - 2);
    maxX = Math.min(width - 1, maxX + bufferPx + 2);
    maxY = Math.min(height - 1, maxY + bufferPx + 2);

    if (clipBounds) {
      if (maxX < clipBounds.x0 || minX > clipBounds.x1 || maxY < clipBounds.y0 || minY > clipBounds.y1) {
        continue;
      }
      minX = Math.max(minX, clipBounds.x0);
      minY = Math.max(minY, clipBounds.y0);
      maxX = Math.min(maxX, clipBounds.x1);
      maxY = Math.min(maxY, clipBounds.y1);
    }

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (pointInSurfacePolygon(x + 0.5, y + 0.5, pxRings)) {
          data[y * width + x] = 255;
        }
      }
    }
  }

  if (bufferPx > 0) dilateMask(data, width, height, bufferPx);
  return data;
}

/** Hit-test stitch/tile canvas coordinates against WGS84 surface polygons. */
export function canvasPointInSurfacePolygons(
  x: number,
  y: number,
  polygons: readonly SurfacePolygon[],
  toPx: (p: LatLng) => { x: number; y: number },
): boolean {
  for (const poly of polygons) {
    if (poly.rings.length === 0) continue;
    const pxRings = poly.rings.map((ring) => ring.map((p) => toPx(p)));
    if (pointInSurfacePolygon(x, y, pxRings)) return true;
  }
  return false;
}
