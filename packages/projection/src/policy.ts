import type { TruckFamily } from '@teneolog/domain';

/**
 * The slice of the versioned Policy that S5 consumes. Values are calibration
 * (the console's job); the SHAPE is the contract. No literal in this package
 * reads from anywhere but here.
 */
export interface ProjectionPolicy {
  /** Lateral clearance required beside the vehicle, summed over both sides. */
  readonly lateralClearanceM: number;
  /** Added to the kinematic requirement in turns (ADR-007's safety margin). */
  readonly turnSweptClearanceM: number;
  readonly roundaboutSweptClearanceM: number;
  /** Added to 2×turn radius for a turnaround to auto-clear. */
  readonly turnaroundClearanceM: number;
  /**
   * Positive margins smaller than this stay HUMAN: the geometry clears on
   * paper and a person confirms it clears in life.
   */
  readonly comfortMarginM: number;
  /**
   * LA BANDE DE CONFORT PAR FAMILLE, là où la
   * générique ne suffit pas.
   *
   * Décision produit (principe 31), sur le véhicule articulé : « il faut à
   * l'évidence dégrader, et peut-être même prendre une marge additionnelle,
   * parce que sortir un semi qui est bloqué, c'est très compliqué. […] sa bande
   * de confort est plus large que celle d'un porteur (valeur en policy avec
   * cette source ; proposition 0,8 m contre 0,4). »
   *
   * Optionnelle et partielle : une famille absente prend `comfortMarginM`,
   * donc un appelant écrit avant la clé ne change pas d'un bit. La valeur
   * livrée pour `semi` est la PROPOSITION du principe 31, à confirmer par
   * Le responsable produit — c'est écrit dans le `comment` de la policy.
   */
  readonly comfortMarginByFamilyM?: Partial<Record<TruckFamily, number>>;
  /**
   * Evidence confidence gates (EC-04 / BUG-011: the engine had no
   * low-confidence → HUMAN gate, so a doubtful OK looked like a solid one).
   * At or above `publishable`, a verdict may auto-resolve; below it, OK and
   * NO alike become HUMAN — a doubtful NO is as untrustworthy as a doubtful OK.
   */
  readonly publishableConfidence: number;
  /** GVW strictly above this makes a truck HGV for hgv-scoped rules. */
  readonly hgvThresholdT: number;
  /**
   * Width another vehicle needs to pass a stopped truck.
   *
   * Not a feasibility threshold — the delivery is legal and possible either way
   * — but the difference between "park and unload" and "you will be blocking
   * the street, keep it short or reserve the spot". Reported, never a verdict.
   */
  readonly passingLaneWidthM: number;
  /**
   * how a plan's two legs are joined at the stop.
   *
   * Optional so that a caller written before the plans still compiles and
   * still gets plans: the default below is the policy file's own value, and it
   * lives in ONE place (`PLANS_DEFAULTS`) rather than in each call site.
   */
  readonly plans?: PlansPolicy;
  /**
   * QUI DÉCIDE : les paires de R0, ou le meilleur plan.
   *
   * Optionnelle, et le défaut est `pairs` : un appelant écrit avant cette
   * tâche — un test, un harnais, un script — garde exactement le moteur
   * d'hier sans avoir rien à dire. La policy de référence, elle, dit `plans`.
   */
  readonly conclusion?: ConclusionPolicy;
}

export interface ConclusionPolicy {
  /**
   * `pairs` — la conclusion est celle de `concludePairs` sur les paires de R0
   * (aller et retour par la même ancre) : le moteur de 61efed8, au bit près.
   * C'est le retour arrière.
   *
   * `plans` — la conclusion est le MEILLEUR PLAN : entrer par une ancre,
   * sortir par une autre, la manœuvre à l'arrêt entre les deux. Les paires
   * d'hier sont des plans (même ancre), et le classement met le verdict en
   * premier, donc le verdict retenu ne peut que rester ou s'améliorer — ce que
   * l'A/B mesure sur le corpus et ce qu'un test d'invariant tient sur les
   * fixtures.
   */
  readonly mode: 'pairs' | 'plans';
}

export const CONCLUSION_DEFAULTS: ConclusionPolicy = { mode: 'pairs' };

export interface PlansPolicy {
  /**
   * Beyond this angle between the arrival heading and the departure heading,
   * the exit no longer continues the arrival and the plan is read as a
   * reversal at the stop.
   *
   * 60° is the product owner's number (2026-09-11). It is deliberately wide: what is
   * being separated is "the lorry drives on" from "the lorry turns round",
   * not one junction geometry from another.
   */
  readonly straightToleranceDeg: number;
  /**
   * Over how many metres a leg's heading at the stop is measured.
   *
   * Not the last vertex pair: a router draws a kerb-side wiggle at the
   * destination, and two metres of it would say the street points somewhere it
   * does not. Twenty metres is a street's own direction, and short enough that
   * the junction fifty metres on does not pollute it.
   */
  readonly headingSpanM: number;
}

export const PLANS_DEFAULTS: PlansPolicy = { straightToleranceDeg: 60, headingSpanM: 20 };
