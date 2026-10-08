/**
 * Business parameters — the single home.
 *
 * Every threshold, radius, budget and margin the system uses lives here. There
 * is no numeric literal in domain logic: a parameter that is not in the policy
 * does not exist.
 *
 * No default is shipped. Values come from calibration against the corpus, and
 * shipping invented ones would make them look decided.
 */
import type { TruckProfile, TruckProfileId } from './truck.js';

export interface VehiclePolicy {
  readonly catalogue: readonly TruckProfile[];
  readonly defaultProfileId: TruckProfileId;
  /** Order within a family, from smallest to largest, for the step-up / step-down control. */
  readonly ladders: Readonly<Record<string, readonly TruckProfileId[]>>;
}

export interface DrivingPolicy {
  /** Lateral clearance required beside the vehicle, summed over both sides. */
  readonly lateralClearanceM: number;
  /** Free width below which a narrow street escalates rather than passing. */
  readonly narrowMinFreeM: number;
  /** At or above this, a street is wide enough that no measurement is needed. */
  readonly wideStreetM: number;
  readonly turnSweptClearanceM: number;
  readonly roundaboutSweptClearanceM: number;
  readonly slopeWarnPct: number;
  readonly slopeMaxPct: number;
  /** How far the vehicle may reverse as part of a manoeuvre. */
  readonly reversingAllowanceM: number;
  /** Whether a person on the ground guiding the reverse is assumed. */
  readonly banksmanAssumed: boolean;
}

export interface RelocationPolicy {
  /** How far the driver may walk from the stop to the door. */
  readonly walkingBudgetM: number;
  /** How far from the stop a turnaround candidate may be sought. */
  readonly turnaroundSearchRadiusM: number;
  /** Which grounds may be proposed as a turnaround. */
  readonly acceptableGrounds: readonly ('public' | 'private')[];
  /** Depth limit when re-anchoring through nested dead-ends. */
  readonly maxMouthDepth: number;
}

export interface ConfidencePolicy {
  /** At or above this, a measured fact may support an automatic OK. */
  readonly publishableConfidence: number;
  /** Below this, the point escalates to human review rather than resolving. */
  readonly escalationConfidence: number;
  /** Facts older than this are refetched rather than reused. Per source. */
  readonly maxFactAgeDays: Readonly<Record<string, number>>;
}

export interface MeasurementPolicy {
  /** Maximum distance between the stop and the window used to describe it. */
  readonly stopWindowMaxOffsetM: number;
  /** Snap tolerance when attaching a route sample to a road segment. */
  readonly segmentSnapM: number;
  readonly topologyFetchRadiusM: number;
  /** Merge rule when two sources state different limits. */
  readonly legalLimitMerge: 'smallest_wins' | 'highest_confidence_wins';
}

export interface RoutingPolicy {
  readonly candidateCount: number;
  /** Diversified candidates required before a large-vehicle answer is confident. */
  readonly minDiversifiedCandidates: number;
}

export interface BudgetPolicy {
  /** Ceiling on external provider spend for one analysis, in cents. */
  readonly maxCostCentsPerRun: number;
}

export interface Policy {
  /** Stamped on every run. Editing a value mints a new version; history is never mutated. */
  readonly version: string;
  readonly vehicles: VehiclePolicy;
  readonly driving: DrivingPolicy;
  readonly relocation: RelocationPolicy;
  readonly confidence: ConfidencePolicy;
  readonly measurement: MeasurementPolicy;
  readonly routing: RoutingPolicy;
  readonly budget: BudgetPolicy;
}
