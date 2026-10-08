/**
 * LA RECHERCHE DU DEMI-TOUR dans un espace quelconque : A* sur un
 * réseau de poses (« hybride » : les poses restent continues, le réseau ne sert
 * qu'à dédoublonner), le coût le moins de TEMPS d'abord, puis le moins de
 * mètres. Le modèle est écrit en tête de `turnaround-plan.ts`.
 *
 *  - ÉTAT : la pose de l'essieu arrière, le sens du dernier pas, le nombre de
 *    changements de sens (les temps moins un), les mètres roulés.
 *  - PAS : `TURNAROUND_STEP_M` (0,5 m) au braquage maxi à gauche, à droite, ou
 *    droit ; en avant, et en arrière si le camion recule. Quand le pas entier
 *    touche le bord, le pas s'arrête au contact (dichotomie à 1/8 de pas, 6 cm) :
 *    un chauffeur recule jusqu'au mur, pas jusqu'au dernier multiple de 0,5 m.
 *  - COÛT : temps × 10 000 + mètres (un demi-tour de plus de 999 m n'en est pas
 *    un) — `tempsCostM` baisse le prix d'un temps pour la variante compacte ;
 *    un changement de braquage en roulant coûte `STEER_CHANGE_COST_M` (le
 *    chemin le plus calme à temps et longueur presque égaux), à l'arrêt il est
 *    gratuit.
 *  - DOUBLONS : une pose par case de `POSITION_BIN_M` (0,25 m) × `HEADING_BIN_DEG`
 *    (5°) et par sens ; et une pose atteinte dans un sens domine la même pose
 *    dans l'autre sens au coût d'un temps de plus (changer de sens sur place
 *    coûte un temps et zéro mètre).
 *  - PRIORITÉ : un camion qui recule a encore au moins un temps à faire (on ne
 *    finit qu'en avant) — les reculs d'un temps se mêlent donc, par longueur,
 *    aux marches avant du temps suivant au lieu d'être tous développés avant — ;
 *    puis les mètres estimés (`turnaround-heuristic.ts` en avant, Rr × l'écart
 *    de cap en arrière). Le compte des temps y est exact et prime : les mètres
 *    estimés ne départagent que des poses d'un même nombre de temps, et le
 *    demi-tour rendu a le moins de temps que ce parcours du réseau atteint (un
 *    réseau ne garde qu'une pose par case : l'ordre du parcours peut, dans un
 *    cas limite, décider d'un temps — mesuré le 2026-09-25 contre un parcours
 *    presque par longueur, sans la table, sur 31 cas : les mêmes temps partout,
 *    des chemins à 0,5 m près).
 *  - BUDGET : un nombre d'expansions (déterministe) et un délai (garde-fou) ;
 *    budget épuisé = « pas trouvé », dit par son nom, jamais un refus.
 */
import { angleGap } from './three-point-search.js';
import { bodyFar, stepPose, stepReachM, sweepClear, type Direction, type MotionCtx, type Steer } from './turnaround-motion.js';
import type { ExitTable } from './turnaround-heuristic.js';
import { clearanceUpperBound, insideCells } from './turnaround-space.js';
import type { Point, Pose } from './types.js';

export const TURNAROUND_STEP_M = 0.5;
export const POSITION_BIN_M = 0.25;
export const HEADING_BIN_DEG = 5;
const HEADING_BINS = 360 / HEADING_BIN_DEG;
const HEADING_BIN_RAD = (HEADING_BIN_DEG * Math.PI) / 180;
const STEER_CHANGE_COST_M = 0.25;
const CONTACT_BISECTIONS = 3;
const MIN_CONTACT_STEP_M = 0.05;
/**
 * Un temps pèse plus que tout chemin et toute estimation : par défaut, le compte des temps prime,
 * toujours. `SearchInput.tempsCostM` le baisse pour la variante compacte.
 */
