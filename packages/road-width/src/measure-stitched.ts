import type { ConsolidatedRoadWidthResult, ProfileResultView } from './types.js';
import type { RoadAxis, TileGeoContext } from './geometry.js';
import type { YoloBbox } from './yolo.js';
import type { RgbImageData } from './image.js';
import { measureTileWidth } from './profile.js';
import {
  prepareStitchedPipeline,
  type D10CoreTimingMs,
} from './stitched-pipeline.js';
import { estimateLateralBdtopoOffset } from './bdtopo-coreg.js';

export type { D10CoreTimingMs };

function phaseNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
import type { TilePipelinePrep } from './tile-pipeline.js';
import {
  applyYoloClampingToProfile,
  type YoloClampContext,
} from './yolo-clamp.js';

export interface MeasureStitchedInput {
  readonly stitched: RgbImageData;
  readonly tile: TileGeoContext;
  readonly bearingDeg: number;
  readonly pxPerM: number;
  readonly gtWidthM: number | null;
  readonly yoloBboxes?: readonly YoloBbox[];
  /** YOLO boxes used only to exclude vehicle pixels from asphalt reference sampling. */
  readonly asphaltReferenceYoloBboxes?: readonly YoloBbox[];
  /** D10v2 — lateral crop half (m). */
  readonly lateralHalfM?: number;
}

/**
 * Primary D10 path: one lateral profile on the stitched orthophoto canvas.
 */
export type StitchedMeasureWithTiming = ConsolidatedRoadWidthResult & {
  readonly d10TimingMs?: D10CoreTimingMs;
};

/** D10 core: axis, BDTOPO masks, asphalt model, lateral profile — no YOLO vehicle layer. */
export function measureStitchedRoadWidthWithoutYolo(
  input: Omit<MeasureStitchedInput, 'yoloBboxes'>,
): StitchedMeasureWithTiming {
  const consolidated = measureStitchedRoadWidth({ ...input, yoloBboxes: [] });
  return {
    ...consolidated,
    reasonCodes: [...consolidated.reasonCodes, 'pipeline_d10_core_without_yolo'],
    profileResult: {
      ...consolidated.profileResult,
      notes: [...consolidated.profileResult.notes, 'pipeline_d10_core_without_yolo'],
      reasonCodes: [
        ...consolidated.profileResult.reasonCodes,
        'pipeline_d10_core_without_yolo',
      ],
    },
  };
}

export interface MergeStitchedYoloInput {
  readonly consolidated: ConsolidatedRoadWidthResult;
  readonly profile: ProfileResultView;
  readonly yoloBboxes: readonly YoloBbox[];
  readonly roadAxis: RoadAxis;
  readonly pxPerM: number;
  readonly gtWidthM: number | null;
  readonly clampCtx: YoloClampContext;
}

/** Apply YOLO classify, vehicle rescore, parking exclusion, and width clamp on a D10 core profile. */
export function mergeStitchedProfileWithYolo(input: MergeStitchedYoloInput): ProfileResultView {
  const profile = applyYoloClampingToProfile(
    input.profile,
    [...input.yoloBboxes],
    input.roadAxis,
    input.pxPerM,
    input.gtWidthM,
    input.clampCtx,
  );
  return {
    ...profile,
    notes: [...profile.notes, 'pipeline_d10_yolo_merge'],
  };
}

export function measureStitchedRoadWidth(input: MeasureStitchedInput): StitchedMeasureWithTiming {
  const totalStart = phaseNowMs();
  const { prep, prepTimingMs } = prepareStitchedPipeline({
    rgb: input.stitched.data,
    width: input.stitched.width,
    height: input.stitched.height,
    pxPerM: input.pxPerM,
    bearingDeg: input.bearingDeg,
    gtWidthM: input.gtWidthM,
    tile: input.tile,
    yoloBboxes: input.yoloBboxes ?? [],
    asphaltReferenceYoloBboxes: input.asphaltReferenceYoloBboxes,
    lateralHalfM: input.lateralHalfM,
  });

  const profileStart = phaseNowMs();
  const tileResult = measureTileWidth(prep as TilePipelinePrep);
  const lateralProfile = Math.round(phaseNowMs() - profileStart);
  const d10TimingMs: D10CoreTimingMs = {
    ...prepTimingMs,
    lateralProfile,
    total: Math.round(phaseNowMs() - totalStart),
  };
  const coreg = estimateLateralBdtopoOffset(
    tileResult.scores.offsetsM,
    tileResult.scores.roadMatchProfile,
    { bdtopoWidthM: null },
  );
  const reasonCodes = [
    ...tileResult.reasonCodes,
    'consolidated_stitched_single',
    `d10:coreg_offset=${coreg.offsetM.toFixed(2)},conf=${coreg.confidence.toFixed(2)},captured=${coreg.capturedRoadFrac.toFixed(2)}`,
  ];

  return {
    widthM: tileResult.widthM,
    confidence: tileResult.confidence,
    leftPerpM: tileResult.leftPerpM,
    rightPerpM: tileResult.rightPerpM,
    reasonCodes,
    tiles: [{ ...tileResult, notes: [...tileResult.notes, 'mode:stitched'] }],
    primaryTileIndex: 0,
    stitchRoadAxis: prep.roadAxis,
    stitchRoadAxisSerial: prep.roadAxisSerial,
    d10TimingMs,
    profileResult: {
      widthM: tileResult.widthM,
      confidence: tileResult.confidence,
      leftPerpM: tileResult.leftPerpM,
      rightPerpM: tileResult.rightPerpM,
      profile: tileResult.scores.profile,
      roadMatchProfile: tileResult.scores.roadMatchProfile,
      nonVegProfile: tileResult.scores.nonVegProfile,
      vegProfile: tileResult.scores.vegProfile,
      coverageProfile: tileResult.scores.coverageProfile,
      bdtopoBuildingCost: tileResult.scores.bdtopoBuildingCost,
      bdtopoVegetationCost: tileResult.scores.bdtopoVegetationCost,
      bdtopoCanopyCost: tileResult.scores.bdtopoCanopyCost,
      bdtopoHardCost: tileResult.scores.bdtopoHardCost,
      parkingExclusion: tileResult.scores.parkingExclusion,
      sidewalkBoundaryScore: [...tileResult.scores.sidewalkBoundaryScore],
      sidewalkBoundaryCandidateScore: [...tileResult.scores.sidewalkBoundaryCandidateScore],
      offsetsM: tileResult.scores.offsetsM,
      plateaux: tileResult.plateaux,
      roadColour: tileResult.roadColour,
      threshold: tileResult.threshold,
      sampleCount: tileResult.sampleCount,
      asphaltModel: tileResult.asphaltModel,
      notes: [...tileResult.notes, 'mode:stitched'],
      deltaToGtM: tileResult.deltaToGtM,
      durationMs: tileResult.durationMs,
      plateauVegFrac: tileResult.plateauVegFrac,
      carZones: [],
      yoloBboxes: [...(input.yoloBboxes ?? [])],
      parkedYoloBboxes: [],
      yoloClassifications: [],
      masks: tileResult.masks,
      tiles: [{ ...tileResult, notes: [...tileResult.notes, 'mode:stitched'] }],
      reasonCodes,
      primaryTileIndex: 0,
      yoloStatus: 'empty',
      verdict: {
        status: 'needs_review',
        blockingReasons: [],
        degradedReasons: [],
      },
    },
  };
}
