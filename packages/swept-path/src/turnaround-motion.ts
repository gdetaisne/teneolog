/**
 * UN PAS DU CAMION DANS L'ESPACE, vérifié sans trou entre deux poses.
 *
 * Un pas est un arc de bicyclette à l'essieu arrière (`advanceRearAxle`, forme
 * close) : braquage maxi à gauche, à droite, ou droit ; en avant ou en arrière.
 * Le chemin lissé (`turnaround-smooth.ts`) pose aussi des braquages
 * partiels : l'arc de rayon Rr / |braquage|, et sa flèche bornée d'autant.
 * La caisse est le rectangle de `truckCornersInto` (porte-à-faux compris).
 *
 * LE TEST, exact à `eps` près : pendant un pas, chaque point de la caisse suit
 * un arc de cercle, qui ne s'écarte de sa corde que de la flèche
 * r·(1 − cos(Δθ/2)) — 5 mm au plus pour un pas de 0,5 m du 19 t. Le balayage
 * tient donc dans l'enveloppe convexe des deux caisses (début et fin du pas),
 * grossie de cette flèche ; pour un pas droit, l'enveloppe EST le balayage.
 * Cette enveloppe est dans l'espace quand :
 *  1. son contour est à au moins `eps` + flèche de tout côté des anneaux
 *     (`segmentClear`) ;
 *  2. aucun anneau n'est tout entier dedans (un trou — une voiture, un îlot) ;
 *  3. un de ses points est dans l'espace. C'est vrai par construction : la
 *     caisse du début du pas y était (vérifiée au pas précédent, ou à la pose
 *     de départ par `poseInSpace`), et un de ses coins est un sommet de
 *     l'enveloppe. Un contour que rien ne touche et dont un point est dedans
 *     est dedans en entier.
 */
import { truckCornersInto } from './geometry.js';
import { advanceRearAxle } from './kinematics.js';
import { pointInSpace, segmentClear, segmentFar, type PreparedSpace } from './turnaround-space.js';
import type { Pose, TruckSpec } from './types.js';

export type Steer = -1 | 0 | 1;
export type Direction = 1 | -1;

/** Ce qu'un pas lit du camion, calculé une fois. */
export interface MotionCtx {
  readonly space: PreparedSpace;
  readonly truck: TruckSpec;
  /** Rayon de l'essieu arrière au braquage maxi (`rearAxleMinTurnRadiusM`). */
  readonly rr: number;
  /** Le plus grand rayon d'un coin de caisse autour du centre du virage, au braquage maxi. */
  readonly cornerRadiusM: number;
  /** La tolérance numérique : la caisse reste à au moins `eps` du bord (0,02 m, pas une marge — principe 31). */
  readonly eps: number;
  /** Tampons réutilisés (16 coordonnées de coins, 16 d'enveloppe). */
  readonly corners: Float64Array;
  readonly hull: Float64Array;
}

export function motionCtx(space: PreparedSpace, truck: TruckSpec, rr: number, eps: number): MotionCtx {
  const front = truck.wheelbaseM + truck.frontOverhangM;
  const halfW = truck.widthM / 2;
  const outer = rr + halfW;
  return {
    space,
    truck,
    rr,
    cornerRadiusM: Math.hypot(outer, Math.max(front, truck.rearOverhangM)),
    eps,
    corners: new Float64Array(16),
    hull: new Float64Array(16),
  };
}

/**
 * La flèche d'un pas : ce dont un point de la caisse s'écarte de sa corde. Nulle pour un pas droit.
 * Au braquage maxi, le coin le plus loin du centre (`cornerRadiusM`) ; à un braquage partiel (le chemin
 * lissé), un point de la caisse est à au plus Rr / |steer| + la portée de la caisse autour de
 * l'essieu arrière du centre du virage (inégalité triangulaire) — une borne haute, jamais moins.
 */
function stepSagittaM(ctx: MotionCtx, steer: number, lengthM: number): number {
  if (steer === 0) return 0;
  const turn = Math.abs(steer);
  const half = (Math.abs(lengthM) * turn) / ctx.rr / 2;
  if (turn === 1) return ctx.cornerRadiusM * (1 - Math.cos(half));
  const { truck } = ctx;
  const reach = Math.hypot(truck.widthM / 2, Math.max(truck.wheelbaseM + truck.frontOverhangM, truck.rearOverhangM));
  return (ctx.rr / turn + reach) * (1 - Math.cos(half));
}

/** Le plus long chemin d'un point de la caisse pendant un pas : le pas lui-même, ou l'arc du coin le plus loin du centre. */
export function stepReachM(ctx: MotionCtx, steer: Steer, lengthM: number): number {
  const length = Math.abs(lengthM);
  return steer === 0 ? length : (ctx.cornerRadiusM * length) / ctx.rr;
}

/**
 * La caisse à cette pose est-elle, d'après la grille seule, à au moins
 * `clearance` du bord ? Alors tout pas dont aucun point ne parcourt plus de
 * `clearance − eps` reste dans l'espace sans autre test : le balayage est dans
 * la caisse grossie de ce chemin. (Pour une caisse déjà dans l'espace.)
 */
export function bodyFar(ctx: MotionCtx, pose: Pose, clearance: number): boolean {
  const c = ctx.corners;
  truckCornersInto(pose, ctx.truck, c.subarray(0, 8));
  for (let k = 0; k < 4; k += 1) {
    const j = (k + 1) % 4;
    if (!segmentFar(ctx.space, c[k * 2]!, c[k * 2 + 1]!, c[j * 2]!, c[j * 2 + 1]!, clearance)) return false;
  }
  return true;
}

