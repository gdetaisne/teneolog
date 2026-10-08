/**
 * Coordinate vocabulary.
 *
 * One GPS point type for the whole system. `lng` does not exist here — the
 * `lat/lng` vs `lat/lon` drift was a real, recurring defect and it is closed by
 * having a single declared shape.
 */

/** WGS84. The only GPS point type in the system. */
export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

/** Degrees clockwise from true north, normalised to [0, 360). */
export type BearingDeg = number;

declare const roleTag: unique symbol;

/**
 * Attaches a role to a value so the compiler refuses to swap two values that
 * have the same shape but different meaning.
 */
type Role<T, R extends string> = T & { readonly [roleTag]: R };

/** Where the truck reaches the stop. Cannot be passed where an exit is expected. */
export type ArrivalPoint = Role<GeoPoint, 'arrival'>;
/** Where the truck leaves from. Cannot be passed where an arrival is expected. */
export type ExitPoint = Role<GeoPoint, 'exit'>;

/** Heading of the truck on arrival at the stop. */
export type ArrivalHeadingDeg = Role<BearingDeg, 'arrival'>;
/** Heading of the truck as it leaves the stop. */
export type EgressHeadingDeg = Role<BearingDeg, 'egress'>;

/**
 * Which frame a non-GPS geometry lives in. Any pixel or local-metric payload
 * carries this; a bare array of numbers is not an acceptable geometry.
 */
export interface FrameProvenance {
  readonly frame: 'stitchedPixel' | 'axisMetric' | 'truckLocal';
  /** Frame origin in WGS84 — for the stitched canvas, the centre of tile A. */
  readonly origin: GeoPoint;
  /** Pixels per ground metre. Null for metric frames. */
  readonly pxPerM: number | null;
  /** Frame rotation: the axis bearing the frame is aligned to. */
  readonly bearingDeg: BearingDeg;
  /**
   * BDTOPO to ortho registration offset, in metres, decomposed East/North.
   * Positive lateral offset means a shift along the axis' RIGHT normal.
   */
  readonly coregOffsetM: { readonly east: number; readonly north: number } | null;
  readonly coregConfidence: number | null;
}
