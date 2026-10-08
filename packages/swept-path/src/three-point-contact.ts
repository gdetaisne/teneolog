/**
 * LE PREMIER CONTACT D'UN MOUVEMENT, en forme close
 * (la note de conception interne, marge nulle §0.4, principe 31).
 *
 * Au braquage maxi, la caisse tourne d'un bloc autour du centre du virage C :
 * chaque coin de la caisse décrit un arc de cercle autour de C, et, vu de la
 * caisse, chaque coin de bâti aussi, en sens inverse. Le premier contact d'une
 * caisse convexe avec un obstacle convexe est un sommet de l'un qui franchit un
 * bord de l'autre. Les obstacles, dans le repère canonique
 * (`three-point-corridor.ts`, y vers le bas, la branche du côté y > 0) :
 * - le trottoir d'en face, y < −h, et, sans branche, celui de ce côté, y > h ;
 * - avec une branche de largeur connue, les deux coins de bâti de part et
 *   d'autre de sa bouche : au-delà du bord de la rue ET hors de la bande de la
 *   branche. Leurs sommets sont les SOMMETS RENTRANTS du couloir.
 * (Largeur inconnue : la branche n'est pas bornée, il n'y a pas de coin de bâti.)
 * Donc trois franchissements : un coin de caisse passe un bord de trottoir, un
 * coin de caisse passe un bord d'un coin de bâti, un coin de bâti passe un bord
 * de la caisse. Chacun est l'équation a + ρ·cos ψ = niveau, résolue exactement
 * (`three-point-wave.ts`) — y compris quand le point est déjà sur le niveau au
 * départ et le franchit en partant : un mouvement qui repart de la pose de
 * contact du précédent est alors bloqué dès τ = 0.
 *
 * POURQUOI PAS DES ÉCHANTILLONS. Tous les 2° de cap, un coin de caisse à 12,7 m
 * du centre (19 t) avance de 44 cm. Contre un bord droit, il ne mord entre deux
 * échantillons que de la flèche r·(1 − cos 1°) ≈ 2 mm ; mais au sommet
 * rentrant, la caisse coupe le coin de bâti de toute la corde : jusqu'à 10 cm
 * relevés, assez pour changer le nombre de temps.
 *
 * La tolérance est celle du couloir (1 µm), prise du côté de l'obstacle : un
 * coin qui touche le bord sans le passer n'est pas un contact, ce qui le passe
 * d'un micron l'est.
 */
import { truckCornersInto } from './geometry.js';
import { CORRIDOR_TOL_M, type ThreePointCorridor } from './three-point-corridor.js';
import { crossingRad, setWave, turnCentre, valueAt, type Wave } from './three-point-wave.js';
import type { Pose, TruckSpec } from './types.js';

const TOL_M = CORRIDOR_TOL_M;
const HALF_PI = Math.PI / 2;

/** Tampons du chemin chaud : le module est synchrone. */
const corners = new Float64Array(8);
const waveA: Wave = { base: 0, rho: 0, psi0: 0, k: 1 };
const waveB: Wave = { base: 0, rho: 0, psi0: 0, k: 1 };

/**
 * Le premier contact d'un mouvement au braquage `steer` (±1) dont le cap tourne
 * de `rotation`·τ, τ ∈ [0, spanRad] : le τ du premier franchissement, ou
 * `spanRad` s'il n'y en a pas. La pose de départ est supposée libre (elle a
 * passé `cornersFitCorridor`).
 */
export function firstContactRad(
  corridor: ThreePointCorridor,
  truck: TruckSpec,
  start: Pose,
  steer: 1 | -1,
  rotation: 1 | -1,
  rearAxleRadiusM: number,
  spanRad: number,
): number {
  if (!(spanRad > 0)) return 0;
  const { x: cx, y: cy } = turnCentre(start, steer, rearAxleRadiusM);
  truckCornersInto(start, truck, corners);
  let first = spanRad;
  for (let i = 0; i < 8; i += 2) {
    first = cornerContactRad(corridor, cx, cy, corners[i]!, corners[i + 1]!, rotation, first);
  }
  const branch = corridor.branch;
  if (branch === null || branch.halfWidthM === null) return first;
  for (const sigma of [1, -1]) {
    // Le sommet rentrant : le bord de la branche (p·n = ±largeur/2) sur le bord de la rue (y = h).
    const vx = (sigma * branch.halfWidthM - corridor.halfStreetM * branch.ny) / branch.nx;
    first = vertexContactRad(truck, start, cx, cy, vx, corridor.halfStreetM, rotation, first);
  }
  return first;
}

