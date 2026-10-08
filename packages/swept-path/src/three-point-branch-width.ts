/**
 * LA LARGEUR QU'UN MOUVEMENT PREND DANS UNE BRANCHE DE LARGEUR
 * INCONNUE, en forme close (la note de conception interne, décision 5 du §0).
 *
 * La largeur nécessaire (`branchWidthNeededM`) est le double du plus grand écart
 * |p·n| à l'axe de la branche, sur la part de la caisse au-delà du bord de la rue
 * (y ≥ h, à la tolérance du couloir près). Lue tous les 2° de cap, elle ratait
 * jusqu'à 0,6 m (relecture de 19 t, rue de 5,25 m, branche à 80°, 9,62 m
 * rendus pour 10,24 m balayés) : ce maximum est souvent porté par le point où un
 * grand côté de la caisse, presque parallèle au bord, croise ce bord — il file le
 * long du bord entre deux échantillons, puis disparaît quand le coin repasse dans
 * la rue. Une branche déclarée un centimètre au-dessus de la largeur rendue
 * donnait alors plus de temps : le modèle ne tenait pas dans ce qu'il disait
 * nécessaire.
 *
 * Au braquage maxi, la caisse tourne d'un bloc autour du centre C. La part
 * au-delà du bord est un polygone convexe : les coins de la caisse au-delà du
 * bord, et les croisements de ses côtés avec le bord ; |p·n| est convexe, son
 * maximum est à l'un d'eux. Le long du mouvement :
 * - un coin au-delà du bord suit une onde (`three-point-wave.ts`) : son écart
 *   est maximal aux bouts de l'intervalle (départ, fin, passage du bord) ou à un
 *   extrême de l'onde ;
 * - le croisement d'un côté avec le bord glisse le long du bord ; aux bouts de
 *   l'intervalle, c'est un coin sur le bord, ou le départ, ou la fin ; entre les
 *   deux, il ne s'arrête que lorsque le pied de la perpendiculaire menée de C à
 *   ce côté est SUR le bord (x = cx + (e − D·sin θ)/cos θ,
 *   dx/dθ = (e·sin θ − D)/cos² θ). Ce pied est un point fixe de la caisse : il
 *   tourne autour de C comme un coin.
 * Donc : au départ et à la fin, la part entière (coins et croisements) ; entre
 * les deux, les quatre coins et les pieds qui tombent sur un côté, aux extrêmes
 * de leur écart et à leurs passages du bord. Un point de la caisse n'est compté
 * qu'au-delà du bord ou sur lui — il est alors dans la part découpée : le
 * maximum est exact, jamais surestimé.
 */
import { truckCornersInto } from './geometry.js';
import { CORRIDOR_TOL_M, type ThreePointCorridor } from './three-point-corridor.js';
import { crossingRad, setWave, turnCentre, valueAt, wrapRad, type Wave } from './three-point-wave.js';
import type { Pose, TruckSpec } from './types.js';

const HALF_PI = Math.PI / 2;

/** Tampons du chemin chaud : le module est synchrone. */
const corners = new Float64Array(8);
/** Les quatre coins (dans l'ordre de `truckCornersInto` : deux coins voisins font un côté), puis jusqu'à quatre pieds. */
const points = new Float64Array(16);
/** y et écart de chaque coin, au départ (0–3) et à la fin (4–7). */
const endY = new Float64Array(8);
const endLateral = new Float64Array(8);
const yWave: Wave = { base: 0, rho: 0, psi0: 0, k: 1 };
const lateralWave: Wave = { base: 0, rho: 0, psi0: 0, k: 1 };

/**
 * Le plus grand écart |p·n| à l'axe de la branche de la part de la caisse
 * au-delà du bord de la rue, sur tout le mouvement au braquage `steer` dont le
 * cap tourne de `rotation`·τ, τ ∈ [0, spanRad]. 0 quand rien ne passe le bord.
 */
