import {
  asphaltScanHalfM,
  isRoadPixel,
  isRoadPixelModel,
  isVegetationPixel,
  sampleRGB,
} from './color-utils.js';
import { rebridgeProfileScores } from './canopy-bridge.js';
import { CAR_KERB_OFFSET_M } from './car-zone.js';
import type { CarZone } from './car-zone.js';
import { buildVehicleMask, maskFractionAlongScan } from './masks.js';
import type { AsphaltModel } from './types.js';
import type { ProfileResultView } from './types.js';
import type { RoadAxis } from './geometry.js';
import { YOLO_MIN_CONF, type YoloBbox } from './yolo.js';
import {
  classifyYoloParking,
  geometryToCarZone,
  PARKING_ROAD_MARGIN_M,
  parkingClassificationToDebug,
  parkedYoloBboxes,
  type ParkingClassification,
} from './parking-classify.js';

export const YOLO_CAR_ZONE_MIN_CONF = YOLO_MIN_CONF;

const ROAD_SCAN_SAMPLE_STEP_PX = 3;
const STRICT_ROAD_ANCHOR_T = 0.35;
const MIN_ROAD_SCAN_COVERAGE = 0.4;

/** YOLO boxes used to mask vehicle pixels from asphalt scoring (parked + circulating). */
export function yoloCarBboxesForMask(
  bboxes: readonly YoloBbox[],
  conf = YOLO_CAR_ZONE_MIN_CONF,
): YoloBbox[] {
  return bboxes.filter(b => b.conf >= conf);
}

export interface YoloClampContext {
  readonly rgb: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly bdtopoWidthM?: number | null;
  readonly bdtopoParkingAt?: import('./parking-classify.js').ClassifyYoloParkingOpts['bdtopoParkingAt'];
}

export function yoloBboxesToCarZones(
  bboxes: YoloBbox[],
  roadAxis: RoadAxis,
  pxPerM: number,
  conf = YOLO_CAR_ZONE_MIN_CONF,
  classifications?: readonly ParkingClassification[],
): CarZone[] {
  const classList = classifications
    ? classifications.filter(c => c.status === 'parked')
    : classifyYoloParking(bboxes, roadAxis, pxPerM, conf).filter(c => c.status === 'parked');

  const zones: CarZone[] = [];
  for (const c of classList) {
    zones.push(geometryToCarZone(c.geometry, [c.reason]));
  }
  return zones;
}

/** True when lateral offset s (m, road-axis perp) lies inside any YOLO car band. */
export function lateralOffsetInCarZone(sM: number, zones: readonly CarZone[]): boolean {
  for (const z of zones) {
    const lo = Math.min(z.innerEdgeM, z.outerEdgeM);
    const hi = Math.max(z.innerEdgeM, z.outerEdgeM);
    if (sM >= lo && sM <= hi) return true;
  }
  return false;
}

/** Parked vehicles only — for vehicle mask / parkingExclusion (circulating ignored). */
export interface ParkedVehicleFilterContext {
  readonly rgb?: Uint8ClampedArray;
  readonly width?: number;
  readonly height?: number;
  readonly asphaltModel?: AsphaltModel;
  readonly bdtopoWidthM?: number | null;
  readonly bdtopoParkingAt?: import('./parking-classify.js').ClassifyYoloParkingOpts['bdtopoParkingAt'];
}

export function classifyAndFilterParkedBboxes(
  bboxes: readonly YoloBbox[],
  roadAxis: RoadAxis,
  pxPerM: number,
  conf: number,
  ctx: ParkedVehicleFilterContext = {},
): { readonly classifications: ParkingClassification[]; readonly parkedBboxes: YoloBbox[] } {
  const classifications = classifyYoloParking(bboxes, roadAxis, pxPerM, conf, {
    rgb: ctx.rgb,
    width: ctx.width,
    height: ctx.height,
    asphaltModel: ctx.asphaltModel,
    bdtopoWidthM: ctx.bdtopoWidthM,
    bdtopoParkingAt: ctx.bdtopoParkingAt,
  });
  return { classifications, parkedBboxes: parkedYoloBboxes(classifications) };
}

function plateauEdgeForSide(side: 'left' | 'right', plateauStartM: number, plateauEndM: number): number {
  return side === 'right' ? plateauEndM : plateauStartM;
}

