/**
 * The one rule that turns legs into an answer.
 *
 * A leg is as bad as its worst point, a pair as bad as its worse leg, the run
 * as good as its best pair. S5 applies it to measured verdicts; the beta wire
 * applies it again to verdicts corrected by human judgements. Two copies of
 * the rule drifted apart once (divergent reason codes, no shared test), so
 * the rule lives here and both callers hand it their legs.
 *
 * The caller joins points to legs because a judgement is scoped to a LEG (the
 * same corner reviewed on arrival does not answer for the departure
 * manoeuvre) — a map keyed by point ref alone could not carry that.
 *
 * A missing pair is never a refusal. In S3 an outbound always names
 * its inbound, so an unpaired leg means the router did not return the other
 * leg — a provider fault, i.e. an unknown fact — and the verdict is HUMAN
 * with `router_unavailable`. Only a measured fact (a legal band, a point) can
 * produce NO.
 */
import type { NoLegReachesRingMotif, PointRef, Verdict } from '@teneolog/domain';

export interface PairLegInput {
  readonly id: string;
  /** The inbound this outbound continues (`egressOf.inboundId`); null on inbound legs. */
  readonly inboundId: string | null;
  /** The leg's own verdict before its points: legality in S5, "blocked or not" on replay. */
  readonly verdict: Verdict;
  /** The segment that eliminated the leg, when a legal or dimensional limit did. */
  readonly blockedAtSegmentId: string | null;
  /** The points along the leg, each with the verdict the caller stands behind. */
  readonly points: readonly PairPointInput[];
}

export interface PairPointInput {
  readonly ref: PointRef;
  readonly verdict: Verdict;
}

export interface PairConclusionInput {
  readonly legs: readonly PairLegInput[];
  /**
   * S3 lost at least one leg to the router (`some_gate_routes_failed` on the
   * candidates fact). Optional: an unpaired leg already says the same thing.
   */
  readonly routerFailed?: boolean;
  /**
   * set only by the caller that already knows `legs` is empty
   * BECAUSE no R0 anchor and no discovered leg reaches `gates.minReachM`
   * (`detectNoLegReachesRing`). Optional and inert on every other input: with
   * `legs` non-empty, or with a router failure, it is never read.
   */
  readonly noRouteMotif?: NoLegReachesRingMotif | null;
}

export interface RetainedPair {
  readonly outId: string;
  readonly inboundId: string;
  readonly verdict: Verdict;
  /** The point that set the pair's verdict, when a point did (not a legal block). */
  readonly decidedBy: PointRef | null;
  readonly blockedAtSegmentId: string | null;
}

export interface PairConclusion {
  readonly overall: Verdict;
  readonly bestPair: RetainedPair | null;
  readonly reasonCodes: readonly string[];
  /** See `RunConclusion.retainedPointRefs`. */
  readonly retainedPointRefs: readonly PointRef[];
  /** See `RunConclusion.noLegReachesRing`. Null unless `reasonCodes` carries `no_leg_reaches_ring`. */
  readonly noLegReachesRing: NoLegReachesRingMotif | null;
}

export const SEVERITY: Readonly<Record<Verdict, number>> = { OK: 0, HUMAN: 1, NO: 2 };

export interface FoldedLeg {
  readonly leg: PairLegInput;
  readonly verdict: Verdict;
  /** Worst point on the leg; first one wins a tie. */
  readonly worstPoint: PairPointInput | null;
}

/** The pairs of a run, and the folded legs they were made of. */
export interface PairFormation {
  /** In the order the legs arrived — S3's order, which is azimuth order. */
  readonly pairs: readonly RetainedPair[];
  readonly folded: ReadonlyMap<string, FoldedLeg>;
}

/**
 * Which legs make a pair, and what verdict the pair carries.
 *
 * Exported because the ranking must rank THE pairs the conclusion
 * concluded over, not a second set that merely looks like them. A pair formed
 * twice is a pair that can be formed differently twice.
 */
