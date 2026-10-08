/**
 * sorti de `full.ts` (gelé, principe 26) : une constante pure, sans
 * dépendance, exactement ce que le principe demande de sortir en premier
 * quand un fichier gelé doit grossir ailleurs.
 */
import type { GraftOptions } from '@teneolog/topology';

/**
 * Les tolérances de la greffe quand l'appelant n'en fournit pas.
 *
 * Ce sont celles de `pipeline.roadAttributes` dans la policy de référence. Les
 * répéter ici n'est pas une deuxième définition : c'est le repli d'un port
 * optionnel, et l'API passe toujours les siennes (l'API (hors instantané)).
 */
export const DEFAULT_GRAFT: GraftOptions = {
  sampleStepM: 10,
  lateralToleranceM: 5,
  bearingToleranceDeg: 25,
  minCoverage: 0.6,
};