/**
 * Clamp target at vehicle inner edge (first occupied lateral metre).
 * When plateau road edge is within {@link PARKING_ROAD_MARGIN_M} of parking, include marginal asphalt in width.
 */
export function parkedClampTargetM(
  side: 'left' | 'right',
  innerEdgeM: number,
  plateauEdgeM: number,
): number {
  const base = side === 'right' ? innerEdgeM - CAR_KERB_OFFSET_M : innerEdgeM + CAR_KERB_OFFSET_M;
  const gap =
    side === 'right' ? innerEdgeM - plateauEdgeM : plateauEdgeM - innerEdgeM;
  if (gap > 0 && gap < PARKING_ROAD_MARGIN_M) {
    return base;
  }
  return base;
}

/** Parked band overlaps the pre-parking plateau span (kerb cars may extend outside plateau edges). */
export function carZoneIntersectsPlateau(
  zone: CarZone,
  plateauStartM: number,
  plateauEndM: number,
): boolean {
  const lo = Math.min(zone.innerEdgeM, zone.outerEdgeM);
  const hi = Math.max(zone.innerEdgeM, zone.outerEdgeM);
  return hi > plateauStartM && lo < plateauEndM;
}

function parkingGapToPlateauEdge(
  side: 'left' | 'right',
  innerEdgeM: number,
  plateauStartM: number,
  plateauEndM: number,
): number {
  const plateauEdge = plateauEdgeForSide(side, plateauStartM, plateauEndM);
  return side === 'right' ? innerEdgeM - plateauEdge : plateauEdge - innerEdgeM;
}

export function carZoneEligibleForParkedBarrier(
  zone: CarZone,
  plateauStartM: number,
  plateauEndM: number,
): boolean {
  if (carZoneIntersectsPlateau(zone, plateauStartM, plateauEndM)) return true;
  const gap = parkingGapToPlateauEdge(zone.side, zone.innerEdgeM, plateauStartM, plateauEndM);
  return gap > 0 && gap < PARKING_ROAD_MARGIN_M;
}

const PROFILE_VEHICLE_SAMPLE_STEP_PX = ROAD_SCAN_SAMPLE_STEP_PX;

export interface VehicleRoadRescoreOpts {
  readonly rgb: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly roadAxis: RoadAxis;
  readonly pxPerM: number;
  readonly asphaltModel: AsphaltModel;
}

/**
 * Re-score lateral roadMatch / profile after YOLO, skipping pixels inside any car OBB.
 * Circulating vehicles must not tint asphalt scores; parked cars are masked before parking exclusion.
 */
