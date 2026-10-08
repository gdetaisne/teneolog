import type { ProfileResultView } from './types.js';
import {
  applyVerdictToConfidence,
  buildRoadWidthVerdict,
  entryTagsParkingSensitive,
} from './verdict.js';
import type { YoloFetchResult } from './yolo-status.js';
import { yoloBoxesFromResult } from './yolo-status.js';

export interface FinalizeProfileOptions {
  readonly entryTags?: string;
  readonly bdtopoWidthM?: number | null;
}

export function finalizeProfileResultView(
  base: ProfileResultView,
  yolo: YoloFetchResult,
  entryTagsOrOptions: string | FinalizeProfileOptions = '',
): ProfileResultView {
  const entryTags =
    typeof entryTagsOrOptions === 'string'
      ? entryTagsOrOptions
      : (entryTagsOrOptions.entryTags ?? '');
  const bdtopoWidthM =
    typeof entryTagsOrOptions === 'string'
      ? null
      : (entryTagsOrOptions.bdtopoWidthM ?? null);
  const yoloMessage = yolo.status === 'ok' || yolo.status === 'empty'
    ? undefined
    : yolo.message;

  const verdict = buildRoadWidthVerdict({
    widthM: base.widthM,
    confidence: base.confidence,
    reasonCodes: base.reasonCodes,
    yoloStatus: yolo.status,
    asphaltSampleCount: base.asphaltModel.sampleCount,
    parkingSensitive: entryTagsParkingSensitive(entryTags),
    bdtopoWidthM,
  });

  const confidence = applyVerdictToConfidence(base.confidence, verdict, yolo.status);

  const reasonCodes = [
    ...base.reasonCodes,
    `yolo_status:${yolo.status}`,
    `verdict:${verdict.status}`,
    ...verdict.blockingReasons.map((r) => `block:${r}`),
    ...verdict.degradedReasons.map((r) => `degraded:${r}`),
  ];

  const notes = [
    ...base.notes,
    `yolo:${yolo.status}`,
    ...(yolo.meta?.source ? [`yolo_source:${yolo.meta.source}`] : []),
    `verdict:${verdict.status}`,
    ...(yoloMessage ? [`yolo_msg:${yoloMessage}`] : []),
  ];

  return {
    ...base,
    yoloBboxes: [...yoloBoxesFromResult(yolo)],
    yoloStatus: yolo.status,
    yoloMessage,
    yoloMeta: yolo.status === 'ok' || yolo.status === 'empty' ? yolo.meta : undefined,
    verdict,
    confidence,
    reasonCodes,
    notes,
  };
}
