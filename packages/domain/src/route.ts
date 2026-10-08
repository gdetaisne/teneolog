/**
 * S3 — Route candidates.
 *
 * The router proposes; the measurement layer disposes. A candidate is a
 * geometry plus the agnostic constraints found along it, never a verdict.
 */
import type { Fact } from './fact.js';
import type { GeoPoint } from './geo.js';
import type { LegalBands, Width } from './constraints.js';
import type { Turnaround } from './topology.js';

/**
 * Where a segment sits in the journey. This is what decides whether a
 * conditional access rule clears: local service is lawful on the approach to
 * the destination and on the way out, and unlawful in the middle.
 */
export type SegmentPosition = 'approach' | 'transit' | 'egress';

export interface RouteSegmentConstraint {
  readonly segmentId: string;
  readonly from: GeoPoint;
  readonly to: GeoPoint;
  readonly position: SegmentPosition;
  /**
   * The OSM `highway` class of the corridor way this run was snapped to; null
   * when the way carries no such tag.
   *
   * The bands already say what is FORBIDDEN here. The class says what KIND of
   * road it is, which is a different question and the only one that separates
   * two itineraries both of which are lawful: a departmental road and a service
   * lane can carry identical (empty) bands and are not the same proposal.
   */
  readonly highway: string | null;
  /**
   * Length of the run along the routed polyline, in metres.
   *
   * Measured on the ROUTE, not on the way: the same street crossed twice
   * contributes twice, and a way merely brushed contributes what was driven on
   * it. Without it a segment is a point of law with no extent, and "how far
   * does this itinerary travel on small roads" has no answer.
   */
  readonly lengthM: number;
  readonly legal: LegalBands;
  readonly width: Fact<Width>;
}

/**
 * How the candidate was produced.
 *
 * A car-optimal router prefers narrow shortcuts, so a set made only of
 * car-optimal candidates under-samples the routes a large vehicle would
 * actually take. Recording the strategy makes that visible: a candidate set
 * with no diversified member cannot support a confident answer for a large
 * truck.
 *
 * `discovered` is the leg no anchor produced: the discovery routed
 * it from a ray on the 2 km circle, R0 did not cover it, and the pipeline
 * promoted it to a candidate. It is named rather than folded into
 * `alternative` because the distinction is load-bearing in two places — the
 * coverage by R0 must be measured against R0 ALONE, and a run that is read
 * back must be able to say which legs the current rule would not have found.
 */
export type GenerationStrategy =
  | 'car-optimal'
  | 'arterial-biased'
  | 'axis-seeded'
  | 'alternative'
  | 'discovered';

/**
 * CE QUI A CONFONDU DEUX JAMBES.
 *
 * L'engine dédoublonne ses arrivées sur deux signatures indépendantes
 * (`itinerary-route-candidates/selection.ts` l.59-96) : la GÉOMÉTRIE complète,
 * arrondie à 5 décimales (~1,1 m), et les RUES BD TOPO des 500 derniers mètres
 * (`arrivalLastMileStreetSignature`) ; une sortie sur la géométrie et ses 500
 * PREMIERS mètres. Le port garde les deux et DIT LAQUELLE A JOUÉ, parce
 * qu'elles ne valent pas la même chose : `geometry` est indiscutable — le même
 * tracé, au mètre près — quand `approach` confond deux jambes qui ne se
 * rejoignent que sur la fin, donc efface une différence en amont que l'app,
 * elle, contrôle sur toute l'approche (principe 7).
 */
export type RouteDuplicateSignature = 'geometry' | 'approach';

export interface RouteDuplicate {
  /** La jambe dont celle-ci est la copie : la première rencontrée, jamais une autre. */
  readonly candidateId: string;
  readonly on: RouteDuplicateSignature;
}

/**
 * UNE JAMBE QUI TRAVERSE UNE AUTRE ANCRE.
 *
 * L'engine pose `passes_through_other_gate` et
 * `passes_through_other_gate:<ancre>` quand la jambe passe à moins de
 * `GATE_SITE_PROXIMITY_M` (30 m) de la zone d'une autre ancre
 * (`itinerary-fast-filters.ts:12,292-360`), et peut alors l'éliminer. Ici la
 * marque est une LECTURE : elle ne retire rien, elle dit que deux ancres
 * alignées sur la même pénétrante ont produit deux itinéraires qui se
 * ressemblent — ce que l'opérateur ne pouvait pas voir.
 */
export interface GatePassMark {
  /** L'ancre traversée, sous la clé de R0 : `wayId@azimut`. */
  readonly gateId: string;
  /** À combien de mètres du point de cette ancre la jambe est passée. */
  readonly distanceM: number;
}

