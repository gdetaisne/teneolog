import type { MaskLayer, SpatialMaskSet } from './types.js';
import type { RoadAxis, LatLng, TileGeoContext } from './geometry.js';
import { boundedScanHalfM, latLngToCanvasPx } from './geometry.js';
import { isAerialCanopyPixel, isVegetationPixel, sampleRGB } from './color-utils.js';
import { YOLO_MIN_CONF, type YoloBbox } from './yolo.js';
import { rasterizeSurfacePolygons, type SurfacePolygon } from './polygon-mask.js';
import type { PixelBounds } from './mask-corridor.js';
import type { SerializableRoadAxis } from './road-axis-serial.js';
import type { SpatialMasksTimingMs } from './spatial-masks-timing.js';
import { getSpatialMaskParallelRuntime, spatialMaskParallelAvailable } from './masks-runtime.js';

const WIDTH_SCAN_HALF_M = 12;

/** Min longitudinal scan fraction under aerial canopy before profile flags occlusion. */
export const AERIAL_CANOPY_SCAN_MIN_FRAC = 0.22;

export function aerialCanopyScanHit(fraction: number): boolean {
  return fraction >= AERIAL_CANOPY_SCAN_MIN_FRAC;
}

function emptyMask(width: number, height: number, label: MaskLayer['label']): MaskLayer {
  return { width, height, data: new Uint8Array(width * height), label };
}

function setMaskPixel(mask: MaskLayer, x: number, y: number, on: boolean) {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return;
  if (on) mask.data[y * mask.width + x] = 255;
}

function applyLateralMassFilter(
  mask: MaskLayer,
  roadAxis: RoadAxis,
  pxPerM: number,
  minLateralM: number,
  corridorBounds: PixelBounds | null = null,
): MaskLayer {
  const out = emptyMask(mask.width, mask.height, mask.label);
  const ax = roadAxis.axisAt(0);
  const y0 = corridorBounds?.y0 ?? 0;
  const y1 = corridorBounds?.y1 ?? mask.height - 1;
  const x0 = corridorBounds?.x0 ?? 0;
  const x1 = corridorBounds?.x1 ?? mask.width - 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (mask.data[y * mask.width + x]! === 0) continue;
      const lateralPx = (x - ax.cx) * ax.perpX + (y - ax.cy) * ax.perpY;
      if (Math.abs(lateralPx / pxPerM) >= minLateralM) {
        out.data[y * mask.width + x] = 255;
      }
    }
  }
  return out;
}

/** BDTOPO building footprint raster (used for axis refinement and masks). */
export function buildBdtopoBuildingMask(
  W: number,
  H: number,
  tile: TileGeoContext,
  metrics: { tileACanvasX: number; tileACanvasY: number },
  pxPerM: number,
  corridorBounds: PixelBounds | null = null,
): MaskLayer {
  const polys = tile.buildingPolygons ?? [];
  const bufferPx = Math.max(1, Math.round(0.8 * pxPerM));
  const data = rasterizeSurfacePolygons(
    W,
    H,
    polys as SurfacePolygon[],
    (p) => latLngToCanvasPx(p, tile, metrics, pxPerM),
    bufferPx,
    corridorBounds,
  );
  return { width: W, height: H, data, label: 'building' };
}

export function buildBdtopoVegetationRaster(
  W: number,
  H: number,
  tile: TileGeoContext,
  metrics: { tileACanvasX: number; tileACanvasY: number },
  pxPerM: number,
  corridorBounds: PixelBounds | null = null,
): Uint8Array {
  const polys = tile.vegetationPolygons ?? [];
  return rasterizeSurfacePolygons(
    W,
    H,
    polys as SurfacePolygon[],
    (p) => latLngToCanvasPx(p, tile, metrics, pxPerM),
    0,
    corridorBounds,
  );
}