export const DEFAULT_TEMPS_COST_M = 10_000;
/** Un demi-tour de plus de 999 m n'en est pas un. */
const MAX_LENGTH_M = 999;
/** L'estimation plafonnée : elle reste sous un temps (au coût par défaut). */
const MAX_ESTIMATE_M = 5_000;
const CLOCK_EVERY = 256;
const STEERS: readonly Steer[] = [-1, 0, 1];

/** Où finir : en avant, près du chemin de sortie, dans son sens, et une longueur de camion droit devant. */
export interface SearchGoal {
  /** Le chemin de sortie en segments (ax, ay, ux, uy, longueur, cap) — `exitSegments`. */
  readonly segments: Float64Array;
  readonly headingToleranceRad: number;
  readonly lateralM: number;
  readonly driveAwayM: number;
  /** L'essieu arrière reste à au plus tant du chemin de sortie (Infinity : partout dans l'espace). */
  readonly reachM: number;
}

export interface SearchInput {
  readonly ctx: MotionCtx;
  readonly start: Pose;
  readonly reversing: boolean;
  readonly maxTemps: number;
  readonly maxExpansions: number;
  /** `performance.now()` au-delà duquel on s'arrête. */
  readonly deadline: number;
  readonly goal: SearchGoal;
  /** Ce que coûte un temps de plus, en mètres (`DEFAULT_TEMPS_COST_M` : le moins de temps d'abord). */
  readonly tempsCostM: number;
  /**
   * Ce qu'il reste à rouler en avant, sans obstacle (`turnaround-heuristic.ts`) : ce qui guide la
   * recherche vers la sortie. Sans elle (Rr × l'écart de cap seul), la recherche développait presque
   * par longueur, et un grand espace ouvert épuisait le budget avant le demi-tour en un temps qui s'y
   * fait d'évidence (418 000 poses sur 64 × 60 m, contre 1 200 avec elle).
   */
  readonly table: ExitTable;
}

export interface PathStep {
  readonly pose: Pose;
  readonly dir: Direction;
  /**
   * Le braquage du pas, en fraction du braquage maxi (la courbure de l'essieu arrière vaut `steer / Rr`) :
   * −1, 0 ou +1 sur le chemin de la recherche ; entre les deux sur un mouvement lissé (`turnaround-smooth.ts`).
   */
  readonly steer: number;
  /** Le chemin de l'essieu arrière depuis la pose précédente (≥ 0) ; 0 pour le départ. */
  readonly lengthM: number;
}

export type SearchOutcome =
  | { readonly found: true; readonly path: readonly PathStep[]; readonly temps: number; readonly expanded: number }
  | {
      readonly found: false;
      readonly why: 'budget_expansions' | 'budget_time' | 'max_temps_reached' | 'no_turn_in_space';
      readonly expanded: number;
    };

/** Les segments du chemin de sortie, dans le sens où l'on part. Vide si le chemin n'a pas de longueur. */
export function exitSegments(path: readonly Point[]): Float64Array {
  const out: number[] = [];
  for (let k = 1; k < path.length; k += 1) {
    const a = path[k - 1]!;
    const b = path[k]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(length > 1e-9)) continue;
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    out.push(a.x, a.y, ux, uy, length, Math.atan2(uy, ux));
  }
  return Float64Array.from(out);
}

/** Le segment le plus proche de (x, y) : sa distance et son cap (le premier en cas d'égalité). */
function nearestExit(segments: Float64Array, x: number, y: number): { distance: number; heading: number } {
  let distance = Infinity;
  let heading = 0;
  for (let s = 0; s < segments.length; s += 6) {
    const t = Math.max(0, Math.min(segments[s + 4]!, (x - segments[s]!) * segments[s + 2]! + (y - segments[s + 1]!) * segments[s + 3]!));
    const d = Math.hypot(segments[s]! + t * segments[s + 2]! - x, segments[s + 1]! + t * segments[s + 3]! - y);
    if (d < distance) {
      distance = d;
      heading = segments[s + 5]!;
    }
  }
  return { distance, heading };
}

