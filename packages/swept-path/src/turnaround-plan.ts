/**
 * LE DEMI-TOUR DANS L'ESPACE RÉEL : un camion, un espace de forme
 * quelconque (les anneaux de `turnaroundMap.openSpace`, en mètres locaux), la
 * pose où il s'arrête, le chemin par lequel il doit repartir ; la manœuvre la
 * plus courte en TEMPS, puis en mètres, qui le fait repartir en avant, caisse
 * entière dans l'espace. Modèle dessiné, jamais une mesure ni un verdict
 * (principes 17, 39 et 42; la note de conception interne bis).
 *
 * Ce que le simulateur du trois temps (`three-point.ts`) ne savait pas faire,
 * et que ce planificateur fait parce qu'il cherche au lieu de dérouler un plan :
 *  - L'ESPACE EST QUELCONQUE : une placette sur le côté, une voie qui s'élargit,
 *    un passage — pas une bande de rue et une branche à angles francs. La
 *    Sèvremoine (2026-09-25) : le 19 t y fait demi-tour en trois temps dans une
 *    placette de ~12,5 × 14,9 m que le modèle « rue + branche » ne voyait pas.
 *  - LE PREMIER MOUVEMENT EST LIBRE : avancer au-delà de la placette pour y
 *    reculer, ou reculer d'abord ; chaque mouvement s'arrête où il veut, au
 *    contact s'il le faut.
 *  - LA SORTIE SE REDRESSE : le dernier mouvement en avant peut braquer pour
 *    revenir dans l'axe ; le demi-tour est fini quand le camion roule en avant,
 *    près du chemin de sortie (`exitLateralM`), dans son sens (π ± 5°, la
 *    fermeture du simulateur, `CLOSURE_TOLERANCE_RAD`), et qu'une longueur de
 *    camion tout droit devant lui tient encore dans l'espace.
 *
 * LE MODÈLE, en entier :
 *  1. Bicyclette exacte à l'essieu arrière (`advanceRearAxle`) ; Rr = √(R² − L²),
 *     R lu au centre de l'essieu avant (`rearAxleMinTurnRadiusM`,
 *     `radius_front_axle_reading`, dossier §9 toujours ouvert). Braquage maxi ou
 *     droit, changé entre deux pas de 0,5 m — plus vif qu'un chauffeur, qui
 *     tourne le volant en roulant sur 2 à 3 m : `steering_instant` le dit.
 *  2. La caisse entière (porte-à-faux compris) dans l'espace, sans trou entre
 *     deux poses (`turnaround-motion.ts`), à 2 cm près (`CLEARANCE_EPS_M`, une
 *     tolérance numérique, pas une marge : principe 31) ; puis le chemin trouvé
 *     est revérifié sur les côtés des anneaux (`turnaround-verify.ts`).
 *  3. Le moins de temps d'abord (A*, `turnaround-search.ts`), puis le moins de
 *     mètres (un temps vaut `tempsCostM` mètres, par défaut plus que tout
 *     chemin), guidé par ce qu'il reste à rouler en avant jusqu'à la sortie
 *     (`turnaround-heuristic.ts`, à 5 % du plus court chemin de Dubins). Le
 *     temps 1 est l'arrivée : un premier mouvement en arrière est le temps 2,
 *     et le compte est toujours impair (on repart en avant).
 * 4. Un semi ne recule pas (`semi_cannot_reverse`) : `reversingAllowed:
 *     false` ne cherche qu'un demi-tour en un temps, en avant.
 * 5. Le chemin SERVI est lissé (`turnaround-smooth.ts`) : la recherche
 *     ne braque que tout ou rien, et zigzague pour suivre une voie qui tourne
 *     doucement (la Sèvremoine : 3,4 m à gauche, 2,5 à droite… dans l'approche).
 *     Chaque mouvement est adouci là où ses changements de braquage le permettent,
 *     avec le même début, la même fin et le même sens, et le lissé passe les deux
 *     contrôles du point 2 ; sinon c'est le chemin de la recherche, tel quel
 *     (`path_smoothed` dit qu'au moins un mouvement l'est). L'enveloppe, son aire
 *     et la place au plus près sont celles du chemin servi.
 *
 * Ce que le modèle ne sait pas : l'espace n'est pas « roulable » (le cadastre
 * dit ce qui n'est à personne — trottoirs, espaces verts, un chemin piéton —,
 * décalé d'un mètre ou deux sur la photo) ; les voitures garées et les murs
 * bas n'y sont pas. Le réseau des poses (0,25 m × 5°) peut manquer une
 * manœuvre qui demande plus de finesse : « pas trouvé » est une limite du
 * modèle (principe 5), jamais un refus. Une entrée illisible est dite par son
 * nom, jamais levée.
 */