/** Flood-fill connected vegetation components; keep only large lateral masses. */
export function buildVegetationMassMaskFromColor(
  rgb: Uint8ClampedArray,
  W: number,
  H: number,
  roadAxis: RoadAxis,
  pxPerM: number,
  corridorBounds: PixelBounds | null = null,
): MaskLayer {
  const mask = emptyMask(W, H, 'vegetationMass');
  const vegSeed = new Uint8Array(W * H);
  const y0 = corridorBounds?.y0 ?? 0;
  const y1 = corridorBounds?.y1 ?? H - 1;
  const x0 = corridorBounds?.x0 ?? 0;
  const x1 = corridorBounds?.x1 ?? W - 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = sampleRGB(rgb, W, H, x, y);
      if (c && isVegetationPixel(c)) vegSeed[y * W + x] = 1;
    }
  }

  const minAreaPx = Math.max(80, Math.round(1.5 * pxPerM * 1.5 * pxPerM));
  const visited = new Uint8Array(W * H);
  const stack: number[] = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (!vegSeed[idx] || visited[idx]) continue;
      stack.length = 0;
      stack.push(idx);
      visited[idx] = 1;
      const component: number[] = [idx];

      while (stack.length > 0) {
        const cur = stack.pop()!;
        const cx = cur % W;
        const cy = (cur / W) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nIdx = ny * W + nx;
          if (!vegSeed[nIdx] || visited[nIdx]) continue;
          visited[nIdx] = 1;
          stack.push(nIdx);
          component.push(nIdx);
        }
      }

      if (component.length < minAreaPx) continue;

      let lateralSum = 0;
      for (const pIdx of component) {
        const px = pIdx % W;
        const py = (pIdx / W) | 0;
        const ax = roadAxis.axisAt(0);
        const lateralPx = (px - ax.cx) * ax.perpX + (py - ax.cy) * ax.perpY;
        lateralSum += Math.abs(lateralPx / pxPerM);
      }
      const meanLateralM = lateralSum / component.length;
      if (meanLateralM < 1.2) continue;

      for (const pIdx of component) {
        mask.data[pIdx] = 255;
      }
    }
  }
  return mask;
}

/**
 * Lateral vegetation mass for hard exclusion: BDTOPO `zone_de_vegetation` only when
 * available (≥1 m from axis). Color CC is fallback when WFS returns nothing.
 */
export function buildVegetationMassMask(
  rgb: Uint8ClampedArray,
  W: number,
  H: number,
  roadAxis: RoadAxis,
  pxPerM: number,
  tile: TileGeoContext,
  metrics: { tileACanvasX: number; tileACanvasY: number },
  bdtopoVegRaster: Uint8Array | null,
  corridorBounds: PixelBounds | null,
): MaskLayer {
  // Trust BDTOPO when WFS returned vegetation coverage for the tile, even if no
  // polygon falls inside the crop (empty in-crop = no roadside vegetation here).
  // The colour fallback runs only on a true data gap (no BDTOPO veg data at all):
  // otherwise it misclassifies greenish-grey asphalt as a vegetation mass and
  // wrongly clips the carriageway on peri-urban green roads (the rasterised veg
  // mask being empty does NOT mean "no BDTOPO data", just "no veg in this crop").
  const hasBdtopoData = bdtopoVegRaster != null;
  if (!hasBdtopoData) {
    return buildVegetationMassMaskFromColor(rgb, W, H, roadAxis, pxPerM, corridorBounds);
  }

  const bdtopoMask: MaskLayer = {
    width: W,
    height: H,
    data: bdtopoVegRaster,
    label: 'vegetationMass',
  };
  return applyLateralMassFilter(bdtopoMask, roadAxis, pxPerM, 1.0, corridorBounds);
}

/**
 * Aerial canopy proxy: green pixels in the axis band that are NOT in BDTOPO
 * `zone_de_vegetation` (likely treetops in orthophoto). Used for profile bridging
 * and debug — never hard-excluded. BDTOPO-registered veg uses vegetationMass instead.
 */
export function buildAerialCanopyMask(
  rgb: Uint8ClampedArray,
  W: number,
  H: number,
  roadAxis: RoadAxis,
  pxPerM: number,
  bdtopoVegRaster: Uint8Array | null,
  corridorBounds: PixelBounds | null = null,
): MaskLayer {
  const mask = emptyMask(W, H, 'treeOcclusion');
  const scanHalfM = boundedScanHalfM(roadAxis, WIDTH_SCAN_HALF_M);
  const axisBandM = 2.5;
  const axisBandPx = axisBandM * pxPerM;
  const y0 = corridorBounds?.y0 ?? 0;
  const y1 = corridorBounds?.y1 ?? H - 1;
  const x0 = corridorBounds?.x0 ?? 0;
  const x1 = corridorBounds?.x1 ?? W - 1;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = sampleRGB(rgb, W, H, x, y);
      if (!c || !isAerialCanopyPixel(c)) continue;
      if (bdtopoVegRaster && bdtopoVegRaster[y * W + x]! > 0) continue;
      const ax = roadAxis.axisAt(0);
      const lateralPx = (x - ax.cx) * ax.perpX + (y - ax.cy) * ax.perpY;
      if (Math.abs(lateralPx) > axisBandPx) continue;
      const alongPx = (x - ax.cx) * ax.tangentX + (y - ax.cy) * ax.tangentY;
      const alongM = alongPx / pxPerM;
      if (Math.abs(alongM) > scanHalfM) continue;
      setMaskPixel(mask, x, y, true);
    }
  }
  return mask;
}

