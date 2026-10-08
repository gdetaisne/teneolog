/**
 * Swept envelope via raster union of footprint quads — robust, always coupled to footprints.
 * Used for N1 clearance metrics (not on passage-simulation hot path — UI uses evenodd).
 */

import { polygonArea } from './geometry.js';
import type { Point } from './types.js';

/** 10 cm cells — balance accuracy vs perf for ~300 footprints. */
export const DEFAULT_RASTER_CELL_M = 0.1;
const GRID_MARGIN_CELLS = 2;

function pointInRing(x: number, y: number, ring: readonly Point[]): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]!.x;
    const yi = ring[i]!.y;
    const xj = ring[j]!.x;
    const yj = ring[j]!.y;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function filled(grid: Uint8Array, cols: number, i: number, j: number): boolean {
  return i >= 0 && j >= 0 && i < cols && j < grid.length / cols && grid[j * cols + i] === 1;
}

function ptKey(x: number, y: number): string {
  return `${x.toFixed(6)},${y.toFixed(6)}`;
}

function edgesToRings(edges: ReadonlyArray<readonly [Point, Point]>): Point[][] {
  const adj = new Map<string, Point[]>();
  for (const [a, b] of edges) {
    const ka = ptKey(a.x, a.y);
    const kb = ptKey(b.x, b.y);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka)!.push(b);
    adj.get(kb)!.push(a);
  }

  const visited = new Set<string>();
  const rings: Point[][] = [];

  for (const [startKey] of adj) {
    if (visited.has(startKey)) continue;
    const parts = startKey.split(',');
    const ring: Point[] = [{ x: Number(parts[0]), y: Number(parts[1]) }];
    visited.add(startKey);
    let current = ring[0]!;
    let prev: Point | null = null;

    for (let guard = 0; guard < edges.length + 5; guard++) {
      const neighbors = adj.get(ptKey(current.x, current.y)) ?? [];
      const next = neighbors.find((n) => {
        if (prev && n.x === prev.x && n.y === prev.y) return false;
        const k = ptKey(n.x, n.y);
        return !visited.has(k) || (ring.length > 2 && k === startKey);
      });
      if (!next) break;
      const nk = ptKey(next.x, next.y);
      if (nk === startKey && ring.length >= 3) break;
      if (visited.has(nk)) break;
      visited.add(nk);
      ring.push(next);
      prev = current;
      current = next;
    }

    if (ring.length >= 4) rings.push(ring);
  }

  return rings;
}

function simplifyCollinear(ring: readonly Point[], eps = 1e-9): Point[] {
  if (ring.length <= 3) return [...ring];
  const out: Point[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[(i + n - 1) % n]!;
    const b = ring[i]!;
    const c = ring[(i + 1) % n]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > eps) out.push(b);
  }
  return out.length >= 3 ? out : [...ring];
}

/** Stamp one footprint quad onto the grid (cells whose centre falls inside the quad). */
function stampFootprint(
  grid: Uint8Array,
  cols: number,
  minX: number,
  minY: number,
  cellSizeM: number,
  fp: readonly Point[],
): void {
  let fMinX = fp[0]!.x;
  let fMinY = fp[0]!.y;
  let fMaxX = fp[0]!.x;
  let fMaxY = fp[0]!.y;
  for (const p of fp) {
    fMinX = Math.min(fMinX, p.x);
    fMinY = Math.min(fMinY, p.y);
    fMaxX = Math.max(fMaxX, p.x);
    fMaxY = Math.max(fMaxY, p.y);
  }

  const i0 = Math.max(0, Math.floor((fMinX - minX) / cellSizeM));
  const j0 = Math.max(0, Math.floor((fMinY - minY) / cellSizeM));
  const i1 = Math.min(cols - 1, Math.ceil((fMaxX - minX) / cellSizeM));
  const rows = grid.length / cols;
  const j1 = Math.min(rows - 1, Math.ceil((fMaxY - minY) / cellSizeM));

  for (let j = j0; j <= j1; j++) {
    const cy = minY + (j + 0.5) * cellSizeM;
    for (let i = i0; i <= i1; i++) {
      const idx = j * cols + i;
      if (grid[idx] === 1) continue;
      const cx = minX + (i + 0.5) * cellSizeM;
      if (pointInRing(cx, cy, fp)) grid[idx] = 1;
    }
  }
}

