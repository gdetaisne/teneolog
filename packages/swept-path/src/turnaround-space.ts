/**
 * L'ESPACE OÙ LE CAMION MANŒUVRE, préparé une fois pour des
 * dizaines de milliers de questions : « ce côté de caisse, ce balayage,
 * touchent-ils le bord ? ». L'espace est une liste d'anneaux quelconques, en
 * mètres locaux, à remplir en règle pair-impair (extérieurs et trous) — la
 * forme de `turnaroundMap.openSpace` (la note de conception interne
 * §3.1), sans rien supposer de sa forme (placette, voie, passage).
 *
 * Deux structures, une seule vérité (les côtés des anneaux) :
 *  - UNE GRILLE DES DISTANCES à `SPACE_GRID_CELL_M` (0,1 m) : au centre de
 *    chaque cellule, la distance EXACTE au côté le plus proche, plafonnée à
 *    `SPACE_BAND_M` (2 m). La distance est 1-lipschitzienne : en tout point p
 *    de la cellule, elle vaut au moins la valeur du centre moins la
 *    demi-diagonale (7 cm). C'est la voie rapide : loin des bords, un pas de
 *    lecture couvre jusqu'à 2 m de côté de caisse ;
 *  - DES SEAUX DE CÔTÉS de `SPACE_BUCKET_M` (0,5 m) : près d'un bord, la
 *    distance se recalcule exactement sur les côtés des 3 × 3 seaux voisins.
 *    La grille ne décide donc jamais seule d'un contact : elle ne fait que
 *    sauter ce qui est loin.
 *
 * Ce que ce module ne dit pas : de quel côté d'un bord est un point. Le
 * balayage le sait par continuité (`turnaround-motion.ts`) : un contour que
 * rien ne touche et dont un point est dedans est dedans en entier. Le test
 * pair-impair (`pointInSpace`) sert à la pose de départ et à la vérification.
 *
 * LES AIRES INTERDITES (`forbidden` : place piétonne, parc, pelouse) sont gardées À PART des
 * anneaux de l'espace (seconde relecture du 2026-09-25) : ajoutées en trous pair-impair, une aire qui
 * débordait de l'espace, ou deux aires qui se chevauchaient, se lisaient « dedans » — de l'espace
 * roulable hors de l'espace public. Un point est dans l'espace quand il est pair-impair dans les anneaux
 * de l'espace ET hors de CHAQUE aire interdite ; les côtés des deux listes sont des bords.
 */
import type { Point } from './types.js';

/** La maille de la grille des distances. */
const SPACE_GRID_CELL_M = 0.1;
/** Au-delà, la grille dit « au moins 2 m » : un pas de lecture ne couvre jamais plus. */
const SPACE_BAND_M = 2;
/** Les seaux des côtés : une requête exacte lit les 3 × 3 seaux autour d'un point. */
const SPACE_BUCKET_M = 0.5;
const HALF_DIAG_M = SPACE_GRID_CELL_M * Math.SQRT1_2;
/** Un plafond de garde (~24 Mo) : 240 × 250 m à 0,1 m — au-delà, ce n'est pas un bout d'impasse. */
const MAX_GRID_CELLS = 6_000_000;
/** Un côté plus court que ça est un sommet doublé : il ne borne rien. */
const MIN_EDGE_M = 1e-9;
/** Un pas sûr plus court que ça : on passe à la lecture exacte, par tronçons d'un quart de seau. */
const FAST_STEP_MIN_M = 0.03;
const EXACT_PIECE_M = SPACE_BUCKET_M / 2;

