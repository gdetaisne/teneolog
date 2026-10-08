/**
 * ce que le pipeline demande à la découverte, en un endroit.
 *
 * Sorti de `full.ts` parce que la tâche y touchait et que le fichier était gelé
 * (principe 26) : « ce qui dépasse se découpe quand on y touche ». La coupure
 * est celle du sujet — ici on TRADUIT la policy en une demande, `full.ts`
 * orchestre. Les deux seuils que la découverte emprunte à d'autres sections
 * (`gates.minDistanceM`, `candidates.alternativesPerGate`) se lisent donc
 * ensemble, ce qui est précisément ce qu'on veut pouvoir relire d'un coup.
 *
 * elles sont trois : `gates.minReachM` a rejoint la liste le jour où
 * la portée a cessé de ne valoir que pour les jambes découvertes.
 */
import type { GeoPoint } from '@teneolog/domain';
import type { DiscoveryInput } from '@teneolog/routes';
import type { RoadNeighbourhood } from '@teneolog/topology';

/** Les seules sections de la policy que la demande lit. */
export interface DiscoveryInputParams {
  readonly gates: { readonly minDistanceM: number; readonly minReachM: number };
  readonly candidates: { readonly alternativesPerGate: number };
  readonly discovery: {
    readonly rounds: readonly number[];
    readonly radiusM: number;
    readonly windowM: number;
    readonly maxConcurrent: number;
    readonly singleWave?: boolean;
  };
}

/**
 * La demande faite à `discoverApproaches`, policy comprise.
 *
 * Rien n'est décidé ici : chaque nombre vient de la policy, et les deux qui
 * viennent d'ailleurs portent la raison pour laquelle ils en viennent.
 */
export function discoveryInputOf(
  stop: GeoPoint,
  neighbourhood: RoadNeighbourhood,
  params: DiscoveryInputParams,
  fetchedAt: string,
): DiscoveryInput {
  return {
    stop,
    neighbourhood,
    rounds: params.discovery.rounds,
    radiusM: params.discovery.radiusM,
    // Le même plancher que R0 : les deux règles partent du même cercle.
    minDistanceM: params.gates.minDistanceM,
    windowM: params.discovery.windowM,
    // une jambe qui n'atteint pas le cercle n'entre pas en
    // concurrence : elle est comptée dans `shortOfRing`, pas gardée. 
    // le nombre vient de `gates`, parce que R0 applique la MÊME règle à ses
    // ancres et que deux clés en auraient fait deux règles.
    minReachM: params.gates.minReachM,
    alternatives: params.candidates.alternativesPerGate,
    maxConcurrent: params.discovery.maxConcurrent,
    // Le critère d'arrêt est MESURÉ après coup, jamais appliqué entre deux
    // tours (§5 de l'A/B : il n'a coupé sur aucune des huit adresses). Tant que
    // c'est vrai, jouer trois tours en série fait attendre six barrières pour
    // rien.
    singleWave: params.discovery.singleWave === true,
    fetchedAt,
  };
}
