/**
 * S2 — slope of the delivery street at the stop.
 *
 * Inherited from the engine (BUG Montée des Balmes / Reyrieux): sample two
 * elevations along the ROAD AXIS around the stop, never a fixed north/south
 * window. A perpendicular sample reads the hillside cross-slope and invents
 * a steep street. No axis → no number.
 */
import type { GeoPoint } from '@teneolog/domain';
import {
  bearingDeg,
  closestPointOnPolyline,
  haversineM,
  offsetPoint,
  type RoadWay,
} from '@teneolog/topology';

/**
 * Half-window along the delivery axis, metres. Symmetric so the grade is the
 * local street approach, not a one-sided ramp.
 */
export const SLOPE_HALF_WINDOW_M = 50;

/** Below this, a segment is not an axis and a pair is not a run. */
const MIN_RUN_M = 1;

export interface SlopeSample {
  readonly from: GeoPoint;
  readonly to: GeoPoint;
  readonly axisBearingDeg: number;
}

/** Bearing of the street at the stop. Null when the geometry has no usable segment. */
export function deliveryAxisBearingDeg(at: GeoPoint, street: RoadWay): number | null {
  const projection = closestPointOnPolyline(street.geometry, at);
  if (projection === null) return null;
  const from = street.geometry[projection.segmentIndex];
  const to = street.geometry[projection.segmentIndex + 1];
  if (from === undefined || to === undefined) return null;
  if (haversineM(from, to) < MIN_RUN_M) return null;
  return bearingDeg(from, to);
}

export function slopeSamplePoints(
  at: GeoPoint,
  axisBearingDeg: number,
  halfWindowM = SLOPE_HALF_WINDOW_M,
): SlopeSample {
  return {
    from: offsetPoint(at, (axisBearingDeg + 180) % 360, halfWindowM),
    to: offsetPoint(at, axisBearingDeg, halfWindowM),
    axisBearingDeg,
  };
}

/**
 * Unsigned grade in percent. Null when the two points collapse (run < 1 m).
 */
export function slopePctFromElevations(
  from: GeoPoint,
  to: GeoPoint,
  elevationFromM: number,
  elevationToM: number,
): number | null {
  const runM = haversineM(from, to);
  if (runM < MIN_RUN_M) return null;
  return (Math.abs(elevationToM - elevationFromM) / runM) * 100;
}
