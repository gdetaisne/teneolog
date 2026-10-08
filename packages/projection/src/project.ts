/**
 * S5 — the whole projection: one truck against the road facts.
 *
 * Pure and cheap by construction; asking about another truck re-runs THIS
 * and nothing upstream — the seam the architecture stands on, and the reason
 * "tester un camion plus gros" costs a replay instead of a re-analysis.
 *
 * The conclusion is an existence claim over PAIRS (in + its out via
 * `egressOf`): the address is served by an itinerary in and an itinerary
 * back, and feasibility at the stop belongs to the pairing — which is how an
 * on-site U-turn stays a measured, rejectable manoeuvre (BUG-001) instead of
 * a silently proposed route.
 */
import type {
  CandidateVerdict,
  NoLegReachesRingMotif,
  PointRef,
  PointVerdict,
  RouteCandidate,
  RunConclusion,
  TruckProfile,
  Verdict,
} from '@teneolog/domain';
import type { CollectedPoints } from '@teneolog/points';

import { evaluatePoint } from './evaluators.js';
import { harderReading, legsFromMeasured, type LegPointVerdicts } from './legs.js';
import { evaluateCandidateLegality } from './legal.js';
import { concludePairs, concludePlan, SEVERITY, type PairConclusionInput, type PairLegInput } from './pairs.js';
import { manoeuvreVerdict, rankPlans, UNKNOWN_STOP_SHAPE, type PlanStopShape } from './plans.js';
import { CONCLUSION_DEFAULTS, type ProjectionPolicy } from './policy.js';
import { rankPairs } from './ranking.js';

export interface ProjectionInput {
  readonly candidates: readonly RouteCandidate[];
  readonly collected: CollectedPoints;
  readonly truck: TruckProfile;
  readonly policy: ProjectionPolicy;
  readonly policyVersion: string;
  /** Facts older than this instant's derived shelf life are the caller's business. */
  readonly validUntil: string;
  /**
   * S3 reported `some_gate_routes_failed` on the candidates fact.
   * Optional: an unpaired leg carries the same information structurally.
   */
  readonly routerFailed?: boolean;
  /**
   * the shape of the street at the stop, for the manoeuvre between a
   * plan's two legs. Optional: without it the plans are still formed, on the
   * headings alone, and every U-turn is `unknown` — which is what a caller who
   * did not say knows.
   */
  readonly stopShape?: PlanStopShape;
  /**
   * set only by a caller projecting an empty `candidates` array
   * BECAUSE no R0 anchor and no discovered leg reaches `gates.minReachM`
   * (`detectNoLegReachesRing`). Reaches `concludePairs` untouched; ignored
   * whenever `candidates` is non-empty or the router is at fault.
   */
  readonly noRouteMotif?: NoLegReachesRingMotif | null;
}

export interface Projection {
  readonly pointVerdicts: readonly PointVerdict[];
  readonly candidateVerdicts: readonly CandidateVerdict[];
  readonly conclusion: RunConclusion;
}

export function projectTruck(input: ProjectionInput): Projection {
  const perLeg = verdictsPerLeg(input);
  const byRef = worstPerPlace(input, perLeg);

  const candidateVerdicts: CandidateVerdict[] = [];
  for (const candidate of input.candidates) {
    const legality = evaluateCandidateLegality(candidate, input.truck, input.policy);
    if (legality.verdict === 'NO') {
      candidateVerdicts.push(legality);
      continue;
    }
    // Legality passed (OK or HUMAN): the candidate is at least as bad as its
    // legality verdict, and at least as bad as its worst point — AS THIS LEG
    // DRIVES IT. Reading the shared verdict instead made a leg answer for a
    // manoeuvre it never performs (Thairé).
    // Starting from legality.verdict (not 'OK') ensures a HUMAN legality
    // (e.g. corridor_empty) cannot be overridden to OK by an absence of points.
    let worst: Verdict = legality.verdict;
    const reasons = [...legality.reasonCodes];
    for (const pv of perLeg.get(candidate.id)?.values() ?? []) {
      if (SEVERITY[pv.verdict] > SEVERITY[worst]) worst = pv.verdict;
    }
    candidateVerdicts.push({ ...legality, verdict: worst, reasonCodes: reasons });
  }

  return {
    pointVerdicts: [...byRef.values()],
    candidateVerdicts,
    conclusion: concludeOverPairs(input, byRef, candidateVerdicts, perLeg),
  };
}

