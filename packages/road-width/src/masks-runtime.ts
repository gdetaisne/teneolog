/**
 * Optional server-side spatial-mask parallel builder (registered by teneolog-api at boot).
 * Keeps worker_threads out of the Next.js client bundle.
 */

import type { MaskLayer, SpatialMaskSet } from './types.js';
import type { RoadAxis, TileGeoContext } from './geometry.js';
import type { SerializableRoadAxis } from './road-axis-serial.js';
import type { PixelBounds } from './mask-corridor.js';
import type { SpatialMasksTimingMs } from './spatial-masks-timing.js';
import type { YoloBbox } from './yolo.js';

export interface SpatialMaskParallelInput {
  readonly rgb: Uint8ClampedArray;
  readonly W: number;
  readonly H: number;
  readonly pxPerM: number;
  readonly roadAxisSerial: SerializableRoadAxis;
  readonly tile: TileGeoContext;
  readonly metrics: { tileACanvasX: number; tileACanvasY: number };
  readonly corridorBounds: PixelBounds | null;
  readonly prebuiltBuildingMask: MaskLayer | null;
  readonly needBuildingMask: boolean;
}

export interface SpatialMaskParallelRuntime {
  readonly build: (
    input: SpatialMaskParallelInput,
  ) => {
    readonly buildingMask: MaskLayer;
    readonly vegetationMassMask: MaskLayer;
    readonly treeOcclusionMask: MaskLayer;
    readonly timing: SpatialMasksTimingMs;
    readonly reasonCodes: string[];
  };
}

let runtime: SpatialMaskParallelRuntime | null = null;

export function registerSpatialMaskParallelRuntime(impl: SpatialMaskParallelRuntime): void {
  runtime = impl;
}

export function getSpatialMaskParallelRuntime(): SpatialMaskParallelRuntime | null {
  return runtime;
}

export function spatialMaskParallelAvailable(): boolean {
  return runtime != null && process.env.D10_MASK_PARALLEL !== '0';
}
