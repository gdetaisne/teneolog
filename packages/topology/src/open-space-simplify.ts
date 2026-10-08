/**
 * simplifier les anneaux du contour (`open-space-contour.ts`) SANS
 * qu'aucun côté n'en croise un autre (relecture du 2026-09-25).
 *
 * Les anneaux tracés sur les arêtes des cellules sont exacts et disjoints — ils
 * ne se touchent qu'en un sommet commun, au coin de deux cellules en diagonale —
 * mais ils sont lourds : chaque marche d'un bord en biais est deux sommets
 * (1 382 à la Sèvremoine). Douglas–Peucker anneau par anneau les allège, mais
 * sans rien regarder autour : près d'une encoche ou d'un obstacle à une ou deux
 * cellules d'un autre bord, un côté simplifié peut en croiser un autre, et la
 * règle pair-impair retourne alors de petits triangles — un polygone invalide
 * pour le simulateur et pour le dessin.
 *
 * D'où deux temps : Douglas–Peucker à `epsilon` près sur chaque anneau, puis,
 * tant qu'un côté simplifié croise un autre côté, en touche l'intérieur, le
 * double ou se réduit à un point — ou que deux passages par un même sommet s'y
 * croisent (`crossingAtSharedVertices`) —, on lui rend le sommet d'origine le
 * plus éloigné de sa corde. Chaque tour rend au moins un sommet, et les anneaux
 * d'origine sont valides : la boucle finit, au pire sur eux. Tout se calcule en
 * coordonnées de SOMMETS de grille, entières : les tests d'orientation y sont
 * exacts, sans tolérance.
 */
import type { XY } from './open-space-grid.js';

/**
 * Un côté simplifié : l'anneau, ses deux sommets gardés (indices dans l'anneau
 * d'origine), et le côté qui le précède dans l'anneau (index dans la liste des côtés).
 */
interface Side {
  readonly ring: number;
  readonly from: number;
  readonly to: number;
  readonly a: XY;
  readonly b: XY;
  readonly prev: number;
}

/**
 * Les anneaux simplifiés à `epsilon` près (en unités de grille), sans qu'aucun
 * côté n'en croise ni n'en touche un autre hors d'un sommet commun. Chaque
 * anneau garde au moins trois sommets, tous pris parmi les siens.
 */
export function simplifyRings(rings: readonly (readonly XY[])[], epsilon: number): XY[][] {
  const kept = rings.map((ring) => initialKept(ring, epsilon));
  refineUntilValid(rings, kept);
  return rings.map((ring, r) => ring.filter((_p, k) => kept[r]![k] === 1));
}

function distanceToChord(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  return length === 0
    ? Math.hypot(p.x - a.x, p.y - a.y)
    : Math.abs(dx * (a.y - p.y) - dy * (a.x - p.x)) / length;
}

/** Douglas–Peucker sur la chaîne `points[from..to]`, sans récursion ; marque ce qui reste. */
function keepChain(
  points: readonly XY[],
  from: number,
  to: number,
  epsilon: number,
  kept: Uint8Array,
): void {
  const stack: (readonly [number, number])[] = [[from, to]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const worst = farthestBetween(points, a, b);
    if (worst === null || worst.distance <= epsilon) continue;
    kept[worst.index] = 1;
    stack.push([a, worst.index], [worst.index, b]);
  }
}

/** Le sommet de `points` strictement entre `a` et `b` (indices, sans tour) le plus loin de la corde [a, b]. */
function farthestBetween(
  points: readonly XY[],
  a: number,
  b: number,
): { index: number; distance: number } | null {
  let best: { index: number; distance: number } | null = null;
  for (let k = a + 1; k < b; k += 1) {
    const distance = distanceToChord(points[k]!, points[a]!, points[b]!);
    if (best === null || distance > best.distance) best = { index: k, distance };
  }
  return best;
}

/** Douglas–Peucker sur l'anneau fermé, coupé au sommet le plus éloigné du premier ; au moins trois sommets. */
function initialKept(ring: readonly XY[], epsilon: number): Uint8Array {
  const n = ring.length;
  if (n <= 4) return new Uint8Array(n).fill(1);
  const fromFirst = (p: XY): number => Math.hypot(p.x - ring[0]!.x, p.y - ring[0]!.y);
  let far = 1;
  for (let k = 2; k < n; k += 1) if (fromFirst(ring[k]!) > fromFirst(ring[far]!)) far = k;
  const closed = [...ring, ring[0]!];
  const flags = new Uint8Array(n + 1);
  flags[0] = 1;
  flags[far] = 1;
  keepChain(closed, 0, far, epsilon, flags);
  keepChain(closed, far, n, epsilon, flags);
  const kept = flags.slice(0, n);
  return kept.reduce((sum, f) => sum + f, 0) >= 3 ? kept : kept.fill(1);
}