function headingGapToExit(segments: Float64Array, headingRad: number): number {
  let best = Math.PI;
  for (let s = 0; s < segments.length; s += 6) best = Math.min(best, Math.abs(angleGap(segments[s + 5]!, headingRad)));
  return best;
}

/** La pose finit-elle le demi-tour ? (En avant est vérifié par l'appelant.) */
function poseLeaves(ctx: MotionCtx, goal: SearchGoal, pose: Pose): boolean {
  const near = nearestExit(goal.segments, pose.x, pose.y);
  if (near.distance > goal.lateralM) return false;
  if (Math.abs(angleGap(near.heading, pose.headingRad)) > goal.headingToleranceRad) return false;
  const away = stepPose(ctx, pose, 0, goal.driveAwayM);
  return sweepClear(ctx, pose, away, 0, goal.driveAwayM);
}

/** Le réseau des poses : une case de 0,25 m où l'essieu arrière peut être (dans l'espace, assez loin du bord). */
interface Lattice {
  readonly x0: number;
  readonly y0: number;
  readonly cols: number;
  readonly rows: number;
  readonly index: Int32Array;
  readonly count: number;
}

function lattice(ctx: MotionCtx, goal: SearchGoal): Lattice {
  const { space, truck } = ctx;
  const x0 = space.minX;
  const y0 = space.minY;
  const cols = Math.max(1, Math.ceil((space.maxX - x0) / POSITION_BIN_M));
  const rows = Math.max(1, Math.ceil((space.maxY - y0) / POSITION_BIN_M));
  const inside = insideCells(space, x0, y0, cols, rows, POSITION_BIN_M);
  // L'essieu arrière est à au moins min(½ largeur, porte-à-faux arrière) du bord ; une case peut en porter
  // un point si son centre en est à au moins ça moins sa demi-diagonale.
  const floor = Math.min(truck.widthM / 2, truck.rearOverhangM) - POSITION_BIN_M * Math.SQRT1_2;
  const index = new Int32Array(cols * rows).fill(-1);
  let count = 0;
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const k = j * cols + i;
      if (floor > 0 && inside[k] !== 1) continue;
      const cx = x0 + (i + 0.5) * POSITION_BIN_M;
      const cy = y0 + (j + 0.5) * POSITION_BIN_M;
      if (clearanceUpperBound(space, cx, cy) < floor) continue;
      if (nearestExit(goal.segments, cx, cy).distance > goal.reachM + POSITION_BIN_M) continue;
      index[k] = count;
      count += 1;
    }
  }
  return { x0, y0, cols, rows, index, count };
}

function headingBin(headingRad: number): number {
  const bin = Math.round(headingRad / HEADING_BIN_RAD) % HEADING_BINS;
  return bin < 0 ? bin + HEADING_BINS : bin;
}

/** La clé d'une pose et d'un sens ; −1 hors du réseau. */
function keyOf(net: Lattice, pose: Pose, dir: Direction): number {
  const i = Math.floor((pose.x - net.x0) / POSITION_BIN_M);
  const j = Math.floor((pose.y - net.y0) / POSITION_BIN_M);
  if (i < 0 || j < 0 || i >= net.cols || j >= net.rows) return -1;
  const cell = net.index[j * net.cols + i]!;
  if (cell < 0) return -1;
  return ((cell * HEADING_BINS + headingBin(pose.headingRad)) << 1) | (dir === 1 ? 0 : 1);
}

/** Les nœuds, en tableaux typés qui grandissent. */
class Nodes {
  size = 0;
  x = new Float64Array(4096);
  y = new Float64Array(4096);
  h = new Float64Array(4096);
  g = new Float64Array(4096);
  len = new Float64Array(4096);
  parent = new Int32Array(4096);
  dir = new Int8Array(4096);
  steer = new Int8Array(4096);
  cusps = new Uint8Array(4096);

