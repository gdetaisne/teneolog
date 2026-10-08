/**
 * S3 — DEUX CANDIDATS R0 QUI SONT LE MÊME ITINÉRAIRE.
 *
 * Le défaut, relevé deux fois et jamais corrigé (la note de conception interne
 * §8-F2, registre des divergences « Dédoublonnage des itinéraires candidats ») :
 * deux chemins OSRM géométriquement identiques — fréquent entre le principal et
 * son alternative sur un axe unique — produisent deux candidats, deux corridors
 * (0,8 s chacun), deux annotations, et pèsent deux fois dans le classement.
 *
 * LA RÈGLE VIENT DE L'ENGINE (principe 29). `selectTopArrivals`
 * (`itinerary-route-candidates/selection.ts` l.59-96) garde la meilleure jambe
 * par signature et en tient DEUX, indépendantes :
 *
 *  - la GÉOMÉTRIE complète, coordonnées arrondies à 5 décimales — environ
 *    1,1 m (`ARRIVAL_POLYLINE_ROUND_DECIMALS`, `constants.ts`) ;
 *  - les RUES des 500 derniers mètres pour une arrivée, des 500 premiers pour
 *    une sortie (`arrivalLastMileStreetSignature` /
 *    `egressFirstMileStreetSignature`, `ARRIVAL_LAST_MILE_COMPARE_RADIUS_M = 500`).
 *
 * CE QU'ON GARDE : les deux signatures, la fenêtre de 500 m, l'arrondi à
 * 5 décimales, et « le premier rencontré gagne ».
 *
 * CE QU'ON CHANGE, ET POURQUOI :
 *
 *  - les rues se lisent sur la GÉOMÉTRIE, pas sur BD TOPO. L'app a déjà la
 *    mesure — `sameApproach` (`discovery.ts`), qui échantillonne la fenêtre tous
 *    les 10 m et appelle deux jambes la même quand chacune couvre l'autre à 80 %
 *    à 15 m près. La recopier en « chaîne de cleabs » ferait deux définitions de
 *    « la même approche » (principe 23), et l'engine lui-même s'y est brûlé :
 *    BUG-035 — quand la récupération BD TOPO est tronquée, la signature par rues
 *    écarte la MEILLEURE jambe, « the oracle DROPPED the best itinerary ».
 *    Ici, aucune donnée à récupérer : la géométrie routée suffit.
 *  - la signature `approach` n'écarte rien par défaut, même drapeau levé
 *    (`routes.dedup.approach`). Deux jambes qui ne se rejoignent que sur les 500
 *    derniers mètres diffèrent AVANT — et côté app toute l'approche est
 *    contrôlée (principe 7), donc cette différence est mesurée, pas décorative.
 *    L'engine peut se le permettre : chez lui l'amont est un axe structurant,
 *    « always accessible » par principe.
 *
 * Le module ne route rien, ne récupère rien et ne juge rien : il reçoit des
 * jambes déjà routées et rend des marques.
 */
import type { GeoPoint, RouteDuplicate } from '@teneolog/domain';

import { SAMPLE_STEP_M, lastMetres, sameApproach, sampleEvery } from './discovery.js';

/**
 * La fenêtre de comparaison des derniers mètres (arrivée) ou des premiers
 * (sortie). 500 m : `ARRIVAL_LAST_MILE_COMPARE_RADIUS_M` et
 * `EGRESS_FIRST_MILE_COMPARE_RADIUS_M` de l'engine
 * (`arrival-last-mile-signature.ts` l.6-10), « product: ~500 m ».
 *
 * Ce n'est PAS `discovery.windowM` (1 000 m en policy) : celle-là dédoublonne
 * ce qu'une recherche adaptative a trouvé et reste à recalibrer par l'A/B
 *; celle-ci porte la règle de l'engine sur les candidats de R0.
 * Elles se répondent, elles ne se remplacent pas.
 */
export const DEDUP_WINDOW_M = 500;

/** 5 décimales ≈ 1,1 m — `ARRIVAL_POLYLINE_ROUND_DECIMALS` de l'engine. */
export const DEDUP_COORD_DECIMALS = 5;