/**
 * ONE EVALUATION PER (LEG, PLACE) — the seam opened.
 *
 * A point's identity is shared between the legs that reach it; its GEOMETRY is
 * not. The corner of Exemple and Voisine 23 (Thairé) is a 57° swing out of a
 * 3,0 m street on the grey leg and a 98° swing out of a 5,2 m one on the blue:
 * same place, same reference, two manoeuvres. Judging the first finder's
 * measurement for everyone hid the blue leg's real difficulty and lent the grey
 * leg a doubt it never drives.
 *
 * Falls back to `points[]` when a leg carries a ref with no geometry of its own
 * — an older snapshot, a hand-built fixture — rather than dropping the point:
 * a missing measurement is not an absent difficulty.
 */
function verdictsPerLeg(input: ProjectionInput): LegPointVerdicts {
  const pointByRef = new Map(input.collected.points.map((point) => [point.ref, point]));
  const out = new Map<string, Map<PointRef, PointVerdict>>();
  for (const candidate of input.candidates) {
    const geometries = input.collected.geometryByCandidate.get(candidate.id);
    const verdicts = new Map<PointRef, PointVerdict>();
    for (const ref of input.collected.byCandidate.get(candidate.id) ?? []) {
      const point = pointByRef.get(ref);
      if (point === undefined) continue;
      const geometry = geometries?.get(ref) ?? point.geometry;
      const evaluation = evaluatePoint({ ...point, geometry }, input.truck, input.policy);
      verdicts.set(ref, verdictOf(ref, input.truck.id, candidate.id, evaluation));
    }
    out.set(candidate.id, verdicts);
  }
  return out;
}

function verdictOf(
  pointRef: PointRef,
  profileId: string,
  candidateId: string | null,
  evaluation: ReturnType<typeof evaluatePoint>,
): PointVerdict {
  return {
    pointRef,
    profileId,
    candidateId,
    verdict: evaluation.verdict,
    marginM: evaluation.marginM,
    reasonCodes: evaluation.reasonCodes,
    derivedFrom: evaluation.derivedFrom,
    explanation: evaluation.explanation,
  };
}

/**
 * THE PLACE, AT ITS HARDEST — one verdict per reference, for everything that
 * asks about a place rather than about a leg: the review deck, `/explain`, the
 * ranking, the run snapshot.
 *
 * The worst reading over the legs that drive it, never the first one. The
 * question the operator answers is keyed by place (`judgementKey` = leg role +
 * place), so it must be asked as soon as ANY leg needs it asked; and taking the
 * worst is what makes the answer independent of the order S3 happened to list
 * the candidates in.
 */
function worstPerPlace(
  input: ProjectionInput,
  perLeg: LegPointVerdicts,
): Map<PointRef, PointVerdict> {
  const hardest = new Map<PointRef, PointVerdict>();
  for (const verdicts of perLeg.values()) {
    for (const [ref, pv] of verdicts) {
      const held = hardest.get(ref);
      if (held === undefined || harderReading(pv, held)) hardest.set(ref, pv);
    }
  }
  // Emitted in the order of `points[]`, which is the order every reader had
  // before — and a point NO leg carries (the trunk of phase 2 projects points
  // with no candidates at all) is still measured, on its own geometry.
  const byRef = new Map<PointRef, PointVerdict>();
  for (const point of input.collected.points) {
    const worst = hardest.get(point.ref);
    byRef.set(
      point.ref,
      worst === undefined
        ? verdictOf(point.ref, input.truck.id, null, evaluatePoint(point, input.truck, input.policy))
        : { ...worst, candidateId: null },
    );
  }
  return byRef;
}

