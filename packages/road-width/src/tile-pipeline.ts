/**
 * D10 tile measurement pipeline (strict order).
 *
 * 1. Satellite tiles + YOLO detections (stitch → per-tile boxes).
 * 2. BDTOPO hard exclusion (building + lateral vegetation). Canopy mask is separate (confidence only).
 * 3. Asphalt reference colour model sampled only outside BDTOPO exclusion.
 * 4. Vehicle exclusion mask from YOLO.
 * 5. Lateral scoring runs only on the study region (remaining pixels).
 */

import type { AsphaltModel, MaskLayer, SpatialMaskSet } from './types.js';
import type { RoadAxis, TileGeoContext } from './geometry.js';
import {
  getSingleTileMetrics,
  isRoadAxisBuildingBlendEnabled,
  resolveStitchRoadAxis,
} from './geometry.js';
import {
  computeCorridorPixelBounds,
  corridorSignificantlySmallerThanCanvas,
} from './mask-corridor.js';
import {
  buildBdtopoBuildingMask,
  buildSpatialMasks,
  mergeBinaryMaskLayers,
} from './masks.js';
import { buildAsphaltModel, asphaltScanHalfM } from './color-utils.js';
import type { CarZone } from './car-zone.js';
import type { YoloBbox } from './yolo.js';
import { yoloBboxesInTileSpace } from './yolo.js';
import {
  YOLO_CAR_ZONE_MIN_CONF,
  classifyAndFilterParkedBboxes,
  yoloBboxesToCarZones,
  yoloCarBboxesForMask,
} from './yolo-clamp.js';
import { makeBdtopoParkingAt } from './bdtopo-parking.js';
import { buildVehicleMask } from './masks.js';

export interface TilePipelineInput {
  readonly tileIndex: 0 | 1 | 2;
  readonly rgb: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly pxPerM: number;
  readonly bearingDeg: number;
  readonly gtWidthM: number | null;
  readonly tile: TileGeoContext;
  /** YOLO boxes in stitch canvas space (step 1). */
  readonly yoloBboxes: readonly YoloBbox[];
}

/** Outputs of steps 1–4, consumed by lateral scoring (step 5). */
export interface TilePipelinePrep {
  readonly tileIndex: 0 | 1 | 2;
  readonly rgb: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly pxPerM: number;
  readonly bearingDeg: number;
  readonly gtWidthM: number | null;
  readonly roadAxis: RoadAxis;
  readonly masks: SpatialMaskSet;
  readonly asphaltModel: AsphaltModel;
  /** 255 = pixel eligible for scoring (not BDTOPO-excluded, not a vehicle). */
  readonly studyMask: MaskLayer;
  readonly bdtopoExclusionMask: MaskLayer;
  /** Lateral car bands from tile YOLO (step 4), used for profile parking exclusion. */
  readonly carZones: readonly CarZone[];
  readonly pipelineReasonCodes: readonly string[];
  /** Lateral scan half-width (m). Default 15 m in profile scoring. */
  readonly lateralHalfM?: number;
}

/**
 * Steps 1–4: YOLO → BDTOPO exclusion → asphalt reference → vehicle mask → study region.
 */
