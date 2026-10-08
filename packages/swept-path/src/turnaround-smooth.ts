/**
 * LE CHEMIN LISSÉ : le même demi-tour, sans les zigzags du braquage tout ou rien.
 *
 * Décision produit : « le trajet du camion n'est pas 100 % fluide avant le début de la
 * manœuvre — pas rassurant, si ce n'est pas fluide un bug se prépare ». La cause, mesurée sur le vrai
 * cas : la recherche (`turnaround-search.ts`) ne connaît que le braquage maxi ou le droit ; à la
 * Sèvremoine, pour suivre le coude doux de la voie puis prendre large avant la placette, le 19 t roule
 * 19,8 m droit, 3,4 à gauche, 2,5 à droite, 13,4 droit, 2,0 à gauche, 2,3 à droite, 15,5 à gauche : le
 * braquage passe du plein droite au plein gauche d'un pas à l'autre, le cap fait ~60° d'aller-retour
 * (jusqu'à −25° puis +22° sur le run local du 2026-09-28) là où la voie ne tourne que de quelques degrés.
 * L'animation (`manoeuvre-motion.ts` du front) joue fidèlement ces poses : c'est le chemin qui zigzague,
 * pas son interpolation.
 *
 * LE LISSAGE, mouvement par mouvement, APRÈS la recherche et sa vérification exacte. La recherche, le
 * nombre de temps, les sens, et la pose où finit chaque mouvement (les fantômes) ne changent pas :
 *  1. le braquage du mouvement, lu sur des pas égaux d'au plus 0,5 m (la moyenne exacte du braquage de
 *     la recherche sur chaque pas), est adouci par un noyau gaussien — seulement autour des changements
 *     de braquage en roulant (± 3 écarts types) ; ailleurs, c'est l'arc même de la recherche ;
 *  2. chaque tronçon adouci finit sur la pose EXACTE où finit le même tronçon de la recherche : trois
 *     inconnues (une correction du braquage en cloche et en S, nulle aux bouts du tronçon et pondérée par
 *     ce qu'il reste de braquage — nulle au braquage maxi —, et la longueur du pas), trois équations
 *     (x, y, cap), résolues par Newton au nanomètre. Un braquage hors de [−1, 1] est refusé : la
 *     bicyclette reste exacte, le rayon de l'essieu arrière jamais sous Rr ;
 *  3. le mouvement lissé passe les DEUX contrôles du chemin de la recherche : le balayage de chaque pas
 *     dans l'espace à 2 cm près (`sweepClear`, flèche bornée pour un braquage partiel), puis la
 *     vérification exacte tous les 5 cm sur les côtés des anneaux et des aires interdites (`verifyPath`) ;
 *  4. les écarts types vont du plus doux au plus serré (`SMOOTHING_SIGMAS_M`, 3 m à 0,5 m — une rampe
 *     de braquage de 2 à 3 m au plus serré, celle d'un chauffeur) ; chaque tronçon prend le premier qui
 *     passe ; un changement de braquage qu'aucun ne couvre reste celui de la recherche ; un mouvement
 *     sans tronçon retenu est gardé tel quel, au bit près.
 *
 * Ce que le lissage ne fait pas : chercher un autre chemin. Un mouvement lissé reste dans le couloir
 * du chemin trouvé (34 cm au plus à la Sèvremoine) ; s'il n'y tient pas, c'est le chemin brut. Entre
 * deux braquages maxi de sens contraires, le chemin de la recherche est déjà l'extrême : il reste tel quel.
 */
import { angleGap } from './three-point-search.js';
import { stepPose, sweepClear, type Direction, type MotionCtx } from './turnaround-motion.js';
import { TURNAROUND_STEP_M, type PathStep } from './turnaround-search.js';
import { verifyPath } from './turnaround-verify.js';
import type { Pose } from './types.js';