  add(pose: Pose, g: number, lengthM: number, parent: number, dir: Direction, steer: Steer, cusps: number): number {
    if (this.size === this.x.length) this.grow();
    const n = this.size;
    this.x[n] = pose.x;
    this.y[n] = pose.y;
    this.h[n] = pose.headingRad;
    this.g[n] = g;
    this.len[n] = lengthM;
    this.parent[n] = parent;
    this.dir[n] = dir;
    this.steer[n] = steer;
    this.cusps[n] = cusps;
    this.size += 1;
    return n;
  }

  pose(n: number): Pose {
    return { x: this.x[n]!, y: this.y[n]!, headingRad: this.h[n]! };
  }

  private grow(): void {
    const next = this.x.length * 2;
    const widen = <T extends Float64Array | Int32Array | Int8Array | Uint8Array>(a: T, make: (n: number) => T): T => {
      const b = make(next);
      b.set(a);
      return b;
    };
    this.x = widen(this.x, (n) => new Float64Array(n));
    this.y = widen(this.y, (n) => new Float64Array(n));
    this.h = widen(this.h, (n) => new Float64Array(n));
    this.g = widen(this.g, (n) => new Float64Array(n));
    this.len = widen(this.len, (n) => new Float64Array(n));
    this.parent = widen(this.parent, (n) => new Int32Array(n));
    this.dir = widen(this.dir, (n) => new Int8Array(n));
    this.steer = widen(this.steer, (n) => new Int8Array(n));
    this.cusps = widen(this.cusps, (n) => new Uint8Array(n));
  }
}

/** Un tas binaire (priorité, nœud) ; à priorité égale, le nœud le plus ancien d'abord : déterministe. */
class Heap {
  private pri = new Float64Array(4096);
  private ids = new Int32Array(4096);
  size = 0;

  push(priority: number, id: number): void {
    if (this.size === this.pri.length) {
      const pri = new Float64Array(this.size * 2);
      pri.set(this.pri);
      this.pri = pri;
      const ids = new Int32Array(this.size * 2);
      ids.set(this.ids);
      this.ids = ids;
    }
    let i = this.size;
    this.size += 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.before(priority, id, this.pri[p]!, this.ids[p]!)) break;
      this.pri[i] = this.pri[p]!;
      this.ids[i] = this.ids[p]!;
      i = p;
    }
    this.pri[i] = priority;
    this.ids[i] = id;
  }

  pop(): number {
    const top = this.ids[0]!;
    this.size -= 1;
    const priority = this.pri[this.size]!;
    const id = this.ids[this.size]!;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= this.size) break;
      const r = l + 1;
      const c = r < this.size && this.before(this.pri[r]!, this.ids[r]!, this.pri[l]!, this.ids[l]!) ? r : l;
      if (!this.before(this.pri[c]!, this.ids[c]!, priority, id)) break;
      this.pri[i] = this.pri[c]!;
      this.ids[i] = this.ids[c]!;
      i = c;
    }
    this.pri[i] = priority;
    this.ids[i] = id;
    return top;
  }

  private before(pa: number, ia: number, pb: number, ib: number): boolean {
    return pa < pb || (pa === pb && ia < ib);
  }
}

/** Les caps × les sens d'une case du réseau : un bloc de la table des coûts. */
const COST_BLOCK = HEADING_BINS * 2;

/**
 * Le meilleur coût par (case, cap, sens), en simple précision — la clé de `keyOf`. Un bloc de 144 coûts
 * n'est alloué qu'à la première visite de sa case (relecture du 2026-09-25) : la table entière, allouée
 * d'avance, suivait l'aire de l'espace et pas le travail (102 Mo pour une place de 180 × 64 m où la
 * recherche ne développe que 7 400 poses ; 5,6 Mo au 19 t à la Sèvremoine).
 */
class Costs {
  private readonly slots: Int32Array;
  private pool = new Float32Array(COST_BLOCK * 1024).fill(Infinity);
  private used = 0;

  constructor(cells: number) {
    this.slots = new Int32Array(cells).fill(-1);
  }

