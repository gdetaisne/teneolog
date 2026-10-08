/**
 * IGN orthophoto adapter — WMS GetMap on the public Géoplateforme, plus the
 * 3-tile stitch the D10 measurement runs on.
 *
 * Every geometric constant here is PARITY, not choice: the zoom convention
 * (halfM = 25 × 2^(19−zoom)), the 25 % overlap, the 111_100 m/deg bbox
 * scale and the WMS-only transport are the values the frozen road-width core
 * was calibrated against (imagery.md; the WMTS variant produced an axis/photo
 * scale mismatch and stays off the measurement path). Changing any of them
 * silently re-scales the measured widths.
 */
import { getStitchedCanvasMetrics, TILE_SIZE_PX, type RgbImageData, type TileGeoContext } from '@teneolog/road-width';
import type { GeoPoint } from '@teneolog/domain';

import { fetchIgnCaptureDate, type IgnOrthoCapture } from './ign-ortho-capture.js';

/** Engine parity: the WMS bbox uses this scale, not the geodesic constant. */
const WMS_METERS_PER_DEG_LAT = 111_100;
const OVERLAP_RATIO = 0.25;
/** Long enough for the WMS to clear a hiccup, short enough not to blow the budget. */
const TILE_RETRY_DELAY_MS = 350;

/**
 * Half-extent, in metres, of one tile at a given zoom — the convention the
 * frozen road-width core was calibrated against. Exported so a caller can
 * frame a view (which zoom still contains these points?) without restating
 * the constant.
 */
export function orthoHalfFieldM(zoom: number): number {
  return 25 * Math.pow(2, 19 - zoom);
}

export interface IgnOrthoOptions {
  readonly wmsUrl: string;
  readonly timeoutMs: number;
  /** One transparent retry per tile on a transient WMS failure. Defaults on. */
  readonly retryOnce?: boolean;
}

export interface StitchedOrtho {
  readonly rgb: RgbImageData;
  /** The same canvas as PNG — what a scene ships to a viewer. */
  readonly pngBase64: string;
  /** The three raw tiles — what the beta front stitches client-side with the frozen primitives. */
  readonly tilesJpegBase64: { readonly img1: string; readonly img2: string; readonly img3: string };
  /** Geometry of the stitched frame — latA/lngA anchor + pixel offsets. */
  readonly tile: Pick<TileGeoContext, 'latA' | 'lngA' | 'dx2Px' | 'dy2Px' | 'dx3Px' | 'dy3Px'>;
  readonly pxPerM: number;
  readonly fieldM: number;
  readonly bearingDeg: number;
  readonly zoom: number;
  readonly sizePx: number;
}

export class IgnOrtho {
  constructor(private readonly options: IgnOrthoOptions) {}

  /**
   * Three tiles along the axis bearing, stitched into one canvas anchored on
   * tile A's centre. `centre` is where the measurement window starts — for a
   * stop measurement, the stop projected onto the street axis, so the window
   * is anchored at the delivery point rather than drifting to a cleaner
   * stretch (the 44 m lesson in imagery.md §5).
   */
  async fetchStitched(centre: GeoPoint, bearingDeg: number, zoom: number, sizePx: number): Promise<StitchedOrtho> {
    const { tile, pxPerM, fieldM, centreB, centreC } = this.stitchGeometry(centre, bearingDeg, zoom, sizePx);

    const [img1, img2, img3] = await Promise.all([
      this.fetchTile(centre, zoom, sizePx),
      this.fetchTile(centreB, zoom, sizePx),
      this.fetchTile(centreC, zoom, sizePx),
    ]);

    const { rgb, pngBase64 } = await stitchTiles(img1, img2, img3, tile);
    return {
      rgb,
      pngBase64,
      tilesJpegBase64: {
        img1: Buffer.from(img1).toString('base64'),
        img2: Buffer.from(img2).toString('base64'),
        img3: Buffer.from(img3).toString('base64'),
      },
      tile,
      pxPerM,
      fieldM,
      bearingDeg,
      zoom,
      sizePx,
    };
  }

