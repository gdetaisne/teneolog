/**
 * The obvious-stop predicate: at these widths, "does it pass?
 * can it stop?" stops being a question and the list row auto-validates.
 *
 * Calibrated on the 2026-09-04 corpus: declared (BDTOPO) needs 10 m because
 * the attribute ignores bollards and refits (Vaucouleurs: declared 8 m, ~3 m
 * usable); a D10 measurement of the actual free width needs only 6.5 m.
 * Dead-ends never qualify (Villa Damrémont passes, but leaving is the
 * question). A legal band that stops the truck, or a non-open access rule,
 * keeps the human in the loop. The ZFE is NOT a gate: it becomes a chip on the
 * list row, not a question.
 *
 * It lives here, in the pipeline, rather than in the API wire, because 
 * gave it a second reader: the silent discovery records whether the stop was
 * obvious (round 0 of la note de conception interne — an obvious stop
 * needs no search at all). Two copies of a business rule drift; `pairs.ts`
 * carries the scar of the last time. One rule, two callers.
 *
 * le doute de S0 (`street-doubt.ts`) entre dans le prédicat, en
 * dernier. Il ne pose aucune scène nouvelle — il retire l'évidence, ce qui fait
 * poser la scène de destination qui existe déjà.
 */
import type { Fact, TruckProfile, Turnaround } from '@teneolog/domain';
import { readBarrierClosure } from '@teneolog/domain';

import type { S0S2Facts } from './analyse.js';

export interface ObviousStopThresholds {
  /** BDTOPO's declared width needs the larger cushion. */
  readonly declaredWidthMinM: number;
  readonly measuredWidthMinM: number;
  /** Below this confidence a width is not publishable — `projection.publishableConfidence`. */
  readonly publishableConfidence: number;
}

export interface ObviousStopVerdict {
  readonly obvious: boolean;
  /** Which threshold applied, or null when nothing was measured against one. */
  readonly basis: 'declared' | 'measured' | null;
  readonly reasonCodes: readonly string[];
}

export function assessObviousStop(
  facts: S0S2Facts,
  truck: TruckProfile | undefined,
  thresholds: ObviousStopThresholds,
): ObviousStopVerdict {
  const no = (why: string): ObviousStopVerdict => ({ obvious: false, basis: null, reasonCodes: [why] });
  if (truck === undefined) return no('no_truck');
  if (facts.topology.topology.kind !== 'THROUGH') return no('not_through_street');

  const width = facts.stop.width;
  if (!width.known) return no('width_unknown');
  if (width.reliability.confidence < thresholds.publishableConfidence) {
    return no('width_confidence_low');
  }
  const basis = width.reliability.basis === 'declared' ? 'declared' : 'measured';
  const minM = basis === 'declared' ? thresholds.declaredWidthMinM : thresholds.measuredWidthMinM;
  if (width.value.freeM < minM) return no(`width_below_${basis}_threshold`);

  const legal = facts.stop.legal;
  if (legalBandBlocks(legal, truck)) return no('legal_band_blocks_truck');
  if (legal.access.known && legal.access.value.kind !== 'open') {
    return no('access_restricted');
  }

  // UNE RUE FERMÉE N'EST PAS UN ARRÊT ÉVIDENT.
  //
  // Une borne fixe ou un portail relevé sur la rue de livraison ne touchait
  // aucun verdict, et cette ligne s'auto-validait par-dessus : rue traversante,
  // 10 m déclarés, aucune bande légale — et fermée. C'est le pire cas que
  // `topology-assessment.ts` nomme lui-même (« the truck arrives and the report
  // said it would pass »). La lecture est celle du moteur, `readBarrierClosure`,
  // la même que le verdict de l'arrêt : une barrière `conditional` (borne
  // escamotable, chicane, gabarit) ne retire rien — le camion passe sous
  // condition ; une infranchissable ou une dont le franchissement n'est pas
  // établi retire l'évidence, avec ses codes.
  const closure = readBarrierClosure(facts.topology.barriers);
  if (closure.kind !== 'none') {
    return { obvious: false, basis, reasonCodes: closure.reasonCodes };
  }

  // le doute de S0 compte dans ce qui déclenche la question.
  //
  // En DERNIER, et c'est le point : tout ce qui précède décrit l'arrêt, et
  // continue de rendre son propre motif quand il manque quelque chose. Le doute
  // de S0 ne remplace aucun de ces motifs ; il retire l'évidence à un arrêt qui
  // l'aurait eue. La mesure de la règle est donc exactement ce qui passe ici :
  // les arrêts qui étaient évidents et ne le sont plus.
  //
  // La rue est le porteur de toutes les mesures d'au-dessus — la largeur, les
  // bandes légales, la forme sont celles de la rue retenue. Douter de la rue,
  // c'est douter d'elles, et « ça passe ? ça se gare ? » redevient une
  // question. Ce n'est JAMAIS « est-ce la bonne adresse ? » : la scène posée
  // est la scène de destination existante, avec sa raison en en-tête.
  //
  // `basis` est conservé : le seuil a bien été appliqué, et la carte doit
  // pouvoir dire lequel. Absent du fact (test à la main, run d'avant le champ),
  // le doute n'existe pas et le verdict est celui d'avant la règle.
  const doubt = facts.streetDoubt;
  if (doubt !== undefined && doubt.doubtful) {
    return {
      obvious: false,
      basis,
      reasonCodes: doubt.reasons.map((reason) => `street_doubt_${reason}`),
    };
  }

  return { obvious: true, basis, reasonCodes: [`obvious_stop_${basis}_width`] };
}

