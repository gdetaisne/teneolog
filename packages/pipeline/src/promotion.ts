/**
 * les approches que R0 n'a pas trouvées deviennent des candidats.
 *
 * Sorti de `full.ts` (principe 26 : un fichier gelé se découpe
 * quand la tâche du jour y touche — ici pour y faire entrer le réglage du
 * dédoublonnage). Déplacement pur : même code, mêmes appelants, même ordre.
 */
import type { RouteCandidate } from '@teneolog/domain';
import {
  candidateFromRoutedLeg,
  discoveredLegId,
  mapWithConcurrency,
  orderLegsByCertainty,
  type CorridorPort,
} from '@teneolog/routes';
import type { RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import type { DiscoveryCoverage, FullParams } from './full.js';
import type { Phase2Params } from './phase2.js';

export interface Promotion {
  readonly candidates: readonly RouteCandidate[];
  readonly corridors: ReadonlyMap<string, readonly RoadWay[]>;
}

export const EMPTY_PROMOTION: Promotion = { candidates: [], corridors: new Map() };

/**
 * les approches que R0 n'a pas trouvées, passées à S4 et S5.
 *
 * Décision produit, après l'A/B : « activer la découverte + les plans pour
 * le classement : Excellent ». Ce qui suit est la moitié « découverte » de
 * cette phrase — jusqu'ici, les 36 rayons servaient à COMPTER ce que la règle
 * actuelle ratait ; ils servent maintenant à s'en servir.
 *
 * Quatre choses, et rien d'autre :
 *
 *  - **rien n'est refait.** `candidateFromRoutedLeg` (`replay.ts`) est l'étape
 *    5 de `buildRouteCandidatesWithCorridors`, isolée : même annotation, même
 *    comptage de couverture, mêmes codes de corridor. Une jambe découverte est
 *    donc annotée par LE code de production, pas par une copie.
 *  - **aucune ancre n'est inventée.** `egressOf` reste nul : les plans
 *    apparient toute entrante avec toute sortante, et poser un `egressOf`
 *    ressusciterait la paire que §7.2 vient de défaire.
 * - **l'ordre est celui de la certitude** : les jambes les plus
 *    sûres partent en premier, dans la même fenêtre de concurrence que les
 *    corridors de R0 et sur le même cache de tuiles — qui est déjà chaud, car
 *    l'ancre par largeur vient de traverser le même terrain.
 *  - **un corridor muet coûte SA jambe, jamais le run.** Une approche est un
 *    supplément ; l'abandonner rend exactement le moteur d'avant.
 *
 * et pas de dédoublonnage ici : la découverte a déjà dédoublonné ses
 * approches (`sameApproach`, `discovery.ts`) et `coverApproaches` vient d'ôter
 * celles que R0 couvre. Une jambe promue ne porte donc AUCUNE des marques de
 * elles ne sont pas nulles, elles sont absentes, parce qu'elles n'ont
 * pas été mesurées sur elle (principe 14).
 */
export async function promoteDiscoveredLegs(
  covered: DiscoveryCoverage,
  neighbourhood: RoadNeighbourhood,
  corridor: CorridorPort,
  params: FullParams,
  phase2: Phase2Params,
  fetchedAt: string,
): Promise<Promotion> {
  const fresh = [...covered.approaches, ...covered.approachesOut].filter(
    (approach) => approach.coveredByCandidateId === null && approach.polyline.length >= 2,
  );
  if (fresh.length === 0) return EMPTY_PROMOTION;

  const byId = new Map(fresh.map((approach) => [discoveredLegId(approach), approach]));
  const order = orderLegsByCertainty({
    legs: [...byId].map(([id, approach]) => ({
      id,
      direction: approach.direction,
      polyline: approach.polyline,
    })),
    neighbourhood,
    minTurnDeg: phase2.legOrder.minTurnDeg,
    minSegmentM: phase2.legOrder.minSegmentM,
    snapM: phase2.legOrder.snapM,
    batchSize: params.candidates.maxConcurrentFetches,
  });

  const corridors = new Map<string, readonly RoadWay[]>();
  const candidates: RouteCandidate[] = [];
  await mapWithConcurrency(order, params.candidates.maxConcurrentFetches, async (leg) => {
    const approach = byId.get(leg.id);
    if (approach === undefined) return;
    let ways: readonly RoadWay[];
    try {
      ways = await corridor.fetchCorridor(approach.polyline, params.candidates.corridorMarginM);
    } catch {
      return;
    }
    corridors.set(leg.id, ways);
    candidates.push(
      candidateFromRoutedLeg({
        id: leg.id,
        direction: approach.direction,
        polyline: approach.polyline,
        corridor: ways,
        distanceM: approach.distanceM,
        durationS: approach.durationS,
        generatedBy: 'discovered',
        egressOf: null,
        sampleStepM: params.candidates.sampleStepM,
        snapM: params.candidates.snapM,
        approachWindowM: params.candidates.approachWindowM,
        laneWidthM: params.candidates.laneWidthM,
        minCorridorCoverage: params.candidates.minCorridorCoverage,
        fetchedAt,
      }),
    );
  });

  // L'ordre de la liste est celui de la certitude, pas celui de l'arrivée des
  // corridors : un run rejoué doit rendre les mêmes jambes dans le même ordre.
  const rank = new Map(order.map((leg, index) => [leg.id, index]));
  candidates.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return { candidates, corridors };
}