function pointInRotatedRect(px: number, py: number, b: YoloBbox): boolean {
  const cos = Math.cos(-b.angle);
  const sin = Math.sin(-b.angle);
  const dx = px - b.x;
  const dy = py - b.y;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
}

export function buildVehicleMask(
  W: number,
  H: number,
  yoloBboxes: readonly YoloBbox[],
  conf = YOLO_MIN_CONF,
): MaskLayer {
  const mask = emptyMask(W, H, 'vehicle');
  for (const b of yoloBboxes) {
    if (b.conf < conf) continue;
    const hw = Math.ceil(b.w / 2) + 2;
    const hh = Math.ceil(b.h / 2) + 2;
    const x0 = Math.max(0, Math.floor(b.x - hw));
    const y0 = Math.max(0, Math.floor(b.y - hh));
    const x1 = Math.min(W - 1, Math.ceil(b.x + hw));
    const y1 = Math.min(H - 1, Math.ceil(b.y + hh));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (pointInRotatedRect(x + 0.5, y + 0.5, b)) setMaskPixel(mask, x, y, true);
      }
    }
  }
  return mask;
}

export interface BuildSpatialMasksOptions {
  tile?: TileGeoContext;
  tileIndex?: 0 | 1 | 2;
  tileMetrics?: { tileACanvasX: number; tileACanvasY: number };
  /** Reuse building mask already built for axis blend (avoids double raster). */
  prebuiltBuildingMask?: MaskLayer | null;
  /** Limit BDTOPO raster + colour scans to the road analysis corridor. */
  corridorBounds?: PixelBounds | null;
  /** For parallel veg/canopy workers (from `resolveStitchRoadAxis`). */
  roadAxisSerial?: SerializableRoadAxis | null;
}

function phaseNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export interface BuildSpatialMasksResult {
  readonly masks: SpatialMaskSet;
  readonly reasonCodes: string[];
  readonly spatialMasksTiming: SpatialMasksTimingMs;
}

export function buildSpatialMasksWithTiming(
  rgb: Uint8ClampedArray,
  W: number,
  H: number,
  roadAxis: RoadAxis,
  pxPerM: number,
  yoloBboxes: readonly YoloBbox[] = [],
  opts: BuildSpatialMasksOptions = {},
): BuildSpatialMasksResult {
  const tile = opts.tile;
  const metrics = opts.tileMetrics;
  const corridorBounds = opts.corridorBounds ?? null;
  const reasonCodes: string[] = [];
  const needBuildingMask =
    !opts.prebuiltBuildingMask && !!(tile && metrics && (tile.buildingPolygons?.length ?? 0) > 0);

  const parallelRuntime = getSpatialMaskParallelRuntime();
  if (spatialMaskParallelAvailable() && parallelRuntime && opts.roadAxisSerial && tile && metrics) {
    const built = parallelRuntime.build({
      rgb,
      W,
      H,
      pxPerM,
      roadAxisSerial: opts.roadAxisSerial,
      tile,
      metrics,
      corridorBounds,
      prebuiltBuildingMask: opts.prebuiltBuildingMask ?? null,
      needBuildingMask,
    });
    reasonCodes.push(...built.reasonCodes);
    return {
      masks: {
        vehicleMask: buildVehicleMask(W, H, yoloBboxes, YOLO_MIN_CONF),
        buildingMask: built.buildingMask,
        vegetationMassMask: built.vegetationMassMask,
        treeOcclusionMask: built.treeOcclusionMask,
        reasonCodes: [],
      },
      reasonCodes,
      spatialMasksTiming: built.timing,
    };
  }

  let phaseStart = phaseNowMs();
  const lap = (): number => {
    const now = phaseNowMs();
    const elapsed = Math.round(now - phaseStart);
    phaseStart = now;
    return elapsed;
  };

  let buildingMask = opts.prebuiltBuildingMask ?? emptyMask(W, H, 'building');
  if (opts.prebuiltBuildingMask) {
    reasonCodes.push('building_mask_bdtopo_reused');
  } else if (tile && metrics && (tile.buildingPolygons?.length ?? 0) > 0) {
    buildingMask = buildBdtopoBuildingMask(W, H, tile, metrics, pxPerM, corridorBounds);
    reasonCodes.push('building_mask_bdtopo');
  } else {
    reasonCodes.push('building_mask_unavailable');
  }
  const buildingMs = lap();

  const bdtopoVegRaster =
    tile && metrics && (tile.vegetationPolygons?.length ?? 0) > 0
      ? buildBdtopoVegetationRaster(W, H, tile, metrics, pxPerM, corridorBounds)
      : null;
  const vegRasterMs = lap();

  const vegetationMassMask =
    tile && metrics
      ? buildVegetationMassMask(
          rgb,
          W,
          H,
          roadAxis,
          pxPerM,
          tile,
          metrics,
          bdtopoVegRaster,
          corridorBounds,
        )
      : buildVegetationMassMaskFromColor(rgb, W, H, roadAxis, pxPerM, corridorBounds);
  const vegetationMassMs = lap();

  if ((tile?.vegetationPolygons?.length ?? 0) > 0) {
    reasonCodes.push('vegetation_mask_bdtopo_only');
  }

  const treeOcclusionMask = buildAerialCanopyMask(
    rgb,
    W,
    H,
    roadAxis,
    pxPerM,
    bdtopoVegRaster,
    corridorBounds,
  );
  const canopyMs = lap();
  reasonCodes.push(
    bdtopoVegRaster ? 'canopy_mask_aerial_unregistered' : 'canopy_mask_aerial_no_bdtopo',
  );

  const wallMs = buildingMs + vegRasterMs + vegetationMassMs + canopyMs;

  return {
    masks: {
      vehicleMask: buildVehicleMask(W, H, yoloBboxes, YOLO_MIN_CONF),
      buildingMask,
      vegetationMassMask,
      treeOcclusionMask,
      reasonCodes: [],
    },
    reasonCodes,
    spatialMasksTiming: {
      buildingMs,
      vegRasterMs,
      vegetationMassMs,
      canopyMs,
      wallMs,
      parallelized: false,
    },
  };
}

