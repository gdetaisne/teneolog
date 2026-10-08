/**
 * LE DEMI-TOUR EN TROIS TEMPS (en Y), modèle dessiné, jamais une
 * mesure ni un verdict (la note de conception interne, dossier
 * la note de conception interne, principe 39). Il tourne dans le navigateur à
 * chaque déplacement de la poignée : pur, synchrone, 0,9 ms au médian et
 * 2,6 ms au pire sur 923 géométries du 19 t (sans enveloppe ; la grille est au
 * §2 du contrat).
 *
 * Repère local du paquet (mètres, y vers le BAS) : l'ancre à l'origine, le sens
 * d'entrée au cap 0 (vers +x), `left` = y < 0. Le calcul se fait côté droit
 * (y > 0) et le côté gauche en est le miroir exact (y → −y, cap → −cap).
 *
 * LE MODÈLE, en entier — simple pour être vérifiable :
 * 1. Bicyclette exacte à l'essieu arrière (`advanceRearAxle`, forme close) :
 *    braquage maxi (±1) ou droit (0), en avant ou en arrière, braquage changé à
 *    l'arrêt ; rayon de l'essieu arrière Rr = √(R² − L²)
 *    (`rearAxleMinTurnRadiusM`, R lu au centre de l'essieu avant :
 *    `radius_front_axle_reading`, toujours dit, §9). Caisse = le rectangle de
 *    `truckFootprint`.
 * 2. Le couloir est la rue ∪ la branche, à angles francs (pas de rayon de
 *    bordure : `model_sharp_corners`, pessimiste), marge nulle (§0.4) ; une
 *    découpe exacte, pas les seuls coins (`three-point-corridor.ts`). Le premier
 *    contact d'un mouvement se calcule en forme close, coins de bâti compris,
 *    et dès le départ quand un coin posé sur le niveau le franchit en partant
 *    (`three-point-contact.ts`) : la caisse ne sort jamais du couloir entre deux
 *    poses dessinées (à la tolérance du couloir près, 1 µm). La largeur prise
 *    dans une branche inconnue se lit aussi en forme close, sur tout le
 *    balayage (`three-point-branch-width.ts`).
 * 3. Un mouvement va jusqu'au cap visé ou jusqu'au premier contact. Puis on
 *    repart dans l'autre sens au braquage inverse — le cap tourne toujours du
 *    même côté —, jusqu'à ce que le camion REPARTE : un mouvement en avant qui
 *    finit au cap d'entrée + 180° à ±5°, la caisse entière dans la bande de la
 *    rue (plus rien dans la branche) et une longueur de camion tout droit devant
 *    elle encore dans la bande. Tant que ce n'est pas le cas, on alterne encore.
 *    - `forward_into_branch` : avant vers la branche jusqu'à son cap (quand la
 *      rue ne suffit pas, la caisse s'y aligne, et la profondeur rendue est
 *      celle-là ; dans une rue assez large, elle n'y entre pas : profondeur
 *      nulle, `null`), arrière, et l'on alterne ;
 *    - `reverse_into_branch` : l'arrivée est le temps 1 — tout droit au-delà
 *      de la branche, en finissant au besoin par un coup de volant à l'opposé
 *      (0, 20 ou 40°, arrêté au contact), le nez vers l'autre bord, comme le
 *      chauffeur qui se met en travers avant de reculer dans une entrée —, puis
 *      arrière vers la branche jusqu'à pointer hors d'elle, puis avant au
 *      braquage opposé, et l'on alterne ;
 *    - `no_branch` : virage en K dans la bande seule (élargissement, place),
 *      commencé l'essieu arrière au droit de l'ancre.
 * 4. On repart toujours en avant : si le dernier mouvement est une marche
 *    arrière, le départ est un temps de plus (d'où des temps impairs : 1, 3, 5…),
 *    dessiné jusqu'au bout de sa longueur de camion tout droit.
 * 5. Les départs essayés sont une liste fixe (comme `defaultOffsets` de
 *    `simulation.ts`) : l'écart latéral à chaque bord, le coup de volant de
 *    l'arrivée, et, avec une branche, la position le long de l'axe autour de
 *    celle qui pose la caisse dans l'axe de la branche. On garde le moins de
 *    temps, puis la branche la moins large (si elle est inconnue), puis la moins
 *    profonde, puis le premier de la liste : déterministe.
 *
 * Ce que le modèle ne garantit pas : chaque mouvement s'arrête au premier
 * contact, et un couloir plus large déplace ces contacts. Le nombre de temps ne
 * croît pas avec la largeur de la rue sans branche (vérifié au centimètre sur la
 * grille du 19 t, `three-point.test.ts`). Avec une branche — à 90° comme en
 * biais — il peut croître d'un cran ou plus, jusqu'à « pas de solution », sur
 * quelques centimètres de rue ou de branche en plus : une limite du modèle,
 * dite et comptée au §2 du contrat, pas une mesure du terrain.
 *
 * `not_found` au-delà de `maxTemps` est une LIMITE DU MODÈLE (principe 5), dite
 * par `max_temps_reached` — jamais un refus. Une entrée que le modèle ne sait
 * pas lire est dite par son nom, jamais levée.
 */
