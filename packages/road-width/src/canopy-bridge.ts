/**
 * Aerial tree canopy: green pixels not registered in BDTOPO are likely treetops
 * in orthophoto — ground below is unknown. If the lateral score profile shows road
 * before or after that offset, assume pavement continues under the canopy.
 */

/** Max lateral gap (profile steps) to search for a road anchor when bridging. */
export const CANOPY_BRIDGE_MAX_GAP_STEPS = 16;

export function nearestRoadScoreAlongProfile(
  profile: readonly number[],
  fromK: number,
  direction: -1 | 1,
  maxSteps: number,
  roadT: number,
): number | null {
  for (let step = 1; step <= maxSteps; step++) {
    const j = fromK + direction * step;
    if (j < 0 || j >= profile.length) break;
    const v = profile[j]!;
    if (v >= roadT) return v;
  }
  return null;
}

export interface CanopyBridgeResult {
  readonly profile: number[];
  readonly bridgedCount: number;
}

/** Re-apply canopy bridge after a profile patch (e.g. YOLO vehicle rescore). */
export function rebridgeProfileScores(
  profile: readonly number[],
  aerialCanopyAtK: readonly number[],
  hardExcludedAtK: readonly number[],
  roadT: number,
): CanopyBridgeResult {
  return bridgeProfileThroughAerialCanopy(profile, aerialCanopyAtK, hardExcludedAtK, roadT);
}

/**
 * Raise score under aerial-canopy offsets when at least one side of the profile
 * already scores as road (same ENTER threshold as plateau detection).
 */
export function bridgeProfileThroughAerialCanopy(
  profile: readonly number[],
  aerialCanopyAtK: readonly number[],
  hardExcludedAtK: readonly number[],
  roadT: number,
  maxGapSteps = CANOPY_BRIDGE_MAX_GAP_STEPS,
): CanopyBridgeResult {
  const out = [...profile];
  let bridgedCount = 0;

  for (let k = 0; k < out.length; k++) {
    if (aerialCanopyAtK[k]! < 0.5) continue;
    if (hardExcludedAtK[k]! > 0.5) continue;
    if (out[k]! >= roadT) continue;

    const left = nearestRoadScoreAlongProfile(out, k, -1, maxGapSteps, roadT);
    const right = nearestRoadScoreAlongProfile(out, k, 1, maxGapSteps, roadT);
    if (left === null && right === null) continue;

    const bridged =
      left !== null && right !== null ? Math.min(left, right) : (left ?? right)!;
    if (bridged > out[k]!) {
      out[k] = bridged;
      bridgedCount++;
    }
  }

  return { profile: out, bridgedCount };
}