/**
 * UN TRONÇON DE CORRIDOR QUE
 * LA CARTE ROUTIÈRE N'A PAS RENDU.
 *
 * Les échantillons d'un itinéraire qui ne tombent à portée d'AUCUNE voie
 * roulable du corridor : une tuile Overpass en échec, un trou de couverture. Ce
 * n'est pas « pas de restriction ici », c'est « on n'a rien lu ici » — et sans
 * cet objet la différence ne se voyait nulle part, ni sur le fil, ni à l'écran
 * (principe 1 : ce qu'on ne contrôle pas est listé).
 *
 * Il n'y a PAS de référence de voie pour le tronçon lui-même, et il ne peut pas
 * y en avoir : la voie est précisément ce qui manque. Ce que le tronçon peut
 * nommer, ce sont ses VOISINS — la voie sur laquelle l'itinéraire roulait avant
 * le trou, celle qu'il retrouve après — et sa position le long de l'itinéraire.
 */
export interface UnreadStretch {
  /** Le premier échantillon non apparié du tronçon. */
  readonly from: GeoPoint;
  /** Le dernier. */
  readonly to: GeoPoint;
  /** Le MILIEU du tronçon : le lieu que la question nomme et que la carte montre. */
  readonly at: GeoPoint;
  /** Distance parcourue depuis le début de l'itinéraire, en mètres. */
  readonly fromAlongM: number;
  readonly toAlongM: number;
  /** La voie que l'itinéraire quittait, `null` quand le trou ouvre la jambe. */
  readonly afterSegmentId: string | null;
  /** La voie qu'il retrouve, `null` quand le trou la ferme. */
  readonly beforeSegmentId: string | null;
}

export interface RouteCandidate {
  readonly id: string;
  readonly direction: 'in' | 'out';
  readonly polyline: readonly GeoPoint[];
  readonly segments: readonly RouteSegmentConstraint[];
  readonly generatedBy: GenerationStrategy;
  readonly distanceM: number;
  readonly durationS: number;
  /**
   * Corridor sample accounting: how many route-sample points were matched to a
   * drivable way within snapM vs. the total sampled along the polyline.
   * An unmatched stretch contributes zero segments and zero legal coverage —
   * a half-mute corridor is indistinguishable from a clean one without this.
   */
  readonly coverage: { readonly sampled: number; readonly matched: number };
  /**
   * Reason codes set by S3 (routes) based on corridor quality, for S5 to
   * consume without re-deriving. Current values:
   *   `corridor_partial` — matched/sampled fell below the `minCorridorCoverage`
   *   policy threshold.
   */
  readonly corridorReasonCodes: readonly string[];
  /**
   * On an outbound candidate: the inbound it continues, and the manoeuvre at
   * the stop that joins the two.
   *
   * Feasibility at the stop is a property of the *pairing*, not of either leg
   * alone — which is why an on-site reversal proposed as a valid route was able
   * to recur. `known: false, why: 'not_applicable'` is a drive-through; a known
   * value with `surface: 'carriageway'` is a reversal on the road itself, and it
   * carries the diameter it would need. Null on inbound candidates.
   */
  readonly egressOf: {
    readonly inboundId: string;
    readonly turnaround: Fact<Turnaround>;
  } | null;
  /**
   * la jambe dont celle-ci répète l'itinéraire, et sur quelle
   * signature. Null quand elle n'est la copie de personne.
   *
   * Posée EN SILENCE : `routes.dedup.enabled` baissé, le doublon est marqué,
   * gardé, annoté et jugé exactement comme avant. Levé, il est écarté avant son
   * corridor et c'est l'original qui le nomme (`duplicatesRemoved`).
   *
   * Optionnelle, comme `phase2` sur `FullParams` : un appelant écrit avant la
   * tâche compile et ne paie rien.
   */
  readonly duplicateOf?: RouteDuplicate | null;
  /**
   * les jambes écartées PARCE QU'ELLES RÉPÈTENT celle-ci.
   *
   * Vide tant que `routes.dedup.enabled` est baissé : rien n'est écarté, donc
   * rien n'est à nommer, et chaque doublon est là pour se montrer lui-même.
   * Levé, c'est la seule trace de ce qui a disparu — principe 1 : ce qu'on ne
   * contrôle pas est listé, jamais sauté en silence.
   */
  readonly duplicatesRemoved?: readonly string[];
  /**
   * l'ancre retenue que cette jambe traverse en chemin, s'il y en a
   * une. Une LECTURE : rien ne l'élimine, aucun classement ne la lit.
   */
  readonly passesThroughGate?: GatePassMark | null;
  /**
   * LES TRONÇONS QUE LA CARTE N'A PAS RENDUS, dans l'ordre du
   * parcours. C'est la MATIÈRE du `corridor_partial` / `corridor_empty` que S5
   * pose ensuite : sans elle, le doute existait sans lieu, donc sans question
   * possible pour l'opérateur (audit L5-2).
   *
   * ADDITIF, comme `duplicateOf` : le champ n'est posé que lorsqu'il dit
   * quelque chose. Une jambe entièrement lue ne porte pas `corridorUnread: []`
   * — un tableau vide sur une jambe est déjà une affirmation, et retirer le
   * champ doit rendre le candidat d'avant la tâche, au bit près (test d'or).
   */
  readonly corridorUnread?: readonly UnreadStretch[];
}