export function formPairs(legs: readonly PairLegInput[]): PairFormation {
  const folded = new Map<string, FoldedLeg>(legs.map((leg) => [leg.id, foldLeg(leg)]));

  const pairs: RetainedPair[] = [];
  for (const leg of legs) {
    if (leg.inboundId === null) continue;
    const inbound = folded.get(leg.inboundId);
    const outbound = folded.get(leg.id);
    if (inbound === undefined || outbound === undefined) continue;

    // Inbound wins a tie: arriving is what the address is asked about.
    const dominant = SEVERITY[inbound.verdict] >= SEVERITY[outbound.verdict] ? inbound : outbound;
    const decidedBy =
      dominant.leg.blockedAtSegmentId === null &&
      dominant.worstPoint !== null &&
      SEVERITY[dominant.worstPoint.verdict] === SEVERITY[dominant.verdict]
        ? dominant.worstPoint.ref
        : null;
    pairs.push({
      outId: leg.id,
      inboundId: leg.inboundId,
      verdict: dominant.verdict,
      decidedBy,
      blockedAtSegmentId: dominant.leg.blockedAtSegmentId,
    });
  }

  return { pairs, folded };
}

export function concludePairs(input: PairConclusionInput): PairConclusion {
  const { pairs, folded } = formPairs(input.legs);

  const best = pairs.reduce<RetainedPair | null>(
    (held, pair) => (held === null || SEVERITY[pair.verdict] < SEVERITY[held.verdict] ? pair : held),
    null,
  );

  if (best === null) {
    // No pair. Not one fact was measured against this address as a whole, so
    // the answer is unknown — and the cause is named when a leg says it.
    const routerFailed = input.routerFailed === true || hasUnpairedLeg(input.legs, folded);
    const empty = emptySetReason(routerFailed, input.noRouteMotif ?? null);
    return {
      overall: 'HUMAN',
      bestPair: null,
      reasonCodes: [empty.code],
      retainedPointRefs: uniqueRefs(
        input.legs.filter((leg) => folded.get(leg.id)?.verdict === 'HUMAN').flatMap((leg) => leg.points),
      ),
      noLegReachesRing: empty.motif,
    };
  }

  const inboundLeg = folded.get(best.inboundId)?.leg;
  const outboundLeg = folded.get(best.outId)?.leg;
  return {
    overall: best.verdict,
    bestPair: best,
    reasonCodes: best.verdict === 'NO' && best.blockedAtSegmentId !== null ? ['best_pair_legally_blocked'] : [],
    retainedPointRefs: uniqueRefs([...(inboundLeg?.points ?? []), ...(outboundLeg?.points ?? [])]),
    noLegReachesRing: null,
  };
}

/**
 * la même règle, sur un PLAN : une entrante, une sortante, et la
 * manœuvre à l'arrêt.
 *
 * Écrite ici, contre `concludePairs`, et non dans `project.ts` : c'est la même
 * phrase — « une jambe vaut son pire point, la proposition vaut sa pire jambe »
 * — avec un troisième terme. Deux endroits, et la conclusion par plan finirait
 * par plier ses jambes autrement que la conclusion par paire, sans que rien ne
 * le dise.
 *
 * Le troisième terme est le verdict que `rankPlans` a donné à la manœuvre, pas
 * une seconde lecture du retournement : sur une impasse, la manœuvre et le
 * point TURNAROUND rendent déjà le même verdict, et le point est sur
 * les deux jambes — il est donc compté par les jambes. Le terme ne pèse
 * vraiment que sur une rue traversante, où aucun point TURNAROUND n'existe et
 * où un demi-tour non établi est une question que personne d'autre ne pose.
 *
 * Rend `null` quand une des deux jambes ne porte pas de verdict : l'appelant
 * retombe alors sur les paires, plutôt que de conclure sur une moitié de plan.
 */
