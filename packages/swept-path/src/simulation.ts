import {
  add,
  convexHull,
  headingRadFromUnit,
  leftNormal,
  normalize,
  pointInConvexPolygon,
  polygonArea,
  poseAtPathIndex,
  sampleCubicBezier,
  scale,
  signedClearanceToConvexPolygon,
  sub,
  truckFootprint,
  unitFromBearingDeg,
} from './geometry.js';
import {
  DEFAULT_SAFETY_MARGIN_M,
  headingChangeDeg,
  requiredWidthForTurnM,
} from './kinematics.js';
import type {
  Point,
  Pose,
  StreetSimulationInput,
  SweptPathSimulationInput,
  SweptPathSimulationResult,
  SweptPathVerdict,
  TruckSpec,
  TurnSimulationInput,
} from './types.js';

const DEFAULT_LEG_LENGTH_M = 24;
const DEFAULT_SAMPLE_STEP_M = 0.5;
const TIGHT_CLEARANCE_M = 0.5;

function verdictFromClearance(minClearanceM: number): SweptPathVerdict {
  if (minClearanceM < 0) return 'fail';
  if (minClearanceM < TIGHT_CLEARANCE_M) return 'tight';
  return 'pass';
}

function sampleStraightPath(start: Point, end: Point, sampleStepM: number): Point[] {
  const delta = sub(end, start);
  const dist = Math.hypot(delta.x, delta.y);
  const count = Math.max(2, Math.ceil(dist / sampleStepM) + 1);
  return Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    return { x: start.x + delta.x * t, y: start.y + delta.y * t };
  });
}

function footprintsForPath(path: readonly Point[], truck: TruckSpec): { poses: Pose[]; footprints: Point[][] } {
  const poses = path.map((_, index) => poseAtPathIndex(path, index));
  return {
    poses,
    footprints: poses.map((pose) => truckFootprint(pose, truck)),
  };
}

function frontAxlePathFromPoses(poses: readonly Pose[], truck: TruckSpec): Point[] {
  return poses.map((pose) => ({
    x: pose.x + Math.cos(pose.headingRad) * truck.wheelbaseM,
    y: pose.y + Math.sin(pose.headingRad) * truck.wheelbaseM,
  }));
}

function evaluateFootprints(
  footprints: readonly (readonly Point[])[],
  corridorPolygon: readonly Point[],
  sampleStepM: number,
) {
  const corners = footprints.flat();
  let minClearanceM = Number.POSITIVE_INFINITY;
  const biteSamples: Point[] = [];
  for (const corner of corners) {
    const clearance = signedClearanceToConvexPolygon(corner, corridorPolygon);
    minClearanceM = Math.min(minClearanceM, clearance);
    if (!pointInConvexPolygon(corner, corridorPolygon)) {
      biteSamples.push(corner);
    }
  }

  return {
    minClearanceM,
    biteSamples,
    // P0 proxy: corner-sample count times one sample cell. Replaced by polygon difference in P1.
    overlapAreaM2: biteSamples.length * sampleStepM * sampleStepM,
  };
}

function resultFromPath(params: {
  readonly kind: 'street' | 'turn';
  readonly truck: TruckSpec;
  readonly path: readonly Point[];
  readonly corridorPolygon: readonly Point[];
  readonly requiredWidthM1d: number;
  readonly sampleStepM: number;
  readonly reasonCodes: readonly string[];
  readonly optimization?: SweptPathSimulationResult['optimization'];
}): SweptPathSimulationResult {
  const { poses, footprints } = footprintsForPath(params.path, params.truck);
  const envelopePolygon = convexHull(footprints.flat());
  const evaluation = evaluateFootprints(footprints, params.corridorPolygon, params.sampleStepM);
  const verdict = verdictFromClearance(evaluation.minClearanceM);

  return {
    kind: params.kind,
    verdict,
    minClearanceM: Number(evaluation.minClearanceM.toFixed(3)),
    requiredWidthM1d: Number(params.requiredWidthM1d.toFixed(3)),
    corridorPolygon: params.corridorPolygon,
    envelopePolygon,
    drivenPath: params.path,
    rearAxlePath: params.path,
    frontAxlePath: frontAxlePathFromPoses(poses, params.truck),
    bodyPoses: poses,
    bodyFootprints: footprints,
    overlapAreaM2: Number(evaluation.overlapAreaM2.toFixed(3)),
    biteSamples: evaluation.biteSamples,
    confidence: params.kind === 'street' ? 0.9 : 0.65,
    reasonCodes: [
      ...params.reasonCodes,
      'p0_sampled_body_footprint',
      'p0_convex_corridor',
      'p0_overlap_corner_sample_proxy',
    ],
    optimization: params.optimization,
  };
}

