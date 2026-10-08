/**
 * S6 — the PLANS: entering by one anchor, leaving by another.
 *
 * The engine concludes over PAIRS: an inbound and the outbound of the same
 * anchor, joined by `egressOf` at build time. Décision produit: « tu
 * classes les ancres en considérant que le camion doit partir par celle par
 * laquelle il est arrivé. Ce n'est pas le cas : il peut entrer par une ancre
 * et partir par une autre. » So the pairing was never a measurement — it was an
 * assumption baked into `candidates.ts`, and this module is the model beside
 * it: every inbound against every outbound, and the only thing that couples
 * them is what the lorry does at the stop.
 *
 * THE COUPLING RULES, settled on the product side (la note de conception interne):
 *
 *  - through street — STRAIGHT ON by default: the exit must continue the
 *    arrival heading, within `policy.plans.straightToleranceDeg`. A U-turn is
 *    allowed only where one is measured as feasible;
 *  - dead end, terminal loop — a U-turn is required of EVERY plan, whatever the
 *    headings say: the street ends, and turning round is the shape of the
 *    place. Driving the loop round is that same manoeuvre, which is why
 *    `Turnaround` carries `surface: 'loop'` for it;
 *  - one-way streets — respected for free. The legs come from OSRM, which obeys
 *    them, so a leg that leaves by the street it came in on reverses its
 *    heading and falls out of "straight" on the angle alone. An approach is
 *    never its own return.
 *
 * WHAT IS NOT MEASURED IS SAID, NOT GUESSED. A U-turn with no measured
 * turnaround is `unknown` — neither forbidden nor allowed — and the plan is
 * HUMAN. « Fait avec ce qu'on a à ce stade. » put the whole of that
 * sentence where it belongs: the plan reads `judgeTurnaround`, the SAME
 * judgement as the TURNAROUND point, so an unproven shape or a merely declared
 * diameter is a question here too, and `no` only ever comes out of a measured
 * refusal.
 *
 * In silence, and inert: this module elects nothing. `concludePairs` keeps the
 * answer, `rankPairs` keeps its order, and where the plans disagree the
 * conclusion reports it (`plansDisagreeWithVia`) rather than resolving it —
 * which is what leaves the A/B possible.
 */
import type {
  Fact,
  GeoPoint,
  PointVerdict,
  RankedPlan,
  RouteCandidate,
  TerminalTopology,
  TruckProfile,
  Turnaround,
  Verdict,
} from '@teneolog/domain';
import type { CollectedPoints } from '@teneolog/points';
import { bearingDeg, bearingDeltaDeg, haversineM } from '@teneolog/topology';

import { judgeTurnaround } from './evaluators.js';
import { legsFromMeasured } from './legs.js';
import { formPairs, SEVERITY } from './pairs.js';
import { PLANS_DEFAULTS, type ProjectionPolicy } from './policy.js';
import {
  compareOnCriteria,
  gateKeyOf,
  isUnknownDoubt,
  measureContext,
  measureLegPair,
  reasonsAgainst,
  type RankingProjection,
  type UnknownDoubtFacts,
} from './ranking.js';

/**
 * The shape of the street at the stop, as S1 measured it.
 *
 * Passed in rather than read off the candidates: `egressOf.turnaround` carries
 * the same fact, but only on an outbound, and only because the pipeline put it
 * there — the plans must not depend on the pairing they exist to replace.
 */
export interface PlanStopShape {
  /** Null when the caller did not say: then the through-street rule applies, on the headings alone. */
  readonly kind: TerminalTopology['kind'] | null;
  /** The turnaround at the stop. `known: false` — `not_applicable` included — is an unknown U-turn. */
  readonly turnaround: Fact<Turnaround>;
  /**
   * `TopologyAssessment.terminalNodeInterior` — whether the dead-end shape was
   * proven INSIDE the fetched radius (VV1-06 / ).
   *
   * Carried here for one reason: the plan refuses the manoeuvre on the same
   * evidence the TURNAROUND evaluator refuses it on, and that evaluator cannot
   * refuse on a shape that is not established. Without the field the plan would
   * be judging on less than the point does, which is exactly the gap 
   * closes.
   */
  readonly provenTopology: boolean;
}

