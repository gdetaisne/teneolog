/**
 * S3 — rejouer un itinéraire DÉJÀ ROUTÉ, pour la MESURE seule.
 *
 * L'A/B de la note de conception interne (« en silence, puis A/B »)
 * demande une chose que le moteur ne sait pas faire aujourd'hui : prendre une
 * jambe que personne n'a fabriquée à partir d'une ancre — une approche
 * découverte, une approche tronquée à son ancre par largeur
 * — et lui faire subir exactement ce que S3 fait subir à un candidat
 * de production, pour que S4 et S5 puissent la juger avec les mêmes yeux.
 *
 * Trois choses que ce module n'est pas, et ne doit jamais devenir :
 *
 *  - il n'est pas une règle d'ancrage. Rien ici ne rend un `Gate` et rien ici
 *    n'est appelé par `runFullAnalysis` : le harnais l'appelle, le moteur non.
 *    Le test d'or (`full-discovery.test.ts`, `full-gate-by-width.test.ts`) en
 *    est le juge.
 *  - il ne route pas et ne fetche rien. La jambe et son corridor arrivent
 *    tout faits ; ce fichier est PUR, donc rejouable, donc comparable.
 *  - il n'invente aucune annotation. `annotateRoute` et
 *    `corridorReasonCodesFor` sont ceux de `candidates.ts` — les MÊMES
 *    fonctions, pas une copie : deux annotations feraient deux corridors pour
 *    une route, et l'A/B comparerait ses propres erreurs.
 */
import type { GeoPoint, RouteCandidate } from '@teneolog/domain';
import { haversineM, type RoadWay } from '@teneolog/topology';

import { annotateRoute } from './annotate.js';
import { corridorReasonCodesFor, unreadOf } from './candidates.js';

export interface ReplayLegInput {
  /** Le nom de la jambe rejouée — celui que S4 et S5 liront. */
  readonly id: string;
  readonly direction: 'in' | 'out';
  /** La ligne telle que le routeur l'a dessinée, éventuellement taillée. */
  readonly polyline: readonly GeoPoint[];
  readonly corridor: readonly RoadWay[];
  readonly distanceM: number;
  readonly durationS: number;
  readonly generatedBy: RouteCandidate['generatedBy'];
  readonly egressOf: RouteCandidate['egressOf'];
  /** Les mêmes réglages que les itinéraires de production (`params.candidates`). */
  readonly sampleStepM: number;
  readonly snapM: number;
  readonly approachWindowM: number;
  readonly laneWidthM: number;
  readonly minCorridorCoverage: number;
  readonly fetchedAt: string;
}

/**
 * Un candidat d'itinéraire à partir d'une jambe déjà routée et de son corridor.
 *
 * C'est l'étape 5 de `buildRouteCandidatesWithCorridors`, isolée : même
 * annotation, même comptage de couverture, mêmes codes de corridor. Le test
 * `replay.test.ts` le prouve en construisant les deux et en les comparant
 * champ par champ — si un jour l'un des deux dérive, c'est ce test qui tombe,
 * pas un chiffre du rapport.
 */
export function candidateFromRoutedLeg(input: ReplayLegInput): RouteCandidate {
  const annotated = annotateRoute({
    polyline: input.polyline,
    corridor: input.corridor,
    sampleStepM: input.sampleStepM,
    snapM: input.snapM,
    approachWindowM: input.approachWindowM,
    laneWidthM: input.laneWidthM,
    direction: input.direction,
    fetchedAt: input.fetchedAt,
  });
  return {
    id: input.id,
    direction: input.direction,
    polyline: input.polyline,
    segments: annotated.segments,
    coverage: annotated.coverage,
    corridorReasonCodes: corridorReasonCodesFor(annotated.coverage, input.minCorridorCoverage),
    // la MÊME règle que `candidates.ts`, pas une copie.
    ...unreadOf(annotated.unread),
    generatedBy: input.generatedBy,
    distanceM: input.distanceM,
    durationS: input.durationS,
    egressOf: input.egressOf,
  };
}

/**
 * La jambe tronquée : du point de livraison jusqu'à `distanceFromDeliveryM`,
 * rendue dans le sens de l'approche d'origine.
 *
 * C'est ce que l'ancre par largeur affirme : au-delà de ce point, la route est
 * assez large pour ne plus être une question, donc l'itinéraire à contrôler
 * commence là. Tronquer, c'est faire exactement cette affirmation et la
 * soumettre à S4–S5.
 *
 * La distance se compte le long de la ligne ORIENTÉE VERS L'EXTÉRIEUR, comme
 * `GateByWidth.distanceFromDeliveryM` (`gate-by-width.ts`) ; une entrante est
 * donc retournée, tronquée, puis remise à l'endroit. Le dernier point est
 * interpolé sur le segment franchi, pas arrondi au sommet suivant : à 25 m
 * d'échantillonnage, un sommet de trop est un point de passage de trop.
 *
 * Rend une ligne vide quand il n'y a rien à garder — jamais un point seul, qui
 * ne serait pas un itinéraire.
 */
export function legTruncatedAtM(
  approach: { readonly direction: 'in' | 'out'; readonly polyline: readonly GeoPoint[] },
  distanceFromDeliveryM: number,
): readonly GeoPoint[] {
  const outward = approach.direction === 'in' ? [...approach.polyline].reverse() : [...approach.polyline];
  if (outward.length < 2 || distanceFromDeliveryM <= 0) return [];

  const kept: GeoPoint[] = [outward[0] as GeoPoint];
  let travelled = 0;
  for (let i = 0; i + 1 < outward.length; i += 1) {
    const a = outward[i] as GeoPoint;
    const b = outward[i + 1] as GeoPoint;
    const lengthM = haversineM(a, b);
    if (travelled + lengthM >= distanceFromDeliveryM) {
      const remaining = distanceFromDeliveryM - travelled;
      const t = lengthM === 0 ? 0 : remaining / lengthM;
      if (t > 0) kept.push({ lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) });
      break;
    }
    travelled += lengthM;
    kept.push(b);
  }
  if (kept.length < 2) return [];
  return approach.direction === 'in' ? kept.reverse() : kept;
}

/** La longueur d'une ligne, en mètres — ce que le candidat tronqué annonce. */
export function polylineLengthM(polyline: readonly GeoPoint[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < polyline.length; i += 1) {
    sum += haversineM(polyline[i] as GeoPoint, polyline[i + 1] as GeoPoint);
  }
  return sum;
}
