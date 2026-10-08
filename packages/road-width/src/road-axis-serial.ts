/**
 * Serializable road axis for worker postMessage — avoids rebuilding BDTOPO masks on rehydrate.
 */

import type { AxisSample, RoadAxis } from './geometry.js';

function bearingFallbackAxis(
  W: number,
  H: number,
  pxPerM: number,
  bearingDeg: number,
): RoadAxis {
  const bearingRad = (bearingDeg * Math.PI) / 180;
  const fbTanX = Math.sin(bearingRad);
  const fbTanY = -Math.cos(bearingRad);
  const fbPerpX = -fbTanY;
  const fbPerpY = fbTanX;
  return {
    anchor: { x: W / 2, y: H / 2 },
    spanM: Math.hypot(W, H) / pxPerM / 2,
    axisAt: (t: number) => ({
      cx: W / 2 + t * pxPerM * fbTanX,
      cy: H / 2 + t * pxPerM * fbTanY,
      tangentX: fbTanX,
      tangentY: fbTanY,
      perpX: fbPerpX,
      perpY: fbPerpY,
    }),
  };
}

export type SerializableRoadAxis =
  | {
      readonly kind: 'bearing-fallback';
      readonly W: number;
      readonly H: number;
      readonly pxPerM: number;
      readonly bearingDeg: number;
    }
  | {
      readonly kind: 'polyline';
      readonly pxPerM: number;
      readonly anchor: { readonly x: number; readonly y: number };
      readonly spanM: number;
      readonly anchorMeters: number;
      readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>;
      readonly cumLenM: readonly number[];
      readonly segTanX: readonly number[];
      readonly segTanY: readonly number[];
      readonly segLenPx: readonly number[];
    };

/** Rebuild `RoadAxis.axisAt` from worker-serialized polyline data (no BDTOPO raster). */
export function hydrateRoadAxis(serial: SerializableRoadAxis): RoadAxis {
  if (serial.kind === 'bearing-fallback') {
    return bearingFallbackAxis(serial.W, serial.H, serial.pxPerM, serial.bearingDeg);
  }

  const {
    pxPerM,
    anchor,
    spanM,
    anchorMeters,
    points: ordered,
    cumLenM: cumLenArr,
    segTanX: segTanXArr,
    segTanY: segTanYArr,
    segLenPx: segLenPxArr,
  } = serial;
  const N = ordered.length;
  const cumLenM = Float64Array.from(cumLenArr);
  const segTanX = Float64Array.from(segTanXArr);
  const segTanY = Float64Array.from(segTanYArr);
  const segLenPx = Float64Array.from(segLenPxArr);
  const totalM = cumLenM[N - 1]!;

  const axisAt = (tMeters: number): AxisSample => {
    const target = anchorMeters + tMeters;
    if (target <= 0) {
      const tx = segTanX[0]!;
      const ty = segTanY[0]!;
      const dPx = target * pxPerM;
      return {
        cx: ordered[0]!.x + dPx * tx,
        cy: ordered[0]!.y + dPx * ty,
        tangentX: tx,
        tangentY: ty,
        perpX: -ty,
        perpY: tx,
      };
    }
    if (target >= totalM) {
      const k = N - 2;
      const tx = segTanX[k]!;
      const ty = segTanY[k]!;
      const dPx = (target - totalM) * pxPerM;
      return {
        cx: ordered[N - 1]!.x + dPx * tx,
        cy: ordered[N - 1]!.y + dPx * ty,
        tangentX: tx,
        tangentY: ty,
        perpX: -ty,
        perpY: tx,
      };
    }
    let lo = 0;
    let hi = N - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cumLenM[mid]! <= target) lo = mid;
      else hi = mid;
    }
    const seg = lo;
    const u = (target - cumLenM[seg]!) * pxPerM / segLenPx[seg]!;
    const tx = segTanX[seg]!;
    const ty = segTanY[seg]!;
    const a = ordered[seg]!;
    const b = ordered[seg + 1]!;
    return {
      cx: a.x + u * (b.x - a.x),
      cy: a.y + u * (b.y - a.y),
      tangentX: tx,
      tangentY: ty,
      perpX: -ty,
      perpY: tx,
    };
  };

  return { anchor: { ...anchor }, spanM, axisAt };
}