/** No shape given: the rule falls back on what the geometry says, and nothing else. */
export const UNKNOWN_STOP_SHAPE: PlanStopShape = {
  kind: null,
  turnaround: { known: false, why: 'no_data' },
  // Rien n'a été dit de la forme : rien n'est prouvé. Sans mesure du
  // retournement la question ne se pose de toute façon pas — le demi-tour y est
  // `unknown`, jamais un refus.
  provenTopology: false,
};

export interface PlanInput {
  readonly candidates: readonly RouteCandidate[];
  readonly collected: CollectedPoints;
  readonly projection: RankingProjection;
  readonly truck: TruckProfile;
  readonly policy: ProjectionPolicy;
  readonly stop: PlanStopShape;
}

/** Everything a plan is compared on, before any comparison is made. */
interface Measured {
  readonly plan: Omit<RankedPlan, 'rank' | 'reasons'>;
  /** Rank in the formation order — S3's, i.e. azimuth. The last word on a total tie. */
  readonly order: number;
}

/**
 * Every plan the run allows, best first.
 *
 * EVERY combination is formed, including the ones that do not work: a plan whose
 * U-turn is measured impossible is a NO, not an absence. Dropping it would make
 * "five ways in, five ways out, and not one plan" indistinguishable from "the
 * router lost a leg", and the count is the whole point of the silent run.
 *
 * Pure, and total: two plans equal on all six criteria are separated by the
 * order they were formed in — inbound order, then outbound order, both of which
 * are S3's azimuth order.
 */
export function rankPlans(input: PlanInput): readonly RankedPlan[] {
  const legs = legsFromMeasured(
    input.candidates,
    input.collected,
    input.projection.candidateVerdicts,
    input.projection.pointVerdicts,
    //, second volet — les MÊMES jambes que la conclusion, avec le
    // verdict que chaque jambe porte à chaque lieu. Sans cet argument, le
    // verdict d'un plan était le pire de la place, donc `folded` rendait
    // HUMAIN une jambe qui passe et le plan retenu se décidait sur la marge.
    input.projection.perLeg,
  );
  // The legs the conclusion folds, folded once: a plan's verdict must be the
  // verdict its legs already carry, not a second reading of the same points.
  const { folded } = formPairs(legs);
  if (folded.size === 0) return [];

  const context = measureContext(input.candidates, input.collected, input.projection);
  const withVerdict = input.candidates.filter((candidate) => folded.has(candidate.id));
  const inbound = withVerdict.filter((candidate) => candidate.direction === 'in');
  const outbound = withVerdict.filter((candidate) => candidate.direction === 'out');

  const toleranceDeg = (input.policy.plans ?? PLANS_DEFAULTS).straightToleranceDeg;
  const spanM = (input.policy.plans ?? PLANS_DEFAULTS).headingSpanM;
  const uTurn = turnaroundFeasibility(input.stop, input.truck, input.policy);
  // Le point TURNAROUND porte-t-il DÉJÀ la question du demi-tour ? La règle qui
  // s'ensuit est écrite une seule fois, dans `manoeuvreUnknowns`.
  const turnaroundUnknown = input.projection.pointVerdicts.some(
    (pv) => isTurnaroundRef(pv.pointRef) && isUnknownDoubt(pv),
  );

  // Un cap par jambe, mesuré une fois : il ne dépend pas de l'autre jambe, et
  // le recalculer dans la boucle interne en ferait autant de copies qu'il y a
  // d'entrantes.
  const egressDegOf = new Map(
    outbound.map((leg) => [leg.id, egressHeadingDeg(leg.polyline, spanM)]),
  );

  const measured: Measured[] = [];
  for (const legIn of inbound) {
    const arrivalDeg = arrivalHeadingDeg(legIn.polyline, spanM);
    for (const legOut of outbound) {
      const egressDeg = egressDegOf.get(legOut.id) ?? null;
      const headingGapDeg =
        arrivalDeg === null || egressDeg === null ? null : bearingDeltaDeg(arrivalDeg, egressDeg);

      const stopMove = manoeuvreAtStop(input.stop.kind, headingGapDeg, toleranceDeg, uTurn);

      const facts = measureLegPair([legIn.id, legOut.id], context);
      measured.push({
        order: measured.length,
        plan: {
          inboundId: legIn.id,
          outboundId: legOut.id,
          sameGate: gateKeyOf(legIn.id) === gateKeyOf(legOut.id),
          manoeuvre: stopMove.manoeuvre,
          manoeuvreFeasible: stopMove.feasible,
          manoeuvreMarginM: stopMove.judged.marginM,
          manoeuvreReasonCodes: stopMove.judged.reasonCodes,
          headingGapDeg,
          verdict: worst([
            folded.get(legIn.id)?.verdict ?? 'HUMAN',
            folded.get(legOut.id)?.verdict ?? 'HUMAN',
            stopMove.judged.verdict,
          ]),
          ...facts,
          unknownCount:
            facts.unknownCount + manoeuvreUnknowns(stopMove.judged, turnaroundUnknown),
        },
      });
    }
  }

  return rankedBy(measured);
}