export interface PreparedSpace {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** Les côtés, ax, ay, bx, by à la suite. */
  readonly edges: Float64Array;
  /** Leurs boîtes, minX, minY, maxX, maxY à la suite. */
  readonly edgeBoxes: Float64Array;
  readonly edgeCount: number;
  /** Les côtés des anneaux de l'espace : les premiers ; ceux des aires interdites suivent. */
  readonly spaceEdgeCount: number;
  /** Les côtés de chaque aire interdite : [début, fin) à la suite, en index de côté. */
  readonly forbiddenRanges: Int32Array;
  /** Premier sommet et boîte de chaque anneau, aires interdites comprises (x0, y0, minX, minY, maxX, maxY). */
  readonly rings: Float64Array;
  readonly ringCount: number;
  readonly grid: Float32Array;
  readonly gridX0: number;
  readonly gridY0: number;
  readonly gridCols: number;
  readonly gridRows: number;
  readonly bucketX0: number;
  readonly bucketY0: number;
  readonly bucketCols: number;
  readonly bucketRows: number;
  /** Seaux en CSR : les côtés du seau k sont bucketItems[bucketStart[k] .. bucketStart[k + 1]). */
  readonly bucketStart: Int32Array;
  readonly bucketItems: Int32Array;
}

export type PrepareSpaceResult =
  | { readonly ok: true; readonly space: PreparedSpace }
  | { readonly ok: false; readonly why: 'space_empty' | 'space_invalid' | 'space_too_large' };

/** Les anneaux lus : sommets finis, sommet de fermeture retiré, côtés nuls ignorés. */
function readRings(rings: readonly (readonly Point[])[]): Point[][] | 'space_invalid' {
  const kept: Point[][] = [];
  for (const ring of rings) {
    if (!ring.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return 'space_invalid';
    const open = ring.length > 1 && ring[0]!.x === ring[ring.length - 1]!.x && ring[0]!.y === ring[ring.length - 1]!.y
      ? ring.slice(0, -1)
      : [...ring];
    if (open.length >= 3) kept.push(open);
  }
  return kept;
}

function edgesOf(rings: readonly Point[][]): { edges: Float64Array; count: number } {
  const total = rings.reduce((sum, ring) => sum + ring.length, 0);
  const edges = new Float64Array(total * 4);
  let count = 0;
  for (const ring of rings) {
    for (let k = 0; k < ring.length; k += 1) {
      const a = ring[k]!;
      const b = ring[(k + 1) % ring.length]!;
      if (Math.hypot(b.x - a.x, b.y - a.y) < MIN_EDGE_M) continue;
      edges.set([a.x, a.y, b.x, b.y], count * 4);
      count += 1;
    }
  }
  return { edges, count };
}

function boxesOf(edges: Float64Array, count: number): Float64Array {
  const boxes = new Float64Array(count * 4);
  for (let e = 0; e < count * 4; e += 4) {
    boxes[e] = Math.min(edges[e]!, edges[e + 2]!);
    boxes[e + 1] = Math.min(edges[e + 1]!, edges[e + 3]!);
    boxes[e + 2] = Math.max(edges[e]!, edges[e + 2]!);
    boxes[e + 3] = Math.max(edges[e + 1]!, edges[e + 3]!);
  }
  return boxes;
}

function ringTable(rings: readonly Point[][]): Float64Array {
  const table = new Float64Array(rings.length * 6);
  rings.forEach((ring, r) => {
    const xs = ring.map((p) => p.x);
    const ys = ring.map((p) => p.y);
    table.set([ring[0]!.x, ring[0]!.y, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], r * 6);
  });
  return table;
}

/** Distance du point (px, py) au segment (ax, ay)–(bx, by). */
function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Distance entre deux segments : 0 quand ils se coupent, sinon la plus courte des quatre extrémités. */
function segmentSegmentDistance(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number {
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return 0;
  return Math.min(
    pointSegmentDistance(cx, cy, ax, ay, bx, by),
    pointSegmentDistance(dx, dy, ax, ay, bx, by),
    pointSegmentDistance(ax, ay, cx, cy, dx, dy),
    pointSegmentDistance(bx, by, cx, cy, dx, dy),
  );
}

interface Frame {
  readonly x0: number;
  readonly y0: number;
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
}

function frameAround(minX: number, minY: number, maxX: number, maxY: number, cell: number, padCells: number): Frame {
  return {
    x0: minX - padCells * cell,
    y0: minY - padCells * cell,
    cols: Math.ceil((maxX - minX) / cell) + 2 * padCells + 1,
    rows: Math.ceil((maxY - minY) / cell) + 2 * padCells + 1,
    cell,
  };
}

/** La grille : distance exacte au côté le plus proche au centre de chaque cellule, plafonnée à la bande. */
function distanceGrid(frame: Frame, edges: Float64Array, count: number): Float32Array {
  const grid = new Float32Array(frame.cols * frame.rows).fill(SPACE_BAND_M);
  const { cell, x0, y0 } = frame;
  for (let e = 0; e < count; e += 1) {
    const ax = edges[e * 4]!;
    const ay = edges[e * 4 + 1]!;
    const bx = edges[e * 4 + 2]!;
    const by = edges[e * 4 + 3]!;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - SPACE_BAND_M - x0) / cell));
    const i1 = Math.min(frame.cols - 1, Math.ceil((Math.max(ax, bx) + SPACE_BAND_M - x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - SPACE_BAND_M - y0) / cell));
    const j1 = Math.min(frame.rows - 1, Math.ceil((Math.max(ay, by) + SPACE_BAND_M - y0) / cell));
    for (let j = j0; j <= j1; j += 1) {
      const cy = y0 + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i += 1) {
        const d = pointSegmentDistance(x0 + (i + 0.5) * cell, cy, ax, ay, bx, by);
        const k = j * frame.cols + i;
        if (d < grid[k]!) grid[k] = d;
      }
    }
  }
  return grid;
}