/**
 * LES VERDICTS PAR JAMBE, À PLAT — ce que `verdictsPerLeg` a mesuré, publié tel
 * quel pour que personne n'ait à le recalculer (principe 24).
 *
 * Les jambes dans l'ordre des candidats (celui de S3, donc l'azimut des ancres)
 * et, dans chacune, les lieux dans l'ordre du relevé : le même ordre que
 * `pointVerdicts`, pour que deux lectures d'un même run se comparent ligne à
 * ligne. Chaque entrée porte son `candidateId` — c'est ce qui la distingue du
 * résumé par lieu, où il est nul.
 */
function legVerdictsOf(
  input: ProjectionInput,
  perLeg: LegPointVerdicts,
): readonly PointVerdict[] {
  const out: PointVerdict[] = [];
  for (const candidate of input.candidates) {
    const own = perLeg.get(candidate.id);
    if (own === undefined) continue;
    for (const point of input.collected.points) {
      const verdict = own.get(point.ref);
      if (verdict !== undefined) out.push(verdict);
    }
  }
  return out;
}

/**
 * LA CONCLUSION — deux règles, une seule à la fois.
 *
 * `mode: 'pairs'` — celle d'hier, et elle n'a pas bougé d'un bit :
 * `concludePairs` sur les paires de R0 (une entrante et la sortante de la même
 * ancre), `viaCandidateId` nomme la sortante gagnante, `decidedBy` le point qui
 * a fixé le verdict de la paire quand un point l'a fixé.
 *
 * `mode: 'plans'` — le MEILLEUR PLAN décide. Les paires d'hier sont des plans
 * (même ancre), le classement met le verdict en premier, donc le verdict retenu
 * ne peut que rester ou s'améliorer : c'est la garantie que l'A/B mesure sur le
 * corpus et qu'un test d'invariant tient sur les fixtures.
 *
 * Trois choses ne changent pas d'un mode à l'autre, et c'est délibéré :
 *
 *  - `viaCandidateId` reste LA SORTANTE. Le fil, `/explain`, le critère d'arrêt
 *    et `verify-s5` le lisent tous comme « l'itinéraire par lequel la réponse
 *    est rendue », et `pairIdOf` en tire une ancre ; en faire l'entrante
 *    casserait les six lecteurs pour ne rien gagner. L'entrante retenue, elle,
 *    n'était déductible d'aucun champ une fois les ancres découplées — c'est
 *    exactement ce que `retainedPlan` apporte.
 *  - `r0Pair` porte ce que la règle d'hier aurait retenu, dans les deux modes.
 *  - `ranking`, `plans`, `planCount`, `bestPlanIsSameGatePair` et
 *    `plansDisagreeWithVia` gardent leur sens : ils comparent les deux lectures
 *    à la paire de R0, pas à la conclusion. En mode `pairs` le calcul est
 *    littéralement celui d'avant ; en mode `plans` il reste lisible, ce que
 *    « le meilleur plan est-il le meilleur plan ? » n'aurait pas été.
 */