export function sweptBranchHalfWidthM(
  corridor: ThreePointCorridor,
  truck: TruckSpec,
  start: Pose,
  steer: 1 | -1,
  rotation: 1 | -1,
  rearAxleRadiusM: number,
  spanRad: number,
): number {
  const branch = corridor.branch;
  if (branch === null) return 0;
  const centre = turnCentre(start, steer, rearAxleRadiusM);
  truckCornersInto(start, truck, corners);
  const count = bodyPointsInto(centre.x, centre.y);
  const edge = corridor.halfStreetM + CORRIDOR_TOL_M;
  const beta = Math.atan2(branch.ny, branch.nx);
  const lateralBase = centre.x * branch.nx + centre.y * branch.ny;
  const span = Math.max(0, spanRad);
  let widest = 0;
  for (let i = 0; i < count; i += 1) {
    const dx = points[2 * i]! - centre.x;
    const dy = points[2 * i + 1]! - centre.y;
    setWave(yWave, centre.y, Math.hypot(dx, dy), Math.atan2(dy, dx) - HALF_PI, rotation);
    setWave(lateralWave, lateralBase, yWave.rho, yWave.psi0 + HALF_PI - beta, rotation);
    widest = Math.max(widest, widestBeyondEdgeM(yWave, lateralWave, edge, span));
    if (i < 4) recordEnds(i, span);
  }
  return Math.max(widest, sideCrossingsM(0, edge), sideCrossingsM(4, edge));
}

/** Les coins, puis le pied de la perpendiculaire menée de C à chaque côté quand il tombe entre ses deux coins. */
function bodyPointsInto(cx: number, cy: number): number {
  points.set(corners);
  let count = 4;
  for (let i = 0; i < 8; i += 2) {
    const ax = corners[i]!;
    const ay = corners[i + 1]!;
    const dx = corners[(i + 2) % 8]! - ax;
    const dy = corners[(i + 3) % 8]! - ay;
    const s = ((cx - ax) * dx + (cy - ay) * dy) / (dx * dx + dy * dy);
    if (!(s > 0 && s < 1)) continue;
    points[2 * count] = ax + s * dx;
    points[2 * count + 1] = ay + s * dy;
    count += 1;
  }
  return count;
}

/**
 * Un point de la caisse : son plus grand écart |p·n| quand il est au-delà du
 * bord ou sur lui, τ ∈ [0, span]. Sur le bord, à ses deux passages ; au-delà,
 * au départ, à la fin et aux deux extrêmes de son écart (ψ ≡ 0 ou π).
 */
function widestBeyondEdgeM(y: Wave, lateral: Wave, edge: number, span: number): number {
  let widest = Math.max(onEdgeM(lateral, crossingRad(y, edge, true), span), onEdgeM(lateral, crossingRad(y, edge, false), span));
  widest = Math.max(widest, beyondEdgeM(y, lateral, edge, 0), beyondEdgeM(y, lateral, edge, span));
  const toCrest = wrapRad(-lateral.k * lateral.psi0);
  if (toCrest <= span) widest = Math.max(widest, beyondEdgeM(y, lateral, edge, toCrest));
  const toTrough = wrapRad(toCrest + Math.PI);
  if (toTrough <= span) widest = Math.max(widest, beyondEdgeM(y, lateral, edge, toTrough));
  return widest;
}

function onEdgeM(lateral: Wave, tau: number, span: number): number {
  return tau <= span ? Math.abs(valueAt(lateral, tau)) : 0;
}

function beyondEdgeM(y: Wave, lateral: Wave, edge: number, tau: number): number {
  return valueAt(y, tau) >= edge ? Math.abs(valueAt(lateral, tau)) : 0;
}

function recordEnds(corner: number, span: number): void {
  endY[corner] = valueAt(yWave, 0);
  endLateral[corner] = valueAt(lateralWave, 0);
  endY[4 + corner] = valueAt(yWave, span);
  endLateral[4 + corner] = valueAt(lateralWave, span);
}

/** Au départ (`offset` 0) ou à la fin (4) : l'écart des croisements des côtés avec le bord — l'écart est linéaire le long d'un côté. */
function sideCrossingsM(offset: number, edge: number): number {
  let widest = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = offset + i;
    const b = offset + ((i + 1) % 4);
    const ya = endY[a]!;
    const yb = endY[b]!;
    if ((ya - edge) * (yb - edge) >= 0) continue;
    const t = (edge - ya) / (yb - ya);
    widest = Math.max(widest, Math.abs(endLateral[a]! + t * (endLateral[b]! - endLateral[a]!)));
  }
  return widest;
}
