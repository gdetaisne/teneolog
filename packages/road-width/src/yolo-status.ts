import type { YoloBbox } from './yolo.js';

export type YoloFetchStatus =
  | 'ok'
  | 'empty'
  | 'fallback'
  | 'http_error'
  | 'timeout'
  | 'invalid_response';

export interface YoloMeta {
  source: string;
  model?: string;
  conf?: number;
  imgsz?: number;
}

export type YoloFetchResult =
  | { status: 'ok'; boxes: YoloBbox[]; meta: YoloMeta }
  | { status: 'empty'; boxes: []; meta: YoloMeta }
  | {
      status: 'fallback' | 'http_error' | 'timeout' | 'invalid_response';
      boxes: [];
      message: string;
      meta?: Partial<YoloMeta>;
    };

export function yoloBoxesFromResult(result: YoloFetchResult): readonly YoloBbox[] {
  return result.boxes;
}

export function isYoloReliable(result: YoloFetchResult): boolean {
  return result.status === 'ok' || result.status === 'empty';
}

export function yoloFetchResultFromMeasureInput(input: {
  yoloStatus: YoloFetchStatus;
  yoloMessage?: string;
  yoloMeta?: YoloMeta;
  yoloBboxes?: readonly YoloBbox[];
}): YoloFetchResult {
  const boxes = input.yoloBboxes ?? [];
  const meta = input.yoloMeta ?? { source: 'client' };

  if (input.yoloStatus === 'ok') {
    return { status: 'ok', boxes: [...boxes], meta };
  }
  if (input.yoloStatus === 'empty') {
    return { status: 'empty', boxes: [], meta };
  }

  return {
    status: input.yoloStatus,
    boxes: [],
    message: input.yoloMessage ?? `yolo_${input.yoloStatus}`,
    meta,
  };
}