/** Les seaux touchés par un côté : ceux de sa boîte dont le centre est à moins d'une demi-diagonale du côté. */
function forEachBucketOfEdge(frame: Frame, edges: Float64Array, e: number, visit: (k: number) => void): void {
  const ax = edges[e * 4]!;
  const ay = edges[e * 4 + 1]!;
  const bx = edges[e * 4 + 2]!;
  const by = edges[e * 4 + 3]!;
  const reach = frame.cell * Math.SQRT1_2 + 1e-9;
  const i0 = Math.floor((Math.min(ax, bx) - frame.x0) / frame.cell);
  const i1 = Math.floor((Math.max(ax, bx) - frame.x0) / frame.cell);
  const j0 = Math.floor((Math.min(ay, by) - frame.y0) / frame.cell);
  const j1 = Math.floor((Math.max(ay, by) - frame.y0) / frame.cell);
  for (let j = j0; j <= j1; j += 1) {
    for (let i = i0; i <= i1; i += 1) {
      const cx = frame.x0 + (i + 0.5) * frame.cell;
      const cy = frame.y0 + (j + 0.5) * frame.cell;
      if (pointSegmentDistance(cx, cy, ax, ay, bx, by) <= reach) visit(j * frame.cols + i);
    }
  }
}

function edgeBuckets(frame: Frame, edges: Float64Array, count: number): { start: Int32Array; items: Int32Array } {
  const start = new Int32Array(frame.cols * frame.rows + 1);
  for (let e = 0; e < count; e += 1) forEachBucketOfEdge(frame, edges, e, (k) => { start[k + 1]! += 1; });
  for (let k = 0; k < frame.cols * frame.rows; k += 1) start[k + 1]! += start[k]!;
  const fill = start.slice(0, -1);
  const items = new Int32Array(start[frame.cols * frame.rows]!);
  for (let e = 0; e < count; e += 1) forEachBucketOfEdge(frame, edges, e, (k) => { items[fill[k]!++] = e; });
  return { start, items };
}

function boundsOf(rings: readonly Point[][]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return [minX, minY, maxX, maxY];
}

/** Les côtés de chaque aire interdite, en [début, fin) d'index de côté, après les `spaceEdges` côtés de l'espace. */
function forbiddenRangesOf(forbidden: readonly Point[][], spaceEdges: number): Int32Array {
  const ranges = new Int32Array(forbidden.length * 2);
  let at = spaceEdges;
  forbidden.forEach((ring, k) => {
    ranges[k * 2] = at;
    at += edgesOf([ring]).count;
    ranges[k * 2 + 1] = at;
  });
  return ranges;
}

/**
 * Prépare l'espace : ses anneaux (pair-impair) et les aires interdites (chacune à part). Ne lève jamais :
 * une entrée illisible est dite par son nom.
 */