export function buildStreetCorridor(lengthM: number, widthM: number, safetyMarginM: number): Point[] {
  const halfWidth = Math.max(0.05, (widthM - safetyMarginM) / 2);
  const halfLength = lengthM / 2;
  return [
    { x: -halfLength, y: -halfWidth },
    { x: halfLength, y: -halfWidth },
    { x: halfLength, y: halfWidth },
    { x: -halfLength, y: halfWidth },
  ];
}

export function simulateStreet(input: StreetSimulationInput): SweptPathSimulationResult {
  const lengthM = input.lengthM ?? 36;
  const safetyMarginM = input.safetyMarginM ?? DEFAULT_SAFETY_MARGIN_M;
  const sampleStepM = input.sampleStepM ?? DEFAULT_SAMPLE_STEP_M;
  const path = sampleStraightPath({ x: -lengthM / 2, y: 0 }, { x: lengthM / 2, y: 0 }, sampleStepM);
  return resultFromPath({
    kind: 'street',
    truck: input.truck,
    path,
    corridorPolygon: buildStreetCorridor(lengthM + input.truck.lengthM * 2, input.streetWidthM, safetyMarginM),
    requiredWidthM1d: input.truck.widthM + safetyMarginM,
    sampleStepM,
    reasonCodes: ['street_mode'],
  });
}

function armRectangle(apex: Point, travelDir: Point, lengthM: number, widthM: number): Point[] {
  const dir = normalize(travelDir);
  const side = leftNormal(dir);
  const half = widthM / 2;
  const far = add(apex, scale(dir, lengthM));
  return [
    add(apex, scale(side, half)),
    add(far, scale(side, half)),
    add(far, scale(side, -half)),
    add(apex, scale(side, -half)),
  ];
}

export function buildTurnCorridor(input: TurnSimulationInput): Point[] {
  const legLengthM = (input.legLengthM ?? DEFAULT_LEG_LENGTH_M) + input.truck.lengthM;
  const safetyMarginM = input.safetyMarginM ?? DEFAULT_SAFETY_MARGIN_M;
  const incomingDir = unitFromBearingDeg(input.incomingBearingDeg);
  const outgoingDir = unitFromBearingDeg(input.outgoingBearingDeg);
  const incomingWidth = Math.max(0.1, input.incomingWidthM - safetyMarginM);
  const outgoingWidth = Math.max(0.1, input.outgoingWidthM - safetyMarginM);
  const incomingArm = armRectangle(input.apex, scale(incomingDir, -1), legLengthM, incomingWidth);
  const outgoingArm = armRectangle(input.apex, outgoingDir, legLengthM, outgoingWidth);
  return convexHull([...incomingArm, ...outgoingArm]);
}

function signedTurnSide(incomingDir: Point, outgoingDir: Point): number {
  const cross = incomingDir.x * outgoingDir.y - incomingDir.y * outgoingDir.x;
  return cross >= 0 ? 1 : -1;
}