/** Ce que la policy dit du dédoublonnage — `routes.dedup`. */
export interface DedupOptions {
  /**
   * Écarter les doublons AVANT leur corridor. Baissé (le défaut), ils sont
   * marqués, gardés et coûtent ce qu'ils coûtaient : rien ne change.
   */
  readonly enabled: boolean;
  /**
   * Écarter aussi les doublons trouvés par la seule signature `approach` —
   * mêmes 500 derniers (ou premiers) mètres, amont différent. Baissé, ces
   * jambes-là sont marquées mais jamais retirées.
   */
  readonly approach: boolean;
}

/** Une jambe routée, réduite à ce que la comparaison regarde. */
export interface DedupLeg {
  readonly id: string;
  readonly direction: 'in' | 'out';
  readonly polyline: readonly GeoPoint[];
}

/**
 * `lat,lon;lat,lon;…` arrondi à `decimals` — deux tracés identiques au mètre
 * près rendent la même chaîne.
 */
export function geometrySignature(
  polyline: readonly GeoPoint[],
  decimals: number = DEDUP_COORD_DECIMALS,
): string {
  return polyline.map((p) => `${p.lat.toFixed(decimals)},${p.lon.toFixed(decimals)}`).join(';');
}

interface Held {
  readonly id: string;
  readonly signature: string;
  readonly tail: readonly GeoPoint[];
  readonly samples: readonly GeoPoint[];
}

/**
 * La fenêtre comparée : les derniers mètres d'une entrante, les premiers d'une
 * sortante. Le même choix d'extrémité que `coverApproaches` (`discovery.ts`) et
 * que l'engine, pour la même raison : une arrivée se juge sur son arrivée.
 */
function windowOf(
  polyline: readonly GeoPoint[],
  direction: 'in' | 'out',
  windowM: number,
): readonly GeoPoint[] {
  return direction === 'in'
    ? lastMetres(polyline, windowM)
    : lastMetres([...polyline].reverse(), windowM);
}

/**
 * Marque les jambes qui répètent une autre jambe DU MÊME SENS.
 *
 * L'ordre est celui reçu — les ancres par azimut, le principal avant ses
 * alternatives — et le PREMIER RENCONTRÉ GAGNE, comme la découverte
 * (`discovery.ts`, « First met wins ») et comme l'engine, qui trie par score
 * avant de dédoublonner. Une entrante n'est jamais comparée à une sortante.
 *
 * Une jambe déjà marquée ne sert pas d'original : sinon deux copies d'un même
 * tracé se nommeraient l'une l'autre et la chaîne dirait n'importe quoi.
 */
export function markDuplicates(
  legs: readonly DedupLeg[],
  windowM: number = DEDUP_WINDOW_M,
): ReadonlyMap<string, RouteDuplicate> {
  const marks = new Map<string, RouteDuplicate>();
  const held = new Map<'in' | 'out', Held[]>([
    ['in', []],
    ['out', []],
  ]);

  for (const leg of legs) {
    // Moins de deux points : rien à comparer, et `lastMetres` rendrait une
    // fenêtre dégénérée que `sameApproach` déclarerait égale à tout.
    if (leg.polyline.length < 2) continue;
    const others = held.get(leg.direction) as Held[];
    const signature = geometrySignature(leg.polyline);
    const tail = windowOf(leg.polyline, leg.direction, windowM);
    const samples = sampleEvery(tail, SAMPLE_STEP_M);

    const twin = others.find((other) => other.signature === signature);
    if (twin !== undefined) {
      marks.set(leg.id, { candidateId: twin.id, on: 'geometry' });
      continue;
    }
    const sameEnd = others.find((other) =>
      sameApproach(samples, tail, other.samples, other.tail),
    );
    if (sameEnd !== undefined) {
      marks.set(leg.id, { candidateId: sameEnd.id, on: 'approach' });
      continue;
    }
    others.push({ id: leg.id, signature, tail, samples });
  }

  return marks;
}

/** Une marque justifie-t-elle d'écarter la jambe, sous ces drapeaux ? */
export function dropsLeg(mark: RouteDuplicate | undefined, options: DedupOptions): boolean {
  if (mark === undefined || !options.enabled) return false;
  return mark.on === 'geometry' || options.approach;
}