import { rasterFootprintEnvelope } from './footprint-raster.js';
import { truckFootprint } from './geometry.js';
import { advanceRearAxle, rearAxleMinTurnRadiusM } from './kinematics.js';
import { canonicalCorridor } from './three-point-corridor.js';
import { angleGap, planFor, searchThreePoint, type Attempt, type SearchCtx, type Segment } from './three-point-search.js';
import type { Point, Pose, TruckSpec } from './types.js';

export type ThreePointSide = 'left' | 'right';
export type ThreePointVariant = 'forward_into_branch' | 'reverse_into_branch' | 'no_branch';

export interface ThreePointTurnInput {
  readonly truck: TruckSpec;
  readonly streetWidthM: number;
  readonly side: ThreePointSide;
  readonly variant: ThreePointVariant;
  /** Null with `no_branch`. `widthM` null = unknown: never invented, the result says what is needed. */
  readonly branch: { readonly angleDeg: number; readonly widthM: number | null } | null;
  /** Upper bound on the number of moves tried; 9 by default. */
  readonly maxTemps?: number;
  /** Compute `envelopePolygon` (raster union, costly); false by default — the page asks it once, not per drag. */
  readonly withEnvelope?: boolean;
}

export interface ThreePointTurnResult {
  /** `not_found` is a limit of the MODEL, never a refusal (principe 5). */
  readonly status: 'found' | 'not_found';
  /** The initial forward move counts: 3 = trois temps, 5 = cinq temps. */
  readonly temps: number | null;
  /** One per temps, at its end (the arrival's end for `reverse_into_branch`; the drive-away for a final forward start). */
  readonly ghostPoses: readonly Pose[];
  readonly ghostFootprints: readonly (readonly Point[])[];
  /** The whole sweep, sampled every ~0.5 m of rear-axle travel, one truck length of arrival included. */
  readonly bodyFootprints: readonly (readonly Point[])[];
  readonly envelopePolygon: readonly Point[];
  /** How deep the body goes into the branch, from the street edge, along the branch; null without a branch or when the body never enters it. */
  readonly branchDepthM: number | null;
  /** The branch width needed, when it is unknown and the body enters the branch — exact over the whole sweep: declared 1 cm wider, it never costs a temps. */
  readonly branchWidthNeededM: number | null;
  readonly minRearAxleRadiusM: number;
  readonly reasonCodes: readonly string[];
}

/** Au plus tant de temps, par défaut : lu aussi par le demi-tour dans l'espace réel (`turnaround-plan.ts`) — une source. */
export const DEFAULT_MAX_TEMPS = 9;
/** Sampling of the drawn sweep, like `DEFAULT_SAMPLE_STEP_M` of `simulation.ts`. */
const SAMPLE_STEP_M = 0.5;
/** Model domain of the branch angle: outside, the branch runs along the street, not off it. */
const MIN_BRANCH_ANGLE_DEG = 10;
const MAX_BRANCH_ANGLE_DEG = 170;

export function simulateThreePointTurn(input: ThreePointTurnInput): ThreePointTurnResult {
  const rr = rearAxleMinTurnRadiusM(input.truck.turnRadiusM, input.truck.wheelbaseM);
  const reasons = modelReasons(input);
  const invalid = invalidInputReason(input, rr);
  if (invalid !== null) return notFound(rr, [...reasons, invalid]);
  const branch = input.variant === 'no_branch' ? null : input.branch;
  const ctx: SearchCtx = {
    truck: input.truck,
    rr,
    corridor: canonicalCorridor(input.streetWidthM, branch),
    unknownWidth: branch !== null && branch.widthM === null,
  };
  const angleDeg = branch === null ? 180 : branch.angleDeg;
  const maxTemps = Math.max(1, Math.floor(input.maxTemps ?? DEFAULT_MAX_TEMPS));
  const best = searchThreePoint(ctx, planFor(input.variant, angleDeg), maxTemps);
  if (best === null) return notFound(rr, [...reasons, 'max_temps_reached']);
  return foundResult(best, ctx, input, reasons);
}