/**
 * La pose au bout d'un pas. `steer` est le braquage en fraction du braquage maxi : la courbure de
 * l'essieu arrière vaut `steer / rr`. La recherche ne pose que −1, 0, +1 (`advanceRearAxle`, au bit
 * près); le chemin lissé pose entre les deux : l'arc exact, par sa corde (stable quand la
 * courbure tend vers zéro).
 */
export function stepPose(ctx: MotionCtx, from: Pose, steer: number, signedLengthM: number): Pose {
  if (steer === 0 || steer === 1 || steer === -1) return advanceRearAxle(from, steer, signedLengthM, ctx.rr);
  const turn = (steer * signedLengthM) / ctx.rr;
  const half = turn / 2;
  const chord = signedLengthM * (half === 0 ? 1 : Math.sin(half) / half);
  const mid = from.headingRad + half;
  return { x: from.x + chord * Math.cos(mid), y: from.y + chord * Math.sin(mid), headingRad: from.headingRad + turn };
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/**
 * L'enveloppe convexe des `n` points de `pts` (x, y à la suite), écrite dans
 * `out` en sens direct (chaîne monotone d'Andrew) ; rend le nombre de sommets.
 * Sans allocation : 8 points au plus ici, triés par insertion.
 */
export function convexHullInto(pts: Float64Array, n: number, out: Float64Array): number {
  const order = ORDER;
  for (let i = 0; i < n; i += 1) {
    let k = i;
    while (k > 0 && before(pts, i, order[k - 1]!)) {
      order[k] = order[k - 1]!;
      k -= 1;
    }
    order[k] = i;
  }
  let m = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    const floor = pass === 0 ? 2 : m + 1;
    for (let r = 0; r < n; r += 1) {
      if (pass === 1 && r === 0) continue;
      const i = order[pass === 0 ? r : n - 1 - r]!;
      const x = pts[i * 2]!;
      const y = pts[i * 2 + 1]!;
      while (m >= floor && cross(out[(m - 2) * 2]!, out[(m - 2) * 2 + 1]!, out[(m - 1) * 2]!, out[(m - 1) * 2 + 1]!, x, y) <= 0) m -= 1;
      out[m * 2] = x;
      out[m * 2 + 1] = y;
      m += 1;
    }
  }
  return m - 1;
}

/** L'ordre de la chaîne monotone : x croissant, puis y. */
function before(pts: Float64Array, a: number, b: number): boolean {
  const dx = pts[a * 2]! - pts[b * 2]!;
  return dx < 0 || (dx === 0 && pts[a * 2 + 1]! < pts[b * 2 + 1]!);
}

const ORDER = new Uint8Array(8);

/** Le point (x, y) est-il dans le polygone convexe direct de `n` sommets ? */
function insideConvex(poly: Float64Array, n: number, x: number, y: number): boolean {
  for (let k = 0; k < n; k += 1) {
    const j = (k + 1) % n;
    if (cross(poly[k * 2]!, poly[k * 2 + 1]!, poly[j * 2]!, poly[j * 2 + 1]!, x, y) < 0) return false;
  }
  return true;
}

/** Un anneau entier dans le polygone : sa boîte y tient et son premier sommet est dedans. */
export function ringInside(space: PreparedSpace, poly: Float64Array, n: number): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < n; k += 1) {
    minX = Math.min(minX, poly[k * 2]!);
    maxX = Math.max(maxX, poly[k * 2]!);
    minY = Math.min(minY, poly[k * 2 + 1]!);
    maxY = Math.max(maxY, poly[k * 2 + 1]!);
  }
  const r = space.rings;
  for (let k = 0; k < space.ringCount; k += 1) {
    const o = k * 6;
    if (r[o + 2]! < minX || r[o + 3]! < minY || r[o + 4]! > maxX || r[o + 5]! > maxY) continue;
    if (insideConvex(poly, n, r[o]!, r[o + 1]!)) return true;
  }
  return false;
}

/** Le contour du polygone à au moins `clearance` de tout côté, et aucun anneau dedans. */
function polygonClear(space: PreparedSpace, poly: Float64Array, n: number, clearance: number): boolean {
  for (let k = 0; k < n; k += 1) {
    const j = (k + 1) % n;
    if (!segmentClear(space, poly[k * 2]!, poly[k * 2 + 1]!, poly[j * 2]!, poly[j * 2 + 1]!, clearance)) return false;
  }
  return !ringInside(space, poly, n);
}

/**
 * Le balayage de `from` à `to` (un pas au braquage `steer`) est-il dans
 * l'espace ? `from` doit y être (voir l'en-tête, point 3).
 */
export function sweepClear(ctx: MotionCtx, from: Pose, to: Pose, steer: number, lengthM: number): boolean {
  const { corners, hull, truck } = ctx;
  truckCornersInto(from, truck, corners.subarray(0, 8));
  truckCornersInto(to, truck, corners.subarray(8, 16));
  const n = convexHullInto(corners, 8, hull);
  return polygonClear(ctx.space, hull, n, ctx.eps + stepSagittaM(ctx, steer, lengthM));
}

/** La caisse à cette pose est-elle dans l'espace ? Pour la pose de départ : le côté se lit à l'essieu arrière. */
export function poseInSpace(ctx: MotionCtx, pose: Pose): boolean {
  if (!pointInSpace(ctx.space, pose.x, pose.y)) return false;
  const body = ctx.corners.subarray(0, 8);
  truckCornersInto(pose, ctx.truck, body);
  const n = convexHullInto(ctx.corners, 4, ctx.hull);
  return polygonClear(ctx.space, ctx.hull, n, ctx.eps);
}