import { truckFootprint } from './geometry.js';
import { rasterFootprintUnion, type RasterUnion } from './footprint-raster.js';
import { rearAxleMinTurnRadiusM } from './kinematics.js';
import { DEFAULT_MAX_TEMPS, truckReadable } from './three-point.js';
import { CLOSURE_TOLERANCE_RAD } from './three-point-search.js';
import { motionCtx, type MotionCtx } from './turnaround-motion.js';
import {
  DEFAULT_TEMPS_COST_M,
  exitSegments,
  HEADING_BIN_DEG,
  POSITION_BIN_M,
  searchTurnaround,
  startSearch,
  TURNAROUND_STEP_M,
  type PathStep,
  type SearchGoal,
  type SearchInput,
  type SearchOutcome,
} from './turnaround-search.js';
import { exitTable } from './turnaround-heuristic.js';
import { prepareSpace } from './turnaround-space.js';
import { smoothPath, SMOOTHING_SIGMAS_M, type SmoothedPath } from './turnaround-smooth.js';
import { startPose, type StartPlacement } from './turnaround-start.js';
import { verifyPath, type Verification } from './turnaround-verify.js';
import type { Point, Pose, TruckSpec } from './types.js';

export interface TurnaroundPlanOptions {
  /** Faux pour un semi : un demi-tour en un temps seulement. Vrai par défaut. */
  readonly reversingAllowed?: boolean;
  /** Au plus tant de temps (par défaut celui du simulateur du trois temps, `DEFAULT_MAX_TEMPS`, 9). */
  readonly maxTemps?: number;
  /** Le budget déterministe : au plus tant de poses développées (300 000 par défaut). */
  readonly maxExpansions?: number;
  /** Le garde-fou d'horloge, en millisecondes (2 000 par défaut). */
  readonly budgetMs?: number;
  /** Jusqu'où la pose de départ peut glisser de côté pour tenir dans l'espace (0 par défaut). */
  readonly startShiftMaxM?: number;
  /**
   * Jusqu'où la pose de départ peut reculer le long du chemin d'arrivée (`arrival`), vers la bouche, quand
   * elle ne tient pas (0 par défaut) : au bout d'une impasse, l'essieu arrière sur l'arrêt met la caisse
   * au-delà du bout.
   */
  readonly startBackMaxM?: number;
  /** À quelle distance du chemin de sortie l'essieu arrière doit finir (2 m par défaut). */
  readonly exitLateralM?: number;
  /** L'essieu arrière reste à au plus tant du chemin de sortie (sans borne par défaut). */
  readonly reachM?: number;
  /** Calculer l'enveloppe balayée (`envelopeRaster`, l'union raster à 10 cm, et son aire) ; faux par défaut. */
  readonly withEnvelope?: boolean;
  /**
   * Ce que coûte un temps de plus, en mètres roulés. Par défaut, plus que tout chemin : le moins de
   * temps d'abord, puis le moins de mètres. Bas (quelques mètres), la recherche échange des temps
   * contre des mètres : c'est ainsi que se cherche la variante compacte.
   */
  readonly tempsCostM?: number;
  /**
   * Lisser chaque mouvement trouvé (`turnaround-smooth.ts`) : vrai par défaut. Faux sert le chemin
   * de la recherche tel quel — la comparaison des tests, jamais un réglage de l'écran.
   */
  readonly smoothing?: boolean;
}

