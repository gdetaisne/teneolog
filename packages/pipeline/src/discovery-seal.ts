/**
 * sorti de `full.ts` (gelé, principe 26) : une fonction pure, sans
 * dépendance sur le reste du module, appelée par deux chemins distincts
 * (le tronc commun de la découverte, et le garde-fou de portée quand R0 n'a
 * retenu aucun candidat) — exactement ce que le principe demande de sortir
 * en premier quand un fichier gelé doit grossir ailleurs.
 */
import type { Discovery, DiscoveryStopCriterion } from '@teneolog/domain';
import type { DiscoveryDraft } from '@teneolog/routes';

/** Le brouillon de la découverte, complété de ce que la mesure a établi. */
export function sealDiscovery(
  draft: DiscoveryDraft,
  measured: {
    readonly approaches: Discovery['approaches'];
    readonly approachesOut: Discovery['approachesOut'];
    readonly coverage: Discovery['coverageByR0'];
    readonly stopCriterion: DiscoveryStopCriterion;
    readonly obviousStop: boolean;
  },
): Discovery {
  return {
    ...draft,
    approaches: measured.approaches,
    approachesOut: measured.approachesOut,
    coverageByR0: measured.coverage,
    stopCriterion: measured.stopCriterion,
    obviousStop: measured.obviousStop,
  };
}
