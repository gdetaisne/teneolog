/**
 * CE QUE L'ÉTAGE PUBLIE, et rien d'autre.
 *
 * Sorti de `axes-stage.ts` le jour où la tâche y touchait (principe 26 : ce qui
 * dépasse se découpe quand on y touche). La coupure est celle du sujet — ici on
 * MET EN FORME ce que la recherche a trouvé : l'anneau retenu, ses portes, ce
 * qui manque, ce qui a réellement servi d'ancres. Aucune règle n'a changé de
 * valeur dans le déplacement.
 *
 * Deux sorties seulement, et c'est voulu : `assemble` quand un anneau porte
 * quelque chose, `empty` quand il n'y a rien à publier — et `empty` DIT lequel
 * des cas s'est produit plutôt que de se taire (principe 5).
 */
import type {
  AxisFetchReport,
  AxisRingProbe,
  AxisSearch,
  AxisSearchReason,
} from '@teneolog/domain';

import type { AxisRingAttempt } from './axes-rings.js';
import { DEFAULT_AXIS_SELECTION, uncoveredArcsOf } from './axes-scale.js';
import { uncontrolledApproaches } from './axes-select.js';
import type { AxisStageParams } from './axes-stage.js';

/** L'anneau retenu, publié : ses axes, ses portes, ses directions, et son motif. */
export function assemble(input: {
  readonly stage: AxisStageParams;
  readonly best: AxisRingAttempt;
  readonly reason: AxisSearchReason;
  /**
   * vrai quand l'étage s'est arrêté AU CERCLE PAR
   * CHOIX, le cercle ayant répondu : `best_ring_kept` avec au moins une porte
   * retenue sur le cercle (en 2–3 ou en classe 4), ou `ring_class4`
   * (2026-09-14 au soir, où la classe 4 de la bande a donné le compte). Faux
   * quand les 15 km ont été épuisés sans rien trouver de mieux, faux pour
   * `ring_reached` (aucun arrêt anticipé n'était nécessaire) et faux pour
   * `timeout` (ce n'est pas un choix).
   */
  readonly boundedByPrinciple34: boolean;
  readonly fetch: AxisFetchReport;
  readonly probes: readonly AxisRingProbe[];
  readonly costMs: number;
}): AxisSearch {
  const { stage, best } = input;
  const labelByAxisId = new Map(best.axes.map((axis) => [axis.id, axis.label]));
  return {
    enabled: stage.enabled,
    selection: stage.selection ?? DEFAULT_AXIS_SELECTION,
    // LA CLASSE DE LA PASSE QUI A SERVI, et non
    // celle de la policy : quand le cercle a répondu en classe 4, l'écran doit
    // pouvoir écrire « portes de classe 4 sur le cercle, faute de 2–3 sous
    // 2 km ». Une lecture qui dirait 3 mentirait sur ce qui a été retenu.
    importanceMax: best.importanceMax,
    ringsM: stage.ringsM,
    sectorCount: stage.sectorCount,
    minGateDirections: stage.minGateDirections,
    minDirectionSeparationDeg: stage.minDirectionSeparationDeg,
    reachedRingM: best.ringM,
    reason: input.reason,
    boundedByPrinciple34: input.boundedByPrinciple34,
    fetch: input.fetch,
    axes: best.axes,
    sectorsCovered: [...new Set(best.axes.map((axis) => axis.sector))].sort((a, b) => a - b),
    gateDirections: best.directions,
    gates: best.selection.gates,
    retained: best.selection.retained,
    rejected: best.found.rejected,
    uncontrolled: uncontrolledApproaches(
      best.selection.retained,
      (gate) => labelByAxisId.get(gate.axisId) ?? gate.label,
      stage.minReachM,
    ),
    uncoveredArcs: uncoveredArcsOf(
      best.selection.retained.map((gate) => gate.azimuthDeg),
      searchedToM(input.probes),
      stage.minDirectionSeparationDeg,
    ),
    fallback: fallbackOf(stage.enabled, input.reason, best.axes.length, best.selection.retained.length),
    ringProbes: input.probes,
    costMs: input.costMs,
  };
}

export function empty(
  params: AxisStageParams,
  fetch: AxisFetchReport,
  reason: AxisSearchReason,
  costMs: number,
  probes: readonly AxisRingProbe[] = [],
): AxisSearch {
  return {
    enabled: params.enabled,
    selection: params.selection ?? DEFAULT_AXIS_SELECTION,
    // Rien n'a été retenu : la classe publiée est celle que l'étage
    // DEMANDAIT, la seule dont on puisse dire quelque chose.
    importanceMax: params.importanceMax,
    ringsM: params.ringsM,
    sectorCount: params.sectorCount,
    minGateDirections: params.minGateDirections,
    minDirectionSeparationDeg: params.minDirectionSeparationDeg,
    reachedRingM: null,
    reason,
    boundedByPrinciple34: false,
    fetch: { ...fetch, wallMs: costMs },
    axes: [],
    sectorsCovered: [],
    gateDirections: [],
    gates: [],
    retained: [],
    rejected: [],
    uncontrolled: [],
    // Aucune ancre : tout le cercle est sans ancre fiable, et l'arc le DIT
    // avec le plus grand anneau qu'on a eu le temps de regarder (principe 1).
    uncoveredArcs: uncoveredArcsOf([], searchedToM(probes), params.minDirectionSeparationDeg),
    fallback: fallbackOf(params.enabled, reason, 0, 0),
    // Les anneaux sondés avant l'échec, s'il y en a eu : un étage qui a
    // regardé quelque chose et n'a rien trouvé le DIT (principe 1).
    ringProbes: probes,
    costMs,
  };
}

/**
 * JUSQU'OÙ ON A REGARDÉ : le plus grand anneau réellement sondé.
 *
 * Lu sur les anneaux publiés plutôt que porté par la recherche : les deux
 * modes, le budget expiré compris, publient leurs anneaux au fil de l'eau, donc
 * `ringProbes` est la seule mesure qui ne puisse pas mentir sur ce qui a
 * vraiment été regardé (principe 1).
 */
function searchedToM(probes: readonly AxisRingProbe[]): number {
  return probes.reduce((widest, probe) => Math.max(widest, probe.ringM), 0);
}

/**
 * Ce qui a réellement servi d'ancres — nommé, jamais tu.
 *
 * RELU LE 2026-09-14 — `timeout` passe AVANT `axisCount`/`gateCount` : un
 * étage coupé au budget n'a pas fini de JUGER son meilleur anneau, même
 * quand ce dernier portait déjà des axes et des portes retenues (principe
 * 5, « un étage inachevé n'est pas une décision »). Avant cette correction,
 * un timeout avec un anneau déjà qualifiant rendait `'axes'` au même titre
 * qu'un `ring_reached` — et `gatesOf` (`gate-stage.ts`) aurait alors servi
 * les portes d'une recherche que rien n'a fini de vérifier.
 */
function fallbackOf(
  enabled: boolean,
  reason: AxisSearchReason,
  axisCount: number,
  gateCount: number,
): AxisSearch['fallback'] {
  if (!enabled) return 'r0_silent';
  if (reason === 'timeout') return 'r0_timeout';
  if (axisCount === 0) return 'r0_no_axis';
  if (gateCount === 0) return 'r0_no_gate';
  return 'axes';
}