function modelReasons(input: ThreePointTurnInput): string[] {
  const reasons = ['radius_front_axle_reading'];
  if (input.variant === 'no_branch') return reasons;
  reasons.push('model_sharp_corners');
  if (input.branch !== null && input.branch.widthM === null) reasons.push('branch_width_unknown');
  return reasons;
}

/** What the model cannot run, said by name (principe 14) — never thrown: the page calls this on every drag. */
function invalidInputReason(input: ThreePointTurnInput, rr: number): string | null {
  if (!Number.isFinite(input.streetWidthM) || input.streetWidthM <= 0) return 'street_width_invalid';
  if (!truckReadable(input.truck)) return 'truck_dimensions_invalid';
  if (rr <= 0) return 'turn_radius_not_above_wheelbase';
  if (input.streetWidthM < input.truck.widthM) return 'street_narrower_than_truck';
  return input.variant === 'no_branch' ? null : invalidBranchReason(input.branch);
}

function invalidBranchReason(branch: ThreePointTurnInput['branch']): string | null {
  if (branch === null) return 'branch_missing';
  const angle = branch.angleDeg;
  if (!(angle >= MIN_BRANCH_ANGLE_DEG && angle <= MAX_BRANCH_ANGLE_DEG)) return 'branch_angle_outside_model';
  const width = branch.widthM;
  if (width !== null && !(Number.isFinite(width) && width > 0)) return 'branch_width_invalid';
  return null;
}

/**
 * Lengths finite and above zero; overhangs finite and zero or more (a flush front is a real truck).
 * Also read by the turnaround in the real space (`turnaround-plan.ts`): one reading of a gabarit.
 */
export function truckReadable(truck: TruckSpec): boolean {
  const positive = [truck.lengthM, truck.widthM, truck.wheelbaseM, truck.turnRadiusM];
  const nonNegative = [truck.frontOverhangM, truck.rearOverhangM];
  return positive.every((m) => Number.isFinite(m) && m > 0) && nonNegative.every((m) => Number.isFinite(m) && m >= 0);
}

function notFound(rr: number, reasonCodes: readonly string[]): ThreePointTurnResult {
  return {
    status: 'not_found',
    temps: null,
    ghostPoses: [],
    ghostFootprints: [],
    bodyFootprints: [],
    envelopePolygon: [],
    branchDepthM: null,
    branchWidthNeededM: null,
    minRearAxleRadiusM: rr,
    reasonCodes,
  };
}

function foundResult(
  best: Attempt,
  ctx: SearchCtx,
  input: ThreePointTurnInput,
  reasonCodes: readonly string[],
): ThreePointTurnResult {
  const place = input.side === 'left' ? leftPose : rightPose;
  const ghostPoses = best.ghosts.map(place);
  const bodyFootprints = best.segments.flatMap((segment) =>
    samplePoses(segment, ctx.rr).map((pose) => truckFootprint(place(pose), ctx.truck)),
  );
  const envelope = input.withEnvelope === true ? rasterFootprintEnvelope(bodyFootprints) : null;
  // The body never went past the street edge: the branch is not used, and nothing is measured in it.
  const entersBranch = ctx.corridor.branch !== null && best.use.depthM > 0;
  return {
    status: 'found',
    temps: best.temps,
    ghostPoses,
    ghostFootprints: ghostPoses.map((pose) => truckFootprint(pose, ctx.truck)),
    bodyFootprints,
    envelopePolygon: envelope?.ok === true ? envelope.envelope : [],
    branchDepthM: entersBranch ? best.use.depthM : null,
    branchWidthNeededM: entersBranch && ctx.unknownWidth ? 2 * best.use.halfWidthM : null,
    minRearAxleRadiusM: ctx.rr,
    reasonCodes,
  };
}

function samplePoses(segment: Segment, rr: number): Pose[] {
  const count = Math.max(1, Math.ceil(segment.lengthM / SAMPLE_STEP_M));
  return Array.from({ length: count + 1 }, (_, index) =>
    advanceRearAxle(segment.start, segment.steer, (segment.direction * segment.lengthM * index) / count, rr),
  );
}

/** Headings leave wrapped to (−π, π]; the canonical run keeps them continuous. */
function rightPose(pose: Pose): Pose {
  return { x: pose.x, y: pose.y, headingRad: angleGap(0, pose.headingRad) };
}

/** Left is the exact mirror of the canonical right: y → −y, heading → −heading (−π read as π). */
function leftPose(pose: Pose): Pose {
  const headingRad = -angleGap(0, pose.headingRad);
  return { x: pose.x, y: -pose.y, headingRad: headingRad === -Math.PI ? Math.PI : headingRad };
}
