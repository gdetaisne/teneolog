import type { ProfileResultView } from './types.js';
import type { Plateau } from './types.js';
import { computeSidewalkBoundaryCandidateCurve } from './sidewalk-boundary-candidate.js';
import { BDTOPO_V2_BAND_HALF_M } from './d10v2-banded-width.js';
import { computeWeightedKerbPair } from './kerb-candidate-score.js';
import {
  assessFlatSaturatedPlateau,
  isPlateauWidthSuspicious,
} from './plateau-safety.js';

/** Extra lateral margin (m) added to BDTOPO width before halving for crop. */
export const D10V2_CROP_MARGIN_M = 2;

/** Reject kerb candidates snapped to the crop window edge (artefact). */
export const D10V2_CROP_EDGE_MARGIN_M = 0.35;

/**
 * Use the weighted kerb-candidate scorer (LEVEL 0/1/2) instead of the legacy
 * boolean cascade for D10v2 structural width. Reversible via env flag.
 * Design: la note de conception interne
 */
export function isWeightedKerbEnabled(): boolean {
  return (process.env.D10V2_WEIGHTED_KERB ?? '1') !== '0';
}

function isNearCropEdge(offsetM: number, cropHalfM: number): boolean {
  return Math.abs(Math.abs(offsetM) - cropHalfM) <= D10V2_CROP_EDGE_MARGIN_M;
}

function plateauCrossesAxis(leftM: number, rightM: number): boolean {
  return leftM < 0 && rightM > 0;
}

export type D10V2SimpleSource = 'kerb_pair' | 'plateau' | 'unavailable';
export type D10V2ScoringBucket =
  | 'credible_kerb'
  | 'uncertain_kerb'
  | 'credible_plateau'
  | 'uncertain_plateau'
  | 'saturated_plateau'
  | 'prior_mismatch'
  | 'no_plateau'
  | 'unavailable';
export type D10V2VehicleEvidenceQuality =
  | 'none'
  | 'circulating_only'
  | 'parked_observed_no_clamp'
  | 'parked_clamped'
  | 'uncertain_vehicle_overlap';
export type D10V2EvidenceStrength = 'none' | 'weak' | 'medium' | 'strong';
export type D10V2StructuralEdgeEvidenceKind =
  | 'confirmed_kerb_pair'
  | 'one_sided_kerb_candidate'
  | 'no_confirmed_edge';
export type D10V2RollableBoundaryEvidenceKind =
  | 'parking_clamp'
  | 'parking_observed_no_clamp'
  | 'truck_observed_passage'
  | 'none';
export type D10V2PlateauEvidenceKind =
  | 'axis_crossing_plateau'
  | 'off_axis_plateau'
  | 'rejected_plateau'
  | 'no_plateau';

export interface D10V2EvidenceSummary<Kind extends string> {
  readonly kind: Kind;
  readonly strength: D10V2EvidenceStrength;
  readonly reasonCodes: readonly string[];
}

export interface D10V2TruckEvidence {
  readonly observed: boolean;
  readonly observedPassageMinM: number | null;
  readonly source: 'yolo-large-vehicle' | null;
  readonly reasonCodes: readonly string[];
}

