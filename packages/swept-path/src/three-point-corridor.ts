/**
 * LE COULOIR DU TROIS TEMPS : la rue ∪ la branche, et la seule
 * question qu'on lui pose — cette caisse y tient-elle, marge nulle
 * (la note de conception interne, principe 31) ?
 *
 * Repère CANONIQUE du simulateur (`three-point.ts` y ramène le côté gauche par
 * symétrie) : l'ancre à l'origine, le sens d'entrée vers +x, y vers le BAS, la
 * branche du côté y > 0 — la droite du conducteur.
 *
 * - La rue : la bande |y| ≤ largeur/2, non bornée en x.
 * - La branche : la bande |p·n| ≤ largeur/2 autour de la droite qui part de
 *   l'ancre à `angleDeg` du sens d'entrée, prise du côté y ≥ 0. Largeur
 *   inconnue : bande NON BORNÉE latéralement (jamais inventée, §0.5), et l'on
 *   mesure ce que la caisse en a pris.
 *
 * POURQUOI UNE DÉCOUPE, et pas les coins. L'union de deux bandes n'est pas
 * convexe : ses deux sommets rentrants sont les angles de la branche sur le
 * bord de la rue. Quatre coins dedans ne suffisent pas — la caisse coupe
 * l'angle, un bout dans la rue, l'autre dans la branche. Ajouter « aucun
 * sommet rentrant dans le rectangle » ne suffit pas non plus : une caisse qui
 * passe en diagonale DERRIÈRE l'angle (l'angle reste hors du rectangle, du côté
 * de la chaussée) traverse le bâti sans qu'aucun des deux tests ne le voie
 * (`three-point.test.ts`, cas h). Le test exact est plus simple : la part de la
 * caisse au-delà du bord de la rue (le rectangle découpé par une droite, convexe)
 * doit tenir dans la bande de la branche (convexe) — ce qui se vérifie sur ses
 * sommets. La même découpe donne la profondeur et la largeur prises.
 *
 * Ce module répond pour UNE pose. Entre deux poses, le premier contact d'un
 * mouvement se calcule en forme close (`three-point-contact.ts`), et la fin du
 * demi-tour se juge sur la bande de la rue seule (`bodyInStreetBand`).
 */
import type { Point } from './types.js';

/** Tolérance numérique, pas une marge : un contact à 1 µm près est un contact. */
export const CORRIDOR_TOL_M = 1e-6;
const TOL_M = CORRIDOR_TOL_M;

interface CanonicalBranch {
  /** Normale unitaire de la branche : `p·n` est l'écart latéral à son axe. */
  readonly nx: number;
  readonly ny: number;
  /** sin de l'angle de la branche : convertit un écart au bord de la rue en profondeur le long de la branche. */
  readonly sinAngle: number;
  /** Null = largeur inconnue, bande non bornée latéralement. */
  readonly halfWidthM: number | null;
}

export interface ThreePointCorridor {
  readonly halfStreetM: number;
  /** Null = pas de branche : la bande de la rue seule. */
  readonly branch: CanonicalBranch | null;
}

/** Ce que la caisse a pris de la branche, cumulé sur la manœuvre. */
export interface BranchUse {
  /** Profondeur le long de la branche depuis le bord de la rue. */
  depthM: number;
  /** Plus grand écart à l'axe de la branche : la largeur nécessaire en est le double. */
  halfWidthM: number;
}

export function canonicalCorridor(
  streetWidthM: number,
  branch: { readonly angleDeg: number; readonly widthM: number | null } | null,
): ThreePointCorridor {
  const halfStreetM = streetWidthM / 2;
  if (branch === null) return { halfStreetM, branch: null };
  const angleRad = (branch.angleDeg * Math.PI) / 180;
  return {
    halfStreetM,
    branch: {
      nx: -Math.sin(angleRad),
      ny: Math.cos(angleRad),
      sinAngle: Math.sin(angleRad),
      halfWidthM: branch.widthM === null ? null : branch.widthM / 2,
    },
  };
}

