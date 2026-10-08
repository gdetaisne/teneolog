/**
 * LA RECHERCHE DU TROIS TEMPS : le plan de chaque variante, les
 * départs essayés, les mouvements, le meilleur retenu. Repère canonique (branche
 * du côté y > 0, la droite du conducteur) ; `three-point.ts` en fait le résultat
 * et le miroir. Le modèle est écrit en tête de `three-point.ts`.
 */
import { truckCornersInto } from './geometry.js';
import { advanceRearAxle } from './kinematics.js';
import { sweptBranchHalfWidthM } from './three-point-branch-width.js';
import { firstContactRad } from './three-point-contact.js';
import {
  bodyInStreetBand,
  cornersFitCorridor,
  type BranchUse,
  type ThreePointCorridor,
} from './three-point-corridor.js';
import type { Pose, TruckSpec } from './types.js';

type Steer = -1 | 0 | 1;
type Direction = 1 | -1;

/** A piece of the sweep, replayable by `advanceRearAxle` (lengthM = rear-axle path, ≥ 0). */
export interface Segment {
  readonly start: Pose;
  readonly steer: Steer;
  readonly direction: Direction;
  readonly lengthM: number;
}

export interface Plan {
  /** Sign of the heading change, the same for every move (steer = rotation × direction). */
  readonly rotation: Direction;
  /** `reverse_into_branch`: the arrival is temps 1, and may end swinging away from the branch. */
  readonly arrivalIsTemps: boolean;
  readonly arrivalSwingsRad: readonly number[];
  /** Try the lateral starts from the branch-side edge first (backing in); else from the opposite edge. */
  readonly branchSideFirst: boolean;
  readonly firstDirection: Direction;
  readonly firstTargetRad: number;
  readonly finalTargetRad: number;
}

export interface SearchCtx {
  readonly truck: TruckSpec;
  readonly rr: number;
  readonly corridor: ThreePointCorridor;
  readonly unknownWidth: boolean;
}

export interface Attempt {
  readonly temps: number;
  readonly ghosts: readonly Pose[];
  readonly segments: readonly Segment[];
  readonly use: BranchUse;
}

interface Candidate {
  readonly start: Pose;
  readonly swingRad: number;
}

interface Run {
  readonly ghosts: Pose[];
  readonly segments: Segment[];
  readonly use: BranchUse;
}

interface Move {
  readonly end: Pose;
  readonly rotatedRad: number;
  readonly segment: Segment;
}

interface Temps {
  readonly end: Pose;
  /** The truck leaves (`leavesStreet`): the turn is over. */
  readonly done: boolean;
}

/** `reverse_into_branch`: how far the arrival may swing away from the branch before backing in. */
const ARRIVAL_SWINGS_DEG = [0, 20, 40] as const;
/** The swing leaves at least this much turn to the reverse into the branch. */
const MIN_REVERSE_TURN_DEG = 10;

/** π ± 5° : un demi-tour fini. Lu aussi par le demi-tour dans l'espace réel (`turnaround-plan.ts`) — une seule fermeture. */
export const CLOSURE_TOLERANCE_RAD = (5 * Math.PI) / 180;
/**
 * The first contact of a move is exact (`three-point-contact.ts`), and so is the
 * width it takes of a branch of unknown width (`three-point-branch-width.ts`).
 * Samples every 2° of heading still read the depth taken in the branch and
 * re-check each pose with the corridor's own cut (`cornersFitCorridor`). The
 * depth is a corner's y, a wave: between two samples it misses at most the
 * sagitta r·(1 − cos 1°), ≈ 2 mm past the street edge for a corner 12,7 m from
 * the centre (19 t) — 2 mm / sin(angle) along the branch. The width is not: its
 * widest point often slides along the street edge between two samples, and they
 * missed up to 0,6 m of it ( review).
 */
const HEADING_STEP_RAD = (2 * Math.PI) / 180;
const BISECTION_STEPS = 8;
/** A move that cannot turn 0,1° is stuck: the sequence ends there. */
const MIN_PROGRESS_RAD = (0.1 * Math.PI) / 180;
/**
 * Lateral start: gap between the truck's side and an edge, metres — from the
 * edge OPPOSITE the branch (the K-turn, the nose into the branch swing wide
 * from there), from the branch-side edge (backing in from a narrow street
 * needs it), and the centre. Absolute, not a share of the width: a wider
 * street keeps every start of a narrower one. The order only settles ties and
 * speeds the pruning: the likelier edge first (`Plan.branchSideFirst`).
 */