  get(key: number): number {
    const cell = Math.floor(key / COST_BLOCK);
    const slot = this.slots[cell]!;
    return slot < 0 ? Infinity : this.pool[slot * COST_BLOCK + key - cell * COST_BLOCK]!;
  }

  set(key: number, value: number): void {
    const cell = Math.floor(key / COST_BLOCK);
    let slot = this.slots[cell]!;
    if (slot < 0) {
      slot = this.allocate();
      this.slots[cell] = slot;
    }
    this.pool[slot * COST_BLOCK + key - cell * COST_BLOCK] = value;
  }

  private allocate(): number {
    if ((this.used + 1) * COST_BLOCK > this.pool.length) {
      const grown = new Float32Array(this.pool.length * 2).fill(Infinity);
      grown.set(this.pool);
      this.pool = grown;
    }
    this.used += 1;
    return this.used - 1;
  }
}

interface Run {
  readonly input: SearchInput;
  readonly net: Lattice;
  readonly best: Costs;
  readonly nodes: Nodes;
  readonly heap: Heap;
  tempsCapped: boolean;
  /** Les nœuds développés. */
  expanded: number;
  /** Les tours de boucle (nœuds tirés du tas, périmés compris) : l'horloge se lit tous les `CLOCK_EVERY`. */
  ticks: number;
  /** Le garde-fou d'horloge, repoussé du temps rendu à la boucle (`postpone`). */
  deadline: number;
}

/** L'estimation en avant : la plus petite, sur les segments de sortie, de la table lue dans le repère de chacun. */
function forwardEstimate(segments: Float64Array, table: ExitTable, pose: Pose): number {
  let best = Infinity;
  for (let s = 0; s < segments.length; s += 6) {
    const d = segments[s + 2]! * (pose.y - segments[s + 1]!) - segments[s + 3]! * (pose.x - segments[s]!);
    best = Math.min(best, table.lookup(d, angleGap(segments[s + 5]!, pose.headingRad)));
  }
  return best;
}

/**
 * La priorité au-delà du coût : un camion qui recule a encore au moins un
 * temps à faire (on ne finit qu'en avant) ; puis les mètres estimés — en avant,
 * la table de la sortie ; en arrière, Rr × l'écart de cap. Le compte des temps
 * est exact et prime par défaut (`DEFAULT_TEMPS_COST_M` > tout chemin et toute estimation) : les
 * mètres ne départagent que des poses d'un même nombre de temps.
 */
function heuristic(run: Run, pose: Pose, dir: Direction): number {
  const { goal, ctx, table } = run.input;
  const turn = ctx.rr * Math.max(0, headingGapToExit(goal.segments, pose.headingRad) - goal.headingToleranceRad);
  const metres = dir === 1 ? Math.max(turn, forwardEstimate(goal.segments, table, pose)) : turn;
  return (dir === -1 ? run.input.tempsCostM : 0) + Math.min(MAX_ESTIMATE_M, metres);
}

/** Le pas arrêté au contact : le plus long, à 1/8 de pas près (6 cm), dont le balayage tient ; null sous 5 cm. */
function contactStep(ctx: MotionCtx, from: Pose, steer: Steer, dir: Direction): { pose: Pose; lengthM: number } | null {
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < CONTACT_BISECTIONS; k += 1) {
    const mid = (lo + hi) / 2;
    const lengthM = TURNAROUND_STEP_M * mid;
    if (sweepClear(ctx, from, stepPose(ctx, from, steer, dir * lengthM), steer, lengthM)) lo = mid;
    else hi = mid;
  }
  const lengthM = TURNAROUND_STEP_M * lo;
  if (lengthM < MIN_CONTACT_STEP_M) return null;
  return { pose: stepPose(ctx, from, steer, dir * lengthM), lengthM };
}

interface Move {
  readonly n: number;
  readonly dir: Direction;
  readonly steer: Steer;
  readonly cusps: number;
  /** Les mètres jusqu'au nœud, plus le coût d'un changement de braquage en roulant. */
  readonly g0: number;
}

