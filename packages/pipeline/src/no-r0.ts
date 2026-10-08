/**
 * LE RUN SANS ANCRE R0 — constat L5-1 de l'audit du 2026-09-18.
 *
 * `continueFromFacts` sortait ici, avant la promotion, dès que
 * `candidates.known` était faux (`gates.length === 0` : aucune ancre R0). La
 * découverte, elle, avait tourné : sur un bourg où aucun secteur ne contient de
 * sommet structurant, l'origine du rayon est posée SUR le cercle
 * (`discovery.radiusM`), donc `approachReachM ≈ 2 000 ≥ minReachM` et la jambe
 * est gardée — avec 36 rayons, presque toujours. Le moteur avait donc en main
 * des jambes routées de 2 km dans plusieurs directions, et les jetait ; et le
 * garde-fou censé parler à leur place se taisait précisément parce qu'elles
 * existaient (`projection/no-route.ts` : `if (legsKept > 0) return null`).
 * L'opérateur voyait « Carte indisponible » puis « Aucun détail technique » :
 * ni conclusion, ni CTA, ni raison.
 *
 * DEUX RÈGLES, ET ELLES SE LISENT DANS CET ORDRE :
 *
 *  1. **les jambes découvertes qui atteignent le cercle sont promues et
 *     jugées, même sans ancre R0.** C'est exactement le geste de la branche
 *     normale (`promoteDiscoveredLegs`), qui ne dépend ni de R0 ni des
 *     candidats : elle lit les approches, le voisinage et le port corridor.
 *     Une jambe promue porte `egressOf: null`, et les plans apparient
 * n'importe quelle entrante avec n'importe quelle sortante —
 *     rien à inventer.
 *  2. **s'il ne reste vraiment rien, la conclusion porte un motif.** Jamais
 *     `projection: null`, qui devenait `reasonCodes: []` sur le fil
 *     (`compat-wire.ts`) à côté d'`itineraries: []`. La conclusion est celle
 *     que `concludePairs` rend déjà pour un ensemble vide (principe 23) :
 *     `no_leg_reaches_ring` avec son motif quand aucune voie n'atteint le
 *     cercle, `router_unavailable` quand le routeur a perdu les jambes,
 *     `no_viable_pair` sinon — et `summariseConclusion` a une phrase pour les
 *     trois. Un inconnu n'est jamais un refus (principe 5), mais il se dit.
 *
 * Sorti de `full.ts` (gelé, principe 26 : `continueFromFacts` est déjà à sa
 * borne de 200 lignes) avec `searchWithoutR0`, qui n'a que cette branche pour
 * appelant.
 */
import type { Discovery, Fact, GateSearch, RouteCandidate, Turnaround, TruckProfile } from '@teneolog/domain';
import { collectCriticalPoints } from '@teneolog/points';
import { projectTruck } from '@teneolog/projection';
import { summariseConclusion } from '@teneolog/report';
import type { CorridorPort, DiscoveryDraft } from '@teneolog/routes';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import type { S0S2Facts } from './analyse.js';
import { sealDiscovery } from './discovery-seal.js';
import { stopPointsInputOf } from './stop-points-input.js';
import type { DiscoveryCoverage, FullAnalysis, FullParams } from './full.js';
import { noCandidateProjection, noRouteAnalysisFieldsOf, validUntilFrom } from './no-route.js';
import type { Phase2Params } from './phase2.js';
import { EMPTY_PROMOTION, promoteDiscoveredLegs } from './promotion.js';

/** Ce que la branche « aucune ancre R0 » a besoin de savoir du run en cours. */
export interface NoR0Input {
  readonly facts: S0S2Facts;
  readonly truck: TruckProfile;
  readonly params: FullParams;
  readonly phase2: Phase2Params;
  /** La raison pour laquelle R0 n'a rendu aucun candidat — `no_data` ou `provider_error`. */
  readonly candidates: Fact<readonly RouteCandidate[]>;
  readonly gateSearch: GateSearch;
  readonly discovered: DiscoveryDraft | null;
  readonly obviousStop: boolean;
  readonly neighbourhood: RoadNeighbourhood;
  readonly corridor: CorridorPort;
  readonly stopTurnaround: Fact<Turnaround>;
  readonly fetchedAt: string;
}

/** Tout ce que la branche produit, sauf le compte rendu de phase 2 (scellé par l'appelant). */
export type NoR0Analysis = Omit<FullAnalysis, 'phase2'>;

export async function analyseWithoutR0(input: NoR0Input): Promise<NoR0Analysis> {
  const coverage = input.discovered === null ? null : coverageWithoutR0(input.discovered);
  const gateSearch = searchWithoutR0(input.gateSearch, input.discovered, coverage, input.obviousStop);

  const promoted =
    coverage === null || input.params.discovery.feedsCandidates !== true
      ? EMPTY_PROMOTION
      : await promoteDiscoveredLegs(
          coverage,
          input.neighbourhood,
          input.corridor,
          input.params,
          input.phase2,
          input.fetchedAt,
        );

  if (promoted.candidates.length === 0) return withoutAnyLeg(input, gateSearch);
  return judgePromoted(input, gateSearch, promoted.candidates, promoted.corridors);
}