/**
 * Les plans mesurés, mis en ordre — et rien d'autre.
 *
 * Sorti de `rankPlans` : la fonction touchait la borne de complexité
 * du cliquet (principe 26), et la coupure est celle du sujet — là-bas on
 * MESURE, ici on CLASSE. `compareOnCriteria` reste le seul comparateur, et il
 * n'a qu'un ordre — celui du principe 28.
 */
function rankedBy(measured: readonly Measured[]): readonly RankedPlan[] {
  const sorted = [...measured].sort(
    (a, b) => compareOnCriteria(a.plan, b.plan) || a.order - b.order,
  );
  return sorted.map((entry, index) => ({
    rank: index + 1,
    ...entry.plan,
    // Why it sits here: what it beats the plan BELOW it on — the same reading,
    // and the same codes, as the pairs.
    reasons: reasonsAgainst(entry.plan, sorted[index + 1]?.plan),
  }));
}

// ---------------------------------------------------------------------------
// The manoeuvre at the stop
// ---------------------------------------------------------------------------

/** Ce que le camion fait à l'arrêt sur CE plan, et comment c'est jugé. */
interface StopManoeuvre {
  readonly manoeuvre: 'straight' | 'u_turn';
  readonly feasible: 'yes' | 'no' | 'unknown';
  /** Verdict, marge et codes — la manœuvre dite comme un point le serait. */
  readonly judged: UnknownDoubtFacts;
}

/**
 * Tout droit, ou demi-tour — et ce que ça vaut.
 *
 * Sorti de `rankPlans` : la boucle y touchait la borne de complexité
 * du cliquet (principe 26). La coupure est celle du sujet — ici on décide ce
 * que le camion fait à l'arrêt, là-bas on assemble les plans.
 *
 * Une rue terminale fait de tout plan un demi-tour ; ailleurs c'est l'angle qui
 * décide, et un angle qu'on n'a pas su mesurer n'est pas une continuation.
 * Rouler tout droit ne coûte rien à établir — la jambe sortante part de l'arrêt
 * et le routeur l'a tracée — donc `yes`, sans marge ni code : il n'y a pas de
 * manœuvre à justifier.
 */
function manoeuvreAtStop(
  kind: TerminalTopology['kind'] | null,
  headingGapDeg: number | null,
  toleranceDeg: number,
  uTurn: TurnaroundVerdict,
): StopManoeuvre {
  const straight =
    kind !== 'DEAD_END' &&
    kind !== 'TERMINAL_LOOP' &&
    headingGapDeg !== null &&
    headingGapDeg <= toleranceDeg;
  if (straight) {
    return {
      manoeuvre: 'straight',
      feasible: 'yes',
      judged: { verdict: 'OK', marginM: null, reasonCodes: EMPTY_CODES },
    };
  }
  return {
    manoeuvre: 'u_turn',
    feasible: uTurn.feasible,
    judged: {
      verdict: manoeuvreVerdict(uTurn.feasible),
      marginM: uTurn.marginM,
      reasonCodes: uTurn.reasonCodes,
    },
  };
}

