/**
 * CE QU'IL RESTE À ROULER EN AVANT, sans obstacle, pour repartir :
 * l'estimation qui guide la recherche (`turnaround-search.ts`) dans le temps
 * où elle trouve la sortie.
 *
 * Un camion qui roule en avant, braquage maxi ou droit, doit finir dans le sens
 * du chemin de sortie (± la tolérance) et à au plus `lateralM` de lui. Dans le
 * repère d'un segment de sortie, seuls comptent l'écart latéral d à sa droite
 * porteuse (à gauche > 0) et l'écart de cap φ : dd/ds = sin φ, dφ/ds = braquage
 * / Rr. La table donne, pour chaque (d, φ), la plus courte distance en avant
 * jusqu'au but, calculée une fois par camion (Dijkstra à rebours sur une
 * grille de `D_BIN_M` × `PHI_BIN_DEG`). C'est la « demi-lune » : faire
 * demi-tour en avant ET revenir sur l'axe coûte ~2 π Rr, pas π Rr — sans elle,
 * la recherche développait toute une place ouverte avant de trouver le
 * demi-tour en un temps qui s'y fait les yeux fermés.
 *
 * LES PAS DE LA TABLE sont taillés sur la grille, pour qu'aucun arrondi ne
 * mange le mouvement : un pas en virage tourne d'EXACTEMENT une case de cap
 * (Rr × 2,5°, soit 0,40 m pour le 19 t, 0,56 m pour le semi) ; un pas droit
 * déplace d'EXACTEMENT une case d'écart latéral (0,1 m / |sin φ|). Seul l'écart
 * latéral d'un virage s'arrondit, à 5 cm près. (Le 2026-09-25, une table à pas
 * fixe de 0,5 m sur des cases de 5° tournait d'une case par pas pour TOUT
 * camion de Rr 3,8 à 11,5 m — le 19 t y virait comme un camion de 5,7 m — et
 * jamais pour le semi, Rr 12,9 m : sa table était nulle.)
 *
 * Une ESTIMATION, pas une borne : l'arrondi latéral peut la faire mentir d'un
 * mètre ou deux sur un demi-tour. Elle ne départage que des poses d'un même
 * nombre de temps (le compte des temps prime dans la priorité, et il est
 * exact) : elle peut coûter quelques mètres de chemin, jamais un temps.
 */
const D_BIN_M = 0.1;
const D_MAX_M = 48;
const PHI_BIN_DEG = 2.5;
const PHI_BINS = 360 / PHI_BIN_DEG;
const PHI_BIN_RAD = (PHI_BIN_DEG * Math.PI) / 180;
const D_BINS = Math.round((2 * D_MAX_M) / D_BIN_M) + 1;
/** Un pas droit plus long que ça ne se prend pas (cap presque parallèle : il ne rapproche de rien). */
const MAX_STRAIGHT_STEP_M = D_MAX_M;

export interface ExitTable {
  /** La distance estimée à rouler en avant depuis (d, φ) ; au-delà de la table, le bord plus l'écart. */
  lookup(dM: number, phiRad: number): number;
}

function wrapBin(bin: number): number {
  const b = bin % PHI_BINS;
  return b < 0 ? b + PHI_BINS : b;
}

const dOf = (i: number): number => -D_MAX_M + i * D_BIN_M;
const phiOf = (j: number): number => (j <= PHI_BINS / 2 ? j : j - PHI_BINS) * PHI_BIN_RAD;
const dBin = (d: number): number => Math.round((d + D_MAX_M) / D_BIN_M);

/** Un tas minimal de (valeur, cellule), sans dépendance. */
function heapPush(heap: number[], value: number, cell: number): void {
  heap.push(value, cell);
  let i = heap.length / 2 - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p * 2]! <= heap[i * 2]!) break;
    [heap[p * 2], heap[i * 2]] = [heap[i * 2]!, heap[p * 2]!];
    [heap[p * 2 + 1], heap[i * 2 + 1]] = [heap[i * 2 + 1]!, heap[p * 2 + 1]!];
    i = p;
  }
}