export function refreshRoadScoresExcludingVehicles(
  raw: ProfileResultView,
  bboxes: readonly YoloBbox[],
  opts: VehicleRoadRescoreOpts,
): ProfileResultView {
  const carBboxes = yoloCarBboxesForMask(bboxes);
  if (carBboxes.length === 0) return raw;

  const vehicleMask = buildVehicleMask(opts.width, opts.height, carBboxes, YOLO_CAR_ZONE_MIN_CONF);
  const scanHalfM = asphaltScanHalfM(opts.roadAxis);
  const scanStepM = ROAD_SCAN_SAMPLE_STEP_PX / opts.pxPerM;
  const nSamplesPerLine = Math.max(1, Math.floor((2 * scanHalfM) / scanStepM) + 1);
  const { rgb, width: W, height: H, pxPerM, roadAxis, asphaltModel } = opts;
  const maskData = vehicleMask.data;

  const profile = [...raw.profile];
  const roadMatchProfile = [...raw.roadMatchProfile];
  const coverageProfile = [...raw.coverageProfile];
  let rescored = 0;

  for (let k = 0; k < raw.offsetsM.length; k++) {
    if ((raw.bdtopoBuildingCost[k] ?? 0) > 0 || (raw.bdtopoVegetationCost[k] ?? 0) > 0) {
      continue;
    }
    if ((raw.parkingExclusion[k] ?? 0) > 0) continue;

    const sM = raw.offsetsM[k]!;
    let total = 0;
    let matches = 0;
    let strictMatches = 0;

    for (let j = 0; j < nSamplesPerLine; j++) {
      const tM = -scanHalfM + j * scanStepM;
      const ax = roadAxis.axisAt(tM);
      const x = Math.round(ax.cx + sM * pxPerM * ax.perpX);
      const y = Math.round(ax.cy + sM * pxPerM * ax.perpY);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (maskData[y * W + x]!) continue;
      const c = sampleRGB(rgb, W, H, x, y);
      if (!c) continue;
      if (isVegetationPixel(c)) continue;
      total++;
      if (isRoadPixelModel(c, asphaltModel, { allowBrightAsphalt: false })) strictMatches++;
      if (isRoadPixel(c, asphaltModel)) matches++;
    }

    const coverage = total / nSamplesPerLine;
    const strictRoadMatch = total > 0 ? strictMatches / total : 0;
    const relaxedRoadMatch = total > 0 ? matches / total : 0;
    const roadMatch =
      strictRoadMatch >= STRICT_ROAD_ANCHOR_T ? relaxedRoadMatch : strictRoadMatch;

    if (
      Math.abs((raw.roadMatchProfile[k] ?? 0) - roadMatch) > 0.01 ||
      Math.abs((raw.coverageProfile[k] ?? 0) - coverage) > 0.01
    ) {
      rescored++;
    }
    roadMatchProfile[k] = roadMatch;
    coverageProfile[k] = coverage;
    if (total < MIN_ROAD_SCAN_COVERAGE * nSamplesPerLine) {
      profile[k] = 0;
    } else if ((raw.bdtopoHardCost[k] ?? 0) > 0) {
      profile[k] = 0;
    } else {
      profile[k] = roadMatch;
    }
  }

  const notes =
    rescored > 0 ? [...raw.notes, `yolo_vehicle_pixels_rescored:${rescored}`] : [...raw.notes];

  return { ...raw, profile, roadMatchProfile, coverageProfile, notes };
}

const PLATEAU_ENTER_T = 0.75;

function withCanopyBridge(profile: ProfileResultView): ProfileResultView {
  const { profile: bridged, bridgedCount } = rebridgeProfileScores(
    profile.profile,
    profile.bdtopoCanopyCost,
    profile.bdtopoHardCost,
    PLATEAU_ENTER_T,
  );
  const notes =
    bridgedCount > 0
      ? [...profile.notes, `canopy_bridged_post_patch:${bridgedCount}`]
      : profile.notes;
  return { ...profile, profile: bridged, notes };
}

