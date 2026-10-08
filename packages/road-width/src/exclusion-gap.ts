/**
 * Gaps narrower than this between exclusion zones cannot be carriageway (19T assumption).
 */
export const MIN_ROAD_GAP_BETWEEN_EXCLUSIONS_M = 1.5;

function isCoreBinaryExclusion(
  buildingCost: readonly number[],
  vegCost: readonly number[],
  parkingCost: readonly number[],
  k: number,
): boolean {
  return (
    (buildingCost[k] ?? 0) > 0 ||
    (vegCost[k] ?? 0) > 0 ||
    (parkingCost[k] ?? 0) > 0
  );
}

/**
 * Mark narrow gaps between exclusion runs as excluded (`bdtopoHardCost = 1`).
 * Only fills gaps with exclusion on both sides (not at profile edges).
 */
export function fillNarrowGapsBetweenBinaryExclusions(
  bdtopoBuildingCost: number[],
  bdtopoVegetationCost: number[],
  parkingExclusion: number[],
  bdtopoHardCost: number[],
  offsetsM: readonly number[],
  minGapM = MIN_ROAD_GAP_BETWEEN_EXCLUSIONS_M,
): number {
  const n = offsetsM.length;
  if (n < 3) return 0;

  const stepM = offsetsM[1]! - offsetsM[0]!;
  let filled = 0;
  let k = 0;

  while (k < n) {
    while (k < n && isCoreBinaryExclusion(bdtopoBuildingCost, bdtopoVegetationCost, parkingExclusion, k)) {
      k++;
    }
    const gapStart = k;
    while (k < n && !isCoreBinaryExclusion(bdtopoBuildingCost, bdtopoVegetationCost, parkingExclusion, k)) {
      k++;
    }
    const gapEnd = k - 1;

    if (gapStart <= gapEnd && gapStart > 0 && gapEnd < n - 1) {
      const widthM = (gapEnd - gapStart + 1) * stepM;
      if (widthM < minGapM) {
        for (let j = gapStart; j <= gapEnd; j++) {
          if (bdtopoHardCost[j]! === 0) filled++;
          bdtopoHardCost[j] = 1;
        }
      }
    }
  }

  return filled;
}