export function concludePlan(input: PlanConclusionInput): PairConclusion | null {
  const folded = new Map<string, FoldedLeg>(input.legs.map((leg) => [leg.id, foldLeg(leg)]));
  const inbound = folded.get(input.inboundId);
  const outbound = folded.get(input.outboundId);
  if (inbound === undefined || outbound === undefined) return null;

  // Comme pour une paire : l'entrante l'emporte à égalité — c'est l'arrivée
  // que l'adresse fait poser comme question.
  const dominant = SEVERITY[inbound.verdict] >= SEVERITY[outbound.verdict] ? inbound : outbound;
  const manoeuvreDecides = SEVERITY[input.manoeuvreVerdict] > SEVERITY[dominant.verdict];
  const overall = manoeuvreDecides ? input.manoeuvreVerdict : dominant.verdict;

  // Quand c'est la manœuvre qui a décidé, aucun LIEU n'a décidé : `decidedBy`
  // reste nul et le motif le nomme, plutôt que de désigner un point qui n'y
  // est pour rien.
  const blockedAtSegmentId = manoeuvreDecides ? null : dominant.leg.blockedAtSegmentId;
  const decidedBy =
    !manoeuvreDecides &&
    dominant.leg.blockedAtSegmentId === null &&
    dominant.worstPoint !== null &&
    SEVERITY[dominant.worstPoint.verdict] === SEVERITY[dominant.verdict]
      ? dominant.worstPoint.ref
      : null;

  const reasonCodes = manoeuvreDecides
    ? [input.manoeuvreVerdict === 'NO' ? 'retained_plan_uturn_refused' : 'retained_plan_uturn_unproven']
    : overall === 'NO' && blockedAtSegmentId !== null
      ? ['best_pair_legally_blocked']
      : [];

  return {
    overall,
    bestPair: {
      outId: outbound.leg.id,
      inboundId: inbound.leg.id,
      verdict: overall,
      decidedBy,
      blockedAtSegmentId,
    },
    reasonCodes,
    // Les points des deux jambes, comptés une fois — l'arrêt (DESTINATION,
    // TURNAROUND) y est déjà : `collectCriticalPoints` l'accroche à CHAQUE
    // candidat.
    retainedPointRefs: uniqueRefs([...inbound.leg.points, ...outbound.leg.points]),
    // Un plan s'est formé : ce garde-fou ne parle que de son absence.
    noLegReachesRing: null,
  };
}

export interface PlanConclusionInput {
  readonly legs: readonly PairLegInput[];
  readonly inboundId: string;
  readonly outboundId: string;
  /** Le verdict de la manœuvre à l'arrêt, tel que `rankPlans` l'a jugée. */
  readonly manoeuvreVerdict: Verdict;
}

function foldLeg(leg: PairLegInput): FoldedLeg {
  let verdict: Verdict = leg.verdict;
  let worstPoint: PairPointInput | null = null;
  for (const point of leg.points) {
    if (worstPoint === null || SEVERITY[point.verdict] > SEVERITY[worstPoint.verdict]) worstPoint = point;
    if (SEVERITY[point.verdict] > SEVERITY[verdict]) verdict = point.verdict;
  }
  return { leg, verdict, worstPoint };
}

/** An outbound whose inbound is missing, or an inbound no outbound continues. */
function hasUnpairedLeg(legs: readonly PairLegInput[], folded: ReadonlyMap<string, FoldedLeg>): boolean {
  const continued = new Set(legs.map((leg) => leg.inboundId).filter((id): id is string => id !== null));
  return legs.some((leg) =>
    leg.inboundId === null ? !continued.has(leg.id) : !folded.has(leg.inboundId),
  );
}

function uniqueRefs(points: readonly PairPointInput[]): readonly PointRef[] {
  return [...new Set(points.map((point) => point.ref))];
}

/**
 * pourquoi un ensemble vide de paires n'est pas une réponse.
 *
 * Un routeur en échec l'emporte toujours : c'est une panne du fournisseur,
 * pas une absence mesurée, et `router_unavailable` le dit déjà. Sinon, un
 * motif de portée fourni par l'appelant (`detectNoLegReachesRing`) précise
 * `no_viable_pair` en `no_leg_reaches_ring` ; sans motif, rien ne change.
 */
function emptySetReason(
  routerFailed: boolean,
  noRouteMotif: NoLegReachesRingMotif | null,
): { readonly code: string; readonly motif: NoLegReachesRingMotif | null } {
  if (routerFailed) return { code: 'router_unavailable', motif: null };
  if (noRouteMotif !== null) return { code: 'no_leg_reaches_ring', motif: noRouteMotif };
  return { code: 'no_viable_pair', motif: null };
}
