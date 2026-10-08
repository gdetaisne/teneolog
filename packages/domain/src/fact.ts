/**
 * The fact envelope.
 *
 * Every measured or observed value in the system travels inside a `Fact`. A
 * fact carries where it came from and what it is worth, and absence is one of
 * its two shapes rather than a null someone may default away.
 *
 * This is the device that closes the "false OK from a missing measurement"
 * class: `Fact<T>` cannot be read without deciding what to do when it is not
 * known.
 */
import type { FrameProvenance } from './geo.js';

export type SourceId =
  | 'bdtopo-postgis'
  | 'bdtopo-wfs'
  | 'osm-overpass'
  | 'ign-ortho'
  | 'osrm'
  | 'geocoder-ban'
  | 'geocoder-google'
  | 'elevation'
  /** Base nationale consolidée des zones à faibles émissions. */
  | 'bnzfe'
  | 'human';

/** How a value came to be, independently of which service produced it. */
export type Basis =
  /** Read off an instrument or an image. */
  | 'measured'
  /** Computed from other facts by a pure function. */
  | 'derived'
  /** Stated by a data source as an attribute, not measured by us. */
  | 'declared'
  /** Answered by a person. */
  | 'human';

export interface Provenance {
  readonly source: SourceId;
  /** The named method that produced the value, e.g. 'd10v2', 'degree-1-topology'. */
  readonly method: string;
  /** When the value was acquired. ISO 8601. */
  readonly fetchedAt: string;
  /**
   * Capture date of the imagery the value rests on, when it rests on imagery.
   * Facts made on a photograph cannot be fresher than the photograph.
   */
  readonly imageryDate?: string;
  readonly frame?: FrameProvenance;
}

export interface Reliability {
  /** 0..1. One scale for the whole system — see the confidence contract. */
  readonly confidence: number;
  readonly basis: Basis;
  readonly reasonCodes: readonly string[];
}

/** Why a fact is not known. Absence always has a stated cause. */
export type UnknownReason =
  | 'no_data'
  | 'out_of_coverage'
  | 'provider_error'
  | 'not_visible'
  | 'below_confidence'
  | 'budget_exceeded'
  | 'not_applicable';

export type Fact<T> =
  | {
      readonly known: true;
      readonly value: T;
      readonly provenance: Provenance;
      readonly reliability: Reliability;
    }
  | {
      readonly known: false;
      readonly why: UnknownReason;
      /** Present when a source was consulted and returned nothing usable. */
      readonly provenance?: Provenance;
    };

/**
 * A pointer to a fact, used by verdicts to record what they were derived from.
 * Verdicts are derived, never authored: a verdict that cannot name its inputs
 * is a bug.
 */
export interface FactRef {
  readonly path: string;
  readonly source: SourceId;
  readonly confidence: number;
}