/**
 * La caisse (ses quatre coins, convexe) tient-elle dans le couloir ? Si oui et
 * si `use` est donné, y cumule ce qu'elle prend de la branche. La forme
 * lisible, sur des `Point` — celle des tests ; la recherche passe par
 * `cornersFitCorridor`, le même calcul sans objet.
 */
export function bodyFitsCorridor(
  corners: readonly Point[],
  corridor: ThreePointCorridor,
  use: BranchUse | null,
): boolean {
  const flat = new Float64Array(2 * corners.length);
  corners.forEach((corner, i) => {
    flat[2 * i] = corner.x;
    flat[2 * i + 1] = corner.y;
  });
  return cornersFitCorridor(flat, corridor, use);
}

/** Le même test sur les coins à plat (x0, y0, x1, y1 …) de `truckCornersInto` : le chemin chaud, sans objet. */
export function cornersFitCorridor(flat: Float64Array, corridor: ThreePointCorridor, use: BranchUse | null): boolean {
  const h = corridor.halfStreetM;
  const branch = corridor.branch;
  for (let i = 1; i < flat.length; i += 2) {
    if (flat[i]! < -h - TOL_M) return false;
    if (branch === null && flat[i]! > h + TOL_M) return false;
  }
  if (branch === null) return true;
  scratch.depthM = 0;
  scratch.halfWidthM = 0;
  if (!readBeyondStreetEdge(flat, h, branch, scratch)) return false;
  if (use !== null) {
    use.depthM = Math.max(use.depthM, scratch.depthM);
    use.halfWidthM = Math.max(use.halfWidthM, scratch.halfWidthM);
  }
  return true;
}

/**
 * La caisse (coins à plat) est-elle entière dans la bande de la rue, sans rien
 * prendre de la branche ? C'est là que le demi-tour finit (`three-point-search.ts`).
 */
export function bodyInStreetBand(flat: Float64Array, corridor: ThreePointCorridor): boolean {
  const edge = corridor.halfStreetM + TOL_M;
  for (let i = 1; i < flat.length; i += 2) {
    if (Math.abs(flat[i]!) > edge) return false;
  }
  return true;
}

/** Tampon du chemin chaud : le module est synchrone, un seul suffit. */
const scratch: BranchUse = { depthM: 0, halfWidthM: 0 };

/**
 * La part de la caisse au-delà du bord y = h (découpe de Sutherland–Hodgman par
 * un demi-plan : les sommets dedans et les croisements du bord), lue dans
 * `reading`. Faux dès qu'un de ses sommets sort de la bande de la branche.
 */
function readBeyondStreetEdge(flat: Float64Array, h: number, branch: CanonicalBranch, reading: BranchUse): boolean {
  const edge = h + TOL_M;
  const n = flat.length;
  for (let i = 0; i < n; i += 2) {
    const px = flat[i]!;
    const py = flat[i + 1]!;
    const qx = flat[(i + 2) % n]!;
    const qy = flat[(i + 3) % n]!;
    if (py >= edge && !takeVertex(px, py, h, branch, reading)) return false;
    if ((py - edge) * (qy - edge) < 0) {
      const t = (edge - py) / (qy - py);
      if (!takeVertex(px + t * (qx - px), edge, h, branch, reading)) return false;
    }
  }
  return true;
}

function takeVertex(x: number, y: number, h: number, branch: CanonicalBranch, reading: BranchUse): boolean {
  const lateral = Math.abs(x * branch.nx + y * branch.ny);
  if (branch.halfWidthM !== null && lateral > branch.halfWidthM + TOL_M) return false;
  reading.halfWidthM = Math.max(reading.halfWidthM, lateral);
  reading.depthM = Math.max(reading.depthM, (y - h) / branch.sinAngle);
  return true;
}
