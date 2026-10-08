import type { Plateau, TileWidthResult, LateralScoreComponents } from './types.js';
import type { TilePipelinePrep } from './tile-pipeline.js';
import { boundedScanHalfM } from './geometry.js';
import {
  adaptiveThreshold,
  isRoadPixel,
  isRoadPixelModel,
  isVegetationPixel,
  sampleRGB,
} from './color-utils.js';
import {
  aerialCanopyScanHit,
  maskFractionAlongScan,
  maskPixelAtLateralOffset,
} from './masks.js';
import { bridgeProfileThroughAerialCanopy } from './canopy-bridge.js';
import { fillNarrowGapsBetweenBinaryExclusions, MIN_ROAD_GAP_BETWEEN_EXCLUSIONS_M } from './exclusion-gap.js';
import { lateralOffsetInCarZone } from './yolo-clamp.js';
import { applyStudyRegionGates } from './study-region-gates.js';
import {
  applyMarkingEdgeTrim,
  buildPerpendicularCrosswalkFlags,
} from './marking-edge.js';
import { assessFlatSaturatedPlateau } from './plateau-safety.js';
import {
  computeSidewalkBoundaryShadowScore,
  sidewalkShadowDebugTags,
} from './sidewalk-boundary-shadow.js';
import { computeSidewalkBoundaryCandidateCurve } from './sidewalk-boundary-candidate.js';

export const WIDTH_SCAN_HALF_M = 12;

/** Any hard exclusion at lateral index k (incl. narrow-gap fill via bdtopoHardCost). */
export function isBinaryExclusionAtOffset(
  buildingCost: readonly number[],
  vegCost: readonly number[],
  parkingCost: readonly number[],
  hardCost: readonly number[],
  k: number,
): boolean {
  return (
    (buildingCost[k] ?? 0) > 0 ||
    (vegCost[k] ?? 0) > 0 ||
    (parkingCost[k] ?? 0) > 0 ||
    (hardCost[k] ?? 0) > 0
  );
}

export function applyBinaryExclusionToProfile(
  profile: number[],
  bdtopoBuildingCost: number[],
  bdtopoVegetationCost: number[],
  parkingExclusion: number[],
  bdtopoHardCost: number[],
): void {
  for (let k = 0; k < profile.length; k++) {
    if (
      isBinaryExclusionAtOffset(
        bdtopoBuildingCost,
        bdtopoVegetationCost,
        parkingExclusion,
        bdtopoHardCost,
        k,
      )
    ) {
      profile[k] = 0;
      bdtopoHardCost[k] = 1;
    }
  }
}

/** Profile scores for charts: zero wherever a binary exclusion flag is set. */
export function profileScoresForChart(
  profile: readonly number[],
  bdtopoBuildingCost: readonly number[],
  bdtopoVegetationCost: readonly number[],
  parkingExclusion: readonly number[],
  bdtopoHardCost: readonly number[],
): number[] {
  return profile.map((v, i) =>
    isBinaryExclusionAtOffset(
      bdtopoBuildingCost,
      bdtopoVegetationCost,
      parkingExclusion,
      bdtopoHardCost,
      i,
    )
      ? 0
      : v,
  );
}

function findPlateaux(
  profile: number[],
  offsetsM: number[],
  enterT: number,
  exitT: number,
  exitSustained: number,
): Plateau[] {
  const plateaux: Plateau[] = [];
  const ENTER_BACKFILL_T = 0.6;
  const ENTER_BACKFILL_STEPS = 2;
  const backfillStart = (idx: number): number => {
    let j = idx;
    while (j > 0 && idx - j < ENTER_BACKFILL_STEPS && profile[j - 1]! >= ENTER_BACKFILL_T) j--;
    return j;
  };
  let inPlateau = false;
  let startIdx = 0;
  let belowCount = 0;
  let lastAboveExit = 0;
  for (let i = 0; i < profile.length; i++) {
    const v = profile[i]!;
    if (!inPlateau) {
      if (v > enterT) {
        inPlateau = true;
        startIdx = backfillStart(i);
        belowCount = 0;
        lastAboveExit = i;
      }
    } else if (v < exitT) {
      belowCount++;
      if (belowCount >= exitSustained) {
        const endIdx = lastAboveExit;
        if (endIdx > startIdx) {
          const slice = profile.slice(startIdx, endIdx + 1);
          const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
          plateaux.push({
            startM: offsetsM[startIdx]!,
            endM: offsetsM[endIdx]!,
            widthM: offsetsM[endIdx]! - offsetsM[startIdx]!,
            meanScore: mean,
          });
        }
        inPlateau = false;
        belowCount = 0;
      }
    } else {
      belowCount = 0;
      lastAboveExit = i;
    }
  }
  if (inPlateau) {
    const endIdx = lastAboveExit;
    if (endIdx > startIdx) {
      const slice = profile.slice(startIdx, endIdx + 1);
      const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
      plateaux.push({
        startM: offsetsM[startIdx]!,
        endM: offsetsM[endIdx]!,
        widthM: offsetsM[endIdx]! - offsetsM[startIdx]!,
        meanScore: mean,
      });
    }
  }
  return plateaux;
}