/** La clé d'un enfant à ce coût, ou −1 quand il est hors du réseau ou qu'un meilleur a déjà la case. */
function openKey(run: Run, pose: Pose, move: Move, lengthM: number): number {
  const key = keyOf(run.net, pose, move.dir);
  if (key < 0) return -1;
  const cost = move.cusps * run.input.tempsCostM + move.g0 + lengthM;
  if (cost >= run.best.get(key)) return -1;
  // Même pose, l'autre sens : y changer de sens coûte un temps et zéro mètre.
  if (run.best.get(key ^ 1) + run.input.tempsCostM <= cost) return -1;
  return key;
}

function accept(run: Run, move: Move, key: number, pose: Pose, lengthM: number): void {
  const g = move.g0 + lengthM;
  if (g > MAX_LENGTH_M) return;
  const cost = move.cusps * run.input.tempsCostM + g;
  run.best.set(key, cost);
  const child = run.nodes.add(pose, g, lengthM, move.n, move.dir, move.steer, move.cusps);
  run.heap.push(cost + heuristic(run, pose, move.dir), child);
}

/**
 * Un enfant : le pas entier s'il tient (sans test quand la caisse est loin de
 * tout bord, `roomy`), sinon le pas arrêté au contact. Un pas entier dont la
 * case a déjà mieux n'est pas testé, et ne donne pas de contact.
 */
function tryChild(run: Run, n: number, dir: Direction, steer: Steer, roomy: boolean): void {
  const { nodes } = run;
  const ctx = run.input.ctx;
  const turned = dir !== nodes.dir[n];
  const cusps = nodes.cusps[n]! + (turned ? 1 : 0);
  if (cusps + 1 > run.input.maxTemps) {
    run.tempsCapped = true;
    return;
  }
  const rolling = !turned && n !== 0 && steer !== nodes.steer[n];
  const move: Move = { n, dir, steer, cusps, g0: nodes.g[n]! + (rolling ? STEER_CHANGE_COST_M : 0) };
  const from = nodes.pose(n);
  const full = stepPose(ctx, from, steer, dir * TURNAROUND_STEP_M);
  const fullKey = keyOf(run.net, full, dir);
  if (fullKey >= 0) {
    const key = openKey(run, full, move, TURNAROUND_STEP_M);
    if (key < 0) return;
    if (roomy || sweepClear(ctx, from, full, steer, TURNAROUND_STEP_M)) {
      accept(run, move, key, full, TURNAROUND_STEP_M);
      return;
    }
  }
  const contact = contactStep(ctx, from, steer, dir);
  if (contact === null) return;
  const key = openKey(run, contact.pose, move, contact.lengthM);
  if (key >= 0) accept(run, move, key, contact.pose, contact.lengthM);
}

function pathTo(nodes: Nodes, n: number): PathStep[] {
  const path: PathStep[] = [];
  for (let k = n; k >= 0; k = nodes.parent[k]!) {
    path.push({ pose: nodes.pose(k), dir: nodes.dir[k] as Direction, steer: nodes.steer[k] as Steer, lengthM: nodes.len[k]! });
  }
  return path.reverse();
}

/**
 * Un nœud qu'un meilleur a remplacé dans sa case. `best` est en simple précision (la mémoire du réseau) :
 * le coût se compare ARRONDI comme il a été rangé. Aujourd'hui les longueurs sont des multiples de 1/16 m
 * (pas de 0,5 m, contact au 1/8 de pas, 0,25 m par changement de braquage) et tombent juste ; une tolérance
 * fixe jetterait un nœud sur quatre au-delà de 40 000 (cinq temps) le jour où un pas ne le serait plus.
 */
function stale(run: Run, n: number): boolean {
  const { nodes } = run;
  const key = keyOf(run.net, nodes.pose(n), nodes.dir[n] as Direction);
  const cost = nodes.cusps[n]! * run.input.tempsCostM + nodes.g[n]!;
  return key >= 0 && Math.fround(cost) > run.best.get(key);
}

