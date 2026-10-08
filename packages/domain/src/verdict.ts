/**
 * S5/S6/S7 — Projection, conclusion, human input.
 *
 * A verdict is a pure function of facts and policy. Nothing in the system
 * writes a verdict directly; a verdict that cannot name the facts it came from
 * is a defect, which is why `derivedFrom` is not optional.
 */
import type { FactRef } from './fact.js';
import type { PointRef } from './point.js';
import type { TruckProfileId } from './truck.js';

/** `HUMAN` is an escalation, never a silent middle. */
export type Verdict = 'OK' | 'NO' | 'HUMAN';

export interface PointVerdict {
  readonly pointRef: PointRef;
  readonly profileId: TruckProfileId;
  /**
   * The itinerary this verdict is scoped to; null when the point is common to
   * every itinerary. Without it, a manoeuvre that fails on one pairing poisons
   * the itineraries where it never occurs.
   */
  readonly candidateId: string | null;
  readonly verdict: Verdict;
  /** Clearance in metres where the check is dimensional; null where it is not. */
  readonly marginM: number | null;
  readonly reasonCodes: readonly string[];
  readonly derivedFrom: readonly FactRef[];
  /** Rendered from the facts, for the reader. Not a free-text field. */
  readonly explanation: string;
}

/**
 * The one thing a user is asked, per scene: does the truck pass here.
 *
 * Deliberately a single boolean. Everything else the deck could ask has been
 * considered and set aside — the input stays as simple as a swipe.
 */
export interface Judgement {
  readonly pointRef: PointRef;
  readonly profileId: TruckProfileId;
  readonly passes: boolean;
  readonly decidedAt: string;
  /** Capture date of the imagery it was decided on. A judgement is no fresher than its photograph. */
  readonly imageryDate: string | null;
  readonly source: 'user' | 'operator';
}

/**
 * Reuse of a judgement across trucks, by envelope dominance only.
 *
 * A failure carries upward to every truck that dominates the one judged; a
 * success carries downward to every truck it dominates. Where neither envelope
 * dominates the other, nothing is inferred and the point is asked again.
 */
export interface InferredJudgement {
  readonly judgement: Judgement;
  readonly inferredFor: TruckProfileId;
  readonly direction: 'failure_upward' | 'success_downward';
}

/**
 * The outcome of one candidate itinerary.
 *
 * A route can be eliminated by something that is not a place at all — a weight
 * limit on a segment it traverses. Without a per-candidate record, that reason
 * has nowhere to be reported, and every distinct cause of "no itinerary" is
 * flattened into the same empty answer.
 */
export interface CandidateVerdict {
  readonly candidateId: string;
  readonly verdict: Verdict;
  /** The segment that eliminated it, when a legal or dimensional limit did. */
  readonly blockedAtSegmentId: string | null;
  readonly reasonCodes: readonly string[];
  readonly derivedFrom: readonly FactRef[];
}

export type OverallVerdict = 'OK' | 'NO' | 'HUMAN' | 'NOT_DELIVERABLE';

/**
 * One pair (an inbound and the outbound that continues it), and its place in
 * the ORDER OF PREFERENCE among the pairs of a run.
 *
 * The conclusion is an existence claim — "a pair passes". That claim answers
 * the customer and says nothing to the operator who has to pick one: five pairs
 * all marked HUMAN are not five equivalent proposals, and until now nothing in
 * the run said which one to look at first, or on what grounds.
 *
 * Strictly a second reading of facts the conclusion already rests on. It
 * changes no verdict and elects nothing: `viaCandidateId` stays exactly what
 * the existence claim made it, and where the two disagree the conclusion wins
 * and the disagreement is reported (`RunConclusion.rankingDisagreesWithVia`)
 * rather than resolved.
 */