const EDGE_GAPS_M = [0, 0.15, 0.3, 0.6, 1.2, 2.5] as const;
/** Along the axis, around the start that lands the body on the branch axis, metres. */
const ALONG_OFFSETS_M = [0, -1, 1, -2, 2, -3, 3] as const;
const TIE_EPS = 1e-9;

/**
 * Canonical side (branch at y > 0). Forward into the branch: the heading
 * climbs 0 → angle → π. Reverse into it: it falls 0 → (swing) → angle − π,
 * pointing out of the branch → −π. No branch: 0 → π.
 */
export function planFor(
  variant: 'forward_into_branch' | 'reverse_into_branch' | 'no_branch',
  angleDeg: number,
): Plan {
  const angleRad = (angleDeg * Math.PI) / 180;
  if (variant === 'reverse_into_branch') {
    const swings = ARRIVAL_SWINGS_DEG.filter((swing) => swing <= 180 - angleDeg - MIN_REVERSE_TURN_DEG);
    return {
      rotation: -1,
      arrivalIsTemps: true,
      arrivalSwingsRad: swings.map((swing) => (swing * Math.PI) / 180),
      branchSideFirst: true,
      firstDirection: -1,
      firstTargetRad: angleRad - Math.PI,
      finalTargetRad: -Math.PI,
    };
  }
  return {
    rotation: 1,
    arrivalIsTemps: false,
    arrivalSwingsRad: [0],
    branchSideFirst: false,
    firstDirection: 1,
    firstTargetRad: variant === 'forward_into_branch' ? angleRad : Math.PI,
    finalTargetRad: Math.PI,
  };
}

/** The best attempt over the fixed list of starts, or null when none closes within `maxTemps`. */
export function searchThreePoint(ctx: SearchCtx, plan: Plan, maxTemps: number): Attempt | null {
  let best: Attempt | null = null;
  for (const candidate of candidates(ctx, plan)) {
    const attempt = runCandidate(ctx, plan, candidate, { maxTemps, best });
    if (attempt !== null && (best === null || isBetter(attempt, best, ctx))) best = attempt;
  }
  return best;
}

/** Signed gap from `a` to `b`, wrapped to (−π, π]. */
export function angleGap(a: number, b: number): number {
  const twoPi = 2 * Math.PI;
  let gap = (b - a) % twoPi;
  if (gap > Math.PI) gap -= twoPi;
  else if (gap <= -Math.PI) gap += twoPi;
  return gap;
}

/**
 * The starts, in a fixed order: lateral offset, then arrival swing, then the
 * position along the axis. With a branch, the reference position is the one
 * whose nominal first turn (no contact) ends with the rear axle — hence the
 * body, parallel to the branch — on the branch axis.
 */
function candidates(ctx: SearchCtx, plan: Plan): Candidate[] {
  const list: Candidate[] = [];
  for (const y0 of lateralStarts(ctx, plan.branchSideFirst)) {
    for (const swingRad of plan.arrivalSwingsRad) {
      for (const x of alongStarts(ctx, plan, y0, swingRad)) list.push({ start: { x, y: y0, headingRad: 0 }, swingRad });
    }
  }
  return list;
}

/** Rear-axle y of each lateral start, deduplicated, in a fixed order. */
function lateralStarts(ctx: SearchCtx, branchSideFirst: boolean): number[] {
  const h = ctx.corridor.halfStreetM;
  const play = 2 * h - ctx.truck.widthM;
  const opposite = EDGE_GAPS_M.map((gap) => gap);
  const branchSide = EDGE_GAPS_M.map((gap) => play - gap);
  const gaps = branchSideFirst ? [...branchSide, ...opposite, play / 2] : [...opposite, ...branchSide, play / 2];
  const kept: number[] = [];
  for (const gap of gaps) {
    if (gap < -TIE_EPS || gap > play + TIE_EPS) continue;
    if (kept.some((other) => Math.abs(other - gap) < 1e-6)) continue;
    kept.push(gap);
  }
  return kept.map((gap) => -h + ctx.truck.widthM / 2 + gap);
}

function alongStarts(ctx: SearchCtx, plan: Plan, y0: number, swingRad: number): number[] {
  const branch = ctx.corridor.branch;
  if (branch === null) return [0];
  let pose: Pose = { x: 0, y: y0, headingRad: 0 };
  if (swingRad > 0) pose = advanceRearAxle(pose, plan.rotation, swingRad * ctx.rr, ctx.rr);
  const turnRad = plan.rotation * (plan.firstTargetRad - pose.headingRad);
  const steer = (plan.rotation * plan.firstDirection) as Steer;
  pose = advanceRearAxle(pose, steer, plan.firstDirection * turnRad * ctx.rr, ctx.rr);
  // Shifting the start by x shifts the lateral gap to the branch axis by x·nx = −x·sin(angle).
  const reference = (pose.x * branch.nx + pose.y * branch.ny) / branch.sinAngle;
  return ALONG_OFFSETS_M.map((delta) => reference + delta);
}

