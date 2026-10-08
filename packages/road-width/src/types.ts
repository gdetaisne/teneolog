/** Stable reason codes emitted by tile measurement and consolidation. */
export type RoadWidthReasonCode =
  | 'no_plateau'
  | 'no_plateau_at_zero'
  | 'too_narrow'
  | 'too_wide'
  | 'few_samples'
  | 'building_mask_unavailable'
  | 'tile_low_coverage'
  | 'tile_rejected_outlier'
  | 'tile_rejected_low_confidence'
  | 'consolidated_median'
  | 'consolidated_single_tile'
  | 'consolidated_stitched_single'
  | 'measurement_stitched_primary'
  | 'hard_exclusion_lateral'
  | 'occlusion_canopy'
  | 'occlusion_vehicle'
  | 'high_veg_in_plateau'
  | 'study_region_low_coverage'
  | 'plateau_crosses_exclusion'
  | 'measurement_unavailable'
  | 'exclusion_narrow_gap_fill'
  | 'exclusion_narrow_gap_fill_2m'
  | 'aerial_canopy_bridge'
  | 'score_asphalt_only'
  | 'hard_exclusion_bdtopo'
  | 'hard_exclusion_vehicle';

/** Pipeline step tags (prefixed strings). */
export type RoadWidthPipelineReasonCode =
  | 'pipeline_step1_yolo'
  | 'pipeline_step2_bdtopo_exclusion'
  | 'pipeline_step3_asphalt_reference'
  | 'pipeline_step4_vehicle_exclusion'
  | 'pipeline_step5_study_region'
  | 'pipeline_step5_lateral_score'
  | 'pipeline_asphalt_few_samples';

/** Dynamic runtime codes: `pipeline_yolo_detections:N`, `pipeline_car_zones:N`, `yolo_status:*`, `verdict:*`, `block:*`, `degraded:*`. */
export type RoadWidthRuntimeReasonCode = string;

export function isKnownRoadWidthReasonCode(code: string): code is RoadWidthReasonCode {
  const known: readonly string[] = [
    'no_plateau',
    'no_plateau_at_zero',
    'too_narrow',
    'too_wide',
    'few_samples',
    'building_mask_unavailable',
    'tile_low_coverage',
    'tile_rejected_outlier',
    'tile_rejected_low_confidence',
    'consolidated_median',
    'consolidated_single_tile',
    'consolidated_stitched_single',
    'measurement_stitched_primary',
    'hard_exclusion_lateral',
    'occlusion_canopy',
    'occlusion_vehicle',
    'high_veg_in_plateau',
    'study_region_low_coverage',
    'plateau_crosses_exclusion',
    'exclusion_narrow_gap_fill',
    'exclusion_narrow_gap_fill_2m',
    'aerial_canopy_bridge',
    'score_asphalt_only',
    'hard_exclusion_bdtopo',
    'hard_exclusion_vehicle',
  ];
  return known.includes(code);
}

/** Binary mask layer aligned with image pixels (row-major, length W×H). */
export interface MaskLayer {
  readonly width: number;
  readonly height: number;
  /** 0 = off, 255 = on */
  readonly data: Uint8Array;
  readonly label:
    | 'vehicle'
    | 'building'
    | 'vegetationMass'
    | 'treeOcclusion'
    | 'bdtopoExclusion'
    | 'studyRegion';
}

export interface SpatialMaskSet {
  readonly vehicleMask: MaskLayer;
  readonly buildingMask: MaskLayer;
  readonly vegetationMassMask: MaskLayer;
  readonly treeOcclusionMask: MaskLayer;
  readonly reasonCodes: readonly string[];
}

export interface AsphaltModel {
  medianColour: [number, number, number];
  rgbMin: [number, number, number];
  rgbMax: [number, number, number];
  lumaMin: number;
  lumaMax: number;
  maxSat: number;
  sampleCount: number;
}

export interface Plateau {
  startM: number;
  endM: number;
  widthM: number;
  meanScore: number;
}

/** Per-offset lateral scoring components (parallel arrays, metres). */
export interface LateralScoreComponents {
  offsetsM: number[];
  roadLikelihood: number[];
  hardExclusion: number[];
  occlusion: number[];
  edgeEvidence: number[];
  /** Legacy combined profile used for plateau detection */
  profile: number[];
  roadMatchProfile: number[];
  /** Deprecated — always 0; vegetation handled via BDTOPO exclusion only. */
  nonVegProfile: number[];
  /** Deprecated — always 0; no pixel-HSV veg gate in score. */
  vegProfile: number[];
  coverageProfile: number[];
  /** 1 = BDTOPO building mask hits this lateral scan (binary exclusion). */
  bdtopoBuildingCost: number[];
  /** 1 = BDTOPO lateral vegetation-mass hits scan (binary exclusion). */
  bdtopoVegetationCost: number[];
  /** 1 = aerial canopy (green ∉ BDTOPO) hits scan; profile may be bridged from neighbors. */
  bdtopoCanopyCost: number[];
  /** 1 = any hard binary exclusion on scan (building, lateral veg, parking); score forced to 0. */
  bdtopoHardCost: number[];
  /** 1 = YOLO vehicle mask hits scan (parked cars / traffic). */
  parkingExclusion: number[];
  /** Debug-only sidewalk boundary shadow score per lateral offset [0, 1]. */
  sidewalkBoundaryScore: number[];
  /** Debug-only narrow peaks at outward sidewalk-boundary candidates [0, 1]. */
  sidewalkBoundaryCandidateScore: number[];
}