export function buildSpatialMasks(
  rgb: Uint8ClampedArray,
  W: number,
  H: number,
  roadAxis: RoadAxis,
  pxPerM: number,
  yoloBboxes: readonly YoloBbox[] = [],
  opts: BuildSpatialMasksOptions = {},
): SpatialMaskSet {
  const built = buildSpatialMasksWithTiming(rgb, W, H, roadAxis, pxPerM, yoloBboxes, opts);
  return {
    ...built.masks,
    reasonCodes: built.reasonCodes,
  };
}

/** Union or inverted-union of binary mask layers (255 = on). */
export function mergeBinaryMaskLayers(
  W: number,
  H: number,
  label: MaskLayer['label'],
  layers: readonly MaskLayer[],
  opts: { invert?: boolean } = {},
): MaskLayer {
  const out = new Uint8Array(W * H);
  if (!opts.invert) {
    for (const layer of layers) {
      for (let i = 0; i < out.length; i++) {
        if (layer.data[i]! > 0) out[i] = 255;
      }
    }
  } else {
    for (let i = 0; i < out.length; i++) {
      let excluded = false;
      for (const layer of layers) {
        if (layer.data[i]! > 0) {
          excluded = true;
          break;
        }
      }
      if (!excluded) out[i] = 255;
    }
  }
  return { width: W, height: H, data: out, label };
}

/** Single pixel at lateral offset s (m) on the road axis section t = 0. */
export function maskPixelAtLateralOffset(
  mask: MaskLayer,
  W: number,
  H: number,
  roadAxis: RoadAxis,
  pxPerM: number,
  sM: number,
  tM = 0,
): boolean {
  const ax = roadAxis.axisAt(tM);
  const x = Math.round(ax.cx + sM * pxPerM * ax.perpX);
  const y = Math.round(ax.cy + sM * pxPerM * ax.perpY);
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  return mask.data[y * W + x]! > 0;
}

export function maskFractionAlongScan(
  mask: MaskLayer,
  rgbW: number,
  roadAxis: RoadAxis,
  pxPerM: number,
  sM: number,
  scanHalfM: number,
  sampleStepPx: number,
): number {
  const nSamples = Math.max(1, Math.floor((2 * scanHalfM) / (sampleStepPx / pxPerM)) + 1);
  const scanStepM = sampleStepPx / pxPerM;
  let hits = 0;
  let total = 0;
  for (let j = 0; j < nSamples; j++) {
    const tM = -scanHalfM + j * scanStepM;
    const ax = roadAxis.axisAt(tM);
    const x = Math.round(ax.cx + sM * pxPerM * ax.perpX);
    const y = Math.round(ax.cy + sM * pxPerM * ax.perpY);
    if (x < 0 || y < 0 || x >= rgbW || y >= mask.height) continue;
    total++;
    if (mask.data[y * mask.width + x]! > 0) hits++;
  }
  return total > 0 ? hits / total : 0;
}
