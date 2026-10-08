import { TILE_SIZE_PX, getStitchedCanvasMetrics, type TileGeoContext } from './geometry.js';

/** Min confidence for inference, masks, classify, and clamp (aligned with `YOLO_CONF` default). */
export const YOLO_MIN_CONF = 0.02;

export interface YoloBbox {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  conf: number;
  class_name: string;
}

/** Map stitch-canvas YOLO boxes to a single 512×512 tile index (0 = apex tile). */
export function yoloBboxesInTileSpace(
  stitchBboxes: readonly YoloBbox[],
  tile: TileGeoContext,
  tileIndex: 0 | 1 | 2,
): YoloBbox[] {
  const stitch = getStitchedCanvasMetrics(tile);
  const offsets = [
    { dx: 0, dy: 0 },
    { dx: Math.round(tile.dx2Px), dy: Math.round(tile.dy2Px) },
    { dx: Math.round(tile.dx3Px), dy: Math.round(tile.dy3Px) },
  ] as const;
  const { dx, dy } = offsets[tileIndex];
  const originX = stitch.tileACanvasX - TILE_SIZE_PX / 2 + dx;
  const originY = stitch.tileACanvasY - TILE_SIZE_PX / 2 + dy;
  const halfDiag = (b: YoloBbox) => Math.hypot(b.w, b.h) / 2;

  const out: YoloBbox[] = [];
  for (const b of stitchBboxes) {
    const x = b.x - originX;
    const y = b.y - originY;
    const margin = halfDiag(b) + 2;
    if (
      x + margin < 0 ||
      x - margin > TILE_SIZE_PX ||
      y + margin < 0 ||
      y - margin > TILE_SIZE_PX
    ) {
      continue;
    }
    out.push({ ...b, x, y });
  }
  return out;
}