export function prepareTilePipeline(input: TilePipelineInput): TilePipelinePrep {
  const { tileIndex, rgb, width: W, height: H, pxPerM, bearingDeg, tile, yoloBboxes } = input;
  const reasonCodes: string[] = [];

  // Step 1 — YOLO (mapped from stitch to this tile)
  const tileYolo = yoloBboxesInTileSpace(yoloBboxes, tile, tileIndex);
  reasonCodes.push('pipeline_step1_yolo');
  if (tileYolo.length > 0) {
    reasonCodes.push(`pipeline_yolo_detections:${tileYolo.length}`);
  }

  const tileMetrics = getSingleTileMetrics(tile, tileIndex);
  const hasBuildings = (tile.buildingPolygons?.length ?? 0) > 0;
  const axisBlendOn = isRoadAxisBuildingBlendEnabled();
  const buildingMaskForAxis =
    axisBlendOn && hasBuildings
      ? buildBdtopoBuildingMask(W, H, tile, tileMetrics, pxPerM)
      : null;

  const { axis: roadAxis, corridorApplied } = resolveStitchRoadAxis(
    W,
    H,
    pxPerM,
    bearingDeg,
    tile,
    tileIndex,
    buildingMaskForAxis,
  );
  if (corridorApplied) {
    reasonCodes.push('axis_bdtopo_building_blend');
  }

  const corridorBounds = computeCorridorPixelBounds(roadAxis, W, H, pxPerM);
  if (corridorSignificantlySmallerThanCanvas(corridorBounds, W, H)) {
    reasonCodes.push('mask_corridor_roi');
  }

  // Step 2 — BDTOPO exclusion (buildings + vegetation); colour CC only if WFS empty
  const masksBase = buildSpatialMasks(rgb, W, H, roadAxis, pxPerM, [], {
    tile,
    tileIndex,
    tileMetrics,
    prebuiltBuildingMask: buildingMaskForAxis,
    corridorBounds,
  });
  reasonCodes.push('pipeline_step2_bdtopo_exclusion');
  reasonCodes.push(...masksBase.reasonCodes);

  // Hard exclude buildings + lateral veg only. Tree canopy (axis band) affects confidence, not score zeroing.
  const bdtopoExclusionMask = mergeBinaryMaskLayers(
    W,
    H,
    'bdtopoExclusion',
    [masksBase.buildingMask, masksBase.vegetationMassMask],
  );

  // Step 3 — Asphalt reference on axis corridor, excluding BDTOPO zones only
  const asphaltModel = buildAsphaltModel(
    rgb,
    W,
    H,
    pxPerM,
    roadAxis,
    asphaltScanHalfM(roadAxis),
    { excludeMask: bdtopoExclusionMask.data },
  );
  reasonCodes.push('pipeline_step3_asphalt_reference');
  if (asphaltModel.sampleCount < 30) {
    reasonCodes.push('pipeline_asphalt_few_samples');
  }

  const bdtopoParkingAt = makeBdtopoParkingAt(tile, tileMetrics, pxPerM, tile.parkingPolygons);
  const { classifications, parkedBboxes } = classifyAndFilterParkedBboxes(
    tileYolo,
    roadAxis,
    pxPerM,
    YOLO_CAR_ZONE_MIN_CONF,
    { rgb, width: W, height: H, asphaltModel, bdtopoParkingAt },
  );
  if (tile.parkingPolygons?.length) {
    reasonCodes.push(`pipeline_bdtopo_parking_polys:${tile.parkingPolygons.length}`);
  }
  const carBboxesForMask = yoloCarBboxesForMask(tileYolo);
  const vehicleMask =
    carBboxesForMask.length > 0
      ? buildVehicleMask(W, H, carBboxesForMask, YOLO_CAR_ZONE_MIN_CONF)
      : masksBase.vehicleMask;
  if (carBboxesForMask.length > 0) {
    reasonCodes.push(`pipeline_vehicle_mask_yolo:${carBboxesForMask.length}`);
  }
  const masks = { ...masksBase, vehicleMask };

  // Step 4 — Parked vehicles only (circulating excluded from profile parkingExclusion)
  const carZones = yoloBboxesToCarZones(
    tileYolo,
    roadAxis,
    pxPerM,
    YOLO_CAR_ZONE_MIN_CONF,
    classifications,
  );
  reasonCodes.push('pipeline_step4_vehicle_exclusion');
  if (parkedBboxes.length > 0) {
    reasonCodes.push(`pipeline_parked_vehicles:${parkedBboxes.length}`);
  }
  if (carZones.length > 0) {
    reasonCodes.push(`pipeline_car_zones:${carZones.length}`);
  }

  // Step 5 prep — study region = all pixels not BDTOPO-excluded and not vehicles
  const studyMask = mergeBinaryMaskLayers(
    W,
    H,
    'studyRegion',
    [bdtopoExclusionMask, masks.vehicleMask],
    { invert: true },
  );
  reasonCodes.push('pipeline_step5_study_region');

  return {
    tileIndex,
    rgb,
    width: W,
    height: H,
    pxPerM,
    bearingDeg,
    gtWidthM: input.gtWidthM,
    roadAxis,
    masks,
    asphaltModel,
    studyMask,
    bdtopoExclusionMask,
    carZones,
    pipelineReasonCodes: reasonCodes,
  };
}