export function prepareSpace(
  input: readonly (readonly Point[])[],
  forbiddenInput: readonly (readonly Point[])[] = [],
): PrepareSpaceResult {
  const spaceRings = readRings(input);
  const forbidden = readRings(forbiddenInput);
  if (spaceRings === 'space_invalid' || forbidden === 'space_invalid') return { ok: false, why: 'space_invalid' };
  const spaceEdgeCount = edgesOf(spaceRings).count;
  if (spaceEdgeCount < 3) return { ok: false, why: 'space_empty' };
  const rings = [...spaceRings, ...forbidden];
  const { edges, count } = edgesOf(rings);
  const [minX, minY, maxX, maxY] = boundsOf(rings);
  const gridFrame = frameAround(minX, minY, maxX, maxY, SPACE_GRID_CELL_M, 2);
  if (gridFrame.cols * gridFrame.rows > MAX_GRID_CELLS) return { ok: false, why: 'space_too_large' };
  const bucketFrame = frameAround(minX, minY, maxX, maxY, SPACE_BUCKET_M, 2);
  const buckets = edgeBuckets(bucketFrame, edges, count);
  return {
    ok: true,
    space: {
      minX, minY, maxX, maxY,
      edges,
      edgeBoxes: boxesOf(edges, count),
      edgeCount: count,
      spaceEdgeCount,
      forbiddenRanges: forbiddenRangesOf(forbidden, spaceEdgeCount),
      rings: ringTable(rings),
      ringCount: rings.length,
      grid: distanceGrid(gridFrame, edges, count),
      gridX0: gridFrame.x0,
      gridY0: gridFrame.y0,
      gridCols: gridFrame.cols,
      gridRows: gridFrame.rows,
      bucketX0: bucketFrame.x0,
      bucketY0: bucketFrame.y0,
      bucketCols: bucketFrame.cols,
      bucketRows: bucketFrame.rows,
      bucketStart: buckets.start,
      bucketItems: buckets.items,
    },
  };
}

/**
 * Une borne BASSE de la distance de (x, y) au côté le plus proche, par la
 * grille. Hors de la grille : −1 (hors de la boîte des anneaux, donc dehors).
 */
function clearanceLowerBound(space: PreparedSpace, x: number, y: number): number {
  const i = Math.floor((x - space.gridX0) / SPACE_GRID_CELL_M);
  const j = Math.floor((y - space.gridY0) / SPACE_GRID_CELL_M);
  if (i < 0 || j < 0 || i >= space.gridCols || j >= space.gridRows) return -1;
  return space.grid[j * space.gridCols + i]! - HALF_DIAG_M;
}

/** Une borne HAUTE de la même distance ; `Infinity` au-delà de la bande (la grille n'en sait pas plus). */
export function clearanceUpperBound(space: PreparedSpace, x: number, y: number): number {
  const i = Math.floor((x - space.gridX0) / SPACE_GRID_CELL_M);
  const j = Math.floor((y - space.gridY0) / SPACE_GRID_CELL_M);
  if (i < 0 || j < 0 || i >= space.gridCols || j >= space.gridRows) return Infinity;
  const d = space.grid[j * space.gridCols + i]!;
  return d >= SPACE_BAND_M ? Infinity : d + HALF_DIAG_M;
}

function pointSegmentDistanceSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/** Les segments sont-ils à moins de `eps` l'un de l'autre (ou se coupent-ils) ? */
function segmentsWithin(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number, eps: number,
): boolean {
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const epsSq = eps * eps;
  return (
    pointSegmentDistanceSq(cx, cy, ax, ay, bx, by) < epsSq ||
    pointSegmentDistanceSq(dx, dy, ax, ay, bx, by) < epsSq ||
    pointSegmentDistanceSq(ax, ay, cx, cy, dx, dy) < epsSq ||
    pointSegmentDistanceSq(bx, by, cx, cy, dx, dy) < epsSq
  );
}

/**
 * Un côté des anneaux est-il à moins de `eps` du segment (ax, ay)–(bx, by),
 * de longueur au plus `EXACT_PIECE_M` ? Lu sur les côtés des 3 × 3 seaux
 * autour de son milieu : exact pour `eps` < 0,37 m (un point d'un côté à moins
 * de `eps` du segment est dans un de ces seaux). Les boîtes écartent d'abord
 * les côtés trop loin.
 */
