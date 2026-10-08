import type { AsphaltModel } from './types.js';
import type { YoloVehicleClassificationDebug } from './types.js';
import type { RoadAxis } from './geometry.js';
import { buildAsphaltModelNearAlongM, isRoadPixelModel, sampleRGB } from './color-utils.js';
import {
  SIDEWALK_REF_ALONG_HALF_M,
  SIDEWALK_REF_LATERAL_HALF_M,
} from './sidewalk-boundary-shadow.js';
import type { CarZone } from './car-zone.js';
import type { YoloBbox } from './yolo.js';
import { MIN_ROAD_GAP_BETWEEN_EXCLUSIONS_M } from './exclusion-gap.js';

/** Max edge-to-edge gap along road axis between two small vehicles on the same side → parked pair. */
export const PARKING_PAIR_GAP_M = 3.5;
/** @deprecated Use {@link alongGapM} + {@link PARKING_PAIR_GAP_M}; kept for docs. */
export const PARKING_PAIR_ALONG_M = 2;
export const PARKING_PROBE_ALONG_M = 2;
/** Marginal asphalt between plateau edge and parking counts as carriageway when narrower than this. */
export const PARKING_ROAD_MARGIN_M = MIN_ROAD_GAP_BETWEEN_EXCLUSIONS_M;
export const PARKING_PROBE_SCORE_T = 0.75;
/** Min local asphalt samples before falling back to the global D10 model. */
export const PARKING_PROBE_LOCAL_REF_MIN_SAMPLES = 10;
/**
 * Max |lateralM| from road axis for vehicle centre to count as in-lane on BDTOPO carriageway
 * (fraction of full BDTOPO width). Kerb / épis parking centres sit outside this band.
 */
export const BDTOPO_CARRIAGEWAY_CENTER_FRAC = 0.25;
export type ParkingStatus = 'parked' | 'circulating';

export interface BboxAxisGeometry {
  readonly bbox: YoloBbox;
  readonly side: 'left' | 'right';
  readonly alongM: number;
  readonly lateralM: number;
  readonly innerEdgeM: number;
  readonly outerEdgeM: number;
  readonly halfAlongM: number;
}

export interface ParkingClassification {
  readonly bbox: YoloBbox;
  readonly status: ParkingStatus;
  readonly reason: string;
  readonly geometry: BboxAxisGeometry;
}

export function parkingClassificationToDebug(
  c: ParkingClassification,
): YoloVehicleClassificationDebug {
  return {
    bbox: c.bbox,
    status: c.status,
    reason: c.reason,
    side: c.geometry.side,
    alongM: c.geometry.alongM,
    lateralM: c.geometry.lateralM,
    innerEdgeM: c.geometry.innerEdgeM,
    outerEdgeM: c.geometry.outerEdgeM,
    halfAlongM: c.geometry.halfAlongM,
  };
}

export interface ClassifyYoloParkingOpts {
  readonly rgb?: Uint8ClampedArray;
  readonly width?: number;
  readonly height?: number;
  readonly asphaltModel?: AsphaltModel;
  /** BDTOPO carriageway width (m) — solo vehicles centred on axis are not parked. */
  readonly bdtopoWidthM?: number | null;
  /** BDTOPO parking surface under bbox centre. */
  readonly bdtopoParkingAt?: (geom: BboxAxisGeometry) => boolean;
}

/**
 * True when an isolated vehicle sits on the BDTOPO carriageway (in-lane), not kerb parking.
 * Without BDTOPO width, falls back to OBB straddling the road axis.
 */
export function isVehicleOnBdtopoCarriageway(
  geom: BboxAxisGeometry,
  bdtopoWidthM: number | null | undefined,
): boolean {
  const inner = Math.min(geom.innerEdgeM, geom.outerEdgeM);
  const outer = Math.max(geom.innerEdgeM, geom.outerEdgeM);
  if (inner <= 0 && outer >= 0) {
    return true;
  }
  if (bdtopoWidthM != null && bdtopoWidthM > 0) {
    const maxCenterOffsetM = bdtopoWidthM * BDTOPO_CARRIAGEWAY_CENTER_FRAC;
    return Math.abs(geom.lateralM) <= maxCenterOffsetM;
  }
  return false;
}

export function pointInRotatedRect(px: number, py: number, b: YoloBbox): boolean {
  const cos = Math.cos(-b.angle);
  const sin = Math.sin(-b.angle);
  const dx = px - b.x;
  const dy = py - b.y;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
}

