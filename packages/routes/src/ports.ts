/**
 * S3 ports.
 *
 * The router is a CANDIDATE GENERATOR, never a legal authority
 * (routing-legality-and-largest-truck.md): it runs an agnostic car-shaped
 * profile so `access=destination` streets stay reachable and one routing
 * serves every truck. Everything legal happens after, on the annotated
 * segments.
 */
import type { GeoPoint } from '@teneolog/domain';
import type { RoadWay } from '@teneolog/topology';

export interface RoutedPath {
  readonly polyline: readonly GeoPoint[];
  readonly distanceM: number;
  readonly durationS: number;
}

export interface RoutingPort {
  /**
   * Candidate paths from `from` to `to`, the primary first. `alternatives`
   * is a request, not a promise — the router returns what it has.
   */
  route(from: GeoPoint, to: GeoPoint, alternatives: number): Promise<readonly RoutedPath[]>;
}

export interface CorridorPort {
  /** Every road way within `marginM` of the polyline — the legality scan's ground. */
  fetchCorridor(polyline: readonly GeoPoint[], marginM: number): Promise<readonly RoadWay[]>;
}
