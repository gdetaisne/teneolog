import type { ConsolidatedRoadWidthResult } from './types.js';
import type { TileGeoContext } from './geometry.js';
import { TILE_SIZE_PX } from './geometry.js';
import { measureTileWidth } from './profile.js';
import { consolidateTileResults } from './consolidate.js';
import { prepareTilePipeline } from './tile-pipeline.js';
import type { YoloBbox } from './yolo.js';
import type { ImageLoader } from './image.js';

export interface MeasureTilesInput {
  readonly images: readonly string[];
  readonly tile: TileGeoContext;
  readonly bearingDeg: number;
  readonly pxPerM: number;
  readonly gtWidthM: number | null;
  readonly yoloBboxes?: readonly YoloBbox[];
}

/**
 * Measures each IGN tile independently, then consolidates with a weighted median.
 * `loadImage` must decode JPEG base64 (no data: prefix) to TILE_SIZE_PX squares.
 */
export async function measureTilesAndConsolidate(
  input: MeasureTilesInput,
  loadImage: ImageLoader,
): Promise<ConsolidatedRoadWidthResult> {
  const imgs = input.images.slice(0, 3);

  const tileResults = await Promise.all(
    imgs.map(async (b64, tileIndex) => {
      const imageData = await loadImage(b64);
      if (imageData.width !== TILE_SIZE_PX || imageData.height !== TILE_SIZE_PX) {
        throw new Error(
          `tile image must be ${TILE_SIZE_PX}×${TILE_SIZE_PX}, got ${imageData.width}×${imageData.height}`,
        );
      }
      const idx = tileIndex as 0 | 1 | 2;
      const prep = prepareTilePipeline({
        tileIndex: idx,
        rgb: imageData.data,
        width: imageData.width,
        height: imageData.height,
        pxPerM: input.pxPerM,
        bearingDeg: input.bearingDeg,
        gtWidthM: input.gtWidthM,
        tile: input.tile,
        yoloBboxes: input.yoloBboxes ?? [],
      });
      return measureTileWidth(prep);
    }),
  );

  return consolidateTileResults(tileResults);
}

/** Map consolidated output to legacy ProfileResult shape used by the UI. */
export function consolidatedToProfileView(
  consolidated: ConsolidatedRoadWidthResult,
): ConsolidatedRoadWidthResult['profileResult'] {
  return consolidated.profileResult;
}
