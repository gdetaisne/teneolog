import { describe, expect, it } from 'vitest';
import type { ProfileResultView } from './types.js';
import {
  assembleD10V2SimpleResult,
  d10v2CropHalfM,
  resolveD10V2SimpleStructural,
  D10V2_CROP_MARGIN_M,
} from './d10v2-simple.js';

function minimalProfile(overrides: Partial<ProfileResultView> = {}): ProfileResultView {
  return {
    widthM: 4,
    confidence: 0.7,
    leftPerpM: -2,
    rightPerpM: 2,
    profile: [],
    roadMatchProfile: [],
    nonVegProfile: [],
    vegProfile: [],
    coverageProfile: [],
    bdtopoBuildingCost: [],
    bdtopoVegetationCost: [],
    bdtopoCanopyCost: [],
    bdtopoHardCost: [],
    parkingExclusion: [],
    sidewalkBoundaryScore: [],
    sidewalkBoundaryCandidateScore: [],
    offsetsM: [],
    plateaux: [{ startM: -2, endM: 2, widthM: 4, meanScore: 0.9 }],
    roadColour: [80, 80, 80],
    threshold: 0.5,
    sampleCount: 100,
    asphaltModel: {
      medianColour: [80, 80, 80],
      rgbMin: [70, 70, 70],
      rgbMax: [90, 90, 90],
      lumaMin: 70,
      lumaMax: 90,
      maxSat: 10,
      sampleCount: 100,
    },
    notes: [],
    deltaToGtM: null,
    durationMs: 1,
    plateauVegFrac: 0,
    carZones: [],
    yoloBboxes: [],
    parkedYoloBboxes: [],
    yoloClassifications: [],
    masks: {} as ProfileResultView['masks'],
    tiles: [],
    reasonCodes: [],
    primaryTileIndex: 0,
    yoloStatus: 'empty',
    verdict: { status: 'needs_review', blockingReasons: [], degradedReasons: [] },
    ...overrides,
  };
}

describe('d10v2CropHalfM', () => {
  it('uses (bdtopo + 2m) / 2 per side', () => {
    expect(d10v2CropHalfM(4)).toBe(3);
    expect(d10v2CropHalfM(7)).toBe(4.5);
    expect(D10V2_CROP_MARGIN_M).toBe(2);
  });
});