/** Développe un nœud : les six pas (trois en marche avant seule), testés d'un coup quand la caisse est loin de tout bord. */
function expand(run: Run, n: number, dirs: readonly Direction[]): void {
  const { ctx } = run.input;
  const roomy = bodyFar(ctx, run.nodes.pose(n), ctx.eps + stepReachM(ctx, 1, TURNAROUND_STEP_M));
  for (const dir of dirs) for (const steer of STEERS) tryChild(run, n, dir, steer, roomy);
}

function budgetSpent(run: Run): 'budget_expansions' | 'budget_time' | null {
  if (run.expanded >= run.input.maxExpansions) return 'budget_expansions';
  if (run.expanded % CLOCK_EVERY === 0 && performance.now() > run.deadline) return 'budget_time';
  return null;
}

/**
 * Une recherche qu'on peut interrompre ENTRE deux nœuds et reprendre là où elle en était : la même, pas une
 * copie (relecture du 2026-09-25 : synchrone, elle tenait la boucle d'événements de l'API jusqu'à `budgetMs`
 * par camion, et les délais des autres lectures expiraient pendant ce temps). Interrompre ne change ni
 * l'ordre des nœuds ni le résultat.
 */
export interface ResumableSearch {
  /** Développe jusqu'au bout, ou jusqu'à l'heure `untilMs` (`performance.now()`) : null quand ce n'est pas fini. */
  advance(untilMs: number): SearchOutcome | null;
  /** Repousse le garde-fou d'horloge du temps passé hors de la recherche : il compte le calcul, pas l'attente. */
  postpone(ms: number): void;
}

/** Ouvre la recherche : le réseau, la table des coûts, le départ dans le tas. */
export function startSearch(input: SearchInput): ResumableSearch {
  const net = lattice(input.ctx, input.goal);
  const run: Run = {
    input,
    net,
    best: new Costs(net.count),
    nodes: new Nodes(),
    heap: new Heap(),
    tempsCapped: false,
    expanded: 0,
    ticks: 0,
    deadline: input.deadline,
  };
  // Le départ : le camion est arrivé en avant (le temps 1 est l'arrivée, prolongée ou non).
  run.nodes.add(input.start, 0, 0, -1, 1, 0, 0);
  const rootKey = keyOf(net, input.start, 1);
  if (rootKey >= 0) run.best.set(rootKey, 0);
  run.heap.push(heuristic(run, input.start, 1), 0);
  const dirs: readonly Direction[] = input.reversing ? [1, -1] : [1];
  return {
    advance: (untilMs) => advance(run, dirs, untilMs),
    postpone: (ms) => {
      run.deadline += ms;
    },
  };
}

/** L'A* : le premier nœud en avant qui finit le demi-tour, au moins de temps puis de mètres ; null à l'heure dite. */
function advance(run: Run, dirs: readonly Direction[], untilMs: number): SearchOutcome | null {
  const { input } = run;
  while (run.heap.size > 0) {
    run.ticks += 1;
    if (run.ticks % CLOCK_EVERY === 0 && performance.now() > untilMs) return null;
    const n = run.heap.pop();
    if (stale(run, n)) continue;
    if (run.nodes.dir[n] === 1 && poseLeaves(input.ctx, input.goal, run.nodes.pose(n))) {
      return { found: true, path: pathTo(run.nodes, n), temps: run.nodes.cusps[n]! + 1, expanded: run.expanded };
    }
    const spent = budgetSpent(run);
    if (spent !== null) return { found: false, why: spent, expanded: run.expanded };
    run.expanded += 1;
    expand(run, n, dirs);
  }
  return { found: false, why: run.tempsCapped ? 'max_temps_reached' : 'no_turn_in_space', expanded: run.expanded };
}

/** La recherche d'une traite. */
export function searchTurnaround(input: SearchInput): SearchOutcome {
  return startSearch(input).advance(Infinity)!;
}