/** Les écarts types du noyau essayés, en mètres de chemin de l'essieu arrière, du plus doux au plus serré. */
export const SMOOTHING_SIGMAS_M: readonly number[] = [3, 2, 1, 0.5];
/** Le noyau s'arrête à tant d'écarts types. */
const KERNEL_SPAN = 3;
const NEWTON_MAX_ITERATIONS = 12;
/** La pose visée est tenue au nanomètre (x, y en mètres, cap en radians). */
const NEWTON_TOLERANCE = 1e-9;
const JACOBIAN_STEP = 1e-7;
/** Deux braquages plus proches que ça sont le même (une moyenne de pas qui retombe sur −1, 0 ou 1). */
const SAME_STEER = 1e-12;
/** La longueur d'un tronçon lissé reste à moitié près de celle de la recherche : au-delà, c'est un autre chemin. */
const MAX_LENGTH_CHANGE = 0.5;

/** Un mouvement de la recherche : `path[from]` est sa pose de départ, `path[from + 1 .. to]` ses pas. */
interface MoveRange {
  readonly from: number;
  readonly to: number;
}

/** Le mouvement sur des pas égaux : `raw[i]`, le braquage moyen exact de la recherche sur le pas i. */
interface Profile {
  readonly ctx: MotionCtx;
  readonly path: readonly PathStep[];
  readonly range: MoveRange;
  readonly dir: Direction;
  readonly h0: number;
  readonly raw: Float64Array;
}

/** Un tronçon adouci : les pas [i0, i1) du profil. */
interface Support {
  readonly i0: number;
  readonly i1: number;
}

function moveRanges(path: readonly PathStep[]): MoveRange[] {
  const ranges: MoveRange[] = [];
  let from = 0;
  for (let k = 1; k < path.length; k += 1) {
    if (k === path.length - 1 || path[k + 1]!.dir !== path[k]!.dir) {
      ranges.push({ from, to: k });
      from = k;
    }
  }
  return ranges;
}

/** −1, 0 ou 1 quand la moyenne y retombe (un pas tout entier dans un arc de la recherche). */
function snapped(steer: number): number {
  const whole = Math.round(steer);
  return Math.abs(steer - whole) < SAME_STEER ? whole : steer;
}

function profileOf(ctx: MotionCtx, path: readonly PathStep[], range: MoveRange): Profile {
  let length = 0;
  for (let k = range.from + 1; k <= range.to; k += 1) length += path[k]!.lengthM;
  const n = Math.max(1, Math.ceil(length / TURNAROUND_STEP_M - 1e-9));
  const h0 = length / n;
  const raw = new Float64Array(n);
  let s = 0;
  for (let k = range.from + 1; k <= range.to; k += 1) {
    const step = path[k]!;
    const end = s + step.lengthM;
    for (let i = Math.min(n - 1, Math.floor(s / h0)); i < n && i * h0 < end; i += 1) {
      const overlap = Math.min(end, (i + 1) * h0) - Math.max(s, i * h0);
      if (overlap > 0) raw[i] = raw[i]! + (step.steer * overlap) / h0;
    }
    s = end;
  }
  for (let i = 0; i < n; i += 1) raw[i] = snapped(raw[i]!);
  return { ctx, path, range, dir: path[range.to]!.dir, h0, raw };
}

/** La pose exacte de la recherche à `d` mètres du début du mouvement. */
function rawPoseAt(profile: Profile, d: number): Pose {
  const { ctx, path, range } = profile;
  if (d <= 0) return path[range.from]!.pose;
  let s = 0;
  for (let k = range.from + 1; k <= range.to; k += 1) {
    const step = path[k]!;
    if (k === range.to) return d >= s + step.lengthM ? step.pose : stepPose(ctx, path[k - 1]!.pose, step.steer, step.dir * (d - s));
    if (d < s + step.lengthM) return stepPose(ctx, path[k - 1]!.pose, step.steer, step.dir * (d - s));
    s += step.lengthM;
  }
  return path[range.to]!.pose;
}