export function bboxAxisGeometry(
  b: YoloBbox,
  roadAxis: RoadAxis,
  pxPerM: number,
): BboxAxisGeometry {
  const ax0 = roadAxis.axisAt(0);
  const alongM =
    Math.round(
      ((b.x - ax0.cx) * ax0.tangentX + (b.y - ax0.cy) * ax0.tangentY) / pxPerM * 100,
    ) / 100;

  const ax = roadAxis.axisAt(alongM);
  const dx = b.x - ax.cx;
  const dy = b.y - ax.cy;
  const lateralM = Math.round(((dx * ax.perpX + dy * ax.perpY) / pxPerM) * 100) / 100;

  const roadPerpAngle = Math.atan2(ax.perpY, ax.perpX);
  const roadTanAngle = Math.atan2(ax.tangentY, ax.tangentX);
  const angleDiffPerp = b.angle - roadPerpAngle;
  const angleDiffTan = b.angle - roadTanAngle;
  const perpExtPx = Math.abs(b.w * Math.cos(angleDiffPerp)) + Math.abs(b.h * Math.sin(angleDiffPerp));
  // OBB extents projected on the road tangent axis. Both terms use cos/sin
  // of the OBB-vs-tangent angle: w is the OBB extent along b.angle, h is
  // perpendicular to b.angle. (Previously the sin/cos were swapped, which
  // made alongExtPx == perpExtPx for any angle and underestimated the
  // longitudinal extent of axis-aligned vehicles.)
  const alongExtPx = Math.abs(b.w * Math.cos(angleDiffTan)) + Math.abs(b.h * Math.sin(angleDiffTan));
  const halfPerpM = perpExtPx / 2 / pxPerM;
  const halfAlongM = alongExtPx / 2 / pxPerM;

  const isRight = lateralM >= 0;
  const innerEdgeM = isRight ? lateralM - halfPerpM : lateralM + halfPerpM;
  const outerEdgeM = isRight ? lateralM + halfPerpM : lateralM - halfPerpM;

  return {
    bbox: b,
    side: isRight ? 'right' : 'left',
    alongM,
    lateralM,
    innerEdgeM: Math.round(innerEdgeM * 100) / 100,
    outerEdgeM: Math.round(outerEdgeM * 100) / 100,
    halfAlongM: Math.round(halfAlongM * 100) / 100,
  };
}

export function alongDistanceM(a: BboxAxisGeometry, b: BboxAxisGeometry): number {
  return Math.abs(a.alongM - b.alongM);
}

/** Longitudinal gap between OBB extents (0 when overlapping). */
export function alongGapM(a: BboxAxisGeometry, b: BboxAxisGeometry): number {
  const aLo = a.alongM - a.halfAlongM;
  const aHi = a.alongM + a.halfAlongM;
  const bLo = b.alongM - b.halfAlongM;
  const bHi = b.alongM + b.halfAlongM;
  if (aHi < bLo) return bLo - aHi;
  if (bHi < aLo) return aLo - bHi;
  return 0;
}

function smallVehicles(geoms: readonly BboxAxisGeometry[]): BboxAxisGeometry[] {
  return geoms.filter(g => g.bbox.class_name !== 'large-vehicle');
}

function largeVehicles(geoms: readonly BboxAxisGeometry[]): BboxAxisGeometry[] {
  return geoms.filter(g => g.bbox.class_name === 'large-vehicle');
}

function hasLongitudinalProbeInputs(
  opts: ClassifyYoloParkingOpts,
): opts is ClassifyYoloParkingOpts & {
  readonly rgb: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly asphaltModel: AsphaltModel;
} {
  return !!opts.rgb && !!opts.width && !!opts.height && !!opts.asphaltModel;
}

function isCirculatingByAvailableProbe(
  geom: BboxAxisGeometry,
  opts: ClassifyYoloParkingOpts,
  roadAxis: RoadAxis,
  pxPerM: number,
): boolean | null {
  if (!hasLongitudinalProbeInputs(opts)) return null;
  return isCirculatingByLongitudinalProbe(
    geom,
    roadAxis,
    pxPerM,
    opts.rgb,
    opts.width,
    opts.height,
    opts.asphaltModel,
  );
}

/**
 * Longitudinal asphalt probe: clean road in ±2 m strips along axis outside the OBB → circulation.
 */