function pieceTouches(space: PreparedSpace, ax: number, ay: number, bx: number, by: number, eps: number): boolean {
  const bi = Math.floor(((ax + bx) / 2 - space.bucketX0) / SPACE_BUCKET_M);
  const bj = Math.floor(((ay + by) / 2 - space.bucketY0) / SPACE_BUCKET_M);
  const minX = Math.min(ax, bx) - eps;
  const maxX = Math.max(ax, bx) + eps;
  const minY = Math.min(ay, by) - eps;
  const maxY = Math.max(ay, by) + eps;
  const { edges, edgeBoxes } = space;
  for (let j = Math.max(0, bj - 1); j <= Math.min(space.bucketRows - 1, bj + 1); j += 1) {
    for (let i = Math.max(0, bi - 1); i <= Math.min(space.bucketCols - 1, bi + 1); i += 1) {
      const k = j * space.bucketCols + i;
      for (let n = space.bucketStart[k]!; n < space.bucketStart[k + 1]!; n += 1) {
        const e = space.bucketItems[n]! * 4;
        if (edgeBoxes[e]! > maxX || edgeBoxes[e + 2]! < minX || edgeBoxes[e + 1]! > maxY || edgeBoxes[e + 3]! < minY) continue;
        if (segmentsWithin(ax, ay, bx, by, edges[e]!, edges[e + 1]!, edges[e + 2]!, edges[e + 3]!, eps)) return true;
      }
    }
  }
  return false;
}

/**
 * Vrai quand TOUT le segment (ax, ay)–(bx, by) est à au moins `eps` de tout
 * côté des anneaux. Loin des bords, la grille avance d'un pas sûr (tout point
 * à moins de `borne − eps` d'un point lu garde `eps`) ; près d'un bord, le
 * segment se lit exactement par tronçons de 0,25 m. Ne dit rien du côté.
 */
export function segmentClear(space: PreparedSpace, ax: number, ay: number, bx: number, by: number, eps: number): boolean {
  const length = Math.hypot(bx - ax, by - ay);
  const ux = length === 0 ? 0 : (bx - ax) / length;
  const uy = length === 0 ? 0 : (by - ay) / length;
  let t = 0;
  while (t < length || (t === 0 && length === 0)) {
    const px = ax + ux * t;
    const py = ay + uy * t;
    const step = clearanceLowerBound(space, px, py) - eps;
    if (step >= FAST_STEP_MIN_M) {
      t += step;
      continue;
    }
    const t2 = Math.min(length, t + EXACT_PIECE_M);
    if (pieceTouches(space, px, py, ax + ux * t2, ay + uy * t2, eps)) return false;
    if (length === 0) return true;
    t = t2;
  }
  return true;
}

/**
 * Vrai quand la GRILLE seule prouve le segment à au moins `clearance` de tout
 * côté ; faux dès qu'elle ne le prouve plus (sans lecture exacte : c'est un
 * raccourci, `segmentClear` reste le juge).
 */
export function segmentFar(space: PreparedSpace, ax: number, ay: number, bx: number, by: number, clearance: number): boolean {
  const length = Math.hypot(bx - ax, by - ay);
  const ux = length === 0 ? 0 : (bx - ax) / length;
  const uy = length === 0 ? 0 : (by - ay) / length;
  for (let t = 0; ; ) {
    const step = clearanceLowerBound(space, ax + ux * t, ay + uy * t) - clearance;
    if (step < FAST_STEP_MIN_M) return false;
    t += step;
    if (t >= length) return true;
  }
}

