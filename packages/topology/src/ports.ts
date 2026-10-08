/**
 * Ports — what S0 and S1 need from the outside world.
 *
 * Everything below this line is data. The logic in this package is pure: it
 * takes a neighbourhood and returns an assessment, so every field case in the
 * corpus is a fixture, not an integration test.
 *
 * Adapters (BDTOPO PostGIS, Overpass, IGN, BAN, Google) live elsewhere and are
 * the only place a network call may appear.
 */
import type { GeoPoint, GeocodeOpinion, SourceId } from '@teneolog/domain';

import type { WayAttribution } from './attribution.js';

/** Direction of legal travel on a way, relative to its node order. */
export type OneWay = 'no' | 'forward' | 'backward';

/** Legal limits as a source states them. Null means the source said nothing. */
export interface DeclaredLimits {
  readonly maxWeightT: number | null;
  readonly maxHeightM: number | null;
  readonly maxWidthM: number | null;
  readonly maxLengthM: number | null;
}

/**
 * A road segment as a source describes it.
 *
 * Deliberately close to the raw shape of BDTOPO and OSM. Normalising further
 * here would hide the disagreements the domain wants to keep visible.
 */
export interface RoadWay {
  readonly id: string;
  readonly source: SourceId;
  /** Ordered node ids. Shared ids between ways are what make the graph. */
  readonly nodeIds: readonly string[];
  readonly geometry: readonly GeoPoint[];
  readonly name: string | null;
  /** BDTOPO importance class, 1 (most structuring) to 5. Null when unknown. */
  readonly importance: number | null;
  readonly declaredWidthM: number | null;
  readonly laneCount: number | null;
  readonly oneWay: OneWay;
  readonly isPrivate: boolean;
  readonly limits: DeclaredLimits;
  /** Raw access-ish tags, kept verbatim: `access`, `hgv`, `motor_vehicle`, `highway`… */
  readonly tags: Readonly<Record<string, string>>;
  /**
   * Provenance of the values this way did NOT state itself, grafted from a
   * second source (`attribution.ts`). Absent on a way that stated everything
   * it carries — which is every way, everywhere, until a graft runs.
   *
   * It exists so `source` can keep meaning "who drew this road" while a
   * borrowed attribute still says where it actually came from. Publishing a
   * BD TOPO width under an OSM provenance would be the same lie cut.
   */
  readonly attributed?: WayAttribution;
}

export interface RoadNode {
  readonly id: string;
  readonly at: GeoPoint;
  /** Ids of every way that uses this node. Length 1 at a way tip. */
  readonly wayIds: readonly string[];
  /** `highway=turning_circle`, `highway=turning_loop`, `barrier=bollard`… */
  readonly tags: Readonly<Record<string, string>>;
}

/**
 * Everything fetched around a point, with the radius it was fetched at.
 *
 * The radius travels with the data because a way tip near the edge of the fetch
 * is not evidence of anything — it may simply be where we stopped looking.
 */
export interface RoadNeighbourhood {
  readonly centre: GeoPoint;
  readonly radiusM: number;
  readonly ways: readonly RoadWay[];
  readonly nodes: readonly RoadNode[];
}

/** An open area that a vehicle might turn around on. */
export interface Surface {
  readonly id: string;
  readonly kind: 'parking' | 'square' | 'yard' | 'area_highway' | 'field_entrance';
  readonly polygon: readonly GeoPoint[];
  readonly isPrivate: boolean;
  readonly source: SourceId;
}

export interface RoadGraphPort {
  /** May return more than asked for; must never return less without saying so. */
  fetchNeighbourhood(centre: GeoPoint, radiusM: number): Promise<RoadNeighbourhood>;
}

export interface SurfacePort {
  fetchSurfaces(centre: GeoPoint, radiusM: number): Promise<readonly Surface[]>;
}

export interface GeocodePort {
  /** One opinion per provider consulted. Disagreement is the caller's business. */
  geocode(address: string): Promise<readonly GeocodeOpinion[]>;
}

export interface TopologyPorts {
  readonly graph: RoadGraphPort;
  readonly surfaces: SurfacePort;
  readonly geocode: GeocodePort;
}