/** Le braquage adouci : la moyenne gaussienne, les bouts du mouvement prolongés (le braquage à l'arrêt est libre). */
function gaussian(raw: Float64Array, sigmaSteps: number, span: number): Float64Array {
  const n = raw.length;
  const weights: number[] = [];
  let total = 0;
  for (let j = -span; j <= span; j += 1) {
    const w = Math.exp(-(j * j) / (2 * sigmaSteps * sigmaSteps));
    weights.push(w);
    total += w;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let j = -span; j <= span; j += 1) sum += weights[j + span]! * raw[Math.min(n - 1, Math.max(0, i + j))]!;
    out[i] = sum / total;
  }
  return out;
}

/** Les tronçons où le braquage adouci diffère de celui de la recherche : ± `span` pas autour de chaque changement. */
function supportsOf(raw: Float64Array, span: number): Support[] {
  const supports: Support[] = [];
  for (let c = 1; c < raw.length; c += 1) {
    if (Math.abs(raw[c]! - raw[c - 1]!) < SAME_STEER) continue;
    const i0 = Math.max(0, c - span);
    const i1 = Math.min(raw.length, c + span);
    const last = supports[supports.length - 1];
    if (last !== undefined && i0 <= last.i1) supports[supports.length - 1] = { i0: last.i0, i1: Math.max(last.i1, i1) };
    else supports.push({ i0, i1 });
  }
  return supports;
}

/** Le braquage du tronçon pour la correction (a en cloche, b en S), pondérée par ce qu'il reste de braquage. */
function correctedSteers(smooth: Float64Array, support: Support, a: number, b: number): Float64Array {
  const count = support.i1 - support.i0;
  const out = new Float64Array(count);
  for (let k = 0; k < count; k += 1) {
    const t = (2 * k + 1) / count - 1;
    const bump = 1 - t * t;
    const base = smooth[support.i0 + k]!;
    out[k] = base + (1 - Math.abs(base)) * bump * (a + b * t);
  }
  return out;
}

function endPose(ctx: MotionCtx, start: Pose, steers: Float64Array, signedStepM: number): Pose {
  let pose = start;
  for (const steer of steers) pose = stepPose(ctx, pose, steer, signedStepM);
  return pose;
}

function residual(end: Pose, target: Pose): [number, number, number] {
  return [end.x - target.x, end.y - target.y, angleGap(target.headingRad, end.headingRad)];
}

/** Le système 3 × 3 (colonnes `j0`, `j1`, `j2`) par Cramer ; null quand il est singulier. */
function solve3(j0: readonly number[], j1: readonly number[], j2: readonly number[], f: readonly number[]): number[] | null {
  const det = (a: readonly number[], b: readonly number[], c: readonly number[]): number =>
    a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - b[0]! * (a[1]! * c[2]! - a[2]! * c[1]!) + c[0]! * (a[1]! * b[2]! - a[2]! * b[1]!);
  const d = det(j0, j1, j2);
  if (!(Math.abs(d) > 1e-18)) return null;
  return [det(f, j1, j2) / d, det(j0, f, j2) / d, det(j0, j1, f) / d];
}

interface Solved {
  readonly start: Pose;
  readonly target: Pose;
  readonly steers: Float64Array;
  readonly stepM: number;
}

/**
 * Le tronçon adouci qui finit sur la pose de la recherche : Newton sur (a, b, longueur du pas), la
 * jacobienne par différences. Null quand il ne converge pas, qu'un braquage sort de [−1, 1] (entre deux
 * braquages maxi de sens contraires, le chemin de la recherche est déjà l'extrême : rien à adoucir sans
 * en sortir) ou que la longueur s'écarte de plus de moitié de celle de la recherche.
 */
