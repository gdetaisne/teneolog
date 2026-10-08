export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Pose {
  readonly x: number;
  readonly y: number;
  /** Radians in screen-metric space: 0 points right, +PI/2 points down. */
  readonly headingRad: number;
}

export interface TruckSpec {
  readonly id: string;
  readonly label: string;
  readonly lengthM: number;
  readonly widthM: number;
  readonly wheelbaseM: number;
  readonly turnRadiusM: number;
  readonly frontOverhangM: number;
  readonly rearOverhangM: number;
}

export interface StreetSimulationInput {
  readonly kind: 'street';
  readonly truck: TruckSpec;
  readonly streetWidthM: number;
  readonly lengthM?: number;
  readonly safetyMarginM?: number;
  readonly sampleStepM?: number;
}

export interface TurnSimulationInput {
  readonly kind: 'turn';
  readonly truck: TruckSpec;
  readonly apex: Point;
  /** Geographic-style bearing, degrees clockwise from north, in the image frame. */
  readonly incomingBearingDeg: number;
  /** Geographic-style bearing, degrees clockwise from north, in the image frame. */
  readonly outgoingBearingDeg: number;
  readonly incomingWidthM: number;
  readonly outgoingWidthM: number;
  readonly legLengthM?: number;
  readonly safetyMarginM?: number;
  readonly sampleStepM?: number;
  readonly candidateOffsetsM?: readonly number[];
}

export type SweptPathSimulationInput = StreetSimulationInput | TurnSimulationInput;

export type SweptPathVerdict = 'pass' | 'tight' | 'fail';

// ─── Vehicle chain types (unified kinematic model) ───────────────────────────

/**
 * One rigid segment of a vehicle combination.
 *
 * `refDistM` (g) is the distance from the rear axle to the reference point
 * that tracks the guide path. It controls where the driver places the vehicle:
 *   - refDistM = lengthM  → front-axle tractrix (classic)
 *   - refDistM → 0        → rear axle on path
 *   - 0 < refDistM < lengthM → G.'s model: a point behind the front axle
 *
 * `hitchFwdM`: only for articulated combinations. Distance from the rear axle
 * to the king-pin coupling point, measured forward along the body. The king-pin
 * path becomes the guide for the next link.
 */
export interface VehicleLink {
  readonly lengthM: number;       // wheelbase (front axle → rear axle)
  readonly widthM: number;
  readonly frontOverhangM: number;
  readonly rearOverhangM: number;
  /** Distance rear axle → reference point (0 ≤ refDistM ≤ lengthM). */
  readonly refDistM: number;
  /** Distance rear axle → king-pin (articulated only). Default = rear axle (0). */
  readonly hitchFwdM?: number;
}

export interface VehicleChain {
  readonly links: readonly VehicleLink[];
}

export interface LinkTrackingResult {
  /** Positions of the reference point (the path the link "follows"). */
  readonly refPath: readonly Point[];
  readonly rearAxlePath: readonly Point[];
  readonly frontAxlePath: readonly Point[];
  /** Oriented rectangles at each integration step (for sweep visualization). */
  readonly bodyFootprints: readonly (readonly Point[])[];
  /**
   * King-pin (hitch) path along the body. For articulated links this is the
   * guide handed to the next link; exposed so debug overlays can mark the
   * coupling point. Equals the rear-axle path when `hitchFwdM` is 0.
   */
  readonly hitchPath: readonly Point[];
}

export interface ChainTrackingInput {
  /**
   * Guide path in metric space. The first link's reference point tracks this.
   * Origin is arbitrary (caller decides — typically the first trace point).
   */
  readonly guideM: readonly Point[];
  readonly chain: VehicleChain;
  /** Euler integration step in meters (default 0.25 m). */
  readonly dsM?: number;
}

export interface ChainTrackingResult {
  readonly links: readonly LinkTrackingResult[];
  /** Union of all link footprint quads along the path (swept envelope). */
  readonly envelopePolygon: readonly Point[];
  /** Diagnostic codes (no verdict — for human review only). */
  readonly reasonCodes: readonly string[];
}

// ─── Legacy swept-path simulation types ──────────────────────────────────────

export interface SweptPathSimulationResult {
  readonly kind: 'street' | 'turn';
  readonly verdict: SweptPathVerdict;
  readonly minClearanceM: number;
  readonly requiredWidthM1d: number;
  readonly corridorPolygon: readonly Point[];
  readonly envelopePolygon: readonly Point[];
  /** Rear-axle center path. Kept for compatibility with the P0 overlay. */
  readonly drivenPath: readonly Point[];
  readonly rearAxlePath: readonly Point[];
  readonly frontAxlePath: readonly Point[];
  readonly bodyPoses: readonly Pose[];
  readonly bodyFootprints: readonly (readonly Point[])[];
  readonly overlapAreaM2: number;
  readonly biteSamples: readonly Point[];
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly optimization?: {
    readonly apexOffsetM: number;
    readonly candidates: readonly {
      readonly apexOffsetM: number;
      readonly minClearanceM: number;
      readonly overlapAreaM2: number;
    }[];
  };
}