/** Un coin de caisse : le premier τ ≤ `span` où il passe un bord de trottoir ou entre dans un coin de bâti. */
function cornerContactRad(
  corridor: ThreePointCorridor,
  cx: number,
  cy: number,
  px: number,
  py: number,
  k: number,
  span: number,
): number {
  const h = corridor.halfStreetM;
  const rho = Math.hypot(px - cx, py - cy);
  const phi = Math.atan2(py - cy, px - cx);
  setWave(waveA, cy, rho, phi - HALF_PI, k); // y
  const first = Math.min(span, crossingRad(waveA, -(h + TOL_M), false));
  const branch = corridor.branch;
  if (branch === null) return Math.min(first, crossingRad(waveA, h + TOL_M, true));
  if (branch.halfWidthM === null) return first;
  // p·n, l'écart à l'axe de la branche : ρ·cos(φ + kτ − β), n = (cos β, sin β).
  setWave(waveB, cx * branch.nx + cy * branch.ny, rho, phi - Math.atan2(branch.ny, branch.nx), k);
  return wedgeCrossingRad(waveA, waveB, h + TOL_M, branch.halfWidthM + TOL_M, first);
}

/**
 * Entrer dans un coin de bâti {y > h, |p·n| > largeur/2}, c'est passer le bord
 * de la rue hors de la bouche, ou un bord de la branche au-delà du bord de la rue.
 */
function wedgeCrossingRad(y: Wave, lateral: Wave, streetEdge: number, branchEdge: number, span: number): number {
  let first = span;
  const overEdge = crossingRad(y, streetEdge, true);
  if (overEdge <= first && Math.abs(valueAt(lateral, overEdge)) >= branchEdge) first = overEdge;
  for (const sigma of [1, -1]) {
    const outOfBranch = crossingRad(lateral, sigma * branchEdge, sigma > 0);
    if (outOfBranch <= first && valueAt(y, outOfBranch) >= streetEdge) first = outOfBranch;
  }
  return first;
}

/**
 * Un sommet rentrant (vx ; vy) : dans le repère de la caisse, il tourne autour
 * de C en sens inverse ; le premier τ ≤ `span` où il entre dans le rectangle.
 */
function vertexContactRad(
  truck: TruckSpec,
  start: Pose,
  cx: number,
  cy: number,
  vx: number,
  vy: number,
  rotation: number,
  span: number,
): number {
  const ux = Math.cos(start.headingRad);
  const uy = Math.sin(start.headingRad);
  // Le centre du rectangle de `truckFootprint`, et ses demi-côtés moins la tolérance.
  const offset = (truck.wheelbaseM + truck.frontOverhangM - truck.rearOverhangM) / 2;
  const dx = cx - (start.x + ux * offset);
  const dy = cy - (start.y + uy * offset);
  const halfLength = (truck.wheelbaseM + truck.frontOverhangM + truck.rearOverhangM) / 2 - TOL_M;
  const halfWidth = truck.widthM / 2 - TOL_M;
  const rho = Math.hypot(vx - cx, vy - cy);
  const phi = Math.atan2(vy - cy, vx - cx) - start.headingRad;
  setWave(waveA, dx * ux + dy * uy, rho, phi, -rotation); // le long de la caisse
  setWave(waveB, -dx * uy + dy * ux, rho, phi - HALF_PI, -rotation); // en travers
  const first = sideCrossingRad(waveA, waveB, halfLength, halfWidth, span);
  return sideCrossingRad(waveB, waveA, halfWidth, halfLength, first);
}

/** Entrer dans le rectangle par un des deux côtés |along| = half, en travers dans |across| ≤ limit. */
function sideCrossingRad(along: Wave, across: Wave, half: number, limit: number, span: number): number {
  let first = span;
  for (const sigma of [1, -1]) {
    const tau = crossingRad(along, sigma * half, sigma < 0);
    if (tau <= first && Math.abs(valueAt(across, tau)) <= limit) first = tau;
  }
  return first;
}