export interface TurnaroundPlanInput {
  readonly truck: TruckSpec;
  /**
   * L'espace, en mètres locaux (un repère orthonormé quelconque), anneaux en règle pair-impair ; et les
   * aires interdites (`forbidden` : place piétonne, parc…), chacune à part — un point est dans l'espace
   * quand il est dans ses anneaux ET hors de chaque aire ; leurs côtés sont des bords. Coupées à la boîte
   * de l'espace par l'appelant : leur étendue élargit la grille.
   */
  readonly space: { readonly rings: readonly (readonly Point[])[]; readonly forbidden?: readonly (readonly Point[])[] };
  /** Là où le camion est arrêté : l'essieu arrière et le cap d'arrivée. */
  readonly start: Pose;
  /** Le chemin de sortie, dans le sens où l'on repart (du bout vers la bouche). */
  readonly exit: { readonly path: readonly Point[] };
  /**
   * Le chemin par lequel le camion est arrivé, DE L'ARRÊT vers la bouche : la pose de départ recule le long
   * de lui (`startBackMaxM`) quand elle ne tient pas. Absent : pas de recul.
   */
  readonly arrival?: { readonly path: readonly Point[] };
  readonly options?: TurnaroundPlanOptions;
}

export interface TurnaroundMove {
  /** 1 en avant, −1 en arrière. */
  readonly dir: 1 | -1;
  /** Le chemin de l'essieu arrière. */
  readonly lengthM: number;
  /** Les poses de l'essieu arrière : le début du mouvement, puis la fin de chaque pas (au plus 0,5 m). */
  readonly poses: readonly Pose[];
  /**
   * Le braquage, par tronçons, en fraction du braquage maxi (la courbure de l'essieu arrière vaut
   * `steer / minRearAxleRadiusM`) : 0 droit, ±1 braquage maxi — +1 fait croître le cap en marche avant
   * (la droite du conducteur dans le repère y vers le bas du paquet, sa gauche dans un repère y vers le
   * haut) ; entre les deux sur un mouvement lissé.
   */
  readonly arcs: readonly { readonly steer: number; readonly lengthM: number }[];
  /**
   * le mouvement est lissé (`turnaround-smooth.ts`) : même début, même fin, même sens que celui
   * de la recherche, sans ses changements de braquage instantanés. Faux : le mouvement de la recherche.
   */
  readonly smoothed: boolean;
}

export interface TurnaroundPlanResult {
  /** `not_found` est une limite du MODÈLE, jamais un refus (principe 5). */
  readonly status: 'found' | 'not_found';
  /**
   * Null quand trouvé ; sinon la raison qui décide : `max_temps_reached`, `no_turn_in_space` (tout le
   * réseau atteignable parcouru), `budget_exhausted` (le détail, `budget_expansions` ou `budget_time`,
   * dans `reasonCodes`), `start_outside_space`, `exact_check_failed`, ou une entrée illisible.
   */
  readonly why: string | null;
  /** L'arrivée compte : 1 = en un temps, 3 = trois temps. */
  readonly temps: number | null;
  readonly moves: readonly TurnaroundMove[];
  /** La pose à la fin de chaque temps (le temps 1 est la pose de départ quand le premier mouvement recule). */
  readonly ghostPoses: readonly Pose[];
  readonly ghostFootprints: readonly (readonly Point[])[];
  /** La caisse à chaque pas (au plus tous les 0,5 m de l'essieu arrière), départ compris. */
  readonly bodyFootprints: readonly (readonly Point[])[];
  /**
   * L'enveloppe balayée : l'union raster des caisses à 10 cm (les cases pleines), à tracer en anneaux —
   * l'extérieur ET les trous (un îlot autour duquel le camion tourne) ; le fil la trace avec le contour de
   * l'espace public (`traceRings` de `@teneolog/topology`). Null sans `withEnvelope` ou sans chemin.
   */
  readonly envelopeRaster: RasterUnion | null;
  /** L'aire de l'enveloppe balayée, en m² : les cases pleines de `envelopeRaster`. Null avec elle. */
  readonly envelopeAreaM2: number | null;
  /** La pose de départ retenue (glissée de `startShiftM` sur le côté, reculée de `startBackM`, quand il l'a fallu). */
  readonly start: Pose | null;
  readonly startShiftM: number;
  /** De combien la pose de départ a reculé le long du chemin d'arrivée, vers la bouche (`start_moved_back`). */
  readonly startBackM: number;
  /** La plus petite distance caisse–bord mesurée sur le chemin (plafonnée à 1 m) ; null sans chemin. */
  readonly minClearanceM: number | null;
  readonly minRearAxleRadiusM: number;
  readonly reasonCodes: readonly string[];
  /** Poses développées par la recherche. */
  readonly expanded: number;
  readonly elapsedMs: number;
}