function heapPop(heap: number[]): [number, number] {
  const top: [number, number] = [heap[0]!, heap[1]!];
  const lastCell = heap.pop()!;
  const lastValue = heap.pop()!;
  const n = heap.length / 2;
  if (n > 0) {
    heap[0] = lastValue;
    heap[1] = lastCell;
    for (let i = 0; ; ) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const c = l + 1 < n && heap[(l + 1) * 2]! < heap[l * 2]! ? l + 1 : l;
      if (heap[c * 2]! >= heap[i * 2]!) break;
      [heap[c * 2], heap[i * 2]] = [heap[i * 2]!, heap[c * 2]!];
      [heap[c * 2 + 1], heap[i * 2 + 1]] = [heap[i * 2 + 1]!, heap[c * 2 + 1]!];
      i = c;
    }
  }
  return top;
}

/** Les cellules du but : |d| ≤ lateralM, |φ| ≤ la tolérance. */
function goalCells(values: Float64Array, heap: number[], lateralM: number, toleranceRad: number): void {
  for (let i = 0; i < D_BINS; i += 1) {
    if (Math.abs(dOf(i)) > lateralM + 1e-9) continue;
    for (let j = 0; j < PHI_BINS; j += 1) {
      if (Math.abs(phiOf(j)) > toleranceRad + 1e-9) continue;
      values[i * PHI_BINS + j] = 0;
      heapPush(heap, 0, i * PHI_BINS + j);
    }
  }
}

/**
 * Les prédécesseurs de (d, φ) : d'où vient-on en roulant en avant pour y
 * arriver, et en combien de mètres ? Un virage d'une case de cap exactement,
 * dans chaque sens ; un pas droit d'une case d'écart latéral exactement.
 */
function forEachPredecessor(i: number, j: number, rr: number, visit: (cell: number, stepM: number) => void): void {
  const d = dOf(i);
  const phi = phiOf(j);
  const turnStepM = rr * PHI_BIN_RAD;
  for (const steer of [-1, 1] as const) {
    // dφ/ds = steer / Rr : on vient de φ − steer·Δφ ; d − dPrev = steer·Rr·(cos φPrev − cos φ).
    const phiPrev = phi - steer * PHI_BIN_RAD;
    const iPrev = dBin(d - steer * rr * (Math.cos(phiPrev) - Math.cos(phi)));
    if (iPrev >= 0 && iPrev < D_BINS) visit(iPrev * PHI_BINS + wrapBin(j - steer), turnStepM);
  }
  const sin = Math.sin(phi);
  const straightM = D_BIN_M / Math.abs(sin);
  if (!(straightM <= MAX_STRAIGHT_STEP_M)) return;
  const iPrev = i - Math.sign(sin);
  if (iPrev >= 0 && iPrev < D_BINS) visit(iPrev * PHI_BINS + j, straightM);
}

/** La table d'un camion : Rr, la tolérance latérale et de cap du but. */
export function exitTable(rr: number, lateralM: number, toleranceRad: number): ExitTable {
  // En double précision : les pas (Rr × 2,5°, 0,1 m / |sin φ|) ne tombent pas juste en simple, et un
  // coût rangé arrondi vers le bas faisait sauter sa case au dépilage — la table restait vide.
  const values = new Float64Array(D_BINS * PHI_BINS).fill(Infinity);
  const heap: number[] = [];
  goalCells(values, heap, lateralM, toleranceRad);
  while (heap.length > 0) {
    const [value, cell] = heapPop(heap);
    if (value > values[cell]!) continue;
    forEachPredecessor(Math.floor(cell / PHI_BINS), cell % PHI_BINS, rr, (prev, stepM) => {
      const next = value + stepM;
      if (next < values[prev]!) {
        values[prev] = next;
        heapPush(heap, next, prev);
      }
    });
  }
  return {
    lookup(dM: number, phiRad: number): number {
      const clamped = Math.max(-D_MAX_M, Math.min(D_MAX_M, dM));
      const value = values[dBin(clamped) * PHI_BINS + wrapBin(Math.round(phiRad / PHI_BIN_RAD))]!;
      return (Number.isFinite(value) ? value : 0) + Math.abs(dM - clamped);
    },
  };
}
