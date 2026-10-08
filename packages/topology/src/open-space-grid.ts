/**
 * la grille de l'espace public au bout de l'impasse : un repère
 * local en mètres, le tamponnage des zones et des polygones, et les trois
 * parcours (ouverture, composante connexe) dont `open-space.ts` a besoin.
 *
 * Pourquoi une grille et pas un découpage de polygones : aucune dépendance
 * (le précédent est `packages/swept-path/src/footprint-raster.ts`), un
 * résultat qui ne dépend pas des défauts de topologie du cadastre (sommets
 * doublés, anneaux qui se touchent, parcelles qui se chevauchent de quelques
 * centimètres), et un coût borné par le nombre de cellules — pas par la forme
 * des données. Une cellule est « dans » un polygone quand son CENTRE y est.
 */
import type { GeoPoint } from '@teneolog/domain';

/** Mètres par degré de latitude — la sphère de `haversineM` (rayon 6 371 008,8 m). */
const M_PER_DEG_LAT = (6_371_008.8 * Math.PI) / 180;

export interface XY {
  readonly x: number;
  readonly y: number;
}

/** Un repère équirectangulaire local : x vers l'est, y vers le nord, en mètres depuis le coin sud-ouest. */
export interface GridFrame {
  readonly south: number;
  readonly west: number;
  readonly mPerDegLon: number;
  readonly cellM: number;
  readonly cols: number;
  readonly rows: number;
}

export interface GeoBox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

export function frameOf(box: GeoBox, cellM: number): GridFrame {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((((box.south + box.north) / 2) * Math.PI) / 180);
  return {
    south: box.south,
    west: box.west,
    mPerDegLon,
    cellM,
    cols: Math.max(1, Math.ceil(((box.east - box.west) * mPerDegLon) / cellM)),
    rows: Math.max(1, Math.ceil(((box.north - box.south) * M_PER_DEG_LAT) / cellM)),
  };
}

export function toXY(frame: GridFrame, p: GeoPoint): XY {
  return { x: (p.lon - frame.west) * frame.mPerDegLon, y: (p.lat - frame.south) * M_PER_DEG_LAT };
}

export function toGeo(frame: GridFrame, p: XY): GeoPoint {
  return { lat: frame.south + p.y / M_PER_DEG_LAT, lon: frame.west + p.x / frame.mPerDegLon };
}

/** Un rayon en mètres, en degrés de latitude et de longitude à la latitude `lat`. */
export function metresInDegrees(
  radiusM: number,
  lat: number,
): { readonly dLat: number; readonly dLon: number } {
  return {
    dLat: radiusM / M_PER_DEG_LAT,
    dLon: radiusM / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)),
  };
}

/** La position de p le long de [a, b], non bornée : 0 en a, 1 en b (0 quand a = b). */
function alongOf(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  return lenSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
}

/** Le carré de la distance de p au segment [a, b], `along` étant la position de p le long de lui. */
function segmentDistanceSq(p: XY, a: XY, b: XY, along: number): number {
  const t = Math.max(0, Math.min(1, along));
  const ex = a.x + t * (b.x - a.x) - p.x;
  const ey = a.y + t * (b.y - a.y) - p.y;
  return ex * ex + ey * ey;
}

/** Les indices de cellules dont le centre tombe dans [lo, hi] sur un axe de `count` cellules. */
function cellRange(
  lo: number,
  hi: number,
  cellM: number,
  count: number,
): readonly [number, number] {
  return [
    Math.max(0, Math.ceil(lo / cellM - 0.5)),
    Math.min(count - 1, Math.floor(hi / cellM - 0.5)),
  ];
}

/**
 * Pose `1` sur chaque cellule dont le centre est à au plus `radiusM` du
 * segment [a, b] (un point quand a = b) — le tampon d'une polyligne, segment
 * par segment.
 */
export function stampNearSegment(
  grid: Uint8Array,
  frame: GridFrame,
  a: XY,
  b: XY,
  radiusM: number,
): void {
  visitNearSegment(frame, a, b, radiusM, (k) => {
    grid[k] = 1;
  });
}

/**
 * Appelle `visit(k, along, distSq)` pour chaque cellule dont le centre est à au
 * plus `radiusM` du segment [a, b] : son indice, sa position le long du segment
 * (non bornée : < 0 avant a, > 1 après b) et le carré de sa distance au segment.
 */
export function visitNearSegment(
  frame: GridFrame,
  a: XY,
  b: XY,
  radiusM: number,
  visit: (k: number, along: number, distSq: number) => void,
): void {
  const { cellM, cols, rows } = frame;
  const [i0, i1] = cellRange(
    Math.min(a.x, b.x) - radiusM,
    Math.max(a.x, b.x) + radiusM,
    cellM,
    cols,
  );
  const [j0, j1] = cellRange(
    Math.min(a.y, b.y) - radiusM,
    Math.max(a.y, b.y) + radiusM,
    cellM,
    rows,
  );
  const limit = radiusM * radiusM;
  for (let j = j0; j <= j1; j += 1) {
    const y = (j + 0.5) * cellM;
    for (let i = i0; i <= i1; i += 1) {
      const p = { x: (i + 0.5) * cellM, y };
      const along = alongOf(p, a, b);
      const distSq = segmentDistanceSq(p, a, b, along);
      if (distSq <= limit) visit(j * cols + i, along, distSq);
    }
  }
}

