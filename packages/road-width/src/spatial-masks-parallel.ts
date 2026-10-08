/**
 * Parallel spatial-mask builds via short-lived worker_threads (2 cores per wave).
 */

import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import type { PixelBounds } from './mask-corridor.js';
import type { TileGeoContext } from './geometry.js';
import type { MaskLayer } from './types.js';
import type { SerializableRoadAxis } from './road-axis-serial.js';
import type { SpatialMaskWorkerOp } from './spatial-mask-worker.js';

const WORKER_URL = new URL('./spatial-mask-worker.js', import.meta.url);

type WorkerSuccess<T> = { readonly ok: true; readonly result: T; readonly cpuMs: number };
type WorkerFailure = { readonly ok: false; readonly error: string };
type WorkerMessage<T> = WorkerSuccess<T> | WorkerFailure;

interface WireMask {
  readonly width: number;
  readonly height: number;
  readonly label: MaskLayer['label'];
  readonly data: ArrayBuffer;
  readonly byteLength: number;
}

function maskParallelEnabled(): boolean {
  if (process.env.D10_MASK_PARALLEL === '0') return false;
  return typeof receiveMessageOnPort === 'function';
}

function hydrateMask(wire: WireMask): MaskLayer {
  return {
    width: wire.width,
    height: wire.height,
    label: wire.label,
    data: new Uint8Array(wire.data, 0, wire.byteLength),
  };
}

function runMaskWorker<T>(op: SpatialMaskWorkerOp, transfer: ArrayBuffer[] = []): { result: T; cpuMs: number } {
  const worker = new Worker(WORKER_URL);
  const { port1, port2 } = new MessageChannel();
  try {
    worker.postMessage({ ...op, replyPort: port2 }, [port2, ...transfer]);
    const msg = receiveMessageOnPort(port1) as unknown as WorkerMessage<T>;
    if (!msg?.ok) {
      throw new Error(msg?.error ?? 'spatial mask worker failed');
    }
    return { result: msg.result, cpuMs: msg.cpuMs };
  } finally {
    void worker.terminate();
  }
}

function runMaskWorkersParallel<TA, TB>(
  opA: SpatialMaskWorkerOp,
  opB: SpatialMaskWorkerOp,
  transferA: ArrayBuffer[] = [],
  transferB: ArrayBuffer[] = [],
): [{ result: TA; cpuMs: number }, { result: TB; cpuMs: number }] {
  const workerA = new Worker(WORKER_URL);
  const workerB = new Worker(WORKER_URL);
  const chA = new MessageChannel();
  const chB = new MessageChannel();
  try {
    workerA.postMessage({ ...opA, replyPort: chA.port2 }, [chA.port2, ...transferA]);
    workerB.postMessage({ ...opB, replyPort: chB.port2 }, [chB.port2, ...transferB]);
    const msgA = receiveMessageOnPort(chA.port1) as unknown as WorkerMessage<TA>;
    const msgB = receiveMessageOnPort(chB.port1) as unknown as WorkerMessage<TB>;
    if (!msgA?.ok) throw new Error(msgA?.error ?? 'spatial mask worker A failed');
    if (!msgB?.ok) throw new Error(msgB?.error ?? 'spatial mask worker B failed');
    return [
      { result: msgA.result, cpuMs: msgA.cpuMs },
      { result: msgB.result, cpuMs: msgB.cpuMs },
    ];
  } finally {
    void workerA.terminate();
    void workerB.terminate();
  }
}