function value<T>(fact: Fact<T>): T | null {
  return fact.known ? fact.value : null;
}

/**
 * Une bande légale relevée à l'arrêt arrête-t-elle CE camion ?
 *
 * Sortie de `assessObviousStop` : le prédicat touchait la borne de
 * complexité du cliquet (principe 26 — « ce qui dépasse se découpe quand on y
 * touche »), et la coupure est celle du sujet — ici la loi, là-bas l'évidence.
 * Trois limites, la plus petite qui mord suffit ; une limite absente ne dit
 * rien (principe 5).
 */
function legalBandBlocks(legal: S0S2Facts['stop']['legal'], truck: TruckProfile): boolean {
  const maxWeightT = value(legal.maxWeightT)?.value ?? null;
  const maxHeightM = value(legal.maxHeightM)?.value ?? null;
  const maxWidthM = value(legal.maxWidthM)?.value ?? null;
  return (
    (maxWeightT !== null && maxWeightT < truck.envelope.gvwT) ||
    (maxHeightM !== null && maxHeightM < truck.envelope.heightM) ||
    (maxWidthM !== null && maxWidthM < truck.envelope.widthM)
  );
}

/**
 * Le retournement mesuré à l'arrêt, tel que S1 le laisse.
 *
 * `not_applicable` sur une rue traversante : la question du demi-tour ne s'y
 * est pas posée, ce qui n'est pas la même chose que « cherché, rien trouvé ».
 * Une seule définition, lue par les candidats (`egressOf.turnaround`) et par
 * les plans. Sortie de `full.ts` (fichier gelé, principe 26) : elle
 * ne dépend que des faits, pas des autres locaux de la fonction qui l'appelle.
 */
export function stopTurnaroundOf(facts: S0S2Facts): Fact<Turnaround> {
  return facts.topology.topology.kind === 'THROUGH'
    ? { known: false, why: 'not_applicable' }
    : facts.topology.topology.turnaround;
}

/**
 * `assessObviousStop` posée depuis la policy plutôt que des seuils déjà
 * assemblés — le même geste que `obviousStopThresholds` côté API
 * (`compat-wire.ts`), pour la même raison : composer, pas ajouter une
 * troisième forme. Sortie de `full.ts` (fichier gelé, principe 26) aux côtés
 * de `stopTurnaroundOf`, avec les mêmes deux appelants.
 */
export function obviousStopOf(
  facts: S0S2Facts,
  truck: TruckProfile,
  params: {
    readonly obviousStop: Omit<ObviousStopThresholds, 'publishableConfidence'>;
    readonly projection: { readonly publishableConfidence: number };
  },
): boolean {
  return assessObviousStop(facts, truck, {
    ...params.obviousStop,
    publishableConfidence: params.projection.publishableConfidence,
  }).obvious;
}