const DEFAULTS = {
  maxTemps: DEFAULT_MAX_TEMPS,
  maxExpansions: 300_000,
  budgetMs: 2_000,
  startShiftMaxM: 0,
  startBackMaxM: 0,
  exitLateralM: 2,
} as const;
/** La tolérance numérique de la recherche : la caisse garde au moins 2 cm (pas une marge, principe 31). */
const CLEARANCE_EPS_M = 0.02;

/**
 * Ce que dit `method` sur le fil : la recherche, le modèle, le réseau, le pas, la tolérance, ce qui la guide,
 * et le lissage du chemin servi (les écarts types du noyau essayés, en mètres).
 */
export const TURNAROUND_PLAN_METHOD =
  `lattice-astar/bicycle-rear-axle/pos-${POSITION_BIN_M}m-heading-${HEADING_BIN_DEG}deg-step-${TURNAROUND_STEP_M}m/clearance-${CLEARANCE_EPS_M}m/guide-exit-table` +
  `/smoothed-gauss-${SMOOTHING_SIGMAS_M.join('-')}m`;

interface Settings {
  readonly reversing: boolean;
  readonly maxTemps: number;
  readonly maxExpansions: number;
  readonly budgetMs: number;
  readonly startShiftMaxM: number;
  readonly startBackMaxM: number;
  readonly exitLateralM: number;
  readonly reachM: number;
  readonly withEnvelope: boolean;
  readonly tempsCostM: number;
  readonly smoothing: boolean;
}

function settingsOf(options: TurnaroundPlanOptions | undefined): Settings {
  const positive = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    reversing: options?.reversingAllowed !== false,
    maxTemps: Math.max(1, Math.floor(positive(options?.maxTemps, DEFAULTS.maxTemps))),
    maxExpansions: Math.floor(positive(options?.maxExpansions, DEFAULTS.maxExpansions)),
    budgetMs: positive(options?.budgetMs, DEFAULTS.budgetMs),
    startShiftMaxM: positive(options?.startShiftMaxM, DEFAULTS.startShiftMaxM),
    startBackMaxM: positive(options?.startBackMaxM, DEFAULTS.startBackMaxM),
    exitLateralM: positive(options?.exitLateralM, DEFAULTS.exitLateralM),
    reachM: positive(options?.reachM, Infinity),
    withEnvelope: options?.withEnvelope === true,
    tempsCostM: positive(options?.tempsCostM, DEFAULT_TEMPS_COST_M),
    smoothing: options?.smoothing !== false,
  };
}

function baseReasons(settings: Settings): string[] {
  const reasons = ['radius_front_axle_reading', 'steering_instant'];
  if (!settings.reversing) reasons.push('forward_only');
  return reasons;
}