/** Le demi-tour à l'arrêt, jugé — et les codes de l'évaluateur qui l'ont jugé. */
export interface TurnaroundVerdict {
  readonly feasible: 'yes' | 'no' | 'unknown';
  /**
   * la marge que `judgeTurnaround` a mesurée, `null` quand il n'a
   * rien pu mesurer.
   *
   * Portée jusqu'ici parce que « HUMAIN » ne suffit pas à dire si le doute est
   * une INCONNUE : un retournement de 12,0 m pour 11,8 m requis est un doute
   * MESURÉ, dans la bande de confort, pas un trou de donnée. La distinction est
   * celle de `isUnknownDoubt`, et c'est elle qui classe (principe 28).
   */
  readonly marginM: number | null;
  /**
   * Les codes de raison de `judgeTurnaround`, mot pour mot : `turnaround_
   * diameter`, `margin_negative`, `margin_within_comfort_band`, et les deux qui
   * transforment un refus en question — `topology_unproven`,
   * `declared_width_cannot_refuse`. Vides sur un `straight`, où il n'y a pas de
   * manœuvre à juger.
   */
  readonly reasonCodes: readonly string[];
}

const EMPTY_CODES: readonly string[] = [];

/**
 * Un point de retournement se reconnaît à son préfixe — écrit UNE fois.
 *
 * Exporté parce que le rejeu (l'API (hors instantané)) pose
 * exactement la même question sur les mêmes références, et qu'un deuxième
 * `startsWith('TURNAROUND@')` ailleurs serait une deuxième définition de ce
 * qu'est le demi-tour à l'arrêt.
 */
export function isTurnaroundRef(ref: string): boolean {
  return ref.startsWith('TURNAROUND@');
}

/**
 *, réécrit par CE QUE LA MANŒUVRE À L'ARRÊT AJOUTE
 * D'INCONNUES À UN PLAN. Une seule écriture, pour le moteur et pour le rejeu.
 *
 * Deux conditions, et les deux ont mordu :
 *
 *  1. **la manœuvre est-elle une inconnue ?** `feasible === 'unknown'` ne
 *     suffisait pas. Un demi-tour que rien n'établit est un trou : ni un refus,
 *     ni une permission. Mais un demi-tour dont la marge EST mesurée et tombe
 *     dans la bande de confort est un doute mesuré — le même objet qu'un virage
 *     à +0,20 m, que le troisième critère départage. Les compter ensemble
 *     faisait perdre un rang à un plan sur une question à laquelle on avait
 *     déjà répondu par un nombre. La règle est donc celle de tous les autres
 *     doutes : `isUnknownDoubt`.
 *  2. **l'arrêt porte-t-il déjà la question ?** Sur une impasse, le point
 *     TURNAROUND est accroché aux deux jambes de tous les plans, donc
 *     `measureLegPair` l'a déjà comptée : l'ajouter au titre de la manœuvre la
 *     compterait deux fois. C'est le partage que `concludePlan` décrit déjà
 *     (« le terme ne pèse vraiment que sur une rue traversante, où aucun point
 *     TURNAROUND n'existe »).
 *
 * Un `straight` n'ajoute rien par construction : rouler tout droit ne coûte
 * rien à établir, la jambe sortante part de l'arrêt et le routeur l'a tracée —
 * son verdict est OK, donc jamais une inconnue.
 */
export function manoeuvreUnknowns(
  manoeuvre: UnknownDoubtFacts,
  stopCarriesTheQuestion: boolean,
): number {
  return !stopCarriesTheQuestion && isUnknownDoubt(manoeuvre) ? 1 : 0;
}

/** Le verdict du point, dit dans la langue du plan. Rien d'autre ne traduit. */
const FEASIBLE_OF: Readonly<Record<Verdict, 'yes' | 'no' | 'unknown'>> = {
  OK: 'yes',
  HUMAN: 'unknown',
  NO: 'no',
};

