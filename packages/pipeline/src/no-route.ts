/**
 * le garde-fou de portée, côté pipeline. Élargi 
 * (constat L5-1) à TOUT run sans candidat.
 *
 * `continueFromFacts` s'arrête avant `projectTruck` dès que `candidates.known`
 * est faux (`gates.length === 0` : aucune ancre R0) — et jusqu'ici la
 * conclusion restait `null`, `reasonCodes` vide, l'écran muet
 * (la note de conception interne).
 *
 * Cette fonction construit EXACTEMENT ce qu'un run à zéro candidat produirait
 * — `collectCriticalPoints` puis `projectTruck` sur `candidates: []`, le même
 * chemin que `concludePairs` connaît déjà (principe 23, une seule source pour
 * « pas de paire »).
 *
 * ELLE REND TOUJOURS UNE CONCLUSION. Elle rendait `null` dès que
 * `detectNoLegReachesRing` ne trouvait pas de motif de portée — une ancre R0
 * retenue dont le corridor a échoué, un routeur en panne, une jambe découverte
 * gardée — et l'appelant reposait alors `projection: null`, que le fil traduit
 * en `reasonCodes: []` à côté d'`itineraries: []` : un écran sans conclusion,
 * sans CTA et sans raison. Le motif de portée reste ce qu'il était et n'est
 * PAS inventé : absent, `concludePairs` nomme la vraie cause
 * (`router_unavailable` si le routeur a perdu les jambes, `no_viable_pair`
 * sinon) et `summariseConclusion` a une phrase pour chacune.
 *
 * `collected` sort AVEC la projection (principe 14) : sans
 * lui, `conclusion.pointVerdicts` citait un DESTINATION (le seul point qu'un
 * run à zéro candidat mesure quand même, `collectCriticalPoints` → `stopPoints`)
 * que l'appelant ne pouvait pas montrer — `display.collected` était `null`,
 * donc `criticalPoints` (compat-wire.ts) et la section Points de `/explain`
 * (`analysis.collected?.points ?? []`) ne le portaient jamais : une citation
 * sans preuve à l'appui. Publier `collected` fait correspondre les deux.
 */
import type { Fact, GateSearch, RouteCandidate, TruckProfile } from '@teneolog/domain';
import { collectCriticalPoints, type CollectedPoints, type CollectPointsParams } from '@teneolog/points';
import {
  detectNoLegReachesRing,
  projectTruck,
  type Projection,
  type ProjectionPolicy,
} from '@teneolog/projection';
import { summariseConclusion, type ConclusionSummary } from '@teneolog/report';

import type { S0S2Facts } from './analyse.js';
import type { FullAnalysis } from './full.js';
import { stopPointsInputOf } from './stop-points-input.js';

/** Les seuls champs de `FullParams` dont ce garde-fou a besoin. */
export interface NoRoutePolicyParams {
  readonly points: CollectPointsParams;
  readonly projection: ProjectionPolicy;
  readonly policyVersion: string;
  readonly reportShelfLifeDays: number;
}

/**
 * La péremption d'un rapport, une seule fois (principe 23) : `fetchedAt` (ou
 * `now()` pour un rejeu) plus l'étagère de la policy, en jours. Écrite trois
 * fois avant ce correctif — ici, et deux fois dans `full.ts` (`continueFromFacts`
 * et `reprojectTruck`) — l'a signalé.
 */
export function validUntilFrom(fetchedAt: string, reportShelfLifeDays: number): string {
  return new Date(Date.parse(fetchedAt) + reportShelfLifeDays * 86_400_000).toISOString();
}

export interface NoRouteProjection {
  readonly projection: Projection;
  readonly collected: CollectedPoints;
}

export function noCandidateProjection(
  gateSearch: GateSearch,
  candidates: Fact<readonly RouteCandidate[]>,
  facts: S0S2Facts,
  truck: TruckProfile,
  params: NoRoutePolicyParams,
  fetchedAt: string,
): NoRouteProjection {
  const motif = detectNoLegReachesRing(gateSearch);

  const collected = collectCriticalPoints(
    { candidates: [], corridors: new Map(), ...stopPointsInputOf(facts, fetchedAt) },
    params.points,
  );

  const projection = projectTruck({
    candidates: [],
    collected,
    truck,
    policy: params.projection,
    policyVersion: params.policyVersion,
    validUntil: validUntilFrom(fetchedAt, params.reportShelfLifeDays),
    // le routeur, quand c'est lui : `buildRouteCandidatesWithCorridors`
    // pose `why: 'provider_error'` dès qu'une jambe a été perdue en route. Sans
    // cette lecture, un run que le routeur a vidé sortait `no_viable_pair` — une
    // absence mesurée — au lieu de `router_unavailable`, une panne.
    routerFailed: !candidates.known && candidates.why === 'provider_error',
    noRouteMotif: motif,
  });
  return { projection, collected };
}

/** Les trois champs que `noCandidateProjection` pose sur un `FullAnalysis`. */
export interface NoRouteAnalysisFields {
  readonly collected: CollectedPoints | null;
  readonly projection: Projection | null;
  readonly summary: ConclusionSummary | null;
}

/**
 * `collected`/`projection`/`summary`, ensemble — jamais l'un sans l'autre
 * (principe 14 : un `collected` nul pendant qu'une
 * conclusion cite un point est une donnée qui ment par omission). Sortie de
 * `full.ts` (gelé, principe 26) ET de `reprojectNoRouteTruck` ci-dessous,
 * qui partageaient la même branche `noRoute ? … : null` trois fois — les
 * deux seuls appelants de ce garde-fou.
 */
export function noRouteAnalysisFieldsOf(
  noRoute: NoRouteProjection | null,
  truckLabel: string,
): NoRouteAnalysisFields {
  return {
    collected: noRoute?.collected ?? null,
    projection: noRoute?.projection ?? null,
    summary: noRoute && summariseConclusion(noRoute.projection.conclusion, truckLabel),
  };
}

/**
 * Rejouer le garde-fou pour un autre camion (`reprojectTruck`, `full.ts`).
 *
 * Sans ancre R0, `collected` est nul par construction (S4 n'a jamais tourné) :
 * il n'y a rien à rejouer dans `projectTruck` comme pour un run à candidats
 * connus. Le motif ne dépend pas du camion — seuls `profileId`, le libellé et
 * `validUntil` changent (`gateSearch` est truck-agnostic à ce point, comme
 * `detectNoLegReachesRing` le lit) — donc reconstruire la même conclusion
 * pour CE camion suffit. Avant ce correctif, `reprojectTruck` rendait
 * `analysis` telle quelle : `byTruck` récitait trois fois la conclusion —
 * et le `profileId` — du premier camion analysé.
 */
export function reprojectNoRouteTruck(
  analysis: FullAnalysis,
  truck: TruckProfile,
  params: NoRoutePolicyParams,
  now: () => string,
): FullAnalysis {
  const noRoute =
    analysis.gateSearch === null
      ? null
      : noCandidateProjection(
          analysis.gateSearch,
          analysis.candidates,
          analysis.facts,
          truck,
          params,
          now(),
        );
  return { ...analysis, ...noRouteAnalysisFieldsOf(noRoute, truck.label) };
}