interface Bar {
  readonly maxTemps: number;
  readonly best: Attempt | null;
}

/**
 * Can this run still beat the best? `temps` is a lower bound of its final count
 * and `use` of its final branch use (both only grow): prune as soon as it cannot.
 */
function ruledOut(ctx: SearchCtx, bar: Bar, temps: number, use: BranchUse): boolean {
  const best = bar.best;
  if (best === null) return temps > bar.maxTemps;
  if (temps !== best.temps) return temps > best.temps;
  if (ctx.unknownWidth && use.halfWidthM > best.use.halfWidthM + TIE_EPS) return true;
  if (ctx.unknownWidth && use.halfWidthM < best.use.halfWidthM - TIE_EPS) return false;
  return use.depthM > best.use.depthM + TIE_EPS;
}

/** Fewest temps, then (width unknown) the narrowest branch, then the shallowest; ties keep the first. */
function isBetter(a: Attempt, b: Attempt, ctx: SearchCtx): boolean {
  if (a.temps !== b.temps) return a.temps < b.temps;
  if (ctx.unknownWidth && Math.abs(a.use.halfWidthM - b.use.halfWidthM) > TIE_EPS) {
    return a.use.halfWidthM < b.use.halfWidthM;
  }
  return a.use.depthM < b.use.depthM - TIE_EPS;
}

/**
 * One start, the whole alternation, until the truck leaves (`oneTemps`); null
 * when it sticks or cannot beat the best.
 */
function runCandidate(ctx: SearchCtx, plan: Plan, candidate: Candidate, bar: Bar): Attempt | null {
  const run: Run = { ghosts: [], segments: [approach(ctx, candidate.start)], use: { depthM: 0, halfWidthM: 0 } };
  if (!fits(ctx, candidate.start, run.use)) return null;
  let pose = plan.arrivalIsTemps ? arrive(ctx, plan, candidate, run) : candidate.start;
  let direction = plan.firstDirection;
  let target = plan.firstTargetRad;
  for (;;) {
    if (ruledOut(ctx, bar, run.ghosts.length + 1, run.use)) return null;
    const temps = oneTemps(ctx, plan, { pose, direction, target }, run);
    if (temps === null) return null;
    if (temps.done) break;
    pose = temps.end;
    direction = direction === 1 ? -1 : 1;
    target = plan.finalTargetRad;
  }
  if (ruledOut(ctx, bar, run.ghosts.length, run.use)) return null;
  return { temps: run.ghosts.length, ghosts: run.ghosts, segments: run.segments, use: run.use };
}

/**
 * One temps at full lock, stopped by the first contact. The turn is DONE when a
 * forward move ends with the heading reversed (±5°) and the truck can leave
 * (`leavesStreet`). A forward move that starts with the heading already
 * reversed is the drive-away after a final reverse, a temps of its own: it may
 * turn by nothing, and once done it goes one truck length straight, drawn. Not
 * done: the alternation goes on. Null when the move sticks.
 */
function oneTemps(
  ctx: SearchCtx,
  plan: Plan,
  from: { readonly pose: Pose; readonly direction: Direction; readonly target: number },
  run: Run,
): Temps | null {
  const driveAway = from.direction === 1 && headingReversed(from.pose, plan);
  const move = runArc(ctx, from.pose, from.direction, plan.rotation, from.target, run.use);
  const stuck = move.rotatedRad < MIN_PROGRESS_RAD;
  if (stuck && !driveAway) return null;
  if (move.rotatedRad > 0) run.segments.push(move.segment);
  const done = from.direction === 1 && headingReversed(move.end, plan) && leavesStreet(ctx, move.end);
  if (stuck && !done) return null;
  const end = done && driveAway ? straightAway(ctx, move.end, run) : move.end;
  run.ghosts.push(end);
  return { end, done };
}

function headingReversed(pose: Pose, plan: Plan): boolean {
  return Math.abs(angleGap(pose.headingRad, plan.finalTargetRad)) <= CLOSURE_TOLERANCE_RAD;
}

