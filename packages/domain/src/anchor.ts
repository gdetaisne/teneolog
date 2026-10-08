/**
 * S0 — Resolve.
 *
 * Two questions, both explicit: *where* is the delivery point, and *which
 * street* do we deliver on. The second one is where the Auxerre class of defect
 * lives — a named frontage beside a same-name dead-end spur — so the decision
 * records the alternatives it rejected and why.
 */
import type { Fact } from './fact.js';
import type { GeoPoint } from './geo.js';

export interface GeocodeOpinion {
  readonly source: string;
  readonly point: GeoPoint;
  readonly score: number;
  readonly formatted: string;
  /**
   * The geocoder's own identifier for what it matched — BAN's `id`, the id of
   * a numéro. Null for a source that gives none. It says "these two runs are
   * about the same door", and lets BAN be asked again without a text search.
   */
  readonly banId: string | null;
  /**
   * WHAT the geocoder put the point on, in its own words: BAN's `type` —
   * `housenumber`, `street`, `locality`, `municipality`, `interpolation`,
   * `entrance`. A point posed on the street axis is not a point posed on a
   * door, and every measurement downstream is taken at that point. Null when
   * the source does not say, or on a run stored before the field existed.
   */
  readonly positionType: string | null;
}

/**
 * What the geocoders collectively say. A large disagreement is a fact about
 * the address, not noise to average away: it must reach the report.
 */
export interface GeocodeAgreement {
  readonly opinions: readonly GeocodeOpinion[];
  readonly chosen: GeocodeOpinion;
  readonly maxDisagreementM: number;
}

export interface RejectedStreet {
  readonly segmentId: string;
  readonly name: string | null;
  readonly distanceFromPointM: number;
  /**
   * `declared_stop_street` : pas départagée, écartée parce que
   * l'arrêt est sur une autre voie — l'arrêt de repli que le moteur a posé sur
   * sa rue d'avant, retenue sans concours ; ou un point cliqué, dont la voie
   * départage des rues que le concours laissait à égalité.
   */
  readonly reason:
    | 'lower_importance'
    | 'private'
    | 'dead_end_spur'
    | 'wrong_side'
    | 'narrower'
    | 'declared_stop_street';
}

export interface DeliveryStreet {
  readonly segmentId: string;
  readonly name: string | null;
  /** BDTOPO importance class. Lower is more structuring. */
  readonly importance: number | null;
  readonly declaredWidthM: number | null;
  /**
   * Legal direction of travel as the source declares it: true = one-way,
   * false = two-way. OSM's absent `oneway` and BDTOPO's null both read as
   * two-way — the sources' own convention, not a guess of ours. Null only
   * when no description carried a direction (older stored runs).
   */
  readonly oneWay: boolean | null;
  readonly isPrivate: boolean;
  /**
   * Candidates that were considered and set aside. Empty means there was no
   * ambiguity; a non-empty list is the explanation the report owes the reader.
   */
  readonly alternativesConsidered: readonly RejectedStreet[];
}

/**
 * Where a way stood when the delivery-street contest ended.
 *
 * `stage` is the exact place it left the funnel, `outcome` the coarse bucket a
 * reader colours by. The first three stages are the ones that used to leave no
 * trace at all: a way filtered there never reached `alternativesConsidered`, so
 * the Auxerre spur could be discarded without the report ever naming it.
 */
export type ConsideredWayStage =
  /** A `highway` class no delivery vehicle can be on. Never measured. */
  | 'non_vehicular'
  /** Farther from the point than the snap radius — or carrying no usable line. */
  | 'beyond_snap'
  /** Near enough to snap, too far behind the nearest to be a contender. */
  | 'outside_window'
  /** Folded into a neighbouring carriageway rather than competing with it. */
  | 'continuation_merged'
  /** Reached the contest as the frontage of a rival carriageway. */
  | 'compared'
  /** The delivery street. */
  | 'retained';

export type ConsideredWayOutcome =
  | 'retained'
  | 'merged_into_retained'
  | 'compared'
  | 'filtered';

/** One way the street search looked at, and what became of it. */
export interface ConsideredWay {
  readonly segmentId: string;
  readonly name: string | null;
  /** The raw OSM `highway` tag, so a reader can see what was filtered as non-vehicular. */
  readonly highway: string | null;
  /** The way's own line, as the source drew it. Referenced, never redrawn. */
  readonly geometry: readonly GeoPoint[];
  /** Distance from the delivery point to the way's axis. Null when never measured. */
  readonly distanceM: number | null;
  /**
   * Null when the end-of-road test was never run — a non-vehicular class,
   * refused before any measurement, or a way carrying no line. Every measured
   * way has an answer, snapped or not.
   *
   * `false` is "no tip provably inside the fetch", NOT "provably through": a
   * way whose end sits near the fetch boundary reads false because the tip may
   * be the cut rather than the end (BUG-003).
   */
  readonly endsInsideFetch: boolean | null;
  readonly outcome: ConsideredWayOutcome;
  readonly stage: ConsideredWayStage;
  /** The ground it was set aside on, for a way that was actually compared. */
  readonly reason: RejectedStreet['reason'] | null;
}

/**
 * Everything S0 looked at to choose the street, and the thresholds it looked
 * with — the grey layer under `DeliveryStreet`.
 *
 * It exists to be drawn: a reader cannot confirm that the engine found the
 * best anchor from a winner alone. `alternativesConsidered` shows the rivals
 * the winner beat; this shows the ones that never got to run.
 */
export interface StreetSearch {
  /** The delivery point: the origin of every `distanceM` below. */
  readonly centre: GeoPoint;
  /** Radius the neighbourhood was fetched at, around that same point. */
  readonly fetchRadiusM: number;
  readonly maxSnapM: number;
  readonly ambiguityWindowM: number;
  /** One entry per way of the neighbourhood, in the order they were examined. */
  readonly considered: readonly ConsideredWay[];
}

export interface DeliveryAnchor {
  readonly requestedAddress: string;
  readonly normalisedAddress: string;
  readonly point: Fact<GeoPoint>;
  readonly street: Fact<DeliveryStreet>;
  readonly geocodeAgreement: Fact<GeocodeAgreement>;
  /**
   * What the street search studied. Null when no neighbourhood was ever
   * fetched (the geocode failed first), and on every run stored before the
   * field existed.
   */
  readonly streetSearch: StreetSearch | null;
}