function inputProblem(input: TurnaroundPlanInput, rr: number): string | null {
  if (!truckReadable(input.truck)) return 'truck_dimensions_invalid';
  if (rr <= 0) return 'turn_radius_not_above_wheelbase';
  const { x, y, headingRad } = input.start;
  if (![x, y, headingRad].every(Number.isFinite)) return 'start_invalid';
  const path = input.exit.path;
  if (!path.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) || exitSegments(path).length === 0) {
    return 'exit_path_invalid';
  }
  return null;
}

type Outcome = Omit<TurnaroundPlanResult, 'elapsedMs'>;

function notFound(rr: number, reasonCodes: readonly string[], why: string, extra: Partial<Outcome> = {}): Outcome {
  return {
    status: 'not_found',
    why,
    temps: null,
    moves: [],
    ghostPoses: [],
    ghostFootprints: [],
    bodyFootprints: [],
    envelopeRaster: null,
    envelopeAreaM2: null,
    start: null,
    startShiftM: 0,
    startBackM: 0,
    minClearanceM: null,
    minRearAxleRadiusM: rr,
    reasonCodes,
    expanded: 0,
    ...extra,
  };
}

/** Les mouvements : les pas regroupés par sens, leurs braquages par tronçons ; `smoothed[i]` dit si le i-ième est lissé. */
function movesOf(path: readonly PathStep[], smoothed: readonly boolean[]): TurnaroundMove[] {
  const moves: { dir: 1 | -1; lengthM: number; poses: Pose[]; arcs: { steer: number; lengthM: number }[]; smoothed: boolean }[] = [];
  for (let k = 1; k < path.length; k += 1) {
    const step = path[k]!;
    let move = moves[moves.length - 1];
    if (move === undefined || move.dir !== step.dir) {
      move = { dir: step.dir, lengthM: 0, poses: [path[k - 1]!.pose], arcs: [], smoothed: smoothed[moves.length] === true };
      moves.push(move);
    }
    move.lengthM += step.lengthM;
    move.poses.push(step.pose);
    const arc = move.arcs[move.arcs.length - 1];
    if (arc !== undefined && arc.steer === step.steer) arc.lengthM += step.lengthM;
    else move.arcs.push({ steer: step.steer, lengthM: step.lengthM });
  }
  return moves;
}

interface Found {
  readonly start: Pose;
  readonly startShiftM: number;
  readonly startBackM: number;
  readonly expanded: number;
  readonly reasonCodes: readonly string[];
  readonly minClearanceM: number;
}

function foundOutcome(ctx: MotionCtx, served: SmoothedPath, settings: Settings, found: Found): Outcome {
  const { path } = served;
  const moves = movesOf(path, served.smoothed);
  const reversesFirst = moves[0]?.dir === -1;
  const ends = moves.map((move) => move.poses[move.poses.length - 1]!);
  // Le temps 1 est l'arrivée : quand on recule d'abord, sa fin est la pose de départ.
  const ghostPoses = reversesFirst || moves.length === 0 ? [found.start, ...ends] : ends;
  const bodyFootprints = path.map((step) => truckFootprint(step.pose, ctx.truck));
  const envelope = settings.withEnvelope ? rasterFootprintUnion(bodyFootprints) : null;
  return {
    status: 'found',
    why: null,
    temps: ghostPoses.length,
    moves,
    ghostPoses,
    ghostFootprints: ghostPoses.map((pose) => truckFootprint(pose, ctx.truck)),
    bodyFootprints,
    envelopeRaster: envelope,
    envelopeAreaM2: envelope === null ? null : envelope.areaM2,
    minRearAxleRadiusM: ctx.rr,
    ...found,
  };
}

function goalOf(input: TurnaroundPlanInput, settings: Settings): SearchGoal {
  return {
    segments: exitSegments(input.exit.path),
    headingToleranceRad: CLOSURE_TOLERANCE_RAD,
    lateralM: settings.exitLateralM,
    driveAwayM: input.truck.lengthM,
    reachM: settings.reachM,
  };
}