function solveSupport(profile: Profile, smooth: Float64Array, support: Support): Solved | null {
  const { ctx, dir, h0 } = profile;
  const start = rawPoseAt(profile, support.i0 * h0);
  const target = rawPoseAt(profile, support.i1 * h0);
  const at = (u: readonly number[]): [number, number, number] =>
    residual(endPose(ctx, start, correctedSteers(smooth, support, u[0]!, u[1]!), dir * u[2]!), target);
  const u = [0, 0, h0];
  for (let iteration = 0; iteration < NEWTON_MAX_ITERATIONS; iteration += 1) {
    const f = at(u);
    if (Math.max(Math.abs(f[0]), Math.abs(f[1]), Math.abs(f[2])) < NEWTON_TOLERANCE) {
      const steers = correctedSteers(smooth, support, u[0]!, u[1]!);
      return feasible(steers, u[2]!, h0) ? { start, target, steers, stepM: u[2]! } : null;
    }
    const columns = [0, 1, 2].map((j) => {
      const moved = [...u];
      moved[j] = moved[j]! + JACOBIAN_STEP;
      return at(moved).map((v, k) => (v - f[k]!) / JACOBIAN_STEP);
    });
    const delta = solve3(columns[0]!, columns[1]!, columns[2]!, f);
    if (delta === null) return null;
    for (let j = 0; j < 3; j += 1) u[j] = u[j]! - delta[j]!;
    if (!(u[2]! > 0)) return null;
  }
  return null;
}

/** Le braquage dans [−1, 1] (le rayon de l'essieu arrière jamais sous Rr), la longueur à moitié près de celle de la recherche. */
function feasible(steers: Float64Array, stepM: number, h0: number): boolean {
  if (Math.abs(stepM - h0) > h0 * MAX_LENGTH_CHANGE) return false;
  for (const steer of steers) if (!(Math.abs(steer) <= 1)) return false;
  return true;
}

/**
 * Les pas servis d'un tronçon résolu : un pas plus long que `TURNAROUND_STEP_M` est coupé en pas égaux de
 * même braquage (le même arc) ; le dernier finit sur la pose de la recherche, au bit près.
 */
function servedSteps(ctx: MotionCtx, dir: Direction, solved: Solved): PathStep[] {
  const pieces = Math.max(1, Math.ceil(solved.stepM / TURNAROUND_STEP_M - 1e-9));
  const lengthM = solved.stepM / pieces;
  const steps: PathStep[] = [];
  let pose = solved.start;
  for (const steer of solved.steers) {
    for (let piece = 0; piece < pieces; piece += 1) {
      pose = stepPose(ctx, pose, steer, dir * lengthM);
      steps.push({ pose, dir, steer, lengthM });
    }
  }
  steps[steps.length - 1] = { ...steps[steps.length - 1]!, pose: solved.target };
  return steps;
}

/** Les deux contrôles du chemin de la recherche : le balayage de chaque pas à 2 cm près, puis la vérification exacte. */
function stepsHold(ctx: MotionCtx, start: PathStep, steps: readonly PathStep[]): boolean {
  let from = start.pose;
  for (const step of steps) {
    if (!sweepClear(ctx, from, step.pose, step.steer, step.lengthM)) return false;
    from = step.pose;
  }
  return verifyPath(ctx, [start, ...steps], 0).ok;
}

/** Un tronçon lissé et retenu : ses pas remplacent ceux de la recherche sur [i0, i1). */
interface Kept {
  readonly support: Support;
  readonly steps: readonly PathStep[];
}

/**
 * Les tronçons retenus : pour chaque écart type, du plus doux au plus serré, chaque tronçon qui ne recoupe
 * pas un tronçon déjà retenu est résolu puis contrôlé seul — ses deux bouts sont des poses de la
 * recherche. Un changement de braquage qu'aucun tronçon retenu ne couvre reste celui de la recherche.
 */