export interface RankedPair {
  /** 1 is the pair to look at first. Dense and contiguous over the run's pairs. */
  readonly rank: number;
  readonly inboundId: string;
  readonly outboundId: string;
  /** The anchor both legs pass through, as S3 names it: `<wayId>@<azimuth>`. */
  readonly gateKey: string;
  /** The pair's verdict — its worse leg's, exactly as the conclusion folds it. */
  readonly verdict: Verdict;
  /**
   * LES INCONNUES : les points en doute parce qu'une donnée MANQUE.
   *
   * Largeur déclarée ou estimée qu'on n'a pas le droit de refuser, anneau
   * roulable non mesuré, topologie d'impasse non prouvée, géométrie que S4 n'a
   * pas pu établir. Principe 28, le responsable produit : « prioriser les itinéraires avec
   * aucune inconnue. » C'est le premier critère après le verdict — un trou
   * n'est pas une difficulté mesurée, c'est une question qu'on n'a pas posée.
   *
   * À distinguer de `humanPointCount`, qui compte AUSSI les doutes mesurés
   * (une marge dans la bande de confort) : ceux-là sont des difficultés
   * connues, et c'est la marge qui les départage, pas leur nombre.
   */
  readonly unknownCount: number;
  /**
   * LA PIRE MARGE MESURÉE parmi les virages, les giratoires et les
   * retournements, en mètres signés.
   *
   * Principe 28 : « dix petits virages sont plus sûrs qu'un 90° ; il faut
   * classer les itinéraires en fonction du pire virage — et comme on doit
   * inclure les giratoires aussi, le calcul de marge est pratique. » Les
   * sections droites (`NARROW`) et le point de destination n'y entrent pas
   * (principe 27 : « la largeur seule n'est presque jamais le problème »), en
   * attendant leur calibration par gabarit.
   *
   * `null` quand aucun de ces points n'a porté de marge mesurée — un silence,
   * jamais une marge nulle, et jamais un argument pour passer devant.
   */
  readonly worstTurnMarginM: number | null;
  /**
   * Points along the pair still awaiting a human answer. The review cost.
   *
   * Publié, ne classe PLUS depuis compter les points revenait à
   * préférer l'itinéraire qu'on avait le moins regardé — à Thairé, une jambe
   * tronquée à 604 m battait une jambe contrôlée jusqu'au cercle parce qu'elle
   * portait « un point de moins ».
   */
  readonly humanPointCount: number;
  /**
   * Smallest SIGNED clearance measured on the pair, in metres — negative where
   * the truck does not fit. Null when not one point on the pair was measured
   * dimensionally: an absence of measurement is not a margin of zero.
   *
   * Publié, ne classe plus depuis c'est `worstTurnMarginM` qui
   * départage, parce qu'une section droite étroite et un angle droit ne sont
   * pas la même difficulté (principe 27).
   */
  readonly worstMarginM: number | null;
  /**
   * The best road class the pair reaches, as the lowest OSM rank among its
   * segments (`highwayRankOf`: 1 motorway … 9 track). Null when no segment
   * declares a class.
   *
   * Publié, ne classe plus depuis la classe n'est pas une preuve
   * (principe 15 — Thairé, 83 tertiaires et 0 primaire).
   */
  readonly worstHighwayRank: number | null;
  /** Metres travelled outside the structuring network. Publié, ne classe plus. */
  readonly localNetworkLengthM: number;
  /** Both legs' routed distance, in metres. */
  readonly totalDistanceM: number;
  /**
   * Why this pair sits where it does: the criteria on which it beats the pair
   * ranked just below it, in criterion order — so the first code is the one
   * that decided. Empty on the last pair, and on a pair that ties its
   * successor on every criterion and is separated only by azimuth order.
   *
   * Codes : `verdict_ok` (un verdict strictement meilleur),
   * `no_unknowns` (moins de doutes nés d'une donnée absente),
   * `wider_worst_turn_margin` (une meilleure pire marge de virage, de giratoire
   * ou de retournement), `shorter`.
   */
  readonly reasons: readonly string[];
}

/**
 * A PLAN: one leg in, one leg out, and the manoeuvre between them.
 *
 * The engine of today pairs an inbound with the outbound of the SAME anchor
 * (`egressOf`, by alternative index) and concludes over those pairs. That is an
 * assumption, not the model: a lorry may enter by one anchor and leave by
 * another (la note de conception interne). A plan is the object the
 * model asks for — every inbound against every outbound — and their only
 * coupling is what has to happen at the stop.
 *
 * Computed in silence beside the pairs and acted on by nothing: `viaCandidateId`
 * and `ranking` are exactly what they were, and where the two readings part
 * ways the conclusion reports it (`plansDisagreeWithVia`) instead of resolving
 * it. That is what leaves the A/B possible.
 */