/**
 * Les jambes promues, jugées comme n'importe quelle jambe de production.
 *
 * `candidates` redevient un fait CONNU — il l'est : ce sont des itinéraires
 * routés, avec leur corridor. Sa provenance le dit (`discovered-legs`) et
 * `no_r0_candidates` reste dans ses codes, pour que personne ne prenne ce run
 * pour un run de R0.
 */
function judgePromoted(
  input: NoR0Input,
  gateSearch: GateSearch,
  candidates: readonly RouteCandidate[],
  corridors: ReadonlyMap<string, readonly RoadWay[]>,
): NoR0Analysis {
  const { facts, truck, params, fetchedAt } = input;
  const collected = collectCriticalPoints(
    { candidates, corridors: new Map(corridors), ...stopPointsInputOf(facts, fetchedAt) },
    params.points,
  );
  const projection = projectTruck({
    candidates,
    collected,
    truck,
    policy: params.projection,
    policyVersion: params.policyVersion,
    validUntil: validUntilFrom(fetchedAt, params.reportShelfLifeDays),
    // Aucune jambe de R0 à perdre : ce qui a échoué est l'ANCRAGE, pas le
    // routeur, et `candidates.why` le dit plus haut.
    routerFailed: false,
    stopShape: {
      kind: facts.topology.topology.kind,
      turnaround: input.stopTurnaround,
      provenTopology: facts.topology.terminalNodeInterior,
    },
  });
  return {
    facts,
    candidates: {
      known: true,
      value: candidates,
      provenance: { source: 'osrm', method: 'discovered-legs', fetchedAt },
      reliability: { confidence: 1, basis: 'derived', reasonCodes: ['no_r0_candidates'] },
    },
    collected,
    projection,
    summary: summariseConclusion(projection.conclusion, truck.label),
    gateSearch,
  };
}

/** Rien n'a survécu : la conclusion le dit, avec son motif (règle 2 ci-dessus). */
function withoutAnyLeg(input: NoR0Input, gateSearch: GateSearch): NoR0Analysis {
  const noRoute = noCandidateProjection(
    gateSearch,
    input.candidates,
    input.facts,
    input.truck,
    input.params,
    input.fetchedAt,
  );
  return {
    facts: input.facts,
    candidates: input.candidates,
    ...noRouteAnalysisFieldsOf(noRoute, input.truck.label),
    gateSearch,
  };
}

/**
 * CE QUE R0 COUVRE QUAND R0 N'A RIEN PRODUIT : rien, et c'est écrit une fois.
 *
 * `coverApproaches` n'est pas appelée — il n'y a aucun candidat à comparer, et
 * la faire tourner sur une liste vide rendrait exactement cet objet. La même
 * valeur servait déjà, recopiée, dans `searchWithoutR0` ; elle sert maintenant
 * aussi à la promotion, et une seule écriture garantit que le relevé publié et
 * les jambes promues parlent du même ensemble (principe 23).
 */
function coverageWithoutR0(draft: DiscoveryDraft): DiscoveryCoverage {
  return {
    approaches: draft.approaches.map((approach) => ({ ...approach, coveredByCandidateId: null })),
    approachesOut: draft.approachesOut.map((approach) => ({ ...approach, coveredByCandidateId: null })),
    coverage: {
      approachesTotal: draft.approaches.length,
      coveredByR0: 0,
      r0CandidatesUncovered: [],
    },
    approachOfCandidate: new Map(),
  };
}

/**
 * Le `gateSearch` scellé quand R0 n'a produit aucun candidat : la découverte a
 * quand même tourné, et ce qu'elle a trouvé est précisément ce que la règle
 * actuelle n'a pas su produire.
 *
 * Le critère d'arrêt reste évalué « sur R0 » et insatisfait, motif
 * `no_r0_candidates` : c'est un contrefactuel sur la règle d'hier, et la
 * promotion ne le rend pas vrai.
 */
function searchWithoutR0(
  gateSearch: GateSearch,
  discovered: DiscoveryDraft | null,
  coverage: DiscoveryCoverage | null,
  obviousStop: boolean,
): GateSearch {
  if (discovered === null || coverage === null) return gateSearch;
  return {
    ...gateSearch,
    discovery: sealDiscovery(discovered, {
      approaches: coverage.approaches,
      approachesOut: coverage.approachesOut,
      coverage: coverage.coverage,
      stopCriterion: {
        evaluatedOn: 'R0' as const,
        satisfied: false,
        atRound: obviousStop ? 0 : null,
        reasons: ['no_r0_candidates'],
      },
      obviousStop,
    }) satisfies Discovery,
  };
}