function keptSupports(profile: Profile): Kept[] {
  const { ctx, dir, h0, raw } = profile;
  const kept: Kept[] = [];
  for (const sigmaM of SMOOTHING_SIGMAS_M) {
    const span = Math.max(1, Math.ceil((KERNEL_SPAN * sigmaM) / h0));
    const smooth = gaussian(raw, sigmaM / h0, span);
    for (const support of supportsOf(raw, span)) {
      if (kept.some((k) => k.support.i0 < support.i1 && support.i0 < k.support.i1)) continue;
      const solved = solveSupport(profile, smooth, support);
      if (solved === null) continue;
      const steps = servedSteps(ctx, dir, solved);
      if (stepsHold(ctx, { pose: solved.start, dir, steer: 0, lengthM: 0 }, steps)) kept.push({ support, steps });
    }
  }
  return kept.sort((a, b) => a.support.i0 - b.support.i0);
}

/**
 * Les pas de la recherche entre `fromM` et `toM` mètres du début du mouvement, depuis `start` (la pose de la
 * recherche à `fromM`), coupés aux deux bouts : ses arcs mêmes, braquage compris — un changement de
 * braquage qu'aucun tronçon retenu ne couvre reste instantané, jamais moyenné.
 */
function searchedSteps(profile: Profile, start: Pose, fromM: number, toM: number): PathStep[] {
  const { ctx, path, range, dir } = profile;
  const steps: PathStep[] = [];
  let pose = start;
  let s = 0;
  for (let k = range.from + 1; k <= range.to && s < toM; k += 1) {
    const step = path[k]!;
    const lengthM = Math.min(s + step.lengthM, toM) - Math.max(s, fromM);
    s += step.lengthM;
    if (!(lengthM > 1e-9)) continue;
    pose = stepPose(ctx, pose, step.steer, dir * lengthM);
    steps.push({ pose, dir, steer: step.steer, lengthM });
  }
  return steps;
}

/** Le mouvement servi : les tronçons retenus, et entre eux les pas de la recherche ; null sans tronçon retenu. */
function smoothMove(ctx: MotionCtx, path: readonly PathStep[], range: MoveRange): PathStep[] | null {
  const profile = profileOf(ctx, path, range);
  const kept = keptSupports(profile);
  if (kept.length === 0) return null;
  const { h0, raw } = profile;
  const steps: PathStep[] = [];
  let pose = path[range.from]!.pose;
  let doneM = 0;
  for (const { support, steps: smoothed } of kept) {
    steps.push(...searchedSteps(profile, pose, doneM, support.i0 * h0), ...smoothed);
    pose = smoothed[smoothed.length - 1]!.pose;
    doneM = support.i1 * h0;
  }
  steps.push(...searchedSteps(profile, pose, doneM, raw.length * h0 + 1));
  // La fin du mouvement est celle de la recherche, au bit près : le fantôme et le mouvement suivant en partent.
  steps[steps.length - 1] = { ...steps[steps.length - 1]!, pose: path[range.to]!.pose };
  return steps;
}

export interface SmoothedPath {
  /** Le chemin servi : le départ, puis les pas, mouvement lissé ou mouvement de la recherche. */
  readonly path: readonly PathStep[];
  /** Pour chaque mouvement, dans l'ordre : lissé (au moins un tronçon), ou gardé tel que la recherche l'a trouvé. */
  readonly smoothed: readonly boolean[];
}

/**
 * Le chemin de la recherche, chaque mouvement lissé là où un lissage passe les deux contrôles. Les
 * mouvements, leurs sens et leurs poses de fin sont ceux de la recherche. Pur, déterministe.
 */
export function smoothPath(ctx: MotionCtx, path: readonly PathStep[]): SmoothedPath {
  const out: PathStep[] = [path[0]!];
  const smoothed: boolean[] = [];
  for (const range of moveRanges(path)) {
    const steps = smoothMove(ctx, path, range);
    smoothed.push(steps !== null);
    out.push(...(steps ?? path.slice(range.from + 1, range.to + 1)));
  }
  return { path: out, smoothed };
}