export interface RankedPlan {
  /** 1 is the plan to look at first. Dense and contiguous over the run's plans. */
  readonly rank: number;
  readonly inboundId: string;
  readonly outboundId: string;
  /** Both legs pass through the same anchor — the pair the engine forms today. */
  readonly sameGate: boolean;
  /**
   * What the truck does at the stop.
   *
   * `straight` — the exit continues the arrival heading, within the policy's
   * tolerance: the lorry drives on and no manoeuvre is needed.
   * `u_turn` — it does not, so the direction of travel is reversed at the stop;
   * on a dead end or a terminal loop that is true of every plan by the shape of
   * the street. There is no third label on purpose: a departure that neither
   * continues the arrival nor is measured as a reversal is not a manoeuvre the
   * engine can stand behind, and it is counted as the reversal it may be.
   */
  readonly manoeuvre: 'straight' | 'u_turn';
  /**
   * Whether that manoeuvre is possible for THIS truck.
   *
   * `yes` on a straight-through, and on a reversal the TURNAROUND evaluator
   * clears outright. `no` ONLY where that same evaluator refuses — i.e. on a
   * measured diameter, on a proven shape. `unknown` everywhere else: nothing
   * measured, a shape not established, a diameter merely declared, a confidence
   * below the publishable bar. The honest third value — an unproven U-turn is
   * neither forbidden nor allowed, and it is what "fait avec ce qu'on a à ce
   * stade" means here.
   *
   * one reading of the turnaround, `judgeTurnaround`, shared with the
   * point. A plan used to refuse on exactly the evidence the point forbids
   * itself to refuse on.
   */
  readonly manoeuvreFeasible: 'yes' | 'no' | 'unknown';
  /**
   * la marge mesurée sur la manœuvre, en mètres signés. `null` quand
   * rien n'a pu être mesuré, et sur un `straight`, où il n'y a pas de manœuvre.
   *
   * Le troisième champ du jugement, à côté de `manoeuvreFeasible` et de
   * `manoeuvreReasonCodes` : ensemble ils disent la manœuvre exactement comme
   * un `PointVerdict` dit un point — verdict, marge, codes. Publiée parce que
   * « HUMAIN » ne dit pas si le doute est une INCONNUE (un trou de donnée) ou
   * un doute MESURÉ dans la bande de confort, et que c'est cette différence qui
   * classe (principe 28). Sans elle, le rejeu des réponses humaines devrait
   * refaire le jugement au lieu de le relire.
   */
  readonly manoeuvreMarginM: number | null;
  /**
   * Why the manoeuvre was judged that way: the TURNAROUND evaluator's own
   * reason codes, verbatim. Empty when the truck drives straight on — there is
   * no manoeuvre to justify.
   */
  readonly manoeuvreReasonCodes: readonly string[];
  /**
   * Angle between the heading on arrival at the stop and the heading on
   * departure, in degrees [0, 180]. Null when a leg's line is too short to
   * carry a heading — a silence, never a zero.
   */
  readonly headingGapDeg: number | null;
  /** The worse of the two legs and of the manoeuvre: infeasible is NO, unknown is HUMAN. */
  readonly verdict: Verdict;
  /**
   * les inconnues du plan : les points en doute par MANQUE de donnée,
   * comptés une fois, plus la manœuvre à l'arrêt quand elle n'est pas établie
   * et qu'aucun point TURNAROUND ne porte déjà la question.
   *
   * Le premier critère après le verdict (principe 28).
   */
  readonly unknownCount: number;
  /**
   * la pire marge mesurée du plan sur un virage, un giratoire ou un
   * retournement. `null` quand aucun n'a été mesuré.
   */
  readonly worstTurnMarginM: number | null;
  /** Points along either leg still awaiting a human answer, counted once. Publié, ne classe plus. */
  readonly humanPointCount: number;
  /** Smallest signed clearance measured on the plan, tous types confondus. Publié, ne classe plus. */
  readonly worstMarginM: number | null;
  /** The worst (highest) OSM rank among the segments of both legs. Publié, ne classe plus. */
  readonly worstHighwayRank: number | null;
  /** Publié, ne classe plus. */
  readonly localNetworkLengthM: number;
  readonly totalDistanceM: number;
  /**
   * Why this plan sits where it does: the criteria on which it beats the plan
   * ranked just below it, in criterion order — the same vocabulary as
   * `RankedPair.reasons`, because it is the same lexicographic order.
   */
  readonly reasons: readonly string[];
}