/** @deprecated Use TilePipelinePrep + measureTileWidth(prep) after prepareTilePipeline(). */
export interface TileWidthMeasureInput {
  readonly tileIndex: 0 | 1 | 2;
  readonly rgb: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly pxPerM: number;
  readonly bearingDeg: number;
  readonly gtWidthM: number | null;
  readonly roadAxis: import('./geometry.js').RoadAxis;
  readonly masks: SpatialMaskSet;
  readonly yoloBboxes?: readonly import('./yolo.js').YoloBbox[];
}

export interface TileWidthResult {
  readonly tileIndex: 0 | 1 | 2;
  readonly widthM: number | null;
  readonly confidence: number;
  readonly leftPerpM: number | null;
  readonly rightPerpM: number | null;
  readonly reasonCodes: readonly string[];
  readonly masks: SpatialMaskSet;
  readonly scores: LateralScoreComponents;
  readonly plateaux: Plateau[];
  readonly asphaltModel: AsphaltModel;
  readonly roadColour: [number, number, number];
  readonly threshold: number;
  readonly sampleCount: number;
  readonly notes: readonly string[];
  readonly plateauVegFrac: number;
  readonly durationMs: number;
  readonly deltaToGtM: number | null;
  readonly weight: number;
}

export interface ConsolidatedRoadWidthResult {
  readonly widthM: number | null;
  readonly confidence: number;
  readonly leftPerpM: number | null;
  readonly rightPerpM: number | null;
  readonly reasonCodes: readonly string[];
  readonly tiles: readonly TileWidthResult[];
  readonly primaryTileIndex: 0 | 1 | 2;
  /** Merged profile from primary tile for UI charts */
  readonly profileResult: ProfileResultView;
  /** Stitch canvas road axis used for D10 + YOLO (same instance for clamp when provided). */
  readonly stitchRoadAxis?: import('./geometry.js').RoadAxis;
  readonly stitchRoadAxisSerial?: import('./geometry.js').SerializableRoadAxis | null;
}

export interface YoloVehicleClassificationDebug {
  readonly bbox: import('./yolo.js').YoloBbox;
  readonly status: 'parked' | 'circulating';
  readonly reason: string;
  readonly side: 'left' | 'right';
  readonly alongM: number;
  readonly lateralM: number;
  readonly innerEdgeM: number;
  readonly outerEdgeM: number;
  readonly halfAlongM: number;
}

/** UI-facing profile bundle (stitch debug + detail modal). */
export interface ProfileResultView {
  widthM: number | null;
  confidence: number;
  leftPerpM: number | null;
  rightPerpM: number | null;
  profile: number[];
  roadMatchProfile: number[];
  /** Deprecated — always 0; vegetation handled via BDTOPO exclusion only. */
  nonVegProfile: number[];
  /** Deprecated — always 0; no pixel-HSV veg gate in score. */
  vegProfile: number[];
  coverageProfile: number[];
  bdtopoBuildingCost: number[];
  bdtopoVegetationCost: number[];
  bdtopoCanopyCost: number[];
  bdtopoHardCost: number[];
  parkingExclusion: number[];
  /** Debug-only sidewalk boundary shadow score per lateral offset [0, 1]. */
  sidewalkBoundaryScore: number[];
  /** Debug-only sidewalk boundary candidate peaks per lateral offset [0, 1]. */
  sidewalkBoundaryCandidateScore: number[];
  offsetsM: number[];
  plateaux: Plateau[];
  roadColour: [number, number, number];
  threshold: number;
  sampleCount: number;
  asphaltModel: AsphaltModel;
  notes: string[];
  deltaToGtM: number | null;
  durationMs: number;
  plateauVegFrac: number;
  carZones: import('./car-zone.js').CarZone[];
  yoloBboxes: import('./yolo.js').YoloBbox[];
  /** Parked-only subset of yoloBboxes (clamp / debug overlay). */
  parkedYoloBboxes: import('./yolo.js').YoloBbox[];
  /** Per-vehicle YOLO parking classification in D10 metric frame. */
  yoloClassifications: YoloVehicleClassificationDebug[];
  masks: SpatialMaskSet;
  tiles: readonly TileWidthResult[];
  reasonCodes: readonly string[];
  /** Tile whose lateral profile is shown in the chart (highest weight × confidence). */
  primaryTileIndex: 0 | 1 | 2;
  /** YOLO detect-cars outcome for this measurement. */
  yoloStatus: import('./yolo-status.js').YoloFetchStatus;
  yoloMessage?: string;
  yoloMeta?: import('./yolo-status.js').YoloMeta;
  /** Human / automatic acceptance gate (debug lab; mirrors future server verdict). */
  verdict: import('./verdict.js').RoadWidthVerdict;
}
