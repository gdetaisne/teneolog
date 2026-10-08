/**
 * UN POINT QUI TOURNE AUTOUR DU CENTRE DU VIRAGE (la note de conception interne).
 *
 * Au braquage maxi, la caisse tourne d'un bloc autour du centre du virage C :
 * chacune des coordonnées d'un de ses points (y, écart à l'axe de la branche,
 * position dans la caisse d'un coin de bâti…) est une onde
 * f(τ) = base + ρ·cos(ψ0 + k·τ), τ ≥ 0 l'angle tourné, k le sens (+1 : l'angle
 * croît). Partagé, une seule forme close (principe 23), par le premier contact
 * (`three-point-contact.ts`) et la largeur prise dans une branche de largeur
 * inconnue (`three-point-branch-width.ts`).
 */
import type { Pose } from './types.js';

export interface Wave {
  base: number;
  rho: number;
  psi0: number;
  k: number;
}

const TWO_PI = 2 * Math.PI;

/**
 * Une racine à moins de ceci DERRIÈRE le départ est le départ lui-même : le point
 * est déjà sur le niveau et le franchit en partant. Un mouvement qui repart de la
 * pose de contact du précédent a son coin exactement sur le niveau ; l'arrondi
 * met la racine à ±1e-15 rad, et, repliée à 2π − ε, elle sortait du mouvement
 * sans être vue (seconde relecture de jusqu'à 1,4 mm hors du couloir,
 * 58 des 12 532 manœuvres trouvées d'une grille du 19 t). Bien au-dessus de ce
 * bruit, bien en dessous de tout ce qui se mesure (1e-9 rad à 13 m du centre,
 * c'est 13 nm).
 */
const ROOT_AT_START_RAD = 1e-9;

/** Le centre du virage, à steer·Rr sur la droite du conducteur (`advanceRearAxle`). */
export function turnCentre(start: Pose, steer: 1 | -1, rearAxleRadiusM: number): { readonly x: number; readonly y: number } {
  const signedRadius = steer * rearAxleRadiusM;
  return {
    x: start.x - signedRadius * Math.sin(start.headingRad),
    y: start.y + signedRadius * Math.cos(start.headingRad),
  };
}

export function setWave(target: Wave, base: number, rho: number, psi0: number, k: number): void {
  target.base = base;
  target.rho = rho;
  target.psi0 = psi0;
  target.k = k;
}

export function valueAt(f: Wave, tau: number): number {
  return f.base + f.rho * Math.cos(f.psi0 + f.k * tau);
}

/** L'angle ramené dans [0, 2π). */
export function wrapRad(angle: number): number {
  const wrapped = angle % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

/**
 * Le τ de [0, 2π) où f passe `level` en montant (ou en descendant) — un seul par
 * tour : ψ = ∓k·acos(c), où f′ = −ρ·k·sin ψ a le bon signe. +∞ quand le cercle
 * n'atteint pas le niveau. Un mouvement tourne ici d'au plus π : un tour suffit.
 * Une racine juste derrière le départ vaut 0 (`ROOT_AT_START_RAD`) : seule la
 * racine dans le bon sens est cherchée, donc un point sur le niveau qui revient
 * vers l'intérieur n'est jamais pris pour un contact.
 */
export function crossingRad(f: Wave, level: number, rising: boolean): number {
  if (!(f.rho > 0)) return Number.POSITIVE_INFINITY;
  const c = (level - f.base) / f.rho;
  if (!(c >= -1 && c <= 1)) return Number.POSITIVE_INFINITY;
  const psi = (rising ? -f.k : f.k) * Math.acos(c);
  const tau = wrapRad(f.k * (psi - f.psi0));
  return tau > TWO_PI - ROOT_AT_START_RAD ? 0 : tau;
}
