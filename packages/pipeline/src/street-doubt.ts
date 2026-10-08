/**
 * le doute de S0, lu et jamais recalculé.
 *
 * Décision produit : « la revue humaine du point de livraison, en principe
 * on ne demande que si le camion passe (si on a un doute) et s'il peut se garer
 * (si on a un doute). Mais on ne demande pas à ce stade de valider l'adresse
 * sur la carte. » Ce module ne pose donc AUCUNE question nouvelle : il fabrique
 * une raison de plus de poser celle qui existe déjà — la scène de destination,
 * « ça passe ? », « ça se gare ? » (`assessObviousStop`).
 *
 * Tout ce qu'il lit, S0 le publie déjà :
 *
 *  - `street.reliability.confidence` — 0,9 quand une seule chaussée était en
 *    lice (`street_unambiguous`), 0,75 quand une rivale a été comparée puis
 *    écartée (`street_resolved_by_*`). La deuxième valeur EST le doute ;
 *  - `streetSearch.considered[]` — chaque voie du voisinage avec l'étape où
 *    elle est tombée et sa distance à l'axe. Une voie jetée à 30,002 m pour un
 *    rayon d'accrochage de 30 m n'a pas perdu le concours : elle n'y est jamais
 *    entrée, pour 2 mm. C'est le défaut d'Auxerre (la N77 contre l'éperon de
 *    même nom), et il ne laisse aucune trace dans la confiance.
 *
 * La raison `dead_end_avoidable` (« la rue retenue est une impasse et
 * l'arrêt pourrait être ailleurs ») est sortie avec la règle qui la portait
 * ( tranche 2) : l'arrêt de repli sur une impasse ne se devine plus en
 * S0, il se calcule en S1 bis et se propose après un « Non » sur le demi-tour
 * (principes 10 et 39) — ce n'est pas un doute sur la rue.
 *
 * Rien n'est mesuré ici, rien n'est refait : deux seuils de policy et des
 * champs déjà écrits. La fonction est pure, sans horloge ni réseau, pour que le
 * même anchor rende toujours le même doute.
 */
import type { ConsideredWay, DeliveryAnchor } from '@teneolog/domain';

export type StreetDoubtReason =
  /** Une rivale a été comparée puis écartée : le choix s'est joué au classement. */
  | 'rival_compared'
  /** Une voie est tombée juste au-delà du rayon d'accrochage (Auxerre). */
  | 'near_miss_snap'
  /** Une voie est tombée juste au-delà de la fenêtre d'ambiguïté. */
  | 'near_miss_window'
  /** La confiance publiée de la rue est sous le seuil du « sans rivale ». */
  | 'low_confidence';

/**
 * Les deux nombres de la règle, plus son interrupteur.
 *
 * `nearMissM` est une TOLÉRANCE sur un seuil, pas un seuil : elle dit « à
 * combien de centimètres d'être retenue une voie écartée doit être pour que le
 * seuil cesse d'être une preuve ». `minConfidence` est le 0,9 de
 * `pipeline.selection.confidence.unambiguous`, répété ici parce que la revue
 * doit pouvoir bouger sans toucher à la sélection.
 */
export interface StreetDoubtParams {
  readonly enabled: boolean;
  readonly nearMissM: number;
  readonly minConfidence: number;
}

/** Une voie écartée de justesse, avec de combien elle l'a été. */
export interface NearMiss {
  readonly segmentId: string;
  readonly name: string | null;
  readonly distanceM: number;
  /** Le seuil qu'elle a franchi — rayon d'accrochage, ou bord de fenêtre. */
  readonly thresholdM: number;
  /** `distanceM - thresholdM` : l'écart qui l'a exclue. */
  readonly missedByM: number;
}

export interface StreetDoubtDetails {
  /** La confiance publiée de la rue de livraison. Null si aucune rue retenue. */
  readonly confidence: number | null;
  /** Combien de chaussées ont atteint le concours et l'ont perdu. */
  readonly rivalsCompared: number;
  readonly nearSnap: NearMiss | null;
  readonly nearWindow: NearMiss | null;
  /** Les seuils sous lesquels ce doute a été lu, gardés avec la réponse. */
  readonly maxSnapM: number | null;
  readonly ambiguityWindowM: number | null;
  readonly nearMissM: number;
  readonly minConfidence: number;
}

export interface StreetDoubt {
  /**
   * Vrai quand la règle est active ET qu'au moins une raison est trouvée. Les
   * raisons, elles, sont TOUJOURS calculées : drapeau baissé, `/explain` montre
   * quand même ce que la règle aurait dit, et c'est ainsi qu'on la mesure avant
   * de l'activer.
   */
  readonly doubtful: boolean;
  readonly reasons: readonly StreetDoubtReason[];
  readonly details: StreetDoubtDetails;
}