function turnPath(input: TurnSimulationInput, apexOffsetM: number): Point[] {
  const legLengthM = input.legLengthM ?? DEFAULT_LEG_LENGTH_M;
  const sampleStepM = input.sampleStepM ?? DEFAULT_SAMPLE_STEP_M;
  const incomingDir = unitFromBearingDeg(input.incomingBearingDeg);
  const outgoingDir = unitFromBearingDeg(input.outgoingBearingDeg);
  const insideNormal = scale(leftNormal(normalize(add(incomingDir, outgoingDir))), signedTurnSide(incomingDir, outgoingDir));
  const apexGuide = add(input.apex, scale(insideNormal, apexOffsetM));
  const start = add(input.apex, scale(incomingDir, -legLengthM));
  const end = add(input.apex, scale(outgoingDir, legLengthM));
  const controlDistance = Math.max(input.truck.turnRadiusM, legLengthM * 0.45);
  const c1 = add(apexGuide, scale(incomingDir, -controlDistance));
  const c2 = add(apexGuide, scale(outgoingDir, controlDistance));
  const roughLength = legLengthM * 2;
  return sampleCubicBezier(start, c1, c2, end, Math.ceil(roughLength / sampleStepM) + 1);
}

function defaultOffsets(input: TurnSimulationInput): readonly number[] {
  if (input.candidateOffsetsM) return input.candidateOffsetsM;
  const maxOffset = Math.max(0, Math.min(input.incomingWidthM, input.outgoingWidthM) / 2 - input.truck.widthM / 2);
  const step = Math.max(0.25, maxOffset / 6);
  const offsets: number[] = [];
  for (let offset = -maxOffset; offset <= maxOffset + 1e-6; offset += step) {
    offsets.push(Number(offset.toFixed(2)));
  }
  return offsets.length > 0 ? offsets : [0];
}

export function simulateTurn(input: TurnSimulationInput): SweptPathSimulationResult {
  const sampleStepM = input.sampleStepM ?? DEFAULT_SAMPLE_STEP_M;
  const corridorPolygon = buildTurnCorridor(input);
  const requiredWidthM1d = requiredWidthForTurnM(
    headingChangeDeg(input.incomingBearingDeg, input.outgoingBearingDeg),
    input.truck,
    input.safetyMarginM ?? DEFAULT_SAFETY_MARGIN_M,
  );

  const candidates = defaultOffsets(input).map((apexOffsetM) => {
    const path = turnPath(input, apexOffsetM);
    const { footprints } = footprintsForPath(path, input.truck);
    const evaluation = evaluateFootprints(footprints, corridorPolygon, sampleStepM);
    return {
      apexOffsetM,
      path,
      minClearanceM: evaluation.minClearanceM,
      overlapAreaM2: evaluation.overlapAreaM2,
    };
  });
  const best = candidates.reduce((currentBest, candidate) => {
    if (candidate.minClearanceM > currentBest.minClearanceM) return candidate;
    if (
      candidate.minClearanceM === currentBest.minClearanceM &&
      candidate.overlapAreaM2 < currentBest.overlapAreaM2
    ) {
      return candidate;
    }
    return currentBest;
  }, candidates[0]!);

  return resultFromPath({
    kind: 'turn',
    truck: input.truck,
    path: best.path,
    corridorPolygon,
    requiredWidthM1d,
    sampleStepM,
    reasonCodes: ['turn_mode', 'p0_offset_grid_search'],
    optimization: {
      apexOffsetM: best.apexOffsetM,
      candidates: candidates.map((candidate) => ({
        apexOffsetM: candidate.apexOffsetM,
        minClearanceM: Number(candidate.minClearanceM.toFixed(3)),
        overlapAreaM2: Number(candidate.overlapAreaM2.toFixed(3)),
      })),
    },
  });
}

export function simulateSweptPath(input: SweptPathSimulationInput): SweptPathSimulationResult {
  switch (input.kind) {
    case 'street':
      return simulateStreet(input);
    case 'turn':
      return simulateTurn(input);
  }
}

export function poseFootprint(pose: Pose, truck: TruckSpec): readonly Point[] {
  return truckFootprint(pose, truck);
}

export function poseHeadingFromBearingDeg(bearingDeg: number): number {
  return headingRadFromUnit(unitFromBearingDeg(bearingDeg));
}

export { polygonArea };