/**
 * le plan que la conclusion a retenu, réduit à ce qui l'identifie.
 *
 * Un sous-ensemble de `RankedPlan`, jamais une copie : les chiffres du plan
 * (marge, points, distance) restent dans `plans[rank - 1]`, et les répéter ici
 * ferait deux lectures d'une même mesure. Ce que cet objet porte est ce qu'un
 * lecteur ne peut retrouver nulle part ailleurs — quelles deux jambes, et ce
 * que le camion fait entre elles.
 */
export interface RetainedPlan {
  readonly inboundId: string;
  readonly outboundId: string;
  /** Entrer et sortir par la même ancre — la paire que le moteur d'hier formait. */
  readonly sameGate: boolean;
  readonly manoeuvre: 'straight' | 'u_turn';
  /** Son rang dans `plans` : 1, sauf si un jour la conclusion cessait de prendre le premier. */
  readonly rank: number;
}

/** la conclusion de la règle d'hier, gardée à côté de celle d'aujourd'hui. */
export interface R0Pair {
  /** La sortante de la paire retenue par `concludePairs`, ou null s'il n'y en a pas. */
  readonly viaCandidateId: string | null;
  readonly overall: OverallVerdict;
}

/**
 * le garde-fou de portée : ce qui explique un `no_leg_reaches_ring`.
 *
 * Posé quand ni une ancre R0 (`GateSearch.retained`) ni une jambe découverte
 * (`GateSearch.discovery.approaches` / `approachesOut`) n'atteint le cercle
 * (`gates.minReachM`, principe 7) — aucun candidat, donc aucune paire, mais la
 * raison est mesurée et nommée plutôt que tue (principe 1, 14). Un inconnu
 * n'est jamais un refus (principe 5) : ce motif n'accompagne que HUMAIN,
 * jamais NON.
 *
 * Les nombres viennent tous de `GateSearch.shortOfRing` et
 * `GateSearch.discovery.shortOfRing` — le meilleur sommet mesuré, R0 et
 * découverte confondus. `bestWayId`/`bestWayName`/`bestAzimuthDeg` sont nuls
 * ensemble quand ce sommet vient de la découverte, qui ne nomme pas de voie
 * (`ApproachShortOfRing` ne porte ni id ni azimut) — une donnée absente
 * s'affiche comme absente plutôt que d'en emprunter une autre (principe 14).
 */
export interface NoLegReachesRingMotif {
  /** Le plancher appliqué — `GateSearch.minReachM`, `gates.minReachM` en policy. */
  readonly minReachM: number;
  /** La meilleure portée mesurée, à vol d'oiseau, tous azimuts confondus. */
  readonly bestReachM: number;
  readonly bestWayId: string | null;
  readonly bestWayName: string | null;
  readonly bestAzimuthDeg: number | null;
}