export interface ParallelSpatialMaskInput {
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

export interface ParallelSpatialMaskParts {
  readonly buildingMask: MaskLayer;
  readonly vegetationMassMask: MaskLayer;
  readonly treeOcclusionMask: MaskLayer;
  readonly buildingMs: number;
  readonly vegRasterMs: number;
  readonly vegetationMassMs: number;
  readonly canopyMs: number;
  readonly wallMs: number;
}

export function buildSpatialMaskPartsParallel(
  input: ParallelSpatialMaskInput,
): ParallelSpatialMaskParts {
  const { rgb, W, H, pxPerM, roadAxisSerial, tile, metrics, corridorBounds } = input;
  const rgbBuffer = rgb.buffer.slice(
    rgb.byteOffset,
    rgb.byteOffset + rgb.byteLength,
  ) as ArrayBuffer;

  const wallStart = Date.now();

  let buildingMask: MaskLayer;
  let buildingMs = 0;
  let vegRasterMs = 0;
  let bdtopoVegRaster: Uint8Array | null = null;

  const hasVegPolys = (tile.vegetationPolygons?.length ?? 0) > 0;

  if (input.needBuildingMask && hasVegPolys) {
    const wall1 = Date.now();
    const [buildingOut, vegRasterOut] = runMaskWorkersParallel<
      WireMask,
      { data: ArrayBuffer; byteLength: number }
    >(
      {
        op: 'building',
        W,
        H,
        tile,
        metrics,
        pxPerM,
        corridorBounds,
      },
      {
        op: 'vegRaster',
        W,
        H,
        tile,
        metrics,
        pxPerM,
        corridorBounds,
      },
    );
    buildingMs = buildingOut.cpuMs;
    vegRasterMs = vegRasterOut.cpuMs;
    void wall1;
    buildingMask = hydrateMask(buildingOut.result);
    bdtopoVegRaster = new Uint8Array(vegRasterOut.result.data, 0, vegRasterOut.result.byteLength);
  } else if (input.needBuildingMask) {
    const buildingOut = runMaskWorker<WireMask>({
      op: 'building',
      W,
      H,
      tile,
      metrics,
      pxPerM,
      corridorBounds,
    });
    buildingMs = buildingOut.cpuMs;
    buildingMask = hydrateMask(buildingOut.result);
  } else if (input.prebuiltBuildingMask) {
    buildingMask = input.prebuiltBuildingMask;
  } else {
    buildingMask = {
      width: W,
      height: H,
      data: new Uint8Array(W * H),
      label: 'building',
    };
  }

  if (!bdtopoVegRaster && hasVegPolys) {
    const vegRasterOut = runMaskWorker<{ data: ArrayBuffer; byteLength: number }>({
      op: 'vegRaster',
      W,
      H,
      tile,
      metrics,
      pxPerM,
      corridorBounds,
    });
    vegRasterMs = vegRasterOut.cpuMs;
    bdtopoVegRaster = new Uint8Array(vegRasterOut.result.data, 0, vegRasterOut.result.byteLength);
  }

  const vegRasterBuffer: ArrayBuffer | null = bdtopoVegRaster
    ? (bdtopoVegRaster.buffer.slice(
        bdtopoVegRaster.byteOffset,
        bdtopoVegRaster.byteOffset + bdtopoVegRaster.byteLength,
      ) as ArrayBuffer)
    : null;

  const [vegMassOut, canopyOut] = runMaskWorkersParallel<WireMask, WireMask>(
    {
      op: 'vegMass',
      rgbBuffer,
      W,
      H,
      pxPerM,
      roadAxisSerial,
      tile,
      metrics,
      vegRasterBuffer,
      corridorBounds,
    },
    {
      op: 'canopy',
      rgbBuffer,
      W,
      H,
      pxPerM,
      roadAxisSerial,
      vegRasterBuffer,
      corridorBounds,
    },
    [rgbBuffer],
    [rgbBuffer],
  );

  return {
    buildingMask,
    vegetationMassMask: hydrateMask(vegMassOut.result),
    treeOcclusionMask: hydrateMask(canopyOut.result),
    buildingMs,
    vegRasterMs,
    vegetationMassMs: vegMassOut.cpuMs,
    canopyMs: canopyOut.cpuMs,
    wallMs: Date.now() - wallStart,
  };
}

export { maskParallelEnabled };