/** Ce qu'il faut pour chercher : tout est prêt, ou c'est déjà fini (une entrée illisible, un départ hors de l'espace). */
type Prepared =
  | { readonly done: Outcome }
  | {
      readonly done: null;
      readonly ctx: MotionCtx;
      readonly rr: number;
      readonly reasons: readonly string[];
      readonly start: StartPlacement;
      readonly search: SearchInput;
    };

function prepare(input: TurnaroundPlanInput, settings: Settings, t0: number): Prepared {
  const rr = rearAxleMinTurnRadiusM(input.truck.turnRadiusM, input.truck.wheelbaseM);
  const reasons = baseReasons(settings);
  const problem = inputProblem(input, rr);
  if (problem !== null) return { done: notFound(rr, [...reasons, problem], problem) };
  const prepared = prepareSpace(input.space.rings, input.space.forbidden ?? []);
  if (!prepared.ok) return { done: notFound(rr, [...reasons, prepared.why], prepared.why) };
  const ctx = motionCtx(prepared.space, input.truck, rr, CLEARANCE_EPS_M);
  const goal = goalOf(input, settings);
  const arrival = exitSegments(input.arrival?.path ?? []);
  const room = { shiftMaxM: settings.startShiftMaxM, backMaxM: settings.startBackMaxM, arrival };
  const start = startPose(ctx, input.start, room);
  if (start === null) return { done: notFound(rr, [...reasons, 'start_outside_space'], 'start_outside_space') };
  if (start.shiftM !== 0) reasons.push('start_shifted');
  if (start.backM !== 0) reasons.push('start_moved_back');
  // Ce qu'il reste à rouler en avant, sans obstacle : une table par camion (~40 ms), qui guide la recherche.
  const table = exitTable(rr, goal.lateralM, goal.headingToleranceRad);
  const search: SearchInput = {
    ctx,
    start: start.pose,
    reversing: settings.reversing,
    maxTemps: settings.maxTemps,
    maxExpansions: settings.maxExpansions,
    deadline: t0 + settings.budgetMs,
    goal,
    tempsCostM: settings.tempsCostM,
    table,
  };
  return { done: null, ctx, rr, reasons, start, search };
}

type Ready = Exclude<Prepared, { done: Outcome }>;
type Base = Pick<Found, 'start' | 'startShiftM' | 'startBackM' | 'expanded'>;

/** Le chemin trouvé et son contre-examen ; ou c'est déjà fini (pas trouvé, ou un contre-examen qui échoue). */
type Examined =
  | { readonly done: Outcome }
  | { readonly done: null; readonly path: readonly PathStep[]; readonly check: Verification; readonly base: Base };

function examine(prepared: Ready, outcome: SearchOutcome): Examined {
  const { ctx, rr, reasons, start } = prepared;
  const base = { start: start.pose, startShiftM: start.shiftM, startBackM: start.backM, expanded: outcome.expanded };
  if (!outcome.found) {
    const budget = outcome.why === 'budget_expansions' || outcome.why === 'budget_time';
    const why = budget ? 'budget_exhausted' : outcome.why;
    return { done: notFound(rr, [...reasons, ...(budget ? ['budget_exhausted'] : []), outcome.why], why, base) };
  }
  const check = verifyPath(ctx, outcome.path, prepared.search.goal.driveAwayM);
  if (!check.ok) return { done: notFound(rr, [...reasons, 'exact_check_failed'], 'exact_check_failed', base) };
  return { done: null, path: outcome.path, check, base };
}

/**
 * Le chemin servi : lissé (`turnaround-smooth.ts`) quand un lissage passe ses contrôles, puis
 * revérifié en entier — l'enveloppe, son aire et la place au plus près sont celles du chemin servi ;
 * sinon celui de la recherche, tel quel.
 */