  /**
   * The stitch's frame, from geometry alone — no fetch. Lets a caller start
   * the full-frame background at the same time as the tiles instead of after
   * them (the WMS round trip is the whole cost of both).
   */
  stitchGeometry(
    centre: GeoPoint,
    bearingDeg: number,
    zoom: number,
    sizePx: number,
  ): {
    tile: StitchedOrtho['tile'];
    pxPerM: number;
    fieldM: number;
    centreB: GeoPoint;
    centreC: GeoPoint;
  } {
    const halfM = orthoHalfFieldM(zoom);
    const fieldM = 2 * halfM;
    const pxPerM = sizePx / fieldM;
    const stepM = fieldM * (1 - OVERLAP_RATIO);

    const centreB = offsetGeodesic(centre, bearingDeg, stepM);
    const centreC = offsetGeodesic(centre, bearingDeg, stepM * 2);

    const toPx = (distM: number): { dx: number; dy: number } => ({
      dx: Math.sin((bearingDeg * Math.PI) / 180) * distM * pxPerM,
      dy: -Math.cos((bearingDeg * Math.PI) / 180) * distM * pxPerM,
    });
    const off2 = toPx(stepM);
    const off3 = toPx(stepM * 2);

    return {
      tile: {
        latA: centre.lat,
        lngA: centre.lon,
        dx2Px: off2.dx,
        dy2Px: off2.dy,
        dx3Px: off3.dx,
        dy3Px: off3.dy,
      },
      pxPerM,
      fieldM,
      centreB,
      centreC,
    };
  }

  /**
   * The image we SHOW, as opposed to the image we MEASURE. The 3-tile stitch
   * runs forward from the stop along the axis, so its bounding box is up to a
   * third empty on a diagonal street and the address sits at the edge of the
   * coverage. One GetMap over the stitch's full pixel frame — same anchor,
   * same scale, same WMS bbox convention as the tiles — fills that box so the
   * measured tiles overlay it pixel for pixel. The D10 contract is untouched.
   */
  async fetchFrameBackground(
    stitched: Pick<StitchedOrtho, 'tile' | 'pxPerM'>,
  ): Promise<{ jpegBase64: string; widthPx: number; heightPx: number }> {
    const metrics = getStitchedCanvasMetrics(stitched.tile);
    const mPerPx = 1 / stitched.pxPerM;
    const dLatPerPx = mPerPx / WMS_METERS_PER_DEG_LAT;
    const dLonPerPx =
      mPerPx / (WMS_METERS_PER_DEG_LAT * Math.cos((stitched.tile.latA * Math.PI) / 180));
    const north = stitched.tile.latA + metrics.tileACanvasY * dLatPerPx;
    const south = stitched.tile.latA - (metrics.height - metrics.tileACanvasY) * dLatPerPx;
    const west = stitched.tile.lngA - metrics.tileACanvasX * dLonPerPx;
    const east = stitched.tile.lngA + (metrics.width - metrics.tileACanvasX) * dLonPerPx;
    const jpeg = await this.fetchBboxJpeg(south, west, north, east, metrics.width, metrics.height);
    return {
      jpegBase64: Buffer.from(jpeg).toString('base64'),
      widthPx: metrics.width,
      heightPx: metrics.height,
    };
  }

