/** Parked-car lateral band (metres from road axis). */
export interface CarZone {
  side: 'left' | 'right';
  /** Near edge (closest to road centre), signed metres from road axis. */
  innerEdgeM: number;
  /** Far edge (away from road centre), signed metres. */
  outerEdgeM: number;
  widthM: number;
  level: 'certain' | 'metallic_grey' | 'matte_grey';
  confidence: number;
  notes: string[];
}

/** Lateral inset when clamping to a parked car inner edge. Zero: D10 reports raw geometry;
 *  comfort margins live in DrivingPolicy (ADR-042 / ADR-047 §11). */
export const CAR_KERB_OFFSET_M = 0;

export function applyCarClamping(
  leftM: number,
  rightM: number,
  zones: CarZone[],
  notes: string[],
): { leftM: number; rightM: number } {
  let l = leftM;
  let r = rightM;

  for (const zone of zones) {
    if (zone.side === 'right') {
      const clamp = zone.innerEdgeM - CAR_KERB_OFFSET_M;
      if (clamp < r) {
        r = clamp;
        notes.push(`car_clamp_R:${zone.innerEdgeM.toFixed(2)}m[${zone.level}]`);
      }
    } else {
      const clamp = zone.innerEdgeM + CAR_KERB_OFFSET_M;
      if (clamp > l) {
        l = clamp;
        notes.push(`car_clamp_L:${zone.innerEdgeM.toFixed(2)}m[${zone.level}]`);
      }
    }
  }

  return { leftM: l, rightM: r };
}