function serve(prepared: Ready, examined: Exclude<Examined, { done: Outcome }>, settings: Settings): Outcome {
  const { ctx, reasons } = prepared;
  const { path, check, base } = examined;
  const smoothed = settings.smoothing ? smoothPath(ctx, path) : null;
  const servedCheck = smoothed?.smoothed.includes(true) === true ? verifyPath(ctx, smoothed.path, prepared.search.goal.driveAwayM) : null;
  if (smoothed === null || servedCheck === null || !servedCheck.ok) {
    return foundOutcome(ctx, { path, smoothed: [] }, settings, { ...base, reasonCodes: reasons, minClearanceM: check.minClearanceM });
  }
  return foundOutcome(ctx, smoothed, settings, { ...base, reasonCodes: [...reasons, 'path_smoothed'], minClearanceM: servedCheck.minClearanceM });
}

function finish(prepared: Ready, outcome: SearchOutcome, settings: Settings): Outcome {
  const examined = examine(prepared, outcome);
  return examined.done ?? serve(prepared, examined, settings);
}

/** Le demi-tour dans l'espace réel. Pur, déterministe (hors `elapsedMs` et le garde-fou d'horloge) ; ne lève jamais. */
export function planTurnaround(input: TurnaroundPlanInput): TurnaroundPlanResult {
  const t0 = performance.now();
  const settings = settingsOf(input.options);
  const prepared = prepare(input, settings, t0);
  const outcome = prepared.done ?? finish(prepared, searchTurnaround(prepared.search), settings);
  return { ...outcome, elapsedMs: performance.now() - t0 };
}

/** Rendre la main à la boucle d'événements. */
export type YieldControl = () => Promise<void>;

const yieldByTimer: YieldControl = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Le même demi-tour, la même recherche (`startSearch`), rendue à la boucle d'événements toutes les
 * `sliceMs` millisecondes de calcul (relecture du 2026-09-25 : d'une traite, elle tenait la boucle de l'API
 * jusqu'à `budgetMs` par camion, et les délais des autres lectures expiraient pendant ce temps). Le résultat
 * est celui de `planTurnaround`, au bit près hors `elapsedMs` ; `elapsedMs` et le garde-fou d'horloge
 * comptent le calcul, pas l'attente. Ne rejette jamais.
 */
export async function planTurnaroundAsync(
  input: TurnaroundPlanInput,
  slicing: { readonly sliceMs: number; readonly yieldControl?: YieldControl },
): Promise<TurnaroundPlanResult> {
  const pause = slicing.yieldControl ?? yieldByTimer;
  let waitedMs = 0;
  /** Rend la main ; le temps passé dehors ne compte ni dans `elapsedMs` ni pour le garde-fou. */
  const breathe = async (): Promise<number> => {
    const paused = performance.now();
    await pause();
    const waited = performance.now() - paused;
    waitedMs += waited;
    return waited;
  };
  const t0 = performance.now();
  const settings = settingsOf(input.options);
  const prepared = prepare(input, settings, t0);
  if (prepared.done !== null) return { ...prepared.done, elapsedMs: performance.now() - t0 };
  // Préparer l'espace et la table, ouvrir le réseau, chercher : trois morceaux, la main rendue entre chacun.
  const early = await breathe();
  const search = startSearch({ ...prepared.search, deadline: prepared.search.deadline + early });
  search.postpone(await breathe());
  let outcome = search.advance(performance.now() + slicing.sliceMs);
  while (outcome === null) {
    search.postpone(await breathe());
    outcome = search.advance(performance.now() + slicing.sliceMs);
  }
  // Le contre-examen, puis le lissage et sa revérification : deux morceaux, la main rendue entre les deux.
  const examined = examine(prepared, outcome);
  if (examined.done !== null) return { ...examined.done, elapsedMs: performance.now() - t0 - waitedMs };
  await breathe();
  return { ...serve(prepared, examined, settings), elapsedMs: performance.now() - t0 - waitedMs };
}