export function isCirculatingByLongitudinalProbe(
  geom: BboxAxisGeometry,
  roadAxis: RoadAxis,
  pxPerM: number,
  rgb: Uint8ClampedArray,
  W: number,
  H: number,
  asphaltModel: AsphaltModel,
): boolean {
  const localModel = buildAsphaltModelNearAlongM(
    rgb,
    W,
    H,
    pxPerM,
    roadAxis,
    geom.alongM,
    SIDEWALK_REF_ALONG_HALF_M,
    SIDEWALK_REF_LATERAL_HALF_M,
  );
  const probeModel =
    localModel.sampleCount >= PARKING_PROBE_LOCAL_REF_MIN_SAMPLES
      ? localModel
      : asphaltModel;

  const stepM = 0.35;
  const lateralLo = Math.min(geom.innerEdgeM, geom.outerEdgeM);
  const lateralHi = Math.max(geom.innerEdgeM, geom.outerEdgeM);
  const strips: Array<{ tStart: number; tEnd: number }> = [
    {
      tStart: geom.alongM - geom.halfAlongM - PARKING_PROBE_ALONG_M,
      tEnd: geom.alongM - geom.halfAlongM,
    },
    {
      tStart: geom.alongM + geom.halfAlongM,
      tEnd: geom.alongM + geom.halfAlongM + PARKING_PROBE_ALONG_M,
    },
  ];

  let stripPass = 0;
  for (const strip of strips) {
    let hits = 0;
    let roadHits = 0;
    for (let tM = strip.tStart; tM <= strip.tEnd + 1e-6; tM += stepM) {
      const ax = roadAxis.axisAt(tM);
      for (let sM = lateralLo; sM <= lateralHi + 1e-6; sM += stepM) {
        const x = ax.cx + sM * pxPerM * ax.perpX;
        const y = ax.cy + sM * pxPerM * ax.perpY;
        if (pointInRotatedRect(x, y, geom.bbox)) continue;
        const c = sampleRGB(rgb, W, H, Math.round(x), Math.round(y));
        if (!c) continue;
        hits++;
        if (isRoadPixelModel(c, probeModel, { allowBrightAsphalt: true })) roadHits++;
      }
    }
    const frac = hits > 0 ? roadHits / hits : 0;
    if (hits > 0 && frac >= PARKING_PROBE_SCORE_T) stripPass++;
  }

  return stripPass >= 1 && stripPass === strips.length;
}

function classifySide(
  side: 'left' | 'right',
  geoms: readonly BboxAxisGeometry[],
  opts: ClassifyYoloParkingOpts,
  roadAxis: RoadAxis,
  pxPerM: number,
  out: ParkingClassification[],
): void {
  const onSide = geoms.filter(g => g.side === side);
  const small = smallVehicles(onSide);
  const large = largeVehicles(onSide);

  const push = (geom: BboxAxisGeometry, status: ParkingStatus, reason: string) => {
    out.push({ bbox: geom.bbox, status, reason, geometry: geom });
  };

  const hasKerbSmallVehicle = small.some((g) => !isVehicleOnBdtopoCarriageway(g, opts.bdtopoWidthM));
  for (const g of large) {
    if (isVehicleOnBdtopoCarriageway(g, opts.bdtopoWidthM)) {
      push(g, 'circulating', 'large_vehicle_on_bdtopo_carriageway');
      continue;
    }
    if (opts.bdtopoParkingAt?.(g)) {
      push(g, 'parked', 'large_vehicle_bdtopo_parking');
      continue;
    }
    push(
      g,
      hasKerbSmallVehicle ? 'parked' : 'circulating',
      hasKerbSmallVehicle ? 'parking_car_truck_pair' : 'truck_solo_circulation',
    );
  }

  if (small.length === 0) return;

  const sideParkingContext = small.length > 0 && large.length > 0;

  // In-lane vehicles on the BDTOPO carriageway are circulating regardless of
  // how many other parked cars sit on the same side (row-count must not swallow them).
  const inLaneCirculating: BboxAxisGeometry[] = [];
  const parkingCandidates: BboxAxisGeometry[] = [];
  for (const g of small) {
    if (isVehicleOnBdtopoCarriageway(g, opts.bdtopoWidthM)) {
      inLaneCirculating.push(g);
    } else {
      parkingCandidates.push(g);
    }
  }
  for (const g of inLaneCirculating) {
    push(g, 'circulating', 'vehicle_on_bdtopo_carriageway');
  }

  const parkedSide = parkingCandidates;

  if (sideParkingContext) {
    for (const g of parkedSide) push(g, 'parked', 'parking_car_truck_pair');
    return;
  }

  if (parkedSide.length >= 3) {
    for (const g of parkedSide) push(g, 'parked', 'parking_row_count');
    return;
  }

  if (parkedSide.length === 2) {
    const gap = alongGapM(parkedSide[0]!, parkedSide[1]!);
    const parked = gap < PARKING_PAIR_GAP_M;
    if (!parked) {
      const probeA = isCirculatingByAvailableProbe(parkedSide[0]!, opts, roadAxis, pxPerM);
      const probeB = isCirculatingByAvailableProbe(parkedSide[1]!, opts, roadAxis, pxPerM);
      if (probeA !== null && probeB !== null) {
        const bothClearlyCirculating = probeA && probeB;
        const baseReason = bothClearlyCirculating
          ? 'pair_too_far_circulation_probe'
          : 'parking_pair_probe_parked';
        const reason = `${baseReason}:gap=${gap.toFixed(2)}m`;
        for (const g of parkedSide) push(g, bothClearlyCirculating ? 'circulating' : 'parked', reason);
        return;
      }
    }

    const baseReason = parked ? 'parking_row_pair' : 'pair_too_far_circulation';
    const reason = `${baseReason}:gap=${gap.toFixed(2)}m`;
    for (const g of parkedSide) push(g, parked ? 'parked' : 'circulating', reason);
    return;
  }

  if (parkedSide.length === 1) {
    const g = parkedSide[0]!;
    if (opts.bdtopoParkingAt?.(g)) {
      push(g, 'parked', 'parking_bdtopo');
      return;
    }

    if (isCirculatingByAvailableProbe(g, opts, roadAxis, pxPerM)) {
      push(g, 'circulating', 'vehicle_circulation_probe');
      return;
    }

    push(g, 'circulating', 'solo_vehicle_ambiguous_circulation_default');
  }
}