  /** One arbitrary-bbox GetMap — the static itinerary map's background. */
  async fetchBboxJpeg(
    south: number,
    west: number,
    north: number,
    east: number,
    widthPx: number,
    heightPx: number,
  ): Promise<Uint8Array> {
    const url = new URL(this.options.wmsUrl);
    url.searchParams.set('SERVICE', 'WMS');
    url.searchParams.set('VERSION', '1.3.0');
    url.searchParams.set('REQUEST', 'GetMap');
    url.searchParams.set('LAYERS', 'ORTHOIMAGERY.ORTHOPHOTOS');
    url.searchParams.set('CRS', 'EPSG:4326');
    url.searchParams.set('BBOX', `${south},${west},${north},${east}`);
    url.searchParams.set('WIDTH', String(widthPx));
    url.searchParams.set('HEIGHT', String(heightPx));
    url.searchParams.set('FORMAT', 'image/jpeg');
    url.searchParams.set('STYLES', '');
    const response = await fetch(url, {
      headers: { 'user-agent': 'teneolog-app/0.1 (+https://teneolog.com)' },
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new Error(`IGN WMS ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Flight date of the ortho at this point (GetFeatureInfo). Cached; null when
   * the WMS does not state a vintage. Display-only — never a measurement input.
   */
  async fetchCaptureDate(at: GeoPoint): Promise<IgnOrthoCapture | null> {
    return fetchIgnCaptureDate({
      wmsUrl: this.options.wmsUrl,
      timeoutMs: this.options.timeoutMs,
      at,
    });
  }

  /**
   * One square tile centred on the point — the engine's review-scene framing
   * (haiku-collect fetches a single 512 px image, apex at the canvas centre).
   * Returned as a degenerate stitch: zero offsets make the frozen
   * getStitchedCanvasMetrics/latLngToCanvasPx anchor the point at the centre,
   * so scene builders work unchanged on either shape.
   */
  async fetchCentered(centre: GeoPoint, zoom: number, sizePx: number): Promise<StitchedOrtho> {
    const jpeg = await this.fetchTile(centre, zoom, sizePx);
    const halfM = orthoHalfFieldM(zoom);
    const fieldM = 2 * halfM;
    const pxPerM = sizePx / fieldM;
    const tile = { latA: centre.lat, lngA: centre.lon, dx2Px: 0, dy2Px: 0, dx3Px: 0, dy3Px: 0 };
    // Zero offsets: the three layers land on the same square, a plain identity.
    const stitched = await stitchTiles(jpeg, jpeg, jpeg, tile);
    const jpegBase64 = Buffer.from(jpeg).toString('base64');
    return {
      rgb: stitched.rgb,
      pngBase64: stitched.pngBase64,
      tilesJpegBase64: { img1: jpegBase64, img2: jpegBase64, img3: jpegBase64 },
      tile,
      pxPerM,
      fieldM,
      bearingDeg: 0,
      zoom,
      sizePx,
    };
  }

  private async fetchTile(centre: GeoPoint, zoom: number, sizePx: number): Promise<Uint8Array> {
    const halfM = orthoHalfFieldM(zoom);
    const dLat = halfM / WMS_METERS_PER_DEG_LAT;
    const dLon = halfM / (WMS_METERS_PER_DEG_LAT * Math.cos((centre.lat * Math.PI) / 180));
    const bbox = `${centre.lat - dLat},${centre.lon - dLon},${centre.lat + dLat},${centre.lon + dLon}`;

    const url = new URL(this.options.wmsUrl);
    url.searchParams.set('SERVICE', 'WMS');
    url.searchParams.set('VERSION', '1.3.0');
    url.searchParams.set('REQUEST', 'GetMap');
    url.searchParams.set('LAYERS', 'ORTHOIMAGERY.ORTHOPHOTOS');
    url.searchParams.set('CRS', 'EPSG:4326');
    url.searchParams.set('BBOX', bbox);
    url.searchParams.set('WIDTH', String(sizePx));
    url.searchParams.set('HEIGHT', String(sizePx));
    url.searchParams.set('FORMAT', 'image/jpeg');
    url.searchParams.set('STYLES', '');

    // One transparent retry: the WMS hiccups often enough that a single bad
    // response would otherwise tell the operator this address has no imagery,
    // which is a permanent-sounding answer to a transient failure. The request
    // is an idempotent GET, so retrying costs nothing but the round trip.
    try {
      return await this.getTile(url);
    } catch (err) {
      if (this.options.retryOnce === false) throw err;
      await new Promise((resolve) => setTimeout(resolve, TILE_RETRY_DELAY_MS));
      return this.getTile(url);
    }
  }

  private async getTile(url: URL): Promise<Uint8Array> {
    const response = await fetch(url, {
      headers: { 'user-agent': 'teneolog-app/0.1 (+https://teneolog.com)' },
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new Error(`IGN WMS ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('xml') || contentType.includes('text')) {
      // The WMS reports errors as 200 + XML; letting that reach the decoder
      // would read as a corrupt image instead of the real cause.
      throw new Error(`IGN WMS non-image response: ${(await response.text()).slice(0, 120)}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** Same composite as the engine's stitch — RGBA raw buffer for the D10 core, PNG for viewers. */
async function stitchTiles(
  img1: Uint8Array,
  img2: Uint8Array,
  img3: Uint8Array,
  tile: Pick<TileGeoContext, 'dx2Px' | 'dy2Px' | 'dx3Px' | 'dy3Px'>,
): Promise<{ rgb: RgbImageData; pngBase64: string }> {
  const { default: sharp } = await import('sharp');
  const metrics = getStitchedCanvasMetrics(tile);
  const originX = metrics.tileACanvasX - TILE_SIZE_PX / 2;
  const originY = metrics.tileACanvasY - TILE_SIZE_PX / 2;

  const base = sharp({
    create: { width: metrics.width, height: metrics.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: Buffer.from(img1), left: Math.round(originX), top: Math.round(originY) },
      { input: Buffer.from(img2), left: Math.round(originX + tile.dx2Px), top: Math.round(originY + tile.dy2Px) },
      { input: Buffer.from(img3), left: Math.round(originX + tile.dx3Px), top: Math.round(originY + tile.dy3Px) },
    ])
    .ensureAlpha();

  const [raw, png] = await Promise.all([
    base.clone().raw().toBuffer({ resolveWithObject: true }),
    base.clone().png().toBuffer(),
  ]);
  return {
    rgb: {
      data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
      width: raw.info.width,
      height: raw.info.height,
    },
    pngBase64: png.toString('base64'),
  };
}

function offsetGeodesic(from: GeoPoint, bearingDeg: number, distanceM: number): GeoPoint {
  const R = 6_371_000;
  const d = distanceM / R;
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (from.lat * Math.PI) / 180;
  const lon1 = (from.lon * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lon2 = lon1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: (lat2 * 180) / Math.PI, lon: (lon2 * 180) / Math.PI };
}