/** Ce que vaut la règle quand personne ne l'a posée : elle ne dit rien. */
export const STREET_DOUBT_OFF: StreetDoubtParams = {
  enabled: false,
  nearMissM: 0,
  minConfidence: 0,
};

/**
 * Les étapes qui prouvent qu'une voie a été MESURÉE et accrochée : c'est parmi
 * elles que se trouve la plus proche, l'origine de la fenêtre d'ambiguïté.
 * `beyond_snap` en est exclue (trop loin pour entrer), `non_vehicular` aussi
 * (jamais mesurée, `distanceM` nul).
 */
const SNAPPED_STAGES: ReadonlySet<ConsideredWay['stage']> = new Set([
  'retained',
  'continuation_merged',
  'compared',
  'outside_window',
]);

export function streetDoubt(
  anchor: DeliveryAnchor,
  params: StreetDoubtParams = STREET_DOUBT_OFF,
): StreetDoubt {
  const reasons: StreetDoubtReason[] = [];
  const street = anchor.street;
  const search = anchor.streetSearch;

  const confidence = street.known ? street.reliability.confidence : null;
  // `alternativesConsidered` est la liste que S0 publie sur la rue elle-même :
  // les chaussées qui ont atteint le concours et l'ont perdu.
  const rivalsCompared = street.known ? street.value.alternativesConsidered.length : 0;

  // (a) Une rivale a été comparée — `street_resolved_by_*`. C'est le même
  // événement que la confiance à 0,75, dit par l'autre bout : la liste des
  // écartées. Les deux raisons partent donc ensemble sur une rue résolue au
  // classement, et séparément quand une seule des deux traces existe (un run
  // stocké avant `alternativesConsidered`, une calibration de confiance autre).
  if (rivalsCompared > 0) reasons.push('rival_compared');
  if (confidence !== null && confidence < params.minConfidence) reasons.push('low_confidence');

  // (b) Les quasi-ratés. Une voie jetée pour quelques millimètres n'a pas été
  // départagée : le seuil a tranché à sa place.
  const nearSnap = nearestMiss(
    search?.considered ?? [],
    (way) => way.stage === 'beyond_snap',
    search?.maxSnapM ?? null,
    params.nearMissM,
  );
  if (nearSnap !== null) reasons.push('near_miss_snap');

  const nearestSnappedM = nearestSnapped(search?.considered ?? []);
  const windowEdgeM =
    nearestSnappedM === null || search === null ? null : nearestSnappedM + search.ambiguityWindowM;
  const nearWindow = nearestMiss(
    search?.considered ?? [],
    (way) => way.stage === 'outside_window',
    windowEdgeM,
    params.nearMissM,
  );
  if (nearWindow !== null) reasons.push('near_miss_window');

  return {
    doubtful: params.enabled && reasons.length > 0,
    reasons,
    details: {
      confidence,
      rivalsCompared,
      nearSnap,
      nearWindow,
      maxSnapM: search?.maxSnapM ?? null,
      ambiguityWindowM: search?.ambiguityWindowM ?? null,
      nearMissM: params.nearMissM,
      minConfidence: params.minConfidence,
    },
  };
}

/** La plus proche des voies mesurées et accrochées : l'origine de la fenêtre. */
function nearestSnapped(considered: readonly ConsideredWay[]): number | null {
  let best: number | null = null;
  for (const way of considered) {
    if (way.distanceM === null || !SNAPPED_STAGES.has(way.stage)) continue;
    if (best === null || way.distanceM < best) best = way.distanceM;
  }
  return best;
}

/**
 * La plus proche des écartées à cette étape, si elle a manqué le seuil de moins
 * de `nearMissM`.
 *
 * Le test est INCLUSIF (`<=`) : à 2 m pile, on considère que le seuil n'a rien
 * prouvé. Un seuil qui exclut à sa propre tolérance près recrée exactement le
 * couperet qu'on cherche à amortir.
 */
function nearestMiss(
  considered: readonly ConsideredWay[],
  atStage: (way: ConsideredWay) => boolean,
  thresholdM: number | null,
  nearMissM: number,
): NearMiss | null {
  if (thresholdM === null) return null;
  let best: ConsideredWay | null = null;
  for (const way of considered) {
    if (way.distanceM === null || !atStage(way)) continue;
    if (best === null || way.distanceM < (best.distanceM ?? Infinity)) best = way;
  }
  if (best === null || best.distanceM === null) return null;
  const missedByM = best.distanceM - thresholdM;
  // Une distance SOUS le seuil n'est pas un quasi-raté : la voie a été écartée
  // pour autre chose (elle n'était simplement pas la plus proche), et l'écart
  // négatif ne dit rien. On ne retient que ce qui a franchi le couperet.
  if (missedByM < 0 || missedByM > nearMissM) return null;
  return {
    segmentId: best.segmentId,
    name: best.name,
    distanceM: best.distanceM,
    thresholdM,
    missedByM,
  };
}
