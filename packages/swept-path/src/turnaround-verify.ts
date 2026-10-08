/**
 * LA VÉRIFICATION EXACTE du chemin trouvé, indépendante de la grille.
 *
 * La recherche garantit déjà la caisse dans l'espace (enveloppe de chaque pas,
 * `turnaround-motion.ts`) ; ceci en est le contre-examen, sur les côtés des
 * anneaux eux-mêmes : tous les `VERIFY_STEP_M` (5 cm) de chemin de l'essieu
 * arrière, et sur la longueur de camion du départ, la caisse doit avoir
 * l'essieu arrière dedans (pair-impair), aucun anneau en elle, et ses quatre
 * côtés à une distance STRICTEMENT positive de tout côté des anneaux. Un
 * échec n'est jamais servi : le résultat devient « pas trouvé » avec
 * `exact_check_failed` (principe 14 : on dit ce qu'on n'a pas su faire).
 *
 * Elle rend aussi la plus petite distance mesurée entre la caisse et le bord
 * (plafonnée à 1 m) : ce que le chemin laisse de place, à la tolérance du
 * cadastre près (±1–2 m), jamais une marge garantie sur le terrain.
 */
import { truckCornersInto } from './geometry.js';
import { convexHullInto, ringInside, stepPose, type MotionCtx } from './turnaround-motion.js';
import type { PathStep } from './turnaround-search.js';
import { exactSegmentClearance, pointInSpace } from './turnaround-space.js';
import type { Pose } from './types.js';

const VERIFY_STEP_M = 0.05;
const CLEARANCE_CAP_M = 1;

export interface Verification {
  readonly ok: boolean;
  /** La plus petite distance caisse–bord sur tout le chemin, plafonnée à 1 m (0 quand un échantillon sort). */
  readonly minClearanceM: number;
}

/** La distance exacte de la caisse au bord à cette pose, 0 quand elle n'est pas dedans. */
function bodyClearance(ctx: MotionCtx, pose: Pose): number {
  if (!pointInSpace(ctx.space, pose.x, pose.y)) return 0;
  const c = ctx.corners;
  truckCornersInto(pose, ctx.truck, c.subarray(0, 8));
  // `truckCornersInto` tourne dans le sens indirect ; le test d'anneau veut un polygone direct.
  if (ringInside(ctx.space, ctx.hull, convexHullInto(c, 4, ctx.hull))) return 0;
  let best = CLEARANCE_CAP_M;
  for (let k = 0; k < 4; k += 1) {
    const j = (k + 1) % 4;
    best = Math.min(best, exactSegmentClearance(ctx.space, c[k * 2]!, c[k * 2 + 1]!, c[j * 2]!, c[j * 2 + 1]!, CLEARANCE_CAP_M));
  }
  return best;
}

function stepClearance(ctx: MotionCtx, from: Pose, steer: number, signedLengthM: number): number {
  const count = Math.max(1, Math.ceil(Math.abs(signedLengthM) / VERIFY_STEP_M));
  let best = CLEARANCE_CAP_M;
  for (let i = 0; i <= count; i += 1) {
    best = Math.min(best, bodyClearance(ctx, stepPose(ctx, from, steer, (signedLengthM * i) / count)));
    if (best <= 0) return 0;
  }
  return best;
}

/** Tout le chemin, puis la longueur de camion tout droit devant la dernière pose. */
export function verifyPath(ctx: MotionCtx, path: readonly PathStep[], driveAwayM: number): Verification {
  let best = bodyClearance(ctx, path[0]!.pose);
  for (let k = 1; k < path.length && best > 0; k += 1) {
    const step = path[k]!;
    best = Math.min(best, stepClearance(ctx, path[k - 1]!.pose, step.steer, step.dir * step.lengthM));
  }
  if (best > 0) best = Math.min(best, stepClearance(ctx, path[path.length - 1]!.pose, 0, driveAwayM));
  return { ok: best > 0, minClearanceM: Math.max(0, best) };
}
