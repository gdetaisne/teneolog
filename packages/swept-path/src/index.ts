export type {
  ChainTrackingInput,
  ChainTrackingResult,
  LinkTrackingResult,
  Point,
  Pose,
  StreetSimulationInput,
  SweptPathSimulationInput,
  SweptPathSimulationResult,
  SweptPathVerdict,
  TruckSpec,
  TurnSimulationInput,
  VehicleChain,
  VehicleLink,
} from './types.js';

export {
  add,
  convexHull,
  distancePointToSegment,
  dot,
  headingRadFromUnit,
  leftNormal,
  length,
  normalize,
  pointInConvexPolygon,
  polygonArea,
  rightNormal,
  scale,
  signedClearanceToConvexPolygon,
  sub,
  truckFootprint,
  unitFromBearingDeg,
} from './geometry.js';

export {
  DEFAULT_SAFETY_MARGIN_M,
  PL_19T_TRUCK,
  headingChangeDeg,
  requiredWidthForCurveM,
  requiredWidthForTurnM,
  steadyStateOfftrackingM,
} from './kinematics.js';

export {
  buildStreetAxisToolkit,
  closestPointOnAxisPolyline,
  lateralOffsetMFromPointerDelta,
  screenBearingDeg,
  type StreetAxisToolkitInput,
  type StreetAxisToolkitResult,
} from './street-toolkit.js';

export {
  buildStreetCorridor,
  buildTurnCorridor,
  poseFootprint,
  poseHeadingFromBearingDeg,
  simulateStreet,
  simulateSweptPath,
  simulateTurn,
} from './simulation.js';

export { simulateChainAlongGuide } from './chain-tracking.js';
export { DEFAULT_RASTER_CELL_M, rasterFootprintEnvelope } from './footprint-raster.js';
export {
  simulateThreePointTurn,
  type ThreePointSide,
  type ThreePointTurnInput,
  type ThreePointTurnResult,
  type ThreePointVariant,
} from './three-point.js';
export {
  planTurnaround,
  planTurnaroundAsync,
  TURNAROUND_PLAN_METHOD,
  type TurnaroundMove,
  type TurnaroundPlanInput,
  type TurnaroundPlanOptions,
  type TurnaroundPlanResult,
} from './turnaround-plan.js';