export interface ParkedProfilePatchOpts {
  readonly parkedBboxes: readonly YoloBbox[];
  readonly roadAxis: RoadAxis;
  readonly pxPerM: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Sync lateral profile with parked vehicles (analyze pre-parking path).
 * Uses rotated OBB mask hits along each scan — not the full axis-aligned CarZone band
 * (avoids zeroing shadow asphalt beside a parked car, e.g. Paris SO 1).
 */
export function applyParkedVehicleScoresToProfile(
  raw: ProfileResultView,
  carZones: readonly CarZone[],
  maskOpts?: ParkedProfilePatchOpts,
): ProfileResultView {
  if (carZones.length === 0) return raw;

  const vehicleMask =
    maskOpts && maskOpts.parkedBboxes.length > 0
      ? buildVehicleMask(maskOpts.width, maskOpts.height, maskOpts.parkedBboxes)
      : null;
  const scanHalfM = maskOpts ? asphaltScanHalfM(maskOpts.roadAxis) : 12;

  const parkingExclusion = [...raw.parkingExclusion];
  const profile = [...raw.profile];
  const bdtopoHardCost = [...raw.bdtopoHardCost];
  const roadMatchProfile = [...raw.roadMatchProfile];
  let parkedOffsets = 0;

  for (let i = 0; i < raw.offsetsM.length; i++) {
    const s = raw.offsetsM[i]!;
    let parkingHit = lateralOffsetInCarZone(s, carZones);
    if (vehicleMask && maskOpts) {
      const vehicleFrac = maskFractionAlongScan(
        vehicleMask,
        maskOpts.width,
        maskOpts.roadAxis,
        maskOpts.pxPerM,
        s,
        scanHalfM,
        PROFILE_VEHICLE_SAMPLE_STEP_PX,
      );
      parkingHit = vehicleFrac > 0;
    }
    if (!parkingHit) continue;
    parkingExclusion[i] = 1;
    profile[i] = 0;
    roadMatchProfile[i] = 0;
    bdtopoHardCost[i] = 1;
    parkedOffsets++;
  }

  const notes = [...raw.notes];
  if (parkedOffsets > 0) {
    notes.push(`parking_profile_excluded:${parkedOffsets}`);
    if (vehicleMask) notes.push('parking_profile_obb_mask');
  }

  return {
    ...raw,
    parkingExclusion,
    profile,
    roadMatchProfile,
    bdtopoHardCost,
    carZones: [...carZones],
    notes,
  };
}

function isStrongSingleParkingZone(zone: CarZone): boolean {
  return zone.notes.some((note) =>
    note === 'parking_bdtopo'
    || note === 'large_vehicle_bdtopo_parking'
    || note === 'parking_car_truck_pair',
  );
}

function median(values: readonly number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function parkedBarrierZone(side: 'left' | 'right', zones: readonly CarZone[]): CarZone | null {
  if (zones.length === 0) return null;
  if (zones.length === 1) {
    const only = zones[0]!;
    return isStrongSingleParkingZone(only) ? only : null;
  }

  const innerEdgeM = median(zones.map((zone) => zone.innerEdgeM));
  const reference = zones.slice().sort((a, b) =>
    Math.abs(a.innerEdgeM - innerEdgeM) - Math.abs(b.innerEdgeM - innerEdgeM),
  )[0]!;
  return {
    ...reference,
    side,
    innerEdgeM: Math.round(innerEdgeM * 100) / 100,
    notes: [...reference.notes, `parking_barrier_median:n=${zones.length}`],
  };
}

export function applyYoloClampingToProfile(
  raw: ProfileResultView,
  bboxes: YoloBbox[],
  roadAxis: RoadAxis,
  pxPerM: number,
  gtWidthM: number | null,
  ctx?: YoloClampContext,
): ProfileResultView {
  if (bboxes.length === 0) {
    return { ...raw, yoloBboxes: bboxes, parkedYoloBboxes: [], yoloClassifications: [] };
  }

  const { classifications, parkedBboxes } = classifyAndFilterParkedBboxes(
    bboxes,
    roadAxis,
    pxPerM,
    YOLO_CAR_ZONE_MIN_CONF,
    {
      rgb: ctx?.rgb,
      width: ctx?.width,
      height: ctx?.height,
      asphaltModel: raw.asphaltModel,
      bdtopoWidthM: ctx?.bdtopoWidthM,
      bdtopoParkingAt: ctx?.bdtopoParkingAt,
    },
  );

  const carZones = yoloBboxesToCarZones(bboxes, roadAxis, pxPerM, YOLO_CAR_ZONE_MIN_CONF, classifications);
  const yoloClassifications = classifications.map(parkingClassificationToDebug);
  let notes = [
    ...raw.notes,
    `yolo_classified:${classifications.length}`,
    `yolo_parked:${parkedBboxes.length}`,
    `yolo_circulating:${classifications.length - parkedBboxes.length}`,
  ];

  for (const c of classifications) {
    if (c.status === 'circulating') {
      notes.push(`yolo_circ:${c.reason}(${c.geometry.side})`);
    }
  }

  let working = raw;
  if (ctx?.rgb && yoloCarBboxesForMask(bboxes).length > 0) {
    const notesBefore = raw.notes.length;
    working = refreshRoadScoresExcludingVehicles(raw, bboxes, {
      rgb: ctx.rgb,
      width: ctx.width,
      height: ctx.height,
      roadAxis,
      pxPerM,
      asphaltModel: raw.asphaltModel,
    });
    if (working.notes.length > notesBefore) {
      notes = [...notes, ...working.notes.slice(notesBefore)];
    }
    working = withCanopyBridge(working);
    if (working.notes.length > notes.length) {
      notes = [...notes, ...working.notes.slice(notes.length)];
    }
  }

  if (carZones.length === 0) {
    return {
      ...working,
      carZones: [],
      yoloBboxes: bboxes,
      parkedYoloBboxes: parkedBboxes,
      yoloClassifications,
      notes,
    };
  }

  const scored = applyParkedVehicleScoresToProfile(
    working,
    carZones,
    ctx && parkedBboxes.length > 0
      ? {
          parkedBboxes,
          roadAxis,
          pxPerM,
          width: ctx.width,
          height: ctx.height,
        }
      : undefined,
  );

  if (scored.leftPerpM === null || scored.rightPerpM === null) {
    return { ...scored, notes, yoloBboxes: bboxes, parkedYoloBboxes: parkedBboxes, yoloClassifications };
  }

  const plateauStartM = scored.leftPerpM;
  const plateauEndM = scored.rightPerpM;
  const clampZones: CarZone[] = [];

  for (const side of ['left', 'right'] as const) {
    const plateauEdge = plateauEdgeForSide(side, plateauStartM, plateauEndM);
    const sideCars = carZones.filter(
      z => z.side === side && carZoneEligibleForParkedBarrier(z, plateauStartM, plateauEndM),
    );
    if (sideCars.length === 0) {
      notes.push(`car_clamp_skip_${side}:no_overlap`);
      continue;
    }

    const target = parkedBarrierZone(side, sideCars);
    if (!target) {
      notes.push(`car_clamp_skip_${side}:weak_single`);
      continue;
    }

    const gap = parkingGapToPlateauEdge(side, target.innerEdgeM, plateauStartM, plateauEndM);
    if (gap > 0 && gap < PARKING_ROAD_MARGIN_M) {
      notes.push(`parking_margin_include:${side}(gap=${gap.toFixed(2)}m)`);
    }

    clampZones.push(target);
    for (const targetNote of target.notes) {
      if (targetNote.startsWith('parking_barrier_')) notes.push(targetNote);
    }
    notes.push(
      `car_kerb_${side}:inner=${target.innerEdgeM.toFixed(2)}[${target.notes[0] ?? 'parked'}]`,
    );
  }

  let leftM = plateauStartM;
  let rightM = plateauEndM;
  for (const zone of clampZones) {
    const plateauEdge = plateauEdgeForSide(zone.side, plateauStartM, plateauEndM);
    const clampM = parkedClampTargetM(zone.side, zone.innerEdgeM, plateauEdge);
    const gap = parkingGapToPlateauEdge(zone.side, zone.innerEdgeM, plateauStartM, plateauEndM);
    const includeMargin = gap > 0 && gap < PARKING_ROAD_MARGIN_M;
    if (zone.side === 'right' && clampM < rightM) {
      rightM = clampM;
      notes.push(`car_clamp_R:${zone.innerEdgeM.toFixed(2)}m→${clampM.toFixed(2)}`);
    } else if (zone.side === 'right' && includeMargin && clampM > rightM) {
      rightM = clampM;
      notes.push(`car_margin_R:${zone.innerEdgeM.toFixed(2)}m→${clampM.toFixed(2)}`);
    } else if (zone.side === 'left' && clampM > leftM) {
      leftM = clampM;
      notes.push(`car_clamp_L:${zone.innerEdgeM.toFixed(2)}m→${clampM.toFixed(2)}`);
    } else if (zone.side === 'left' && includeMargin && clampM < leftM) {
      leftM = clampM;
      notes.push(`car_margin_L:${zone.innerEdgeM.toFixed(2)}m→${clampM.toFixed(2)}`);
    }
  }

  const widthM = rightM - leftM;
  if (!Number.isFinite(widthM) || widthM <= 0) {
    return {
      ...scored,
      notes: [...notes, `invalid_yolo_clamp_width:${widthM.toFixed(2)}`],
      parkedYoloBboxes: parkedBboxes,
      yoloClassifications,
    };
  }

  let vegSum = 0;
  let vegCnt = 0;
  for (let i = 0; i < scored.offsetsM.length; i++) {
    const o = scored.offsetsM[i]!;
    if (o >= leftM && o <= rightM) {
      vegSum += scored.vegProfile[i]!;
      vegCnt++;
    }
  }
  const plateauVegFrac = vegCnt > 0 ? Math.round((vegSum / vegCnt) * 1000) / 1000 : 0;

  return {
    ...scored,
    widthM: Math.round(widthM * 100) / 100,
    leftPerpM: Math.round(leftM * 100) / 100,
    rightPerpM: Math.round(rightM * 100) / 100,
    deltaToGtM: gtWidthM !== null ? Math.round((widthM - gtWidthM) * 100) / 100 : null,
    carZones,
    yoloBboxes: bboxes,
    parkedYoloBboxes: parkedBboxes,
    yoloClassifications,
    plateauVegFrac,
    notes,
  };
}