function concludeOverPairs(
  input: ProjectionInput,
  byRef: ReadonlyMap<PointRef, PointVerdict>,
  candidateVerdicts: readonly CandidateVerdict[],
  perLeg: LegPointVerdicts,
): RunConclusion {
  const pointVerdicts = [...byRef.values()];
  //, second volet — LA CONCLUSION ET LE CLASSEMENT LISENT LA MÊME
  // CHOSE : le point tel que CETTE jambe le conduit. Le classement
  // lisait encore le pire de la place ; au coin partagé de Thairé, cela
  // égalisait le plan qui passe et celui qui ne passe pas sur les deux premiers
  // critères du principe 28, et laissait la marge puis la distance désigner le
  // plan RETENU. Une seule lecture, `legPointVerdictReader` (`legs.ts`).
  const ranked = { pointVerdicts, candidateVerdicts, perLeg };
  const legs = legsFromMeasured(
    input.candidates,
    input.collected,
    candidateVerdicts,
    pointVerdicts,
    perLeg,
  );

  const concluded = concludePairs(pairConclusionInputOf(legs, input));
  const r0ViaCandidateId = concluded.bestPair?.outId ?? null;
  const ranking = rankPairs(input.candidates, input.collected, ranked);

  // les plans, sur les mêmes jambes. Formés dans les deux modes : ils
  // sont la matière de l'onglet Itinéraires et de l'A/B, que la conclusion les
  // suive ou non.
  const plans = rankPlans({
    candidates: input.candidates,
    collected: input.collected,
    projection: ranked,
    truck: input.truck,
    policy: input.policy,
    stop: input.stopShape ?? UNKNOWN_STOP_SHAPE,
  });
  const best = plans[0] ?? null;
  const r0InboundId =
    input.candidates.find((candidate) => candidate.id === r0ViaCandidateId)?.egressOf?.inboundId ??
    null;

  // qui décide. En mode `plans`, si aucun plan ne s'est formé, la
  // conclusion est celle des paires : « pas de plan » n'est pas une réponse, et
  // `concludePairs` en a déjà une (HUMAIN, `no_viable_pair` ou
  // `router_unavailable`).
  const mode = (input.policy.conclusion ?? CONCLUSION_DEFAULTS).mode;
  const planConclusion =
    mode === 'plans' && best !== null
      ? concludePlan({
          legs,
          inboundId: best.inboundId,
          outboundId: best.outboundId,
          manoeuvreVerdict: manoeuvreVerdict(best.manoeuvreFeasible),
        })
      : null;
  const retained = planConclusion ?? concluded;
  const retainedPlan =
    planConclusion === null || best === null
      ? null
      : {
          inboundId: best.inboundId,
          outboundId: best.outboundId,
          sameGate: best.sameGate,
          manoeuvre: best.manoeuvre,
          rank: best.rank,
        };

  return {
    profileId: input.truck.id,
    overall: retained.overall,
    pointVerdicts,
    legVerdicts: legVerdictsOf(input, perLeg),
    candidateVerdicts: [...candidateVerdicts],
    decidedBy: retained.bestPair?.decidedBy ?? null,
    viaCandidateId: retained.bestPair?.outId ?? null,
    retainedPointRefs: retained.retainedPointRefs,
    reasonCodes: retained.reasonCodes,
    ranking,
    // No pair retained and no ranking to speak of is not a disagreement: there
    // is nothing for the two readings to disagree about.
    rankingDisagreesWithVia:
      r0ViaCandidateId !== null &&
      ranking.length > 0 &&
      ranking[0]?.outboundId !== r0ViaCandidateId,
    plans,
    planCount: plans.length,
    bestPlanIsSameGatePair: best?.sameGate === true,
    // The disagreement is over the WHOLE proposal: a plan that keeps the
    // retained outbound but enters by another anchor is already something the
    // pairs cannot express.
    plansDisagreeWithVia:
      r0ViaCandidateId !== null &&
      best !== null &&
      (best.outboundId !== r0ViaCandidateId || best.inboundId !== r0InboundId),
    retainedPlan,
    r0Pair: { viaCandidateId: r0ViaCandidateId, overall: concluded.overall },
    // le motif, quand c'est lui qui a dit HUMAIN. `retained` est
    // `planConclusion` ou `concluded` : les deux le portent, jamais nul que
    // par `concludePairs`/`concludePlan` eux-mêmes.
    noLegReachesRing: retained.noLegReachesRing,
    policyVersion: input.policyVersion,
    validUntil: input.validUntil,
  };
}

/**
 * `PairConclusionInput`, avec ses deux champs optionnels posés seulement
 * quand l'appelant les a dits — `concludePairs` distingue « non fourni » de
 * « faux »/« nul », donc un spread inconditionnel les écraserait.
 */
function pairConclusionInputOf(
  legs: readonly PairLegInput[],
  input: ProjectionInput,
): PairConclusionInput {
  return {
    legs,
    ...(input.routerFailed === undefined ? {} : { routerFailed: input.routerFailed }),
    ...(input.noRouteMotif === undefined ? {} : { noRouteMotif: input.noRouteMotif }),
  };
}
