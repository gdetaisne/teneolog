/**
 * Short-lived worker for parallel BDTOPO mask raster / colour scans.
 * Spawned from `spatial-masks-parallel.ts` (D10 worker thread or main).
 */

import { parentPort } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import type { PixelBounds } from './mask-corridor.js';
import type { TileGeoContext } from './geometry.js';
import { hydrateRoadAxis, type SerializableRoadAxis } from './road-axis-serial.js';
import {
  buildBdtopoBuildingMask,
  buildBdtopoVegetationRaster,
  buildVegetationMassMask,
  buildVegetationMassMaskFromColor,
  buildAerialCanopyMask,
} from './masks.js';

export type SpatialMaskWorkerOp =
  | {
      readonly op: 'building';
      readonly W: number;
      readonly H: number;
      readonly tile: TileGeoContext;
      readonly metrics: { tileACanvasX: number; tileACanvasY: number };
      readonly pxPerM: number;
      readonly corridorBounds: PixelBounds | null;
    }
  | {
      readonly op: 'vegRaster';
      readonly W: number;
      readonly H: number;
      readonly tile: TileGeoContext;
      readonly metrics: { tileACanvasX: number; tileACanvasY: number };
      readonly pxPerM: number;
      readonly corridorBounds: PixelBounds | null;
    }
  | {
      readonly op: 'vegMass';
      readonly rgbBuffer: ArrayBuffer;
      readonly W: number;
      readonly H: number;
      readonly pxPerM: number;
      readonly roadAxisSerial: SerializableRoadAxis;
      readonly tile: TileGeoContext;
      readonly metrics: { tileACanvasX: number; tileACanvasY: number };
      readonly vegRasterBuffer: ArrayBuffer | null;
      readonly corridorBounds: PixelBounds | null;
    }
  | {
      readonly op: 'canopy';
      readonly rgbBuffer: ArrayBuffer;
      readonly W: number;
      readonly H: number;
      readonly pxPerM: number;
      readonly roadAxisSerial: SerializableRoadAxis;
      readonly vegRasterBuffer: ArrayBuffer | null;
      readonly corridorBounds: PixelBounds | null;
    };

type WorkerReply =
  | { readonly ok: true; readonly result: unknown; readonly cpuMs: number }
  | { readonly ok: false; readonly error: string };

function maskPayload(mask: { width: number; height: number; data: Uint8Array; label: string }) {
  return {
    width: mask.width,
    height: mask.height,
    label: mask.label,
    data: mask.data.buffer,
    byteLength: mask.data.byteLength,
  };
}

function runOp(msg: SpatialMaskWorkerOp): unknown {
  switch (msg.op) {
    case 'building': {
      const mask = buildBdtopoBuildingMask(
        msg.W,
        msg.H,
        msg.tile,
        msg.metrics,
        msg.pxPerM,
        msg.corridorBounds,
      );
      return maskPayload(mask);
    }
    case 'vegRaster': {
      const data = buildBdtopoVegetationRaster(
        msg.W,
        msg.H,
        msg.tile,
        msg.metrics,
        msg.pxPerM,
        msg.corridorBounds,
      );
      return { data: data.buffer, byteLength: data.byteLength, length: data.length };
    }
    case 'vegMass': {
      const rgb = new Uint8ClampedArray(msg.rgbBuffer);
      const roadAxis = hydrateRoadAxis(msg.roadAxisSerial);
      const vegRaster =
        msg.vegRasterBuffer != null
          ? new Uint8Array(msg.vegRasterBuffer)
          : null;
      const mask =
        msg.tile && msg.metrics
          ? buildVegetationMassMask(
              rgb,
              msg.W,
              msg.H,
              roadAxis,
              msg.pxPerM,
              msg.tile,
              msg.metrics,
              vegRaster,
              msg.corridorBounds,
            )
          : buildVegetationMassMaskFromColor(
              rgb,
              msg.W,
              msg.H,
              roadAxis,
              msg.pxPerM,
              msg.corridorBounds,
            );
      return maskPayload(mask);
    }
    case 'canopy': {
      const rgb = new Uint8ClampedArray(msg.rgbBuffer);
      const roadAxis = hydrateRoadAxis(msg.roadAxisSerial);
      const vegRaster =
        msg.vegRasterBuffer != null
          ? new Uint8Array(msg.vegRasterBuffer)
          : null;
      const mask = buildAerialCanopyMask(
        rgb,
        msg.W,
        msg.H,
        roadAxis,
        msg.pxPerM,
        vegRaster,
        msg.corridorBounds,
      );
      return maskPayload(mask);
    }
    default:
      throw new Error('unknown spatial mask worker op');
  }
}

if (!parentPort) {
  throw new Error('spatial-mask-worker must run as a Worker');
}

parentPort.on(
  'message',
  (msg: SpatialMaskWorkerOp & { readonly replyPort: MessagePort }) => {
    const { replyPort, ...op } = msg;
    const reply = (body: WorkerReply): void => {
      replyPort.postMessage(body);
    };
    try {
      const cpuStart = Date.now();
      const result = runOp(op as SpatialMaskWorkerOp);
      reply({ ok: true, result, cpuMs: Date.now() - cpuStart });
    } catch (err) {
      reply({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);