/** Les abscisses où les arêtes des anneaux coupent l'horizontale `y`, triées. */
function crossingsAt(rings: readonly (readonly XY[])[], y: number): number[] {
  const xs: number[] = [];
  for (const ring of rings) {
    for (let k = 0, prev = ring.length - 1; k < ring.length; prev = k, k += 1) {
      const p = ring[prev]!;
      const q = ring[k]!;
      if (p.y > y !== q.y > y) xs.push(p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y));
    }
  }
  return xs.sort((u, v) => u - v);
}

/**
 * Pose `1` sur chaque cellule dont le centre est dans le polygone — anneau
 * extérieur et trous, règle pair-impair : un trou est hors du polygone.
 */
export function fillPolygon(
  grid: Uint8Array,
  frame: GridFrame,
  rings: readonly (readonly XY[])[],
): void {
  const { cellM, cols, rows } = frame;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  const [j0, j1] = cellRange(minY, maxY, cellM, rows);
  for (let j = j0; j <= j1; j += 1) {
    const xs = crossingsAt(rings, (j + 0.5) * cellM);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const [i0, i1] = cellRange(xs[k]!, xs[k + 1]!, cellM, cols);
      grid.fill(1, j * cols + i0, i1 >= i0 ? j * cols + i1 + 1 : j * cols + i0);
    }
  }
}

/** Les cellules à `1` dans `grid` dont TOUT le carré de côté 2r + 1 est à `1` (bord de grille = 0). */
export function erodeSquare(grid: Uint8Array, cols: number, rows: number, r: number): Uint8Array {
  const across = runAllOnes(grid, cols, rows, r, 1, cols);
  return runAllOnes(across, rows, cols, r, cols, 1);
}

/**
 * Passe 1D de l'érosion : la cellule garde 1 si les 2r + 1 cellules de sa
 * ligne (pas `step`) sont à 1. `lines` lignes de `length` cellules, espacées de `stride`.
 */
function runAllOnes(
  src: Uint8Array,
  length: number,
  lines: number,
  r: number,
  step: number,
  stride: number,
): Uint8Array {
  const out = new Uint8Array(src.length);
  const zerosBefore = new Int32Array(length + 1);
  for (let line = 0; line < lines; line += 1) {
    const base = line * stride;
    for (let k = 0; k < length; k += 1)
      zerosBefore[k + 1] = zerosBefore[k]! + (src[base + k * step] === 1 ? 0 : 1);
    for (let k = r; k < length - r; k += 1) {
      if (zerosBefore[k + r + 1]! - zerosBefore[k - r]! === 0) out[base + k * step] = 1;
    }
  }
  return out;
}

/**
 * Parcours en largeur depuis `seeds` à travers les cellules `allowed` —
 * 4-voisins et sans limite (une composante connexe), ou 8-voisins sur au
 * plus `depth` pas (une dilatation qui ne traverse pas un obstacle).
 */
export function grow(
  seeds: Uint8Array,
  allowed: Uint8Array,
  frame: Pick<GridFrame, 'cols' | 'rows'>,
  mode: { readonly neighbours: 4 | 8; readonly depth: number },
): Uint8Array {
  const reached = new Uint8Array(seeds.length);
  let frontier: number[] = [];
  for (let k = 0; k < seeds.length; k += 1) {
    if (seeds[k] === 1 && allowed[k] === 1) {
      reached[k] = 1;
      frontier.push(k);
    }
  }
  const offsets = mode.neighbours === 4 ? NEIGHBOURS_4 : NEIGHBOURS_8;
  for (let step = 0; step < mode.depth && frontier.length > 0; step += 1) {
    const next: number[] = [];
    for (const k of frontier) spread(k, offsets, frame, allowed, reached, next);
    frontier = next;
  }
  return reached;
}

/** Un pas du parcours depuis la cellule `k` : ses voisins permis et pas encore atteints rejoignent `next`. */
function spread(
  k: number,
  offsets: readonly (readonly [number, number])[],
  frame: Pick<GridFrame, 'cols' | 'rows'>,
  allowed: Uint8Array,
  reached: Uint8Array,
  next: number[],
): void {
  const { cols, rows } = frame;
  const i = k % cols;
  const j = (k - i) / cols;
  for (const [di, dj] of offsets) {
    const ni = i + di;
    const nj = j + dj;
    if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
    const n = nj * cols + ni;
    if (reached[n] === 1 || allowed[n] !== 1) continue;
    reached[n] = 1;
    next.push(n);
  }
}

const NEIGHBOURS_4: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const NEIGHBOURS_8: readonly (readonly [number, number])[] = [
  ...NEIGHBOURS_4,
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