/**
 * Can this truck turn round at the stop, on what was measured?
 *
 * UNE SEULE SOURCE DE VÉRITÉ : le jugement est celui de
 * `judgeTurnaround` (`evaluators.ts`), le même que rend le point de passage
 * TURNAROUND — bandes de marge, topologie non prouvée, diamètre seulement
 * déclaré, filtre de confiance. Ce qui vivait ici était une comparaison nue,
 * `usableDiameterM >= turnaroundRequirementM`, qui rendait `no` là où le point
 * rendait HUMAIN : sur les trois impasses du corpus de l'A/B, le plan refusait
 * un client qui n'avait aucun moyen d'argumenter ( §3.1).
 *
 * `unknown` couvre donc tout silence — retournement non cherché, non trouvé,
 * rue traversante où la question ne s'est pas posée (`not_applicable`) — ET
 * tout ce que la preuve ne suffit pas à condamner. Ni un refus, ni une
 * permission. « Fait avec ce qu'on a à ce stade. »
 */
export function turnaroundFeasibility(
  stop: PlanStopShape,
  truck: TruckProfile,
  policy: ProjectionPolicy,
): TurnaroundVerdict {
  const evaluated = judgeTurnaround(
    { turnaround: stop.turnaround, provenTopology: stop.provenTopology, path: 'stop.turnaround' },
    truck,
    policy,
  );
  return {
    feasible: FEASIBLE_OF[evaluated.verdict],
    marginM: evaluated.marginM,
    reasonCodes: evaluated.reasonCodes,
  };
}

/**
 * An impossible manoeuvre is a refusal; an unmeasured one is a question.
 *
 * Exporté depuis la conclusion par plan a besoin du MÊME mot que le
 * classement des plans pour son troisième terme, et une deuxième traduction de
 * `feasible` serait une deuxième règle.
 */
export function manoeuvreVerdict(feasible: 'yes' | 'no' | 'unknown'): Verdict {
  if (feasible === 'no') return 'NO';
  return feasible === 'unknown' ? 'HUMAN' : 'OK';
}

function worst(verdicts: readonly Verdict[]): Verdict {
  return verdicts.reduce<Verdict>((held, one) => (SEVERITY[one] > SEVERITY[held] ? one : held), 'OK');
}

// ---------------------------------------------------------------------------
// The headings at the stop
// ---------------------------------------------------------------------------

/**
 * The heading the truck arrives on: the bearing of the last `spanM` metres of
 * the inbound line.
 *
 * Over a span rather than the last vertex pair: OSRM draws a kerb-side wiggle
 * at the destination, and two metres of it would say the street points
 * somewhere it does not. Null when the line is too short to say anything — a
 * silence, never a zero (which would read as due north).
 */
export function arrivalHeadingDeg(
  polyline: readonly GeoPoint[],
  spanM: number,
): number | null {
  return headingOf([...polyline].reverse(), spanM, 'towards');
}

/** The heading the truck leaves on: the bearing of the first `spanM` metres out. */
export function egressHeadingDeg(polyline: readonly GeoPoint[], spanM: number): number | null {
  return headingOf(polyline, spanM, 'away');
}

/**
 * Walk from the stop end of the line until `spanM` is covered, and take the
 * bearing between the two ends of that walk.
 *
 * `towards` is the heading of a truck moving TOWARDS the stop (the line is
 * handed in reversed, so it is read back to front); `away` is the heading of
 * one moving away from it.
 */
function headingOf(
  fromStop: readonly GeoPoint[],
  spanM: number,
  sense: 'towards' | 'away',
): number | null {
  const first = fromStop[0];
  if (first === undefined) return null;
  let far = first;
  let acc = 0;
  for (let i = 1; i < fromStop.length; i += 1) {
    const point = fromStop[i]!;
    acc += haversineM(fromStop[i - 1]!, point);
    far = point;
    if (acc >= spanM) break;
  }
  if (acc === 0) return null;
  return sense === 'towards' ? bearingDeg(far, first) : bearingDeg(first, far);
}
