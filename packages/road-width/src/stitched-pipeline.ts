/**
 * D10 pipeline on a single stitched canvas (3 IGN tiles composited).
 * YOLO boxes are expected in stitch pixel space.
 */

import type { AsphaltModel, MaskLayer, SpatialMaskSet } from './types.js';
import type { RoadAxis, SerializableRoadAxis, TileGeoContext } from './geometry.js';
import {
  getStitchedCanvasMetrics,
  isRoadAxisBuildingBlendEnabled,
  resolveStitchRoadAxis,
} from './geometry.js';
import {
  computeCorridorPixelBounds,
  corridorSignificantlySmallerThanCanvas,
} from './mask-corridor.js';
import {
  buildBdtopoBuildingMask,
  buildSpatialMasksWithTiming,
  buildVehicleMask,
  mergeBinaryMaskLayers,
} from './masks.js';
import type { SpatialMasksTimingMs } from './spatial-masks-timing.js';
import { buildAsphaltModel, asphaltScanHalfM } from './color-utils.js';
import type { CarZone } from './car-zone.js';
import type { YoloBbox } from './yolo.js';
import { makeBdtopoParkingAt } from './bdtopo-parking.js';
import {
  YOLO_CAR_ZONE_MIN_CONF,
  classifyAndFilterParkedBboxes,
  yoloBboxesToCarZones,
  yoloCarBboxesForMask,
} from './yolo-clamp.js';

export interface StitchedPipelineInput {
  readonly rgb: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly pxPerM: number;
  readonly bearingDeg: number;
  readonly gtWidthM: number | null;
  readonly tile: TileGeoContext;
  readonly yoloBboxes: readonly YoloBbox[];
  /** YOLO boxes used only to exclude vehicle pixels from asphalt reference sampling. */
  readonly asphaltReferenceYoloBboxes?: readonly YoloBbox[];
  /** Lateral crop half-width (m) — limits scan and mask corridor (D10v2). */
  readonly lateralHalfM?: number;
}

/** Same shape as TilePipelinePrep — reused by measureTileWidth (step 5). */
export interface StitchedPipelinePrep {
  readonly tileIndex: 0;
  readonly rgb: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly pxPerM: number;
  readonly bearingDeg: number;
  readonly gtWidthM: number | null;
  readonly roadAxis: RoadAxis;
  readonly roadAxisSerial: SerializableRoadAxis | null;
  readonly masks: SpatialMaskSet;
  readonly asphaltModel: AsphaltModel;
  readonly studyMask: MaskLayer;
  readonly bdtopoExclusionMask: MaskLayer;
  readonly carZones: readonly CarZone[];
  readonly pipelineReasonCodes: readonly string[];
  readonly lateralHalfM?: number;
}

/** Sequential D10 prep phases (ms). `lateralProfile` and `total` are set in measure-stitched. */
export interface D10CoreTimingMs {
  readonly axisBuildingForAxis: number;
  readonly spatialMasks: number;
  readonly spatialMasksDetail?: SpatialMasksTimingMs;
  readonly bdtopoExclusion: number;
  readonly asphaltModel: number;
  readonly yoloVehicleLayer: number;
  readonly studyMask: number;
  readonly lateralProfile: number;
  readonly total: number;
}

export interface StitchedPipelineOutput {
  readonly prep: StitchedPipelinePrep;
  /** Prep phases only — caller adds lateralProfile + total. */
  readonly prepTimingMs: Omit<D10CoreTimingMs, 'lateralProfile' | 'total'>;
}

function pointInYoloBbox(px: number, py: number, b: YoloBbox): boolean {
  const cos = Math.cos(-b.angle);
  const sin = Math.sin(-b.angle);
  const dx = px - b.x;
  const dy = py - b.y;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
}

