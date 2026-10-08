/** RGBA raster (row-major), same layout as canvas ImageData. */
export interface RgbImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type ImageLoader = (base64Jpeg: string) => Promise<RgbImageData>;