/** Les cases pleines × la case². */
function filledAreaM2(grid: Uint8Array, cellSizeM: number): number {
  let cells = 0;
  for (let k = 0; k < grid.length; k += 1) cells += grid[k]!;
  return cells * cellSizeM * cellSizeM;
}

/** L'union raster des caisses : une case à 1 quand son centre est dans au moins une caisse. */
export interface RasterUnion {
  readonly cells: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  /** Le coin sud-ouest de la case (0, 0). */
  readonly x0: number;
  readonly y0: number;
  readonly cellM: number;
  /**
   * L'aire de l'union : les cases pleines × la case². Pas celle du contour de
   * `rasterFootprintEnvelope` : son tracé ne repasse jamais par un sommet, et là où l'union se pince (deux
   * cases pleines qui ne se touchent que par un coin) il peut en perdre une partie — mesuré le 2026-09-25,
   * un trois temps du 19 t sur une place de 18 m : 102,6 m² tracés pour 186,3 m² d'union.
   */
  readonly areaM2: number;
}

/** L'union raster des caisses ; null sans caisse, ou au-delà de 8 000 cases de côté. */
export function rasterFootprintUnion(
  footprints: readonly (readonly Point[])[],
  cellSizeM = DEFAULT_RASTER_CELL_M,
): RasterUnion | null {
  if (footprints.length === 0 || cellSizeM <= 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const fp of footprints) {
    for (const p of fp) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  const margin = GRID_MARGIN_CELLS * cellSizeM;
  const x0 = minX - margin;
  const y0 = minY - margin;
  const cols = Math.max(1, Math.ceil((maxX + margin - x0) / cellSizeM));
  const rows = Math.max(1, Math.ceil((maxY + margin - y0) / cellSizeM));
  if (cols > 8000 || rows > 8000) return null;
  const cells = new Uint8Array(cols * rows);
  for (const fp of footprints) stampFootprint(cells, cols, x0, y0, cellSizeM, fp);
  return { cells, cols, rows, x0, y0, cellM: cellSizeM, areaM2: filledAreaM2(cells, cellSizeM) };
}

export function rasterFootprintEnvelope(
  footprints: readonly (readonly Point[])[],
  cellSizeM = DEFAULT_RASTER_CELL_M,
): { readonly envelope: Point[]; readonly ok: boolean } {
  const union = rasterFootprintUnion(footprints, cellSizeM);
  if (union === null) return { envelope: [], ok: false };
  const { cells: grid, cols, rows, x0: minX, y0: minY } = union;

  const edges: Array<[Point, Point]> = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!filled(grid, cols, i, j)) continue;
      const x0 = minX + i * cellSizeM;
      const y0 = minY + j * cellSizeM;
      const x1 = x0 + cellSizeM;
      const y1 = y0 + cellSizeM;
      if (!filled(grid, cols, i, j - 1)) edges.push([{ x: x0, y: y0 }, { x: x1, y: y0 }]);
      if (!filled(grid, cols, i + 1, j)) edges.push([{ x: x1, y: y0 }, { x: x1, y: y1 }]);
      if (!filled(grid, cols, i, j + 1)) edges.push([{ x: x1, y: y1 }, { x: x0, y: y1 }]);
      if (!filled(grid, cols, i - 1, j)) edges.push([{ x: x0, y: y1 }, { x: x0, y: y0 }]);
    }
  }

  if (edges.length === 0) return { envelope: [], ok: false };

  const rings = edgesToRings(edges);
  if (rings.length === 0) return { envelope: [], ok: false };

  let best = rings[0]!;
  let bestArea = polygonArea(best);
  for (const ring of rings.slice(1)) {
    const area = polygonArea(ring);
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }

  return { envelope: simplifyCollinear(best), ok: true };
}