/**
 * Step 5 — Lateral profile and plateau detection on the study region only.
 * Expects `prepareTilePipeline()` to have run steps 1–4 first.
 */
export function measureTileWidth(prep: TilePipelinePrep): TileWidthResult {
  const t0 = performance.now();
  const {
    tileIndex,
    rgb,
    width: W,
    height: H,
    pxPerM,
    bearingDeg,
    gtWidthM,
    roadAxis,
    masks,
    asphaltModel,
    studyMask,
    bdtopoExclusionMask,
    carZones,
    pipelineReasonCodes,
  } = prep;

  const scanHalfM = boundedScanHalfM(roadAxis, WIDTH_SCAN_HALF_M);
  const studyData = studyMask.data;
  const roadColour = asphaltModel.medianColour;
  const sampleCount = asphaltModel.sampleCount;
  const threshold = adaptiveThreshold(roadColour, rgb, W, H, (bearingDeg * Math.PI) / 180, pxPerM);

  const LATERAL_HALF_M = prep.lateralHalfM ?? 15;
  const LATERAL_STEP_M = 0.25;
  const SAMPLE_STEP_PX = 3;
  const ENTER_T = 0.75;
  const EXIT_T = 0.75;
  const EXIT_SUSTAINED = 5;
  const MERGE_GAP_M = 0.5;
  // G1 — texture grass gate. Dry roadside grass escapes the green veg test and
  // colour-matches asphalt (roadMatch high), but is mottled: high along-scan
  // luminance dispersion. Smooth asphalt stays low (corpus: ≤9 clean, ~15 with
  // markings/shadows; grass 15–28). Penalise roadMatch on a smoothed lumaStd
  // ramp so plateaux terminate at the kerb. Canopy-bridged offsets are exempt
  // (tree shade over a real road also raises texture — must not be trimmed).
  const TEXTURE_GATE_ENABLED = true;
  // Texture alone cannot tell mottled grass from shaded/gravelly asphalt (a
  // sunken lane's real asphalt can reach lumaStd 40 > grass 28). The colour
  // term disambiguates: grass keeps a positive green excess (~+2.5) while grey
  // asphalt stays ≤ ~+0.6 even in deep shade. Trim = high texture AND green.
  const TEXTURE_STD_LO = 8; // textureFactor 0 below this lumaStd
  const TEXTURE_STD_RAMP = 10; // textureFactor reaches 1 at LO + RAMP
  const GREEN_EXCESS_LO = 1.5; // greenFactor 0 below this green excess
  const GREEN_EXCESS_RAMP = 1.5; // greenFactor reaches 1 at LO + RAMP
  const TEXTURE_SMOOTH_HALF = 2; // ±2 offsets (±0.5 m) moving-average window
  /** Any mask hit along the longitudinal scan → lateral offset is excluded (binary). */
  const maskScanHit = (fraction: number): boolean => fraction > 0;

  const scanStepM = SAMPLE_STEP_PX / pxPerM;
  const nSteps = Math.floor((LATERAL_HALF_M * 2) / LATERAL_STEP_M) + 1;
  const nSamplesPerLine = Math.max(1, Math.floor((2 * scanHalfM) / scanStepM) + 1);
  const MIN_COVERAGE = 0.4;
  const STRICT_ROAD_ANCHOR_T = 0.35;

  const offsetsM: number[] = [];
  const profile: number[] = [];
  const roadMatchProfile: number[] = [];
  const nonVegProfile: number[] = [];
  const lumaStdProfile: number[] = [];
  const greenExcessProfile: number[] = [];
  const vegProfile: number[] = [];
  const coverageProfile: number[] = [];
  const roadLikelihood: number[] = [];
  const hardExclusion: number[] = [];
  const occlusion: number[] = [];
  const edgeEvidence: number[] = [];
  const whiteLineProfile: number[] = [];
  const bdtopoBuildingCost: number[] = [];
  const bdtopoVegetationCost: number[] = [];
  const bdtopoCanopyCost: number[] = [];
  const bdtopoHardCost: number[] = [];
  const parkingExclusion: number[] = [];

  let lowCoverageCount = 0;
  let brightBridgeSuppressedCount = 0;
  let studyPixelSkipped = 0;
  const studySkippedPerOffset: number[] = [];
  const reasonCodes: string[] = [...pipelineReasonCodes, ...masks.reasonCodes];
  reasonCodes.push('pipeline_step5_lateral_score');
  reasonCodes.push('score_asphalt_only');

  for (let k = 0; k < nSteps; k++) {
    const sM = -LATERAL_HALF_M + k * LATERAL_STEP_M;
    offsetsM.push(sM);
    studySkippedPerOffset.push(0);

    let total = 0;
    let matches = 0;
    let strictMatches = 0;
    let whiteCount = 0;
    // G1 calibration: along-scan luminance dispersion per offset. Smooth asphalt
    // → low std; mottled dry grass (escapes the green veg test) → high std.
    let sumLum = 0;
    let sumLum2 = 0;
    let sumGreen = 0;
    for (let j = 0; j < nSamplesPerLine; j++) {
      const tM = -scanHalfM + j * scanStepM;
      const ax = roadAxis.axisAt(tM);
      const x = Math.round(ax.cx + sM * pxPerM * ax.perpX);
      const y = Math.round(ax.cy + sM * pxPerM * ax.perpY);
      if (studyData[y * W + x]! === 0) {
        studyPixelSkipped++;
        studySkippedPerOffset[k]!++;
        continue;
      }
      const c = sampleRGB(rgb, W, H, x, y);
      if (!c) continue;
      if (isVegetationPixel(c)) continue;
      total++;
      const lum = (c[0] + c[1] + c[2]) / 3;
      sumLum += lum;
      sumLum2 += lum * lum;
      // G1 colour term: green excess over the red/blue average. ~0 on grey
      // asphalt (incl. shade), >0 on grass even when too dry for the veg test.
      sumGreen += c[1] - (c[0] + c[2]) / 2;
      if (lum > 200) whiteCount++;
      if (isRoadPixelModel(c, asphaltModel, { allowBrightAsphalt: false })) strictMatches++;
      if (isRoadPixel(c, asphaltModel)) matches++;
    }
    const lumaStd =
      total > 0 ? Math.sqrt(Math.max(0, sumLum2 / total - (sumLum / total) ** 2)) : 0;
    const greenExcess = total > 0 ? sumGreen / total : 0;

    const coverage = total / nSamplesPerLine;
    const strictRoadMatch = total > 0 ? strictMatches / total : 0;
    const relaxedRoadMatch = total > 0 ? matches / total : 0;
    const roadMatch = strictRoadMatch >= STRICT_ROAD_ANCHOR_T ? relaxedRoadMatch : strictRoadMatch;
    if (relaxedRoadMatch > strictRoadMatch && strictRoadMatch < STRICT_ROAD_ANCHOR_T) {
      brightBridgeSuppressedCount++;
    }
    const buildingFrac = maskFractionAlongScan(
      masks.buildingMask, W, roadAxis, pxPerM, sM, scanHalfM, SAMPLE_STEP_PX,
    );
    const vegMassFrac = maskFractionAlongScan(
      masks.vegetationMassMask, W, roadAxis, pxPerM, sM, scanHalfM, SAMPLE_STEP_PX,
    );
    const canopyFrac = maskFractionAlongScan(
      masks.treeOcclusionMask, W, roadAxis, pxPerM, sM, scanHalfM, SAMPLE_STEP_PX,
    );
    const bdtopoFrac = maskFractionAlongScan(
      bdtopoExclusionMask, W, roadAxis, pxPerM, sM, scanHalfM, SAMPLE_STEP_PX,
    );
    const vehicleFrac = maskFractionAlongScan(
      masks.vehicleMask, W, roadAxis, pxPerM, sM, scanHalfM, SAMPLE_STEP_PX,
    );

    const ptBdtopoExcl = maskPixelAtLateralOffset(
      bdtopoExclusionMask, W, H, roadAxis, pxPerM, sM,
    );
    const ptBuilding = maskPixelAtLateralOffset(
      masks.buildingMask, W, H, roadAxis, pxPerM, sM,
    );
    const ptVegMass = maskPixelAtLateralOffset(
      masks.vegetationMassMask, W, H, roadAxis, pxPerM, sM,
    );
    const bdtopoBuildingHit =
      ptBuilding || ptBdtopoExcl || maskScanHit(buildingFrac);
    const bdtopoVegHit = ptVegMass || ptBdtopoExcl || maskScanHit(vegMassFrac);
    const aerialCanopyHit = aerialCanopyScanHit(canopyFrac);
    const carZoneHit = lateralOffsetInCarZone(sM, carZones);
    const parkingHit = maskScanHit(vehicleFrac) || carZoneHit;
    const binaryExcl = bdtopoBuildingHit || bdtopoVegHit || parkingHit;
    const hardExcluded = binaryExcl;
    const occ = canopyFrac;

    roadMatchProfile.push(roadMatch);
    // Repurposed (deprecated field) to surface G1 luma-std texture for calibration.
    nonVegProfile.push(lumaStd);
    lumaStdProfile.push(lumaStd);
    greenExcessProfile.push(greenExcess);
    coverageProfile.push(coverage);
    roadLikelihood.push(roadMatch);
    hardExclusion.push(hardExcluded ? 1 : 0);
    occlusion.push(occ);
    bdtopoBuildingCost.push(bdtopoBuildingHit ? 1 : 0);
    bdtopoVegetationCost.push(bdtopoVegHit ? 1 : 0);
    bdtopoCanopyCost.push(aerialCanopyHit ? 1 : 0);
    bdtopoHardCost.push(hardExcluded ? 1 : 0);
    parkingExclusion.push(parkingHit ? 1 : 0);

    if (total < MIN_COVERAGE * nSamplesPerLine) {
      profile.push(0);
      vegProfile.push(greenExcess);
      whiteLineProfile.push(0);
      edgeEvidence.push(0);
      lowCoverageCount++;
    } else if (hardExcluded) {
      profile.push(0);
      vegProfile.push(greenExcess);
      whiteLineProfile.push(whiteCount / total);
      edgeEvidence.push(0);
    } else {
      profile.push(roadMatch);
      vegProfile.push(greenExcess);
      whiteLineProfile.push(whiteCount / total);
      edgeEvidence.push(0);
    }
  }

  const { profile: bridgedProfile, bridgedCount } = bridgeProfileThroughAerialCanopy(
    profile,
    bdtopoCanopyCost,
    hardExclusion,
    ENTER_T,
  );
  for (let k = 0; k < profile.length; k++) profile[k] = bridgedProfile[k]!;
  if (bridgedCount > 0) reasonCodes.push('aerial_canopy_bridge');

  applyBinaryExclusionToProfile(
    profile,
    bdtopoBuildingCost,
    bdtopoVegetationCost,
    parkingExclusion,
    bdtopoHardCost,
  );

  const narrowGapFilled = fillNarrowGapsBetweenBinaryExclusions(
    bdtopoBuildingCost,
    bdtopoVegetationCost,
    parkingExclusion,
    bdtopoHardCost,
    offsetsM,
  );
  if (narrowGapFilled > 0) {
    reasonCodes.push('exclusion_narrow_gap_fill');
  }
  applyBinaryExclusionToProfile(
    profile,
    bdtopoBuildingCost,
    bdtopoVegetationCost,
    parkingExclusion,
    bdtopoHardCost,
  );

  let textureTrimmedCount = 0;
  if (TEXTURE_GATE_ENABLED) {
    // Green excess of the asphalt reference itself. A greenish/mossy/wet rural
    // road (e.g. medianColour [85,97,97] → +6) has a high ABSOLUTE green excess
    // but matches its own reference, so it must not be flagged as grass. Grass is
    // only the excess ABOVE the reference; shift the green threshold by the
    // model's own green excess so grey-asphalt streets (model ≈ 0) are unchanged.
    const modelGreenExcess = roadColour[1]! - (roadColour[0]! + roadColour[2]!) / 2;
    const greenExcessLoEff = GREEN_EXCESS_LO + Math.max(0, modelGreenExcess);
    if (modelGreenExcess > GREEN_EXCESS_LO) {
      reasonCodes.push(`texture_green_ref_shift:${modelGreenExcess.toFixed(1)}`);
    }
    for (let k = 0; k < profile.length; k++) {
      if (profile[k]! <= 0) continue;
      if ((bdtopoCanopyCost[k] ?? 0) > 0) continue; // tree shade over road — never trim
      let sumStd = 0;
      let sumGreen = 0;
      let n = 0;
      for (let d = -TEXTURE_SMOOTH_HALF; d <= TEXTURE_SMOOTH_HALF; d++) {
        const j = k + d;
        if (j < 0 || j >= lumaStdProfile.length) continue;
        sumStd += lumaStdProfile[j]!;
        sumGreen += greenExcessProfile[j]!;
        n++;
      }
      const smoothStd = n > 0 ? sumStd / n : lumaStdProfile[k]!;
      const smoothGreen = n > 0 ? sumGreen / n : greenExcessProfile[k]!;
      const textureFactor = Math.max(0, Math.min(1, (smoothStd - TEXTURE_STD_LO) / TEXTURE_STD_RAMP));
      const greenFactor = Math.max(0, Math.min(1, (smoothGreen - greenExcessLoEff) / GREEN_EXCESS_RAMP));
      const penalty = textureFactor * greenFactor;
      if (penalty > 0) {
        profile[k] = profile[k]! * (1 - penalty);
        textureTrimmedCount++;
      }
    }
    if (textureTrimmedCount > 0) reasonCodes.push('texture_grass_trim');
  }

  for (let k = 1; k < profile.length - 1; k++) {
    edgeEvidence[k] = Math.abs(profile[k + 1]! - profile[k - 1]!) / (2 * LATERAL_STEP_M);
  }

  const rawPlateaux = findPlateaux(profile, offsetsM, ENTER_T, EXIT_T, EXIT_SUSTAINED);
  const plateaux: Plateau[] = [];
  let mergedCount = 0;
  let i = 0;
  while (i < rawPlateaux.length) {
    const a = rawPlateaux[i]!;
    if (i + 1 < rawPlateaux.length) {
      const b = rawPlateaux[i + 1]!;
      if (b.startM - a.endM <= MERGE_GAP_M) {
        const aw = a.widthM || 0.01;
        const bw = b.widthM || 0.01;
        plateaux.push({
          startM: a.startM,
          endM: b.endM,
          widthM: b.endM - a.startM,
          meanScore: (a.meanScore * aw + b.meanScore * bw) / (aw + bw),
        });
        mergedCount++;
        i += 2;
        continue;
      }
    }
    plateaux.push(a);
    i++;
  }

  const notes: string[] = [];
  notes.push(`tile:${tileIndex}`);
  notes.push(`scan_window_half_m:${scanHalfM}`);
  if (bridgedCount > 0) notes.push(`canopy_bridged:${bridgedCount}`);
  if (narrowGapFilled > 0) notes.push(`narrow_gap_excluded:${narrowGapFilled}`);
  notes.push(`plateaux:${rawPlateaux.length}`);
  if (mergedCount > 0) notes.push(`merged_gaps:${mergedCount}`);
  if (lowCoverageCount > 0) notes.push(`lowCoverageLines:${lowCoverageCount}/${nSteps}`);
  if (brightBridgeSuppressedCount > 0) {
    notes.push(`bright_bridge_suppressed:${brightBridgeSuppressedCount}/${nSteps}`);
  }
  if (studyPixelSkipped > 0) {
    notes.push(`study_pixels_skipped:${studyPixelSkipped}`);
  }

  // Sidewalk detection runs on a dense lateral grid (~1 px @ zoom 20) so that
  // narrow kerbs (~25 cm) are not missed by the 25 cm D10 sampling. The dense
  // arrays stay local; published scores are downsampled back to `offsetsM`.
  const SIDEWALK_LATERAL_STEP_M = 0.05;
  const nDenseSidewalk =
    Math.floor((LATERAL_HALF_M * 2) / SIDEWALK_LATERAL_STEP_M) + 1;
  const denseSidewalkOffsetsM = new Array<number>(nDenseSidewalk);
  for (let k = 0; k < nDenseSidewalk; k++) {
    denseSidewalkOffsetsM[k] =
      Math.round((-LATERAL_HALF_M + k * SIDEWALK_LATERAL_STEP_M) * 1000) / 1000;
  }
  const coarseStartM = offsetsM[0]!;
  const expandCoarseToDense = (values: readonly number[]): number[] => {
    const out = new Array<number>(nDenseSidewalk).fill(0);
    for (let i = 0; i < nDenseSidewalk; i++) {
      let k = Math.round((denseSidewalkOffsetsM[i]! - coarseStartM) / LATERAL_STEP_M);
      if (k < 0) k = 0;
      if (k >= values.length) k = values.length - 1;
      out[i] = values[k] ?? 0;
    }
    return out;
  };
  const downsampleDenseToCoarseMax = (dense: readonly number[]): number[] => {
    const out = new Array<number>(offsetsM.length).fill(0);
    const halfStep = LATERAL_STEP_M / 2;
    let i = 0;
    for (let kCoarse = 0; kCoarse < offsetsM.length; kCoarse++) {
      const lo = offsetsM[kCoarse]! - halfStep;
      const hi = offsetsM[kCoarse]! + halfStep;
      while (i < nDenseSidewalk && denseSidewalkOffsetsM[i]! < lo) i++;
      let max = 0;
      let j = i;
      while (j < nDenseSidewalk && denseSidewalkOffsetsM[j]! <= hi) {
        const v = dense[j]!;
        if (v > max) max = v;
        j++;
      }
      out[kCoarse] = max;
    }
    return out;
  };

  // Sidewalk shadow must ignore vehicle pixels too: a bright car roof would
  // otherwise score as "brighter than asphalt" and create a phantom sidewalk
  // candidate (e.g. Creuse incoming R~1.4 m false positive on a parked car).
  const sidewalkExcludeMask = new Uint8Array(W * H);
  for (let i = 0; i < sidewalkExcludeMask.length; i++) {
    if (
      bdtopoExclusionMask.data[i]! > 0 ||
      masks.vehicleMask.data[i]! > 0
    ) {
      sidewalkExcludeMask[i] = 255;
    }
  }
  const sidewalkBoundaryDense = computeSidewalkBoundaryShadowScore({
    rgb,
    width: W,
    height: H,
    pxPerM,
    roadAxis,
    scanHalfM,
    scanStepM,
    offsetsM: denseSidewalkOffsetsM,
    studyData,
    excludeMask: sidewalkExcludeMask,
  });
  const sidewalkBoundaryScore = downsampleDenseToCoarseMax(sidewalkBoundaryDense);
  const shadowTags = sidewalkShadowDebugTags(sidewalkBoundaryScore, offsetsM);
  if (shadowTags.note) notes.push(shadowTags.note);
  if (shadowTags.reason) reasonCodes.push(shadowTags.reason);

  const scores: LateralScoreComponents = {
    offsetsM,
    roadLikelihood,
    hardExclusion,
    occlusion,
    edgeEvidence,
    profile,
    roadMatchProfile,
    nonVegProfile,
    vegProfile,
    coverageProfile,
    bdtopoBuildingCost,
    bdtopoVegetationCost,
    bdtopoCanopyCost,
    bdtopoHardCost,
    parkingExclusion,
    sidewalkBoundaryScore,
    sidewalkBoundaryCandidateScore: offsetsM.map(() => 0),
  };

  if (plateaux.length === 0) {
    reasonCodes.push('no_plateau');
    return {
      tileIndex,
      widthM: null,
      confidence: 0,
      leftPerpM: null,
      rightPerpM: null,
      reasonCodes,
      masks,
      scores,
      plateaux,
      asphaltModel,
      roadColour,
      threshold,
      sampleCount,
      notes,
      plateauVegFrac: 0,
      durationMs: Math.round(performance.now() - t0),
      deltaToGtM: null,
      weight: coverageProfile.reduce((a, b) => a + b, 0) / Math.max(1, coverageProfile.length),
    };
  }

  const gradProfile = profile.map((_, k) => {
    const prev = profile[Math.max(0, k - 1)]!;
    const next = profile[Math.min(profile.length - 1, k + 1)]!;
    return Math.abs(next - prev) / (2 * LATERAL_STEP_M);
  });

  const containing = plateaux.filter(p => p.startM <= 0 && p.endM >= 0);
  let chosen: Plateau;
  if (containing.length > 0) {
    chosen = containing.sort((a, b) => a.widthM - b.widthM)[0]!;
  } else {
    chosen = plateaux.slice().sort((a, b) => {
      const ca = (a.startM + a.endM) / 2;
      const cb = (b.startM + b.endM) / 2;
      return Math.abs(ca) - Math.abs(cb);
    })[0]!;
    notes.push('no_plateau_at_zero');
    reasonCodes.push('no_plateau_at_zero');
  }

  const crosswalkFlags = buildPerpendicularCrosswalkFlags(
    rgb,
    W,
    H,
    roadAxis,
    pxPerM,
    studyData,
    offsetsM,
    scanHalfM,
    scanStepM,
  );
  const markingTrim = applyMarkingEdgeTrim({
    chosen,
    profile,
    offsetsM,
    whiteLineProfile,
    crosswalkFlags,
    enterT: ENTER_T,
    exitT: EXIT_T,
    lateralStepM: LATERAL_STEP_M,
  });
  chosen = markingTrim.chosen;
  notes.push(...markingTrim.notes);
  if (markingTrim.notes.some((n) => n.startsWith('crosswalk_edge:'))) {
    reasonCodes.push('crosswalk_edge_trim');
  }
  if (markingTrim.notes.some((n) => n.startsWith('marking_keep:'))) {
    reasonCodes.push('marking_continuation_kept');
  }

  const SHARP_WIN_M = 1;
  const SHARP_MIN_GRAD = 0.12;
  const snapSharp = (bM: number, loM: number, hiM: number): number => {
    let best = SHARP_MIN_GRAD;
    let bestM = bM;
    for (let idx = 0; idx < offsetsM.length; idx++) {
      const o = offsetsM[idx]!;
      if (o < loM || o > hiM) continue;
      if (gradProfile[idx]! > best) {
        best = gradProfile[idx]!;
        bestM = o;
      }
    }
    return bestM;
  };
  const sL = snapSharp(chosen.startM, chosen.startM, chosen.startM + SHARP_WIN_M);
  const sR = snapSharp(chosen.endM, chosen.endM - SHARP_WIN_M, chosen.endM);
  if (sL !== chosen.startM || sR !== chosen.endM) {
    notes.push(`boundary_sharp:L${sL.toFixed(2)}R${sR.toFixed(2)}`);
    chosen = { startM: sL, endM: sR, widthM: sR - sL, meanScore: chosen.meanScore };
  }

  // Candidate runs on the dense sidewalk grid for sub-decimetre kerb precision;
  // the published curve is downsampled back to `offsetsM` for UI compatibility.
  const sidewalkCandidate = computeSidewalkBoundaryCandidateCurve({
    offsetsM: denseSidewalkOffsetsM,
    sidewalkBoundaryScore: sidewalkBoundaryDense,
    bdtopoBuildingCost: expandCoarseToDense(bdtopoBuildingCost),
    bdtopoVegetationCost: expandCoarseToDense(bdtopoVegetationCost),
    parkingExclusion: expandCoarseToDense(parkingExclusion),
    bdtopoHardCost: expandCoarseToDense(bdtopoHardCost),
    chosenPlateau: chosen,
  });
  const sidewalkBoundaryCandidateScore = downsampleDenseToCoarseMax(sidewalkCandidate.curve);
  scores.sidewalkBoundaryCandidateScore.splice(
    0,
    scores.sidewalkBoundaryCandidateScore.length,
    ...sidewalkBoundaryCandidateScore,
  );
  if (sidewalkCandidate.note) notes.push(sidewalkCandidate.note);
  if (sidewalkCandidate.reason) reasonCodes.push(sidewalkCandidate.reason);

  // Option A: trim the chosen plateau to detected kerb edges (sidewalk start).
  // Only acts when a candidate sits strictly INSIDE the plateau, and refuses
  // the trim if it would shrink the road below SIDEWALK_TRIM_MIN_WIDTH_M.
  const SIDEWALK_TRIM_MIN_WIDTH_M = 2;
  const SIDEWALK_TRIM_MIN_SHRINK_M = 0.10;
  let trimStartM = chosen.startM;
  let trimEndM = chosen.endM;
  if (
    sidewalkCandidate.leftOffsetM !== null
    && sidewalkCandidate.leftOffsetM > chosen.startM + SIDEWALK_TRIM_MIN_SHRINK_M
    && sidewalkCandidate.leftOffsetM < chosen.endM
  ) {
    trimStartM = sidewalkCandidate.leftOffsetM;
  }
  if (
    sidewalkCandidate.rightOffsetM !== null
    && sidewalkCandidate.rightOffsetM < chosen.endM - SIDEWALK_TRIM_MIN_SHRINK_M
    && sidewalkCandidate.rightOffsetM > chosen.startM
  ) {
    trimEndM = sidewalkCandidate.rightOffsetM;
  }
  if (
    (trimStartM !== chosen.startM || trimEndM !== chosen.endM)
    && trimEndM - trimStartM >= SIDEWALK_TRIM_MIN_WIDTH_M
  ) {
    notes.push(
      `sidewalk_kerb_trim:L${trimStartM.toFixed(2)}R${trimEndM.toFixed(2)}`
        + `(was L${chosen.startM.toFixed(2)}R${chosen.endM.toFixed(2)})`,
    );
    reasonCodes.push('sidewalk_kerb_trim');
    chosen = {
      startM: trimStartM,
      endM: trimEndM,
      widthM: trimEndM - trimStartM,
      meanScore: chosen.meanScore,
    };
  }

  const gateResult = applyStudyRegionGates({
    studyPixelSkipped,
    studySkippedPerOffset,
    coverageProfile,
    nSamplesPerLine,
    offsetsM,
    chosen,
    bdtopoBuildingCost,
    bdtopoVegetationCost,
    parkingExclusion,
    bdtopoHardCost,
  });
  notes.push(
    `study_skip_global:${(gateResult.metrics.skipFracGlobal * 100).toFixed(0)}%`
    + `;plateau:${(gateResult.metrics.skipFracPlateau * 100).toFixed(0)}%`
    + `;cov_plateau:${(gateResult.metrics.meanCoveragePlateau * 100).toFixed(0)}%`,
  );
  if (gateResult.blocked) {
    reasonCodes.push(...gateResult.reasonCodes);
    notes.push(`study_region_gate:blocked:${gateResult.reasonCodes.join(',')}`);
    return {
      tileIndex,
      widthM: null,
      confidence: 0,
      leftPerpM: null,
      rightPerpM: null,
      reasonCodes,
      masks,
      scores,
      plateaux,
      asphaltModel,
      roadColour,
      threshold,
      sampleCount,
      notes,
      plateauVegFrac: 0,
      durationMs: Math.round(performance.now() - t0),
      deltaToGtM: null,
      weight: coverageProfile.reduce((a, b) => a + b, 0) / Math.max(1, coverageProfile.length),
    };
  }
  reasonCodes.push(...gateResult.reasonCodes);

  const rawLeftM = Math.round(chosen.startM * 100) / 100;
  const rawRightM = Math.round(chosen.endM * 100) / 100;
  const rawWidthM = rawRightM - rawLeftM;

  let confidence = 0;
  if (chosen.meanScore > 0.82) confidence += 0.4;
  else if (chosen.meanScore > 0.75) confidence += 0.25;
  if (rawWidthM >= 3 && rawWidthM <= 14) confidence += 0.3;

  const centerK = offsetsM.findIndex((o) => o >= 0);
  if (centerK >= 0 && hardExclusion[centerK]! > 0) {
    reasonCodes.push('hard_exclusion_lateral');
    if (bdtopoBuildingCost[centerK]! > 0 || bdtopoVegetationCost[centerK]! > 0) {
      reasonCodes.push('hard_exclusion_bdtopo');
    }
    if (parkingExclusion[centerK]! > 0) reasonCodes.push('hard_exclusion_vehicle');
  }

  const tileWeight =
    coverageProfile.reduce((a, b) => a + b, 0) / Math.max(1, coverageProfile.length);
  if (tileWeight < MIN_COVERAGE) {
    reasonCodes.push('tile_low_coverage');
    confidence *= 0.5;
  }

  confidence = Math.max(0, Math.min(1, confidence));

  const plateauVegFrac = 0;

  if (sampleCount < 30) notes.push('few_samples');
  if (rawWidthM < 3) {
    notes.push('too_narrow');
    reasonCodes.push('too_narrow');
  }
  if (rawWidthM > 14) {
    notes.push('too_wide');
    reasonCodes.push('too_wide');
  }
  const flatPlateau = assessFlatSaturatedPlateau({
    offsetsM,
    profile,
    plateau: chosen,
  });
  if (flatPlateau.unsafe) {
    reasonCodes.push(...flatPlateau.reasonCodes);
    notes.push(
      `flat_saturated_plateau:mean=${flatPlateau.meanScore.toFixed(2)}`
      + `;grad=${flatPlateau.maxGradientPerM.toFixed(2)}`,
    );
    confidence = Math.min(confidence, 0.15);
  }

  return {
    tileIndex,
    widthM: Math.round(rawWidthM * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    leftPerpM: rawLeftM,
    rightPerpM: rawRightM,
    reasonCodes,
    masks,
    scores,
    plateaux,
    asphaltModel,
    roadColour,
    threshold,
    sampleCount,
    notes,
    plateauVegFrac,
    durationMs: Math.round(performance.now() - t0),
    deltaToGtM:
      gtWidthM !== null ? Math.round((rawWidthM - gtWidthM) * 100) / 100 : null,
    weight: tileWeight,
  };
}