/** Rend des sommets aux côtés fautifs jusqu'à ce qu'il n'y en ait plus ; à défaut, les anneaux d'origine. */
function refineUntilValid(rings: readonly (readonly XY[])[], kept: Uint8Array[]): void {
  const total = rings.reduce((sum, ring) => sum + ring.length, 0);
  for (let pass = 0; pass <= total; pass += 1) {
    const sides = sidesOf(rings, kept);
    const faulty = conflicting(sides);
    if (faulty.size === 0) return;
    let changed = false;
    for (const i of faulty) changed = split(rings, kept, sides[i]!) || changed;
    if (!changed) break;
  }
  // Filet : ne devrait jamais servir — les anneaux d'origine ne se croisent pas.
  for (const flags of kept) flags.fill(1);
}

function sidesOf(rings: readonly (readonly XY[])[], kept: readonly Uint8Array[]): Side[] {
  const sides: Side[] = [];
  rings.forEach((ring, r) => {
    const indices = [...kept[r]!.keys()].filter((k) => kept[r]![k] === 1);
    const first = sides.length;
    indices.forEach((from, i) => {
      const to = indices[(i + 1) % indices.length]!;
      const prev = first + ((i - 1 + indices.length) % indices.length);
      sides.push({ ring: r, from, to, a: ring[from]!, b: ring[to]!, prev });
    });
  });
  return sides;
}

/** Rend au côté le sommet d'origine le plus loin de sa corde (le milieu s'ils sont tous dessus) ; faux s'il n'en a pas. */
function split(rings: readonly (readonly XY[])[], kept: Uint8Array[], side: Side): boolean {
  const ring = rings[side.ring]!;
  const n = ring.length;
  const span = (side.to - side.from + n) % n || n;
  if (span <= 1) return false;
  let best = (side.from + Math.floor(span / 2)) % n;
  let bestDistance = 0;
  for (let step = 1; step < span; step += 1) {
    const k = (side.from + step) % n;
    const distance = distanceToChord(ring[k]!, side.a, side.b);
    if (distance > bestDistance) {
      best = k;
      bestDistance = distance;
    }
  }
  kept[side.ring]![best] = 1;
  return true;
}

const same = (p: XY, q: XY): boolean => p.x === q.x && p.y === q.y;

function orient(a: XY, b: XY, c: XY): number {
  return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

/** `p` est dans l'intérieur du côté [a, b] : alignée sur lui, entre ses bouts, et aucun des deux. */
function touchesInside(p: XY, a: XY, b: XY): boolean {
  if (orient(a, b, p) !== 0 || same(p, a) || same(p, b)) return false;
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  );
}

/** Deux côtés en conflit : ils se croisent, l'un touche l'intérieur de l'autre, ou ils se doublent. */
function conflict(s: Side, t: Side): boolean {
  const crossing =
    orient(s.a, s.b, t.a) * orient(s.a, s.b, t.b) < 0 &&
    orient(t.a, t.b, s.a) * orient(t.a, t.b, s.b) < 0;
  if (crossing) return true;
  const touching =
    touchesInside(t.a, s.a, s.b) ||
    touchesInside(t.b, s.a, s.b) ||
    touchesInside(s.a, t.a, t.b) ||
    touchesInside(s.b, t.a, t.b);
  return touching || (same(s.a, t.a) && same(s.b, t.b)) || (same(s.a, t.b) && same(s.b, t.a));
}

/** Le côté d'un seau de l'index : 16 sommets de grille (4 m). */
const BUCKET = 16;

/** Les côtés fautifs : réduits à un point, ou en conflit avec un autre (paires cherchées par seaux). */
function conflicting(sides: readonly Side[]): Set<number> {
  const faulty = new Set<number>();
  const buckets = new Map<number, number[]>();
  sides.forEach((side, i) => {
    if (same(side.a, side.b)) faulty.add(i);
    for (const key of bucketsOf(side)) {
      const list = buckets.get(key);
      if (list === undefined) buckets.set(key, [i]);
      else list.push(i);
    }
  });
  const seen = new Set<number>();
  for (const list of buckets.values()) checkBucket(list, sides, seen, faulty);
  crossingAtSharedVertices(sides, faulty);
  return faulty;
}

