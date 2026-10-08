/**
 * ce que le pipeline demande à R0, en un endroit.
 *
 * Le pendant exact de `discovery-input.ts`, et sorti de `full.ts` pour la même
 * raison : la tâche y touchait et le fichier est gelé (principe 26), « ce qui
 * dépasse se découpe quand on y touche ». La coupure est celle du sujet — ici
 * on TRADUIT la policy en une demande, `full.ts` orchestre.
 *
 * Les trois nombres de l'anneau se lisent donc ensemble, ce qui est précisément
 * ce qu'on veut pouvoir relire d'un coup le jour où l'un d'eux bouge : ce que
 * l'étude mesure (`minDistanceM`), ce qui peut concourir (`minReachM`), et
 * jusqu'où (`searchRadiusM`).
 */
import type { GeoPoint } from '@teneolog/domain';
import type { GateSearchInput } from '@teneolog/routes';
import type { RoadNeighbourhood } from '@teneolog/topology';

/** La seule section de la policy que la demande lit. */
export interface GateInputParams {
  readonly gates: {
    readonly searchRadiusM: number;
    readonly gateCount: number;
    readonly minDistanceM: number;
    readonly minReachM: number;
  };
}

export function gateSearchInputOf(
  stop: GeoPoint,
  neighbourhood: RoadNeighbourhood,
  params: GateInputParams,
): GateSearchInput {
  return {
    stop,
    neighbourhood,
    gateCount: params.gates.gateCount,
    minDistanceM: params.gates.minDistanceM,
    // une ancre qui ne porte pas jusqu'au cercle ne concourt pas : la
    // même règle et le MÊME NOMBRE que la découverte applique au bout de ses
    // jambes routées (principe 7, principe 28). Pour R0 l'ancre est ce bout.
    minReachM: params.gates.minReachM,
    // The circle we asked the neighbourhood for is also the far edge of what
    // counts as an approach to this address.
    maxDistanceM: params.gates.searchRadiusM,
  };
}