/**
 * Classify each YOLO box as parked (excludes carriageway / clamp) or circulating (ignored for parking).
 */
export function classifyYoloParking(
  bboxes: readonly YoloBbox[],
  roadAxis: RoadAxis,
  pxPerM: number,
  conf: number,
  opts: ClassifyYoloParkingOpts = {},
): ParkingClassification[] {
  const geoms = bboxes
    .filter(b => b.conf >= conf)
    .map(b => bboxAxisGeometry(b, roadAxis, pxPerM));

  const out: ParkingClassification[] = [];
  classifySide('left', geoms, opts, roadAxis, pxPerM, out);
  classifySide('right', geoms, opts, roadAxis, pxPerM, out);
  return out;
}

export function parkedYoloBboxes(classifications: readonly ParkingClassification[]): YoloBbox[] {
  return classifications.filter(c => c.status === 'parked').map(c => c.bbox);
}

export interface YoloCropFilterResult {
  readonly kept: YoloBbox[];
  readonly excluded: number;
}

/**
 * Keep YOLO boxes whose lateral footprint intersects the crop window.
 * A parked vehicle can narrow the analysed carriageway even when its centre sits just
 * outside the BDTOPO-guided crop (common for kerb parking on narrow streets).
 */
export function filterYoloBboxesWithinLateralHalfM(
  bboxes: readonly YoloBbox[],
  roadAxis: RoadAxis,
  pxPerM: number,
  lateralHalfM: number,
): YoloCropFilterResult {
  const kept: YoloBbox[] = [];
  let excluded = 0;
  for (const b of bboxes) {
    const g = bboxAxisGeometry(b, roadAxis, pxPerM);
    const lo = Math.min(g.innerEdgeM, g.outerEdgeM);
    const hi = Math.max(g.innerEdgeM, g.outerEdgeM);
    if (hi >= -lateralHalfM && lo <= lateralHalfM) {
      kept.push(b);
    } else {
      excluded++;
    }
  }
  return { kept, excluded };
}

export function geometryToCarZone(geom: BboxAxisGeometry, notes: string[]): CarZone {
  return {
    side: geom.side,
    innerEdgeM: geom.innerEdgeM,
    outerEdgeM: geom.outerEdgeM,
    widthM: Math.round(Math.abs(geom.outerEdgeM - geom.innerEdgeM) * 100) / 100,
    level: 'certain',
    confidence: Math.round(geom.bbox.conf * 100) / 100,
    notes: [`yolo:${geom.bbox.class_name}`, `conf:${geom.bbox.conf.toFixed(2)}`, ...notes],
  };
}