/** Pair-impair sur les côtés [from, to) : le point est-il dedans ? */
function oddCrossings(edges: Float64Array, from: number, to: number, x: number, y: number): boolean {
  let inside = false;
  for (let e = from * 4; e < to * 4; e += 4) {
    const ay = edges[e + 1]!;
    const by = edges[e + 3]!;
    if (ay > y === by > y) continue;
    const ax = edges[e]!;
    const bx = edges[e + 2]!;
    if (x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/** Le point est-il dans l'espace ? Pair-impair dans ses anneaux, et hors de chaque aire interdite. */
export function pointInSpace(space: PreparedSpace, x: number, y: number): boolean {
  if (!oddCrossings(space.edges, 0, space.spaceEdgeCount, x, y)) return false;
  const ranges = space.forbiddenRanges;
  for (let k = 0; k < ranges.length; k += 2) {
    if (oddCrossings(space.edges, ranges[k]!, ranges[k + 1]!, x, y)) return false;
  }
  return true;
}

interface CellGrid {
  readonly x0: number;
  readonly y0: number;
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
}

/** Pair-impair par balayage de lignes sur les côtés [from, to) : `value` dans chaque cellule dont le centre est dedans. */
function fillSpans(out: Uint8Array, edges: Float64Array, from: number, to: number, grid: CellGrid, value: number): void {
  const { x0, y0, cols, rows, cell } = grid;
  const hits: number[] = [];
  for (let j = 0; j < rows; j += 1) {
    const y = y0 + (j + 0.5) * cell;
    hits.length = 0;
    for (let e = from * 4; e < to * 4; e += 4) {
      const ay = edges[e + 1]!;
      const by = edges[e + 3]!;
      if (ay > y === by > y) continue;
      hits.push(edges[e]! + ((y - ay) * (edges[e + 2]! - edges[e]!)) / (by - ay));
    }
    hits.sort((a, b) => a - b);
    for (let h = 0; h + 1 < hits.length; h += 2) {
      const i0 = Math.max(0, Math.ceil((hits[h]! - x0) / cell - 0.5));
      const i1 = Math.min(cols - 1, Math.floor((hits[h + 1]! - x0) / cell - 0.5));
      out.fill(value, j * cols + i0, i1 >= i0 ? j * cols + i1 + 1 : j * cols + i0);
    }
  }
}

/**
 * 1 pour chaque cellule (x0 + (i + ½)·cell, y0 + (j + ½)·cell) dont le centre est dans l'espace — dans
 * ses anneaux, hors de chaque aire interdite (`pointInSpace`). Pour le réseau des poses.
 */
export function insideCells(space: PreparedSpace, x0: number, y0: number, cols: number, rows: number, cell: number): Uint8Array {
  const out = new Uint8Array(cols * rows);
  const grid = { x0, y0, cols, rows, cell };
  fillSpans(out, space.edges, 0, space.spaceEdgeCount, grid, 1);
  const ranges = space.forbiddenRanges;
  for (let k = 0; k < ranges.length; k += 2) fillSpans(out, space.edges, ranges[k]!, ranges[k + 1]!, grid, 0);
  return out;
}

/**
 * La plus courte distance exacte d'un segment aux côtés, plafonnée à `capM` :
 * tous les côtés des seaux à moins de `capM` de sa boîte. Pour la
 * vérification (`turnaround-verify.ts`), pas pour la recherche.
 */
export function exactSegmentClearance(
  space: PreparedSpace, ax: number, ay: number, bx: number, by: number, capM: number,
): number {
  const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - capM - space.bucketX0) / SPACE_BUCKET_M));
  const i1 = Math.min(space.bucketCols - 1, Math.floor((Math.max(ax, bx) + capM - space.bucketX0) / SPACE_BUCKET_M));
  const j0 = Math.max(0, Math.floor((Math.min(ay, by) - capM - space.bucketY0) / SPACE_BUCKET_M));
  const j1 = Math.min(space.bucketRows - 1, Math.floor((Math.max(ay, by) + capM - space.bucketY0) / SPACE_BUCKET_M));
  let best = capM;
  const { edges } = space;
  for (let j = j0; j <= j1; j += 1) {
    for (let i = i0; i <= i1; i += 1) {
      const k = j * space.bucketCols + i;
      for (let n = space.bucketStart[k]!; n < space.bucketStart[k + 1]!; n += 1) {
        const e = space.bucketItems[n]! * 4;
        best = Math.min(best, segmentSegmentDistance(ax, ay, bx, by, edges[e]!, edges[e + 1]!, edges[e + 2]!, edges[e + 3]!));
      }
    }
  }
  return best;
}