export interface RunConclusion {
  readonly profileId: TruckProfileId;
  readonly overall: OverallVerdict;
  readonly pointVerdicts: readonly PointVerdict[];
  /**
   * CE QUE CHAQUE JAMBE A MESURÉ À CHAQUE LIEU QU'ELLE CONDUIT, une
   * entrée par (jambe, lieu), `candidateId` toujours renseigné.
   *
   * `pointVerdicts` est le résumé par LIEU — le pire des jambes — et c'est ce
   * qu'il faut pour demander : la question de l'exploitant est posée dès qu'UNE
   * jambe en a besoin, et une réponse vaut pour toutes (architecture §3.3). Mais
   * ce n'est pas ce qu'il faut pour RÉPONDRE : le coin de Exemple et de la
   * Voisine 23 est 57° dans 3,0 m sur la grise et 98° dans 5,2 m sur la bleue, et
   * une jambe ne répond que de la manœuvre qu'elle exécute.
   *
   * La conclusion lisait déjà la jambe (`verdictsPerLeg`, project.ts) ; elle ne
   * le PUBLIAIT pas. Tout ce qui rejoue un run — `rederiveConclusion` sur le fil
   * l’API, le rejeu d'un run réhydraté — devait donc reposer le pire du
   * lieu sur chaque jambe, et rendait HUMAIN ce que le moteur avait conclu OK.
   * Deux lectures d'une même mesure, et c'est le principe 24 qu'elles coûtaient.
   *
   * Vide sur une conclusion réhydratée d'un snapshot antérieur à le
   * repli est alors `pointVerdicts`, le lieu, c'est-à-dire le monde d'avant —
   * prudent (jamais faux dans le sens du refus), et nommé plutôt que deviné.
   */
  readonly legVerdicts: readonly PointVerdict[];
  readonly candidateVerdicts: readonly CandidateVerdict[];
  /** The point that determined the overall answer, when a place decided it. */
  readonly decidedBy: PointRef | null;
  /**
   * The outbound itinerary the answer is delivered by; its `egressOf` names the
   * inbound. Null when none is feasible. The overall verdict is an existence
   * claim over candidates, so the surviving one is part of the answer.
   */
  readonly viaCandidateId: string | null;
  /**
   * The points the answer rests on: those along the retained pair
   * (`viaCandidateId` and its inbound) or, when no pair formed, those along
   * the legs still open (HUMAN). A point on a discarded itinerary is not a
   * fact about the answer given, so S6 must not list it as pending.
   */
  readonly retainedPointRefs: readonly PointRef[];
  /**
   * Conclusion-level codes, one vocabulary for S5 and for the replay over human
   * judgements:
   *   `best_pair_legally_blocked` — every pair is NO and the best one fell to a
   *     legal band (weight, height, width, access);
   *   `router_unavailable` — no pair could form because the router lost a leg
   * (provider fault): an unknown, never a refusal;
   *   `no_viable_pair` — no pair and no leg at all to explain why;
   * `no_leg_reaches_ring` — no pair, no leg, and `noLegReachesRing`
   *     says why: neither an R0 anchor nor a discovered leg reaches the ring.
   */
  readonly reasonCodes: readonly string[];
  /**
   * The run's pairs in order of preference. Additive and inert: not
   * one field above is derived from it.
   *
   * Empty when no pair formed — the same silence the existence claim keeps.
   */
  readonly ranking: readonly RankedPair[];
  /**
   * The ranking puts a pair other than `viaCandidateId`'s in front.
   *
   * Reported, never acted on. The existence claim keeps the answer; this says
   * the two readings of the same facts part ways here, which is the material an
   * A/B needs and which silently preferring one of them would destroy.
   */
  readonly rankingDisagreesWithVia: boolean;
  /**
   * the run's PLANS (in × out, with the manoeuvre) in order of
   * preference. Additive and inert, like the ranking: not one field above is
   * derived from it.
   *
   * Empty when no plan could form — no inbound, or no outbound.
   */
  readonly plans: readonly RankedPlan[];
  /** How many plans were formed. `plans.length`, served so a reader need not count. */
  readonly planCount: number;
  /**
   * The best plan enters and leaves by the same anchor — i.e. it is one of the
   * pairs the engine already forms. False means the decoupled model proposes
   * something the current one cannot express.
   */
  readonly bestPlanIsSameGatePair: boolean;
  /**
   * The best plan is not the pair the conclusion retained.
   *
   * Reported, never acted on — the material the A/B needs, which silently
   * preferring one of the two readings would destroy.
   */
  readonly plansDisagreeWithVia: boolean;
  /**
   * LE PLAN RETENU, quand c'est le plan qui décide
   * (`projection.conclusion.mode: 'plans'`). Null en mode `pairs`, et null en
   * mode `plans` quand aucun plan n'a pu se former — la conclusion est alors
   * celle des paires, mot pour mot.
   *
   * Additif et nécessaire : une fois l'entrée et la sortie découplées, la
   * sortante ne nomme plus son entrante (`egressOf` n'apparie que la même
   * ancre), donc `viaCandidateId` seul ne suffit plus à dire la proposition.
   * Les deux jambes sont ici, et rien d'autre ne les porte.
   */
  readonly retainedPlan: RetainedPlan | null;
  /**
   * CE QUE LA RÈGLE D'HIER AURAIT RETENU : la paire de R0
   * (`concludePairs`) et son verdict, gardés même quand le plan décide.
   *
   * Servi dans les deux modes, et identique à `overall` / `viaCandidateId` en
   * mode `pairs`. C'est la trace sans laquelle l'onglet Itinéraires ne pourrait
   * plus écrire « hier : … » et l'A/B n'aurait plus de point de comparaison
   * dans le même run.
   */
  readonly r0Pair: R0Pair;
  /**
   * non nul seulement quand `reasonCodes` porte `no_leg_reaches_ring`
   * : le plancher et la meilleure portée mesurée qui expliquent le HUMAIN.
   * Additif et inerte, comme `ranking` et `plans` — rien ci-dessus n'en dépend.
   */
  readonly noLegReachesRing: NoLegReachesRingMotif | null;
  readonly policyVersion: string;
  /** Beyond this, the report rests on facts too old to stand behind. */
  readonly validUntil: string;
}