/**
 * LE CROISEMENT AU SOMMET COMMUN (seconde relecture du 2026-09-25). Deux
 * passages par le même sommet gardé — deux anneaux, ou deux fois le même, au
 * coin de deux cellules en diagonale — ne s'y touchent que s'ils ne s'y
 * croisent pas : les deux directions de l'un (vers le sommet d'avant, vers celui
 * d'après) doivent tomber du même côté de l'angle que dessinent celles de
 * l'autre. Aucune paire de côtés ne le voit — ils ne partagent qu'un bout —,
 * d'où ce test à part ; en fautes, les quatre côtés des deux passages. Les
 * anneaux tracés ne s'y croisent jamais (à un coin, chaque passage tourne vers
 * sa cellule) : la boucle converge toujours.
 */
function crossingAtSharedVertices(sides: readonly Side[], faulty: Set<number>): void {
  const passes = new Map<string, number[]>();
  sides.forEach((side, i) => {
    const key = `${side.a.x},${side.a.y}`;
    const list = passes.get(key);
    if (list === undefined) passes.set(key, [i]);
    else list.push(i);
  });
  for (const list of passes.values()) {
    for (let u = 0; u < list.length; u += 1) {
      for (let v = u + 1; v < list.length; v += 1) {
        const [i, j] = [list[u]!, list[v]!];
        if (!interleaved(pass(sides, i), pass(sides, j))) continue;
        for (const k of [i, sides[i]!.prev, j, sides[j]!.prev]) faulty.add(k);
      }
    }
  }
}

/** Un passage par le sommet `a` du côté `i` : la direction vers le sommet d'avant, puis vers celui d'après. */
function pass(sides: readonly Side[], i: number): readonly [XY, XY] {
  const side = sides[i]!;
  const before = sides[side.prev]!.a;
  return [
    { x: before.x - side.a.x, y: before.y - side.a.y },
    { x: side.b.x - side.a.x, y: side.b.y - side.a.y },
  ];
}

const cross = (u: XY, v: XY): number => Math.sign(u.x * v.y - u.y * v.x);
const sameDirection = (u: XY, v: XY): boolean => cross(u, v) === 0 && u.x * v.x + u.y * v.y > 0;

/** `w` est strictement dans l'angle balayé de `u` à `v` dans le sens trigonométrique. */
function inSector(u: XY, v: XY, w: XY): boolean {
  const turn = cross(u, v);
  if (turn > 0) return cross(u, w) > 0 && cross(w, v) > 0;
  if (turn < 0) return !(cross(v, w) >= 0 && cross(w, u) >= 0);
  return cross(u, w) > 0; // u et v opposés : le demi-plan à gauche de u
}

/** Deux passages se croisent : les directions de l'un de part et d'autre de l'angle de l'autre, ou confondues. */
function interleaved([a1, a2]: readonly [XY, XY], [b1, b2]: readonly [XY, XY]): boolean {
  const rays = [a1, a2, b1, b2];
  const doubled = rays.some((u, k) => rays.some((w, m) => m > k && sameDirection(u, w)));
  return doubled || inSector(a1, a2, b1) !== inSector(a1, a2, b2);
}

function bucketsOf(side: Side): number[] {
  const keys: number[] = [];
  const x1 = Math.floor(Math.max(side.a.x, side.b.x) / BUCKET);
  const y0 = Math.floor(Math.min(side.a.y, side.b.y) / BUCKET);
  const y1 = Math.floor(Math.max(side.a.y, side.b.y) / BUCKET);
  for (let x = Math.floor(Math.min(side.a.x, side.b.x) / BUCKET); x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) keys.push(x * 1_000_003 + y);
  }
  return keys;
}

function checkBucket(
  list: readonly number[],
  sides: readonly Side[],
  seen: Set<number>,
  faulty: Set<number>,
): void {
  for (let u = 0; u < list.length; u += 1) {
    for (let v = u + 1; v < list.length; v += 1) {
      const i = Math.min(list[u]!, list[v]!);
      const j = Math.max(list[u]!, list[v]!);
      const key = i * sides.length + j;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!conflict(sides[i]!, sides[j]!)) continue;
      faulty.add(i);
      faulty.add(j);
    }
  }
}