/**
 * The truck can leave: its whole body lies in the street band — nothing left in
 * the branch —, and so does it one truck length straight ahead. Exact: a
 * translation sweeps the convex hull of its two ends, and the band is convex.
 */
function leavesStreet(ctx: SearchCtx, pose: Pose): boolean {
  truckCornersInto(pose, ctx.truck, corners);
  if (!bodyInStreetBand(corners, ctx.corridor)) return false;
  truckCornersInto(advanceRearAxle(pose, 0, ctx.truck.lengthM, ctx.rr), ctx.truck, corners);
  return bodyInStreetBand(corners, ctx.corridor);
}

/** One truck length straight ahead, drawn — free by `leavesStreet`. */
function straightAway(ctx: SearchCtx, pose: Pose, run: Run): Pose {
  run.segments.push({ start: pose, steer: 0, direction: 1, lengthM: ctx.truck.lengthM });
  return advanceRearAxle(pose, 0, ctx.truck.lengthM, ctx.rr);
}

/** One truck length of straight arrival, drawn, never tested: the street band holds it by construction. */
function approach(ctx: SearchCtx, start: Pose): Segment {
  const lengthM = ctx.truck.lengthM;
  return { start: { ...start, x: start.x - lengthM }, steer: 0, direction: 1, lengthM };
}

/**
 * The arrival as temps 1 (`reverse_into_branch`): straight past the branch, then
 * — if the candidate says so — a forward swing at full lock AWAY from the branch,
 * the nose to the far side, stopped by the first contact: what a driver does
 * before backing into a lot entrance from a narrow street.
 */
function arrive(ctx: SearchCtx, plan: Plan, candidate: Candidate, run: Run): Pose {
  if (candidate.swingRad === 0) {
    run.ghosts.push(candidate.start);
    return candidate.start;
  }
  const move = runArc(ctx, candidate.start, 1, plan.rotation, plan.rotation * candidate.swingRad, run.use);
  if (move.rotatedRad > 0) run.segments.push(move.segment);
  run.ghosts.push(move.end);
  return move.end;
}

/** Corner buffer of the hot path (the search is synchronous). */
const corners = new Float64Array(8);

function fits(ctx: SearchCtx, pose: Pose, use: BranchUse | null): boolean {
  truckCornersInto(pose, ctx.truck, corners);
  return cornersFitCorridor(corners, ctx.corridor, use);
}

/**
 * One move at full lock: steer = rotation × direction, so the heading turns by
 * `rotation` whether the truck goes forward or back. It stops at the first
 * contact, in closed form (`firstContactRad`); the 2° samples up to there read
 * the branch depth and re-check each pose (a disagreement closes in by
 * bisection). Width unknown: the width taken over the whole move, in closed
 * form (`sweptBranchHalfWidthM`) — the ranking and the width served read it.
 */
function runArc(
  ctx: SearchCtx,
  start: Pose,
  direction: Direction,
  rotation: Direction,
  targetRad: number,
  use: BranchUse,
): Move {
  const steer = (rotation * direction) as 1 | -1;
  const totalRad = Math.max(0, rotation * (targetRad - start.headingRad));
  const contactRad = firstContactRad(ctx.corridor, ctx.truck, start, steer, rotation, ctx.rr, totalRad);
  const poseAt = (rotated: number): Pose => advanceRearAxle(start, steer, direction * rotated * ctx.rr, ctx.rr);
  const rotatedRad = lastFree(contactRad, HEADING_STEP_RAD, (rotated) => fits(ctx, poseAt(rotated), use));
  if (ctx.unknownWidth) {
    const swept = sweptBranchHalfWidthM(ctx.corridor, ctx.truck, start, steer, rotation, ctx.rr, rotatedRad);
    use.halfWidthM = Math.max(use.halfWidthM, swept);
  }
  return { end: poseAt(rotatedRad), rotatedRad, segment: { start, steer, direction, lengthM: rotatedRad * ctx.rr } };
}

/** The largest t in [0, total] with every sample up to it free: steps, then bisection on the first contact. */
function lastFree(total: number, step: number, isFree: (t: number) => boolean): number {
  let free = 0;
  for (let t = Math.min(step, total); free < total; t = Math.min(t + step, total)) {
    if (!isFree(t)) return bisect(free, t, isFree);
    free = t;
  }
  return free;
}

function bisect(free: number, blocked: number, isFree: (t: number) => boolean): number {
  let lo = free;
  let hi = blocked;
  for (let i = 0; i < BISECTION_STEPS; i += 1) {
    const mid = (lo + hi) / 2;
    if (isFree(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
