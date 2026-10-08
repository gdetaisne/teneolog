/**
 * The analysis as a whole: the stage outputs, in order, each one persisted as
 * it is produced.
 *
 * S0 to S4 describe the road and hold no truck. S5 onward hold one. That line
 * is the architecture: everything above it is cached by location and reused
 * when the same address is asked about a different vehicle.
 */
import type { DeliveryAnchor } from './anchor.js';
import type { Fact } from './fact.js';
import type { StopConstraints } from './constraints.js';
import type { CriticalPoint } from './point.js';
import type { RouteCandidate } from './route.js';
import type { TopologyAssessment } from './topology.js';
import type { TruckProfileId } from './truck.js';
import type { Judgement, RunConclusion } from './verdict.js';

/** Everything the road says, with no vehicle applied. Cached by location. */
export interface RoadFacts {
  readonly anchor: DeliveryAnchor;
  readonly topology: TopologyAssessment;
  readonly stop: StopConstraints;
  /**
   * Wrapped: an empty candidate set is ambiguous on its own. "No itinerary
   * survives the constraints" and "the router was unreachable" must not reach
   * the reader as the same answer.
   */
  readonly candidates: Fact<readonly RouteCandidate[]>;
  readonly points: readonly CriticalPoint[];
}

export type StageName = 'resolve' | 'topology' | 'stop' | 'routes' | 'points' | 'project' | 'conclude';

export interface StageSnapshot {
  readonly stage: StageName;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly costCents: number;
  /** True when the stage was served from cache rather than recomputed. */
  readonly fromCache: boolean;
}

export interface Run {
  readonly id: string;
  readonly profileId: TruckProfileId;
  readonly policyVersion: string;
  readonly road: RoadFacts;
  readonly judgements: readonly Judgement[];
  readonly conclusion: RunConclusion;
  readonly stages: readonly StageSnapshot[];
  readonly createdAt: string;
}
