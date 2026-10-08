import type { ConsolidatedRoadWidthResult, ProfileResultView, TileWidthResult } from './types.js';

const OUTLIER_WIDTH_DELTA_M = 2.5;
const MIN_TILE_CONFIDENCE = 0.25;

function medianWeighted(values: Array<{ value: number; weight: number }>): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const totalW = sorted.reduce((s, v) => s + v.weight, 0);
  let acc = 0;
  for (const v of sorted) {
    acc += v.weight;
    if (acc >= totalW / 2) return v.value;
  }
  return sorted[sorted.length - 1]!.value;
}

export function consolidateTileResults(
  tiles: readonly TileWidthResult[],
): ConsolidatedRoadWidthResult {
  const reasonCodes: string[] = [];
  const valid = tiles.filter(
    t =>
      t.widthM !== null &&
      t.confidence >= MIN_TILE_CONFIDENCE &&
      !t.reasonCodes.includes('tile_low_coverage'),
  );

  if (valid.length === 0) {
    const fallback = tiles.find(t => t.widthM !== null) ?? tiles[0];
    return buildConsolidated(tiles, fallback ?? tiles[0]!, ['consolidated_single_tile', 'tile_rejected_low_confidence']);
  }

  if (valid.length === 1) {
    reasonCodes.push('consolidated_single_tile');
    return buildConsolidated(tiles, valid[0]!, reasonCodes);
  }

  const widths = valid.map(t => t.widthM!);
  const med = medianWeighted(valid.map(t => ({ value: t.widthM!, weight: t.weight * t.confidence })));
  const kept = valid.filter(t => Math.abs(t.widthM! - med) <= OUTLIER_WIDTH_DELTA_M);
  const rejected = valid.filter(t => Math.abs(t.widthM! - med) > OUTLIER_WIDTH_DELTA_M);
  if (rejected.length > 0) reasonCodes.push('tile_rejected_outlier');

  const pool = kept.length > 0 ? kept : valid;
  const widthM = medianWeighted(pool.map(t => ({ value: t.widthM!, weight: t.weight * t.confidence })));
  const leftM = medianWeighted(pool.map(t => ({ value: t.leftPerpM!, weight: t.weight * t.confidence })));
  const rightM = medianWeighted(pool.map(t => ({ value: t.rightPerpM!, weight: t.weight * t.confidence })));
  const confidence =
    pool.reduce((s, t) => s + t.confidence * t.weight, 0) /
    Math.max(1e-6, pool.reduce((s, t) => s + t.weight, 0));

  const primary = pool.reduce((best, t) =>
    t.confidence * t.weight > best.confidence * best.weight ? t : best,
  );

  reasonCodes.push('consolidated_median');
  return {
    widthM: Math.round(widthM * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    leftPerpM: Math.round(leftM * 100) / 100,
    rightPerpM: Math.round(rightM * 100) / 100,
    reasonCodes,
    tiles,
    primaryTileIndex: primary.tileIndex,
    profileResult: tileToProfileView(primary, tiles, reasonCodes, widthM, leftM, rightM, confidence),
  };
}

function buildConsolidated(
  tiles: readonly TileWidthResult[],
  primary: TileWidthResult,
  reasonCodes: string[],
): ConsolidatedRoadWidthResult {
  return {
    widthM: primary.widthM,
    confidence: primary.confidence,
    leftPerpM: primary.leftPerpM,
    rightPerpM: primary.rightPerpM,
    reasonCodes,
    tiles,
    primaryTileIndex: primary.tileIndex,
    profileResult: tileToProfileView(
      primary,
      tiles,
      reasonCodes,
      primary.widthM,
      primary.leftPerpM,
      primary.rightPerpM,
      primary.confidence,
    ),
  };
}

function tileToProfileView(
  primary: TileWidthResult,
  tiles: readonly TileWidthResult[],
  reasonCodes: readonly string[],
  widthM: number | null,
  leftM: number | null,
  rightM: number | null,
  confidence: number,
): ProfileResultView {
  const durationMs = tiles.reduce((s, t) => s + t.durationMs, 0);
  const deltaToGtM =
    widthM !== null && primary.deltaToGtM !== null && primary.widthM !== null
      ? Math.round((widthM - primary.widthM + primary.deltaToGtM) * 100) / 100
      : primary.deltaToGtM;

  return {
    widthM,
    confidence,
    leftPerpM: leftM,
    rightPerpM: rightM,
    profile: primary.scores.profile,
    roadMatchProfile: primary.scores.roadMatchProfile,
    nonVegProfile: primary.scores.nonVegProfile,
    vegProfile: primary.scores.vegProfile,
    coverageProfile: primary.scores.coverageProfile,
    bdtopoBuildingCost: primary.scores.bdtopoBuildingCost,
    bdtopoVegetationCost: primary.scores.bdtopoVegetationCost,
    bdtopoCanopyCost: primary.scores.bdtopoCanopyCost,
    bdtopoHardCost: primary.scores.bdtopoHardCost,
    parkingExclusion: primary.scores.parkingExclusion,
    sidewalkBoundaryScore: [...primary.scores.sidewalkBoundaryScore],
    sidewalkBoundaryCandidateScore: [...primary.scores.sidewalkBoundaryCandidateScore],
    offsetsM: primary.scores.offsetsM,
    plateaux: primary.plateaux,
    roadColour: primary.roadColour,
    threshold: primary.threshold,
    sampleCount: primary.sampleCount,
    asphaltModel: primary.asphaltModel,
    notes: [
      ...primary.notes,
      `tiles:${tiles.map(t => `${t.tileIndex}=${t.widthM?.toFixed(2) ?? 'null'}`).join(',')}`,
    ],
    deltaToGtM,
    durationMs,
    plateauVegFrac: primary.plateauVegFrac,
    carZones: [],
    yoloBboxes: [],
    parkedYoloBboxes: [],
    yoloClassifications: [],
    yoloStatus: 'empty',
    verdict: {
      status: 'needs_review',
      blockingReasons: [],
      degradedReasons: ['yolo_not_run'],
    },
    masks: primary.masks,
    tiles,
    reasonCodes,
    primaryTileIndex: primary.tileIndex,
  };
}