export function yoloBboxesIntersectAsphaltReferenceSamples(input: {
  readonly yoloBboxes: readonly YoloBbox[];
  readonly width: number;
  readonly height: number;
  readonly pxPerM: number;
  readonly roadAxis: RoadAxis;
  readonly excludeMask?: Uint8Array;
}): YoloBbox[] {
  const candidateBoxes = yoloCarBboxesForMask(input.yoloBboxes);
  if (candidateBoxes.length === 0) return [];

  const scanHalfM = asphaltScanHalfM(input.roadAxis);
  const lateralHalfM = 1;
  const halfPerpPx = Math.round(lateralHalfM * input.pxPerM);
  const alongStepM = 2 / input.pxPerM;
  const polluting = new Set<YoloBbox>();

  for (let tM = -scanHalfM; tM <= scanHalfM + alongStepM * 0.001; tM += alongStepM) {
    const ax = input.roadAxis.axisAt(tM);
    for (let sPx = -halfPerpPx; sPx <= halfPerpPx; sPx += 3) {
      const sM = sPx / input.pxPerM;
      const x = Math.round(ax.cx + sM * input.pxPerM * ax.perpX);
      const y = Math.round(ax.cy + sM * input.pxPerM * ax.perpY);
      if (x < 0 || y < 0 || x >= input.width || y >= input.height) continue;
      if (input.excludeMask && input.excludeMask[y * input.width + x]! > 0) continue;
      for (const bbox of candidateBoxes) {
        if (pointInYoloBbox(x + 0.5, y + 0.5, bbox)) polluting.add(bbox);
      }
    }
  }

  return candidateBoxes.filter((bbox) => polluting.has(bbox));
}

function phaseNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function prepareStitchedPipeline(input: StitchedPipelineInput): StitchedPipelineOutput {
  const { rgb, width: W, height: H, pxPerM, bearingDeg, tile, yoloBboxes } = input;
  const reasonCodes: string[] = ['measurement_stitched_primary', 'axisSource:stitched'];
  let phaseStart = phaseNowMs();
  const prepTimingMs: {
    axisBuildingForAxis: number;
    spatialMasks: number;
    spatialMasksDetail?: SpatialMasksTimingMs;
    bdtopoExclusion: number;
    asphaltModel: number;
    yoloVehicleLayer: number;
    studyMask: number;
  } = {
    axisBuildingForAxis: 0,
    spatialMasks: 0,
    bdtopoExclusion: 0,
    asphaltModel: 0,
    yoloVehicleLayer: 0,
    studyMask: 0,
  };

  type PrepLapKey = Exclude<keyof typeof prepTimingMs, 'spatialMasksDetail'>;
  const lap = (key: PrepLapKey): void => {
    const now = phaseNowMs();
    prepTimingMs[key] = Math.round(now - phaseStart);
    phaseStart = now;
  };

  reasonCodes.push('pipeline_step1_yolo');
  if (yoloBboxes.length > 0) {
    reasonCodes.push(`pipeline_yolo_detections:${yoloBboxes.length}`);
  }

  const stitchMetrics = getStitchedCanvasMetrics(tile);
  const hasBuildings = (tile.buildingPolygons?.length ?? 0) > 0;
  const axisBlendOn = isRoadAxisBuildingBlendEnabled();
  const buildingMaskForAxis =
    axisBlendOn && hasBuildings
      ? buildBdtopoBuildingMask(W, H, tile, stitchMetrics, pxPerM)
      : null;

  const { axis: roadAxis, corridorApplied, roadAxisSerial } = resolveStitchRoadAxis(
    W,
    H,
    pxPerM,
    bearingDeg,
    tile,
    undefined,
    buildingMaskForAxis,
  );
  if (corridorApplied) {
    reasonCodes.push('axis_bdtopo_building_blend');
  }
  if (roadAxisSerial) {
    if (roadAxisSerial.kind === 'polyline') {
      reasonCodes.push(`axis_kind:polyline:pts=${roadAxisSerial.points.length}`);
    } else if (roadAxisSerial.kind === 'bearing-fallback') {
      reasonCodes.push('axis_kind:bearing-fallback');
    } else {
      reasonCodes.push(`axis_kind:${(roadAxisSerial as { kind: string }).kind}`);
    }
  } else if (corridorApplied) {
    reasonCodes.push('axis_kind:building-blend');
  }
  lap('axisBuildingForAxis');

  const corridorBounds = computeCorridorPixelBounds(roadAxis, W, H, pxPerM, {
    lateralHalfM: input.lateralHalfM,
  });
  if (corridorSignificantlySmallerThanCanvas(corridorBounds, W, H)) {
    reasonCodes.push('mask_corridor_roi');
  }

  const spatialBuilt = buildSpatialMasksWithTiming(rgb, W, H, roadAxis, pxPerM, [], {
    tile,
    tileMetrics: stitchMetrics,
    prebuiltBuildingMask: buildingMaskForAxis,
    corridorBounds,
    roadAxisSerial: roadAxisSerial ?? null,
  });
  const masksBase = spatialBuilt.masks;
  reasonCodes.push('pipeline_step2_bdtopo_exclusion');
  reasonCodes.push(...spatialBuilt.reasonCodes);
  prepTimingMs.spatialMasks = spatialBuilt.spatialMasksTiming.wallMs;
  prepTimingMs.spatialMasksDetail = spatialBuilt.spatialMasksTiming;
  phaseStart = phaseNowMs();

  const bdtopoExclusionMask = mergeBinaryMaskLayers(
    W,
    H,
    'bdtopoExclusion',
    [masksBase.buildingMask, masksBase.vegetationMassMask],
  );
  lap('bdtopoExclusion');

  const asphaltReferenceCarBboxes = yoloCarBboxesForMask(
    input.asphaltReferenceYoloBboxes ?? yoloBboxes,
  );
  const asphaltReferenceVehicleMask =
    asphaltReferenceCarBboxes.length > 0
      ? buildVehicleMask(W, H, asphaltReferenceCarBboxes, YOLO_CAR_ZONE_MIN_CONF)
      : masksBase.vehicleMask;

  const asphaltReferenceExclusionMask =
    asphaltReferenceCarBboxes.length > 0
      ? mergeBinaryMaskLayers(
          W,
          H,
          'bdtopoExclusion',
          [bdtopoExclusionMask, asphaltReferenceVehicleMask],
        )
      : bdtopoExclusionMask;
  if (asphaltReferenceCarBboxes.length > 0) {
    reasonCodes.push('pipeline_asphalt_reference_vehicle_masked');
  }

  const asphaltModel = buildAsphaltModel(
    rgb,
    W,
    H,
    pxPerM,
    roadAxis,
    asphaltScanHalfM(roadAxis),
    { excludeMask: asphaltReferenceExclusionMask.data },
  );
  reasonCodes.push('pipeline_step3_asphalt_reference');
  if (asphaltModel.sampleCount < 30) {
    reasonCodes.push('pipeline_asphalt_few_samples');
  }
  lap('asphaltModel');

  const bdtopoParkingAt = makeBdtopoParkingAt(tile, stitchMetrics, pxPerM, tile.parkingPolygons);
  const { classifications, parkedBboxes } = classifyAndFilterParkedBboxes(
    yoloBboxes,
    roadAxis,
    pxPerM,
    YOLO_CAR_ZONE_MIN_CONF,
    { rgb, width: W, height: H, asphaltModel, bdtopoParkingAt },
  );
  if (tile.parkingPolygons?.length) {
    reasonCodes.push(`pipeline_bdtopo_parking_polys:${tile.parkingPolygons.length}`);
  }
  const carBboxesForMask = yoloCarBboxesForMask(yoloBboxes);
  const vehicleMask =
    carBboxesForMask.length > 0
      ? buildVehicleMask(W, H, carBboxesForMask, YOLO_CAR_ZONE_MIN_CONF)
      : masksBase.vehicleMask;
  if (carBboxesForMask.length > 0) {
    reasonCodes.push(`pipeline_vehicle_mask_yolo:${carBboxesForMask.length}`);
  }
  const masks = { ...masksBase, vehicleMask };

  const carZones = yoloBboxesToCarZones(
    [...yoloBboxes],
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
  lap('yoloVehicleLayer');

  const studyMask = mergeBinaryMaskLayers(
    W,
    H,
    'studyRegion',
    [bdtopoExclusionMask, masks.vehicleMask],
    { invert: true },
  );
  reasonCodes.push('pipeline_step5_study_region');
  lap('studyMask');

  return {
    prep: {
      tileIndex: 0,
      rgb,
      width: W,
      height: H,
      pxPerM,
      bearingDeg,
      gtWidthM: input.gtWidthM,
      roadAxis,
      roadAxisSerial: roadAxisSerial ?? null,
      masks,
      asphaltModel,
      studyMask,
      bdtopoExclusionMask,
      carZones,
      pipelineReasonCodes: reasonCodes,
      lateralHalfM: input.lateralHalfM,
    },
    prepTimingMs,
  };
}
