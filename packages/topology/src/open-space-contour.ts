/**
 * le contour d'une zone de la grille (`open-space-grid.ts`) : les
 * anneaux qui la bordent, sur les arêtes des cellules (simplifiés ensuite sans
 * rien croiser : `open-space-simplify.ts`).
 *
 * Chaque côté d'une cellule de la zone qui touche une cellule hors zone est une
 * arête orientée, la zone À GAUCHE : l'anneau extérieur tourne dans le sens
 * trigonométrique, un trou dans le sens horaire — deux cellules qui ne se
 * touchent que par un coin restent séparées (virage à gauche d'abord au coin
 * partagé), comme la composante 4-connexe qui les a produites. Dessinés ensemble
 * en règle pair-impair, les anneaux rendent exactement la zone.
 */
import type { XY } from './open-space-grid.js';

/** E, N, W, S : un bit par direction, le pas en (i, j). */
const STEPS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/** Les arêtes de bord, en bits de direction par sommet de départ (sommet `j * (cols + 1) + i`). */
function boundaryEdges(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  const out = new Uint8Array((cols + 1) * (rows + 1));
  const at = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < cols && j < rows && mask[j * cols + i] === 1;
  const vertex = (i: number, j: number): number => j * (cols + 1) + i;
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      if (!at(i, j)) continue;
      if (!at(i, j - 1)) out[vertex(i, j)]! |= 1; // bas, vers l'est
      if (!at(i + 1, j)) out[vertex(i + 1, j)]! |= 2; // droite, vers le nord
      if (!at(i, j + 1)) out[vertex(i + 1, j + 1)]! |= 4; // haut, vers l'ouest
      if (!at(i - 1, j)) out[vertex(i, j + 1)]! |= 8; // gauche, vers le sud
    }
  }
  return out;
}

/** Au sommet, la direction suivante : à gauche d'abord, puis tout droit, puis à droite. */
function nextDirection(bits: number, from: number): number | null {
  for (const turn of [1, 0, 3]) {
    const d = (from + turn) % 4;
    if ((bits & (1 << d)) !== 0) return d;
  }
  return null;
}

/** Un anneau, depuis `start`, en ne gardant que les coins ; consomme ses arêtes. */
function traceFrom(out: Uint8Array, cols: number, start: number): XY[] {
  const width = cols + 1;
  const corners: XY[] = [];
  let v = start;
  let d = nextDirection(out[start]!, 0) ?? 0;
  let previous = -1;
  for (let guard = out.length * 4; guard > 0; guard -= 1) {
    if (d !== previous) corners.push({ x: v % width, y: Math.floor(v / width) });
    out[v]! &= ~(1 << d);
    const [di, dj] = STEPS[d]!;
    v += dj * width + di;
    if (v === start) break;
    const next = nextDirection(out[v]!, d);
    if (next === null) break;
    previous = d;
    d = next;
  }
  return corners;
}

/**
 * Les anneaux qui bordent la zone, en coordonnées de SOMMETS de grille (le coin
 * sud-ouest de la cellule (i, j) est le sommet (i, j)), coins seulement.
 */
export function traceRings(mask: Uint8Array, cols: number, rows: number): XY[][] {
  const out = boundaryEdges(mask, cols, rows);
  const rings: XY[][] = [];
  for (let v = 0; v < out.length; v += 1) {
    while (out[v] !== 0) rings.push(traceFrom(out, cols, v));
  }
  return rings.filter((ring) => ring.length >= 4);
}

/** Aire signée (formule du lacet) : positive pour un anneau extérieur, négative pour un trou. */
export function signedArea(ring: readonly XY[]): number {
  let twice = 0;
  for (let k = 0, prev = ring.length - 1; k < ring.length; prev = k, k += 1) {
    twice += ring[prev]!.x * ring[k]!.y - ring[k]!.x * ring[prev]!.y;
  }
  return twice / 2;
}