export interface D10V2SimpleResult {
  readonly cropHalfM: number;
  readonly bdtopoWidthM: number | null;
  /** Structural width between kerbs (pre-parking). */
  readonly largeurRueM: number | null;
  /** Rollable width after YOLO parking rules. */
  readonly largeurExploitableM: number | null;
  readonly leftEdgeM: number | null;
  readonly rightEdgeM: number | null;
  readonly leftRollableM: number | null;
  readonly rightRollableM: number | null;
  readonly source: D10V2SimpleSource;
  readonly scoringBucket: D10V2ScoringBucket;
  readonly vehicleEvidenceQuality: D10V2VehicleEvidenceQuality;
  readonly truckEvidence: D10V2TruckEvidence;
  readonly structuralEdgeEvidence: D10V2EvidenceSummary<D10V2StructuralEdgeEvidenceKind>;
  readonly rollableBoundaryEvidence: D10V2EvidenceSummary<D10V2RollableBoundaryEvidenceKind>;
  readonly plateauEvidence: D10V2EvidenceSummary<D10V2PlateauEvidenceKind>;
  readonly reasonCodes: readonly string[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Per-side crop half-width from BDTOPO carriageway width (m). */
export function d10v2CropHalfM(bdtopoWidthM: number): number {
  return round2((bdtopoWidthM + D10V2_CROP_MARGIN_M) / 2);
}

function pickChosenPlateau(plateaux: readonly Plateau[]): Plateau | null {
  if (plateaux.length === 0) return null;
  const containing = plateaux.filter((p) => p.startM <= 0 && p.endM >= 0);
  if (containing.length > 0) {
    return containing.sort((a, b) => a.widthM - b.widthM)[0]!;
  }
  return plateaux.slice().sort((a, b) => {
    const ca = (a.startM + a.endM) / 2;
    const cb = (b.startM + b.endM) / 2;
    return Math.abs(ca) - Math.abs(cb);
  })[0]!;
}

function withScoringBucket<T extends { reasonCodes: readonly string[] }>(
  result: T,
  scoringBucket: D10V2ScoringBucket,
): T & { scoringBucket: D10V2ScoringBucket } {
  return {
    ...result,
    scoringBucket,
    reasonCodes: [...result.reasonCodes, `d10v2:bucket:${scoringBucket}`],
  };
}

function vehicleEvidenceQuality(
  structural: Pick<D10V2SimpleResult, 'largeurRueM' | 'reasonCodes'>,
  rollableProfile: ProfileResultView,
): D10V2VehicleEvidenceQuality {
  const totalYolo = rollableProfile.yoloBboxes?.length ?? 0;
  const parked = rollableProfile.parkedYoloBboxes?.length ?? 0;
  const circulatingNote = rollableProfile.notes.find((note) => note.startsWith('yolo_circulating:'));
  const classifiedCirculating = (rollableProfile.yoloClassifications ?? [])
    .filter((c) => c.status === 'circulating').length;
  const noteCirculating = Number.parseInt(circulatingNote?.slice('yolo_circulating:'.length) ?? '0', 10);
  const circulating = classifiedCirculating > 0 ? classifiedCirculating : noteCirculating;
  const hasCirculating = Number.isFinite(circulating) && circulating > 0;
  const structuralWidth = structural.largeurRueM;
  const exploitable = rollableProfile.widthM;
  const parkingApplied =
    structuralWidth != null
    && exploitable != null
    && exploitable < structuralWidth;

  if (parked > 0 && parkingApplied) return 'parked_clamped';
  if (
    parked > 0
    && structuralWidth != null
    && exploitable != null
    && exploitable > structuralWidth
  ) {
    return 'uncertain_vehicle_overlap';
  }
  if (parked > 0) return 'parked_observed_no_clamp';
  if (totalYolo > 0 && hasCirculating) return 'circulating_only';
  if (totalYolo > 0) return 'uncertain_vehicle_overlap';
  return 'none';
}

function truckEvidenceFromYolo(rollableProfile: ProfileResultView): D10V2TruckEvidence {
  const largeCirculating = (rollableProfile.yoloClassifications ?? []).filter(
    (c) => c.bbox.class_name === 'large-vehicle' && c.status === 'circulating',
  );
  if (largeCirculating.length === 0) {
    return {
      observed: false,
      observedPassageMinM: null,
      source: null,
      reasonCodes: ['truck_evidence:none'],
    };
  }
  return {
    observed: true,
    observedPassageMinM: 2.5,
    source: 'yolo-large-vehicle',
    reasonCodes: [
      'truck_evidence:yolo_large_vehicle_circulating',
      'truck_evidence:observed_passage_min=2.5',
    ],
  };
}

function structuralEdgeEvidence(
  structural: Pick<D10V2SimpleResult, 'source' | 'scoringBucket' | 'reasonCodes'>,
): D10V2EvidenceSummary<D10V2StructuralEdgeEvidenceKind> {
  if (structural.source === 'kerb_pair') {
    return {
      kind: 'confirmed_kerb_pair',
      strength: structural.scoringBucket === 'credible_kerb' ? 'strong' : 'medium',
      reasonCodes: ['d10v2:evidence:structural_edge:confirmed_kerb_pair'],
    };
  }
  const hasOneSidedKerbCandidate = structural.reasonCodes.some((code) =>
    code.startsWith('kerb_w:pair=') || code.startsWith('kerb_weighted:'),
  );
  if (hasOneSidedKerbCandidate) {
    return {
      kind: 'one_sided_kerb_candidate',
      strength: 'weak',
      reasonCodes: ['d10v2:evidence:structural_edge:one_sided_kerb_candidate'],
    };
  }
  return {
    kind: 'no_confirmed_edge',
    strength: 'none',
    reasonCodes: ['d10v2:evidence:structural_edge:no_confirmed_edge'],
  };
}

function rollableBoundaryEvidence(
  vehicleQuality: D10V2VehicleEvidenceQuality,
  truckEvidence: D10V2TruckEvidence,
): D10V2EvidenceSummary<D10V2RollableBoundaryEvidenceKind> {
  if (vehicleQuality === 'parked_clamped') {
    return {
      kind: 'parking_clamp',
      strength: 'strong',
      reasonCodes: ['d10v2:evidence:rollable_boundary:parking_clamp'],
    };
  }
  if (vehicleQuality === 'parked_observed_no_clamp') {
    return {
      kind: 'parking_observed_no_clamp',
      strength: 'medium',
      reasonCodes: ['d10v2:evidence:rollable_boundary:parking_observed_no_clamp'],
    };
  }
  if (truckEvidence.observed) {
    return {
      kind: 'truck_observed_passage',
      strength: 'medium',
      reasonCodes: ['d10v2:evidence:rollable_boundary:truck_observed_passage'],
    };
  }
  return {
    kind: 'none',
    strength: 'none',
    reasonCodes: ['d10v2:evidence:rollable_boundary:none'],
  };
}

function plateauEvidence(
  structural: Pick<
    D10V2SimpleResult,
    'source' | 'largeurRueM' | 'leftEdgeM' | 'rightEdgeM' | 'scoringBucket' | 'reasonCodes'
  >,
): D10V2EvidenceSummary<D10V2PlateauEvidenceKind> {
  const hasPlateau = structural.reasonCodes.some((code) => code.startsWith('d10v2:plateau:'));
  const hasRejectedPlateau = structural.reasonCodes.some((code) =>
    code.startsWith('d10v2:plateau_rejected_'),
  );
  if (!hasPlateau) {
    if (hasRejectedPlateau) {
      return {
        kind: structural.reasonCodes.includes('d10v2:plateau_rejected_axis_sanity')
          ? 'off_axis_plateau'
          : 'rejected_plateau',
        strength: 'weak',
        reasonCodes: [structural.reasonCodes.includes('d10v2:plateau_rejected_axis_sanity')
          ? 'd10v2:evidence:plateau:off_axis_plateau'
          : 'd10v2:evidence:plateau:rejected_plateau'],
      };
    }
    return {
      kind: 'no_plateau',
      strength: 'none',
      reasonCodes: ['d10v2:evidence:plateau:no_plateau'],
    };
  }
  if (structural.source === 'plateau' && structural.largeurRueM != null) {
    return {
      kind: 'axis_crossing_plateau',
      strength: structural.scoringBucket === 'credible_plateau' ? 'strong' : 'medium',
      reasonCodes: ['d10v2:evidence:plateau:axis_crossing_plateau'],
    };
  }
  const offAxis = structural.reasonCodes.includes('d10v2:plateau_rejected_axis_sanity');
  return {
    kind: offAxis ? 'off_axis_plateau' : 'rejected_plateau',
    strength: 'weak',
    reasonCodes: [
      offAxis
        ? 'd10v2:evidence:plateau:off_axis_plateau'
        : 'd10v2:evidence:plateau:rejected_plateau',
    ],
  };
}

/**
 * Resolve D10v2 structural width from a cropped lateral profile (pre-YOLO clamp).
 */
export function resolveD10V2SimpleStructural(
  profile: ProfileResultView,
  cropHalfM: number,
  bdtopoWidthM: number | null,
): Pick<
  D10V2SimpleResult,
  'largeurRueM' | 'leftEdgeM' | 'rightEdgeM' | 'source' | 'scoringBucket' | 'reasonCodes'
> {
  const reasonCodes = [
    `d10v2:crop_half=${cropHalfM}`,
    `d10v2:crop_margin=${D10V2_CROP_MARGIN_M}m`,
  ];
  if (bdtopoWidthM != null) {
    reasonCodes.push(`d10v2:bdtopo=${round2(bdtopoWidthM)}`);
  }

  const chosen = pickChosenPlateau(profile.plateaux);
  if (!chosen) {
    reasonCodes.push('d10v2:no_plateau');
    return withScoringBucket({
      largeurRueM: null,
      leftEdgeM: null,
      rightEdgeM: null,
      source: 'unavailable',
      reasonCodes,
    }, 'no_plateau');
  }

  const useWeighted = isWeightedKerbEnabled();
  let kerbLeftM: number | null;
  let kerbRightM: number | null;
  let kerbNote: string | null;
  if (useWeighted) {
    const weighted = computeWeightedKerbPair({
      offsetsM: profile.offsetsM,
      sidewalkBoundaryScore: profile.sidewalkBoundaryScore,
      roadMatchProfile: profile.roadMatchProfile,
      bdtopoBuildingCost: profile.bdtopoBuildingCost,
      bdtopoVegetationCost: profile.bdtopoVegetationCost,
      parkingExclusion: profile.parkingExclusion,
      bdtopoHardCost: profile.bdtopoHardCost,
      chosenPlateau: chosen,
      bdtopoWidthM,
      bdtopoBandHalfM: BDTOPO_V2_BAND_HALF_M,
    });
    reasonCodes.push('d10v2:kerb_scorer=weighted', ...weighted.reasonCodes);
    kerbLeftM = weighted.leftOffsetM;
    kerbRightM = weighted.rightOffsetM;
    kerbNote = weighted.note;
  } else {
    const kerb = computeSidewalkBoundaryCandidateCurve({
      offsetsM: profile.offsetsM,
      sidewalkBoundaryScore: profile.sidewalkBoundaryScore,
      profile: profile.profile,
      roadMatchProfile: profile.roadMatchProfile,
      bdtopoBuildingCost: profile.bdtopoBuildingCost,
      bdtopoVegetationCost: profile.bdtopoVegetationCost,
      parkingExclusion: profile.parkingExclusion,
      bdtopoHardCost: profile.bdtopoHardCost,
      chosenPlateau: chosen,
    });
    reasonCodes.push('d10v2:kerb_scorer=legacy');
    kerbLeftM = kerb.leftOffsetM;
    kerbRightM = kerb.rightOffsetM;
    kerbNote = kerb.note;
  }

  if (kerbLeftM != null && kerbRightM != null) {
    const atCropEdge =
      isNearCropEdge(kerbLeftM, cropHalfM)
      || isNearCropEdge(kerbRightM, cropHalfM);
    if (atCropEdge) {
      reasonCodes.push(
        `d10v2:kerb_rejected_crop_edge:L${round2(kerbLeftM)}R${round2(kerbRightM)}`,
      );
    } else {
      const widthM = round2(kerbRightM - kerbLeftM);
      reasonCodes.push(
        `d10v2:kerb_pair:L${round2(kerbLeftM)}R${round2(kerbRightM)}`,
        kerbNote ?? 'd10v2:kerb_pair',
      );
      return withScoringBucket({
        largeurRueM: widthM,
        leftEdgeM: round2(kerbLeftM),
        rightEdgeM: round2(kerbRightM),
        source: 'kerb_pair',
        reasonCodes,
      }, reasonCodes.includes('kerb_w:needs_review') ? 'uncertain_kerb' : 'credible_kerb');
    }
  }

  const leftM = profile.leftPerpM ?? chosen.startM;
  const rightM = profile.rightPerpM ?? chosen.endM;
  const widthM = round2(rightM - leftM);
  const plateauHasNoKerbPair = kerbLeftM == null || kerbRightM == null;
  reasonCodes.push(
    `d10v2:plateau:L${round2(leftM)}R${round2(rightM)}`,
    `d10v2:width=${widthM}`,
  );
  if (kerbNote) reasonCodes.push(kerbNote);
  if (!plateauCrossesAxis(leftM, rightM)) {
    reasonCodes.push('d10v2:plateau_rejected_axis_sanity');
    return withScoringBucket({
      largeurRueM: null,
      leftEdgeM: null,
      rightEdgeM: null,
      source: 'unavailable',
      reasonCodes,
    }, 'prior_mismatch');
  }
  const plateauSafety = assessFlatSaturatedPlateau({
    offsetsM: profile.offsetsM,
    profile: profile.profile,
    plateau: chosen,
    expectedWidthM: bdtopoWidthM,
  });
  if (plateauSafety.unsafe) {
    reasonCodes.push(
      ...plateauSafety.reasonCodes,
      'd10v2:plateau_rejected_flat_saturated',
    );
    return withScoringBucket({
      largeurRueM: null,
      leftEdgeM: null,
      rightEdgeM: null,
      source: 'unavailable',
      reasonCodes,
    }, 'saturated_plateau');
  }
  if (isPlateauWidthSuspicious(widthM, bdtopoWidthM)) {
    reasonCodes.push('d10v2:plateau_rejected_prior_mismatch');
    return withScoringBucket({
      largeurRueM: null,
      leftEdgeM: null,
      rightEdgeM: null,
      source: 'unavailable',
      reasonCodes,
    }, 'prior_mismatch');
  }

  if (plateauHasNoKerbPair) {
    reasonCodes.push('d10v2:plateau_uncertain_no_kerb_pair');
  }
  return withScoringBucket({
    largeurRueM: widthM,
    leftEdgeM: round2(leftM),
    rightEdgeM: round2(rightM),
    source: 'plateau',
    reasonCodes,
  }, plateauHasNoKerbPair ? 'uncertain_plateau' : 'credible_plateau');
}

export function assembleD10V2SimpleResult(input: {
  readonly cropHalfM: number;
  readonly bdtopoWidthM: number | null;
  readonly structural: Pick<
    D10V2SimpleResult,
    'largeurRueM' | 'leftEdgeM' | 'rightEdgeM' | 'source' | 'scoringBucket' | 'reasonCodes'
  >;
  readonly rollableProfile: ProfileResultView;
}): D10V2SimpleResult {
  const reasonCodes = [...input.structural.reasonCodes];
  // Exploitable = measured carriageway (D10 asphalt) minus parking. The rollable
  // profile already integrates both: the D10 asphalt scan stops at the kerb and
  // the YOLO clamp removes parked vehicles. The structural kerb pair is shown
  // separately (display) but is NOT used to bound exploitable, because an
  // over/under-reaching kerb candidate would otherwise corrupt the verdict
  // number (corpus: paris-sub-1 regressed when kerb bounded exploitable).
  const exploitable = input.rollableProfile.widthM;
  if (input.structural.source === 'unavailable') {
    reasonCodes.push('d10v2:exploitable_unavailable');
    const vehicleQuality = vehicleEvidenceQuality(input.structural, input.rollableProfile);
    const truckEvidence = truckEvidenceFromYolo(input.rollableProfile);
    const structuralEvidence = structuralEdgeEvidence(input.structural);
    const rollableEvidence = rollableBoundaryEvidence(vehicleQuality, truckEvidence);
    const plateau = plateauEvidence(input.structural);
    reasonCodes.push(`d10v2:vehicle_evidence:${vehicleQuality}`);
    reasonCodes.push(...truckEvidence.reasonCodes.map((code) => `d10v2:${code}`));
    reasonCodes.push(
      ...structuralEvidence.reasonCodes,
      ...rollableEvidence.reasonCodes,
      ...plateau.reasonCodes,
    );
    return {
      cropHalfM: input.cropHalfM,
      bdtopoWidthM: input.bdtopoWidthM,
      largeurRueM: input.structural.largeurRueM,
      largeurExploitableM: null,
      leftEdgeM: input.structural.leftEdgeM,
      rightEdgeM: input.structural.rightEdgeM,
      leftRollableM: null,
      rightRollableM: null,
      source: input.structural.source,
      scoringBucket: input.structural.scoringBucket,
      vehicleEvidenceQuality: vehicleQuality,
      truckEvidence,
      structuralEdgeEvidence: structuralEvidence,
      rollableBoundaryEvidence: rollableEvidence,
      plateauEvidence: plateau,
      reasonCodes,
    };
  }
  if (exploitable != null) {
    reasonCodes.push(`d10v2:exploitable=${round2(exploitable)}`);
  }
  const vehicleQuality = vehicleEvidenceQuality(input.structural, input.rollableProfile);
  const truckEvidence = truckEvidenceFromYolo(input.rollableProfile);
  const structuralEvidence = structuralEdgeEvidence(input.structural);
  const rollableEvidence = rollableBoundaryEvidence(vehicleQuality, truckEvidence);
  const plateau = plateauEvidence(input.structural);
  if (
    input.structural.largeurRueM != null
    && exploitable != null
    && exploitable > input.structural.largeurRueM
  ) {
    reasonCodes.push('d10v2:exploitable_gt_structural');
  }
  if (
    input.structural.largeurRueM != null
    && exploitable != null
    && exploitable < input.structural.largeurRueM
    && vehicleQuality === 'parked_clamped'
  ) {
    reasonCodes.push('d10v2:parking_applied');
  }
  reasonCodes.push(`d10v2:vehicle_evidence:${vehicleQuality}`);
  reasonCodes.push(...truckEvidence.reasonCodes.map((code) => `d10v2:${code}`));
  reasonCodes.push(
    ...structuralEvidence.reasonCodes,
    ...rollableEvidence.reasonCodes,
    ...plateau.reasonCodes,
  );

  return {
    cropHalfM: input.cropHalfM,
    bdtopoWidthM: input.bdtopoWidthM,
    largeurRueM: input.structural.largeurRueM,
    largeurExploitableM: exploitable,
    leftEdgeM: input.structural.leftEdgeM,
    rightEdgeM: input.structural.rightEdgeM,
    leftRollableM: input.rollableProfile.leftPerpM,
    rightRollableM: input.rollableProfile.rightPerpM,
    source: input.structural.source,
    scoringBucket: input.structural.scoringBucket,
    vehicleEvidenceQuality: vehicleQuality,
    truckEvidence,
    structuralEdgeEvidence: structuralEvidence,
    rollableBoundaryEvidence: rollableEvidence,
    plateauEvidence: plateau,
    reasonCodes,
  };
}
