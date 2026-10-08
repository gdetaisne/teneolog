/**
 * Stable identity of a critical point: its TYPE and its PLACE, never the run
 * that found it.
 *
 * This is what lets a human answer outlive the run (architecture §3.3): the
 * same corner, found again next week by another analysis or another
 * candidate, carries the same reference and finds the judgement already
 * recorded against it. Coordinates are rounded to ~11 m so routing jitter
 * between runs does not mint a new identity for the same corner — and two
 * genuinely distinct manoeuvres 5 m apart are one place as far as a reviewer
 * on an aerial photo is concerned.
 */
import type { CriticalPointType, GeoPoint, PointRef } from '@teneolog/domain';

const REF_DECIMALS = 4;

export function makePointRef(type: CriticalPointType, at: GeoPoint): PointRef {
  return `${type}@${at.lat.toFixed(REF_DECIMALS)},${at.lon.toFixed(REF_DECIMALS)}`;
}