describe('resolveD10V2SimpleStructural', () => {
  it('keeps plateau fallback but downgrades it when no kerb pair is available', () => {
    const r = resolveD10V2SimpleStructural(minimalProfile(), 3, 4);
    expect(r.source).toBe('plateau');
    expect(r.scoringBucket).toBe('uncertain_plateau');
    expect(r.largeurRueM).toBe(4);
    expect(r.leftEdgeM).toBe(-2);
    expect(r.rightEdgeM).toBe(2);
    expect(r.reasonCodes).toContain('d10v2:plateau_uncertain_no_kerb_pair');
    expect(r.reasonCodes).toContain('d10v2:bucket:uncertain_plateau');
  });

  it('returns unavailable without plateau', () => {
    const r = resolveD10V2SimpleStructural(minimalProfile({ plateaux: [] }), 3, 4);
    expect(r.source).toBe('unavailable');
    expect(r.scoringBucket).toBe('no_plateau');
    expect(r.largeurRueM).toBeNull();
  });

  it('rejects kerb pair snapped to crop edge and falls back to plateau', () => {
    const offsets = [-3, -2, -1, 0, 1, 2, 3];
    const r = resolveD10V2SimpleStructural(
      minimalProfile({
        offsetsM: offsets,
        plateaux: [{ startM: -2, endM: 2, widthM: 4, meanScore: 0.9 }],
        sidewalkBoundaryScore: offsets.map((s) => (Math.abs(s) >= 2.9 ? 0.95 : 0.1)),
        profile: offsets.map(() => 0.8),
        roadMatchProfile: offsets.map(() => 0.8),
      }),
      3,
      4,
    );
    expect(r.source).toBe('plateau');
    expect(r.largeurRueM).toBe(4);
  });

  it('rejects a flat saturated plateau fallback as unavailable', () => {
    const offsets = Array.from({ length: 41 }, (_, i) => -5 + i * 0.25);
    const profile = offsets.map(() => 0.97);
    const r = resolveD10V2SimpleStructural(
      minimalProfile({
        widthM: 10,
        leftPerpM: -5,
        rightPerpM: 5,
        offsetsM: offsets,
        profile,
        roadMatchProfile: profile,
        plateaux: [{ startM: -5, endM: 5, widthM: 10, meanScore: 0.97 }],
      }),
      6,
      3,
    );

    expect(r.source).toBe('unavailable');
    expect(r.scoringBucket).toBe('saturated_plateau');
    expect(r.largeurRueM).toBeNull();
    expect(r.reasonCodes).toContain('flat_saturated_plateau');
    expect(r.reasonCodes).toContain('d10v2:plateau_rejected_flat_saturated');
    expect(r.reasonCodes).toContain('d10v2:bucket:saturated_plateau');
  });

  it('rejects a plateau fallback that strongly disagrees with BDTOPO width', () => {
    const offsets = Array.from({ length: 61 }, (_, i) => -5 + i * 0.25);
    const profile = offsets.map((s) => {
      if (s < -2 || s > 4) return 0.3;
      return Math.abs(s - 1) < 0.01 ? 0.65 : 0.95;
    });
    const r = resolveD10V2SimpleStructural(
      minimalProfile({
        widthM: 6,
        leftPerpM: -2,
        rightPerpM: 4,
        offsetsM: offsets,
        profile,
        roadMatchProfile: profile,
        plateaux: [{ startM: -2, endM: 4, widthM: 6, meanScore: 0.95 }],
      }),
      4,
      3,
    );

    expect(r.source).toBe('unavailable');
    expect(r.scoringBucket).toBe('prior_mismatch');
    expect(r.largeurRueM).toBeNull();
    expect(r.reasonCodes).toContain('d10v2:plateau_rejected_prior_mismatch');
  });

  it('rejects a narrow-street plateau over-read even below the old wide-ratio guard', () => {
    const offsets = Array.from({ length: 41 }, (_, i) => -3 + i * 0.25);
    const profile = offsets.map((s) => {
      if (s < -1.5 || s > 2.5) return 0.3;
      return Math.abs(s - 0.5) < 0.01 ? 0.65 : 0.95;
    });
    const r = resolveD10V2SimpleStructural(
      minimalProfile({
        widthM: 4,
        leftPerpM: -1.5,
        rightPerpM: 2.5,
        offsetsM: offsets,
        profile,
        roadMatchProfile: profile,
        plateaux: [{ startM: -1.5, endM: 2.5, widthM: 4, meanScore: 0.9 }],
      }),
      2.5,
      3,
    );

    expect(r.source).toBe('unavailable');
    expect(r.scoringBucket).toBe('prior_mismatch');
    expect(r.largeurRueM).toBeNull();
    expect(r.reasonCodes).toContain('d10v2:plateau_rejected_prior_mismatch');
  });

  it('rejects a too-narrow plateau compared with the BDTOPO prior', () => {
    const offsets = Array.from({ length: 41 }, (_, i) => -3 + i * 0.25);
    const profile = offsets.map((s) => {
      if (s < -0.75 || s > 0.75) return 0.3;
      return Math.abs(s) < 0.01 ? 0.65 : 0.95;
    });
    const r = resolveD10V2SimpleStructural(
      minimalProfile({
        widthM: 1.5,
        leftPerpM: -0.75,
        rightPerpM: 0.75,
        offsetsM: offsets,
        profile,
        roadMatchProfile: profile,
        plateaux: [{ startM: -0.75, endM: 0.75, widthM: 1.5, meanScore: 0.9 }],
      }),
      3.5,
      5,
    );

    expect(r.source).toBe('unavailable');
    expect(r.scoringBucket).toBe('prior_mismatch');
    expect(r.largeurRueM).toBeNull();
    expect(r.reasonCodes).toContain('d10v2:plateau_rejected_prior_mismatch');
  });

  it('rejects a plateau whose edges are both on the same side of the axis', () => {
    const offsets = Array.from({ length: 41 }, (_, i) => -4 + i * 0.25);
    const profile = offsets.map(() => 0.9);
    const r = resolveD10V2SimpleStructural(
      minimalProfile({
        widthM: 1.5,
        leftPerpM: -2.75,
        rightPerpM: -1.25,
        offsetsM: offsets,
        profile,
        roadMatchProfile: profile,
        plateaux: [{ startM: -2.75, endM: -1.25, widthM: 1.5, meanScore: 0.9 }],
      }),
      3.5,
      5,
    );

    expect(r.source).toBe('unavailable');
    expect(r.scoringBucket).toBe('prior_mismatch');
    expect(r.largeurRueM).toBeNull();
    expect(r.reasonCodes).toContain('d10v2:plateau_rejected_axis_sanity');
  });

  it('does not publish exploitable width when structural width is unavailable', () => {
    const rollableProfile = minimalProfile({ widthM: 10, leftPerpM: -5, rightPerpM: 5 });
    const result = assembleD10V2SimpleResult({
      cropHalfM: 6,
      bdtopoWidthM: 3,
      structural: {
        largeurRueM: null,
        leftEdgeM: null,
        rightEdgeM: null,
        source: 'unavailable',
        scoringBucket: 'saturated_plateau',
        reasonCodes: ['d10v2:plateau_rejected_flat_saturated'],
      },
      rollableProfile,
    });

    expect(result.largeurExploitableM).toBeNull();
    expect(result.source).toBe('unavailable');
    expect(result.scoringBucket).toBe('saturated_plateau');
    expect(result.vehicleEvidenceQuality).toBe('none');
    expect(result.structuralEdgeEvidence).toMatchObject({
      kind: 'no_confirmed_edge',
      strength: 'none',
    });
    expect(result.rollableBoundaryEvidence).toMatchObject({
      kind: 'none',
      strength: 'none',
    });
    expect(result.plateauEvidence).toMatchObject({
      kind: 'rejected_plateau',
      strength: 'weak',
    });
    expect(result.reasonCodes).toContain('d10v2:exploitable_unavailable');
    expect(result.reasonCodes).toContain('d10v2:vehicle_evidence:none');
  });

  it('marks parked vehicle clamp evidence when YOLO narrows rollable width', () => {
    const result = assembleD10V2SimpleResult({
      cropHalfM: 4,
      bdtopoWidthM: 6,
      structural: {
        largeurRueM: 6,
        leftEdgeM: -3,
        rightEdgeM: 3,
        source: 'kerb_pair',
        scoringBucket: 'credible_kerb',
        reasonCodes: ['d10v2:bucket:credible_kerb'],
      },
      rollableProfile: minimalProfile({
        widthM: 4,
        leftPerpM: -2,
        rightPerpM: 2,
        yoloBboxes: [{} as never],
        parkedYoloBboxes: [{} as never],
        notes: ['yolo_parked:1', 'yolo_circulating:0'],
      }),
    });

    expect(result.vehicleEvidenceQuality).toBe('parked_clamped');
    expect(result.structuralEdgeEvidence).toMatchObject({
      kind: 'confirmed_kerb_pair',
      strength: 'strong',
    });
    expect(result.rollableBoundaryEvidence).toMatchObject({
      kind: 'parking_clamp',
      strength: 'strong',
    });
    expect(result.reasonCodes).toContain('d10v2:parking_applied');
    expect(result.reasonCodes).toContain('d10v2:vehicle_evidence:parked_clamped');
  });

  it('separates uncertain structural plateau from strong rollable parking boundary', () => {
    const result = assembleD10V2SimpleResult({
      cropHalfM: 2.5,
      bdtopoWidthM: 3,
      structural: {
        largeurRueM: 3.5,
        leftEdgeM: -1.5,
        rightEdgeM: 2,
        source: 'plateau',
        scoringBucket: 'uncertain_plateau',
        reasonCodes: [
          'kerb_w:no_candidate',
          'd10v2:plateau:L-1.5R2',
          'd10v2:width=3.5',
          'd10v2:plateau_uncertain_no_kerb_pair',
          'd10v2:bucket:uncertain_plateau',
        ],
      },
      rollableProfile: minimalProfile({
        widthM: 2.35,
        leftPerpM: -0.35,
        rightPerpM: 2,
        yoloBboxes: [{} as never],
        parkedYoloBboxes: [{} as never],
        notes: ['yolo_parked:1', 'yolo_circulating:0'],
      }),
    });

    expect(result.scoringBucket).toBe('uncertain_plateau');
    expect(result.vehicleEvidenceQuality).toBe('parked_clamped');
    expect(result.structuralEdgeEvidence).toMatchObject({
      kind: 'no_confirmed_edge',
      strength: 'none',
    });
    expect(result.rollableBoundaryEvidence).toMatchObject({
      kind: 'parking_clamp',
      strength: 'strong',
    });
    expect(result.plateauEvidence).toMatchObject({
      kind: 'axis_crossing_plateau',
      strength: 'medium',
    });
    expect(result.reasonCodes).toContain('d10v2:evidence:rollable_boundary:parking_clamp');
  });

  it('does not mark parking applied for circulating-only vehicle evidence', () => {
    const result = assembleD10V2SimpleResult({
      cropHalfM: 10,
      bdtopoWidthM: 18,
      structural: {
        largeurRueM: 18,
        leftEdgeM: -9,
        rightEdgeM: 9,
        source: 'kerb_pair',
        scoringBucket: 'credible_kerb',
        reasonCodes: ['d10v2:bucket:credible_kerb'],
      },
      rollableProfile: minimalProfile({
        widthM: 14.4,
        leftPerpM: -7.2,
        rightPerpM: 7.2,
        yoloBboxes: [{} as never, {} as never],
        parkedYoloBboxes: [],
        notes: ['yolo_parked:0', 'yolo_circulating:2'],
      }),
    });

    expect(result.vehicleEvidenceQuality).toBe('circulating_only');
    expect(result.rollableBoundaryEvidence).toMatchObject({
      kind: 'none',
      strength: 'none',
    });
    expect(result.reasonCodes).not.toContain('d10v2:parking_applied');
    expect(result.reasonCodes).toContain('d10v2:vehicle_evidence:circulating_only');
  });

  it('adds observed passage evidence for a circulating large vehicle without changing width', () => {
    const result = assembleD10V2SimpleResult({
      cropHalfM: 6,
      bdtopoWidthM: 8,
      structural: {
        largeurRueM: 8,
        leftEdgeM: -4,
        rightEdgeM: 4,
        source: 'kerb_pair',
        scoringBucket: 'credible_kerb',
        reasonCodes: ['d10v2:bucket:credible_kerb'],
      },
      rollableProfile: minimalProfile({
        widthM: 8,
        leftPerpM: -4,
        rightPerpM: 4,
        yoloBboxes: [{ class_name: 'large-vehicle' } as never],
        parkedYoloBboxes: [],
        yoloClassifications: [
          {
            bbox: { class_name: 'large-vehicle' } as never,
            status: 'circulating',
            reason: 'large_vehicle_on_bdtopo_carriageway',
            side: 'right',
            alongM: 0,
            lateralM: 0.2,
            innerEdgeM: -1,
            outerEdgeM: 1.4,
            halfAlongM: 2,
          },
        ],
      }),
    });

    expect(result.largeurExploitableM).toBe(8);
    expect(result.truckEvidence).toEqual({
      observed: true,
      observedPassageMinM: 2.5,
      source: 'yolo-large-vehicle',
      reasonCodes: [
        'truck_evidence:yolo_large_vehicle_circulating',
        'truck_evidence:observed_passage_min=2.5',
      ],
    });
    expect(result.rollableBoundaryEvidence).toMatchObject({
      kind: 'truck_observed_passage',
      strength: 'medium',
    });
    expect(result.reasonCodes).toContain('d10v2:truck_evidence:observed_passage_min=2.5');
  });

  it('marks parked vehicle evidence as uncertain when rollable exceeds structural', () => {
    const result = assembleD10V2SimpleResult({
      cropHalfM: 4,
      bdtopoWidthM: 5,
      structural: {
        largeurRueM: 5,
        leftEdgeM: -2.5,
        rightEdgeM: 2.5,
        source: 'kerb_pair',
        scoringBucket: 'credible_kerb',
        reasonCodes: ['d10v2:bucket:credible_kerb'],
      },
      rollableProfile: minimalProfile({
        widthM: 20,
        leftPerpM: -10,
        rightPerpM: 10,
        yoloBboxes: [{} as never],
        parkedYoloBboxes: [{} as never],
        notes: ['yolo_parked:1', 'yolo_circulating:0'],
      }),
    });

    expect(result.vehicleEvidenceQuality).toBe('uncertain_vehicle_overlap');
    expect(result.reasonCodes).not.toContain('d10v2:parking_applied');
    expect(result.reasonCodes).toContain('d10v2:exploitable_gt_structural');
    expect(result.reasonCodes).toContain('d10v2:vehicle_evidence:uncertain_vehicle_overlap');
  });
});
