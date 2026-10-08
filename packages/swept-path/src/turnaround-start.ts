/**
 * OÙ LE CAMION EST ARRÊTÉ, quand la pose demandée ne tient pas dans l'espace.
 *
 *  - GLISSÉE DE CÔTÉ (`startShiftMaxM`) : l'axe OSM et le cadastre se calent à un ou deux mètres près ;
 *    la plus proche d'abord, 5 cm par 5 cm, à gauche puis à droite.
 *  - RECULÉE LE LONG DU CHEMIN D'ARRIVÉE, de l'arrêt vers la bouche (`startBackMaxM`, `arrival`), 25 cm
 *    par 25 cm (la case du réseau), glissée de côté à chaque pas : l'essieu arrière posé sur l'arrêt met
 *    la caisse jusqu'à empattement + porte-à-faux avant au-delà (7,3 m pour le 19 t) ; au bout d'une
 *    impasse, elle sort de l'espace alors que le camion, qui s'arrête le nez au bout, tient (relecture du
 *    2026-09-25 : trois espaces sur sept de la mesure du corpus tombaient là). Le cap est à rebours du
 *    segment où l'on se trouve. Le chemin d'arrivée part de l'arrêt lui-même, pas de sa projection sur le
 *    chemin de sortie : sur une impasse en « P », celui-ci est coupé au col, et un arrêt sur la boucle
 *    s'y projetait au col — le camion sautait sur la tige, 19 m plus loin, pour un recul dit de 4,5 m
 *    (seconde relecture du 2026-09-25).
 */
import { poseInSpace, type MotionCtx } from './turnaround-motion.js';
import type { Pose } from './types.js';

const START_SHIFT_STEP_M = 0.05;
const START_BACK_STEP_M = 0.25;

export interface StartPlacement {
  readonly pose: Pose;
  /** Le glissement de côté (+ à gauche du conducteur). */
  readonly shiftM: number;
  /** Le recul le long du chemin d'arrivée, vers la bouche. */
  readonly backM: number;
}

export interface StartRoom {
  readonly shiftMaxM: number;
  readonly backMaxM: number;
  /** Le chemin d'arrivée, de l'arrêt vers la bouche, en segments (`exitSegments`) ; vide : pas de recul. */
  readonly arrival: Float64Array;
}

/** La pose, ou la plus proche glissée de côté (+ avant −, 5 cm par 5 cm) qui tient dans l'espace. */
function shifted(ctx: MotionCtx, base: Pose, maxShiftM: number): { pose: Pose; shiftM: number } | null {
  const lx = -Math.sin(base.headingRad);
  const ly = Math.cos(base.headingRad);
  const steps = Math.floor(maxShiftM / START_SHIFT_STEP_M + 1e-9);
  for (let k = 0; k <= steps; k += 1) {
    for (const sign of k === 0 ? [0] : [1, -1]) {
      const d = sign * k * START_SHIFT_STEP_M;
      const pose = { x: base.x + d * lx, y: base.y + d * ly, headingRad: base.headingRad };
      if (poseInSpace(ctx, pose)) return { pose, shiftM: d };
    }
  }
  return null;
}

/**
 * Le point `d` mètres le long du chemin d'arrivée depuis son début (l'arrêt), cap à rebours du segment
 * (le camion regarde le bout) ; null au-delà du chemin.
 */
function backAlong(segments: Float64Array, d: number): Pose | null {
  let left = d;
  for (let s = 0; s < segments.length; s += 6) {
    if (left <= segments[s + 4]!) {
      return {
        x: segments[s]! + left * segments[s + 2]!,
        y: segments[s + 1]! + left * segments[s + 3]!,
        headingRad: Math.atan2(-segments[s + 3]!, -segments[s + 2]!),
      };
    }
    left -= segments[s + 4]!;
  }
  return null;
}

/** La pose de départ qui tient : demandée, glissée, puis reculée pas à pas (glissée à chaque pas) ; null sinon. */
export function startPose(ctx: MotionCtx, start: Pose, room: StartRoom): StartPlacement | null {
  const steps = Math.floor(room.backMaxM / START_BACK_STEP_M + 1e-9);
  for (let b = 0; b <= steps; b += 1) {
    const backM = b * START_BACK_STEP_M;
    const base = b === 0 ? start : backAlong(room.arrival, backM);
    if (base === null) return null;
    const placed = shifted(ctx, base, room.shiftMaxM);
    if (placed !== null) return { ...placed, backM };
  }
  return null;
}
