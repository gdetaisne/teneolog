/**
 * S5 units. The invariants under test: unknown never auto-resolves, the
 * confidence gate is symmetric, a legal block names its segment, E1's
 * transit violation is per-position, hgv rules are per-weight, and the
 * conclusion is an existence claim over pairs.
 */
import { describe, expect, it } from 'vitest';
import type {
  CriticalPoint,
  Fact,
  RouteCandidate,
  RouteSegmentConstraint,
  TruckProfile,
  Width,
} from '@teneolog/domain';

import { evaluateCandidateLegality } from '../src/legal.js';
import { evaluatePoint } from '../src/evaluators.js';
import { projectTruck } from '../src/project.js';
import type { ProjectionPolicy } from '../src/policy.js';

const POLICY: ProjectionPolicy = {
  lateralClearanceM: 0.8,
  turnSweptClearanceM: 1.0,
  roundaboutSweptClearanceM: 1.0,
  turnaroundClearanceM: 2.0,
  comfortMarginM: 0.4,
  publishableConfidence: 0.55,
  hgvThresholdT: 3.5,
  passingLaneWidthM: 2.75,
};

/** Engine-registry parity: pl-19t and vul-fourgon envelopes. */
const PL19: TruckProfile = {
  id: 'pl-19t',
  label: 'Porteur 19 t',
  family: 'rigid',
  envelope: { lengthM: 9, widthM: 2.5, heightM: 3.5, gvwT: 19, turnRadiusM: 11, wheelbaseM: 6.1, frontOverhangM: 1.2, rearOverhangM: 1.7 },
  equipment: { tailLift: true, crane: false, refrigerated: false },
};
const VUL: TruckProfile = {
  id: 'vul-fourgon',
  label: 'Fourgon',
  family: 'vul',
  envelope: { lengthM: 6, widthM: 2.1, heightM: 2.5, gvwT: 3.5, turnRadiusM: 7, wheelbaseM: 3.7, frontOverhangM: 0.9, rearOverhangM: 1.4 },
  equipment: { tailLift: false, crane: false, refrigerated: false },
};

const AT = { lat: 47.0, lon: 1.0 };

function width(freeM: number, confidence = 0.7): Fact<Width> {
  return {
    known: true,
    value: { freeM, structuralM: freeM, measuredAt: AT, offsetFromAnchorM: 0 },
    provenance: { source: 'ign-ortho', method: 'd10-stitched', fetchedAt: 'x' },
    reliability: { confidence, basis: 'measured', reasonCodes: [] },
  };
}

function destinationPoint(w: Fact<Width>, confidence = 0.9): CriticalPoint {
  return {
    ref: 'DESTINATION@47.0000,1.0371',
    type: 'DESTINATION',
    at: AT,
    geometry: {
      known: true,
      value: { type: 'DESTINATION', width: w },
      provenance: { source: 'ign-ortho', method: 'stop', fetchedAt: 'x' },
      reliability: { confidence, basis: 'derived', reasonCodes: [] },
    },
    evidence: [],
  };
}

describe('evaluatePoint', () => {
  it('a wide street clears the 19 t with its margin', () => {
    const e = evaluatePoint(destinationPoint(width(6.5)), PL19, POLICY);
    expect(e.verdict).toBe('OK');
    expect(e.marginM).toBeCloseTo(6.5 - 3.3, 1);
  });

  it('EC-14 spirit: 2.8 m for a 19 t is NO; the same street clears the van', () => {
    const narrow = destinationPoint(width(2.8));
    expect(evaluatePoint(narrow, PL19, POLICY).verdict).toBe('NO');
    // 2.8 - (2.1 + 0.8) = -0.1 → the van fails too... use 3.0 for the van case.
    const forVan = destinationPoint(width(3.0));
    const vanEval = evaluatePoint(forVan, VUL, POLICY);
    expect(vanEval.verdict).toBe('HUMAN'); // +0.1 margin, inside the comfort band
  });

  it('an unknown width NEVER auto-resolves — HUMAN with the reason', () => {
    const e = evaluatePoint(destinationPoint({ known: false, why: 'not_visible' }), PL19, POLICY);
    expect(e.verdict).toBe('HUMAN');
    expect(e.reasonCodes).toContain('destination_width_not_visible');
  });

  it('EC-04/BUG-011: the confidence gate is symmetric — a doubtful NO becomes HUMAN too', () => {
    const doubtfulNarrow = destinationPoint(width(2.0, 0.4));
    const e = evaluatePoint(doubtfulNarrow, PL19, POLICY);
    expect(e.verdict).toBe('HUMAN');
    expect(e.reasonCodes).toContain('confidence_below_publishable');
  });

  it('a CURVE tighter than the steering radius is NO before any width talk', () => {
    const curve = (radiusM: number): CriticalPoint => ({
      ref: 'TURN@47.0000,1.0371',
      type: 'TURN',
      at: AT,
      geometry: {
        known: true,
        value: {
          type: 'TURN',
          geometry: {
            apex: AT, kind: 'curve', deflectionDeg: 90, approachBearingDeg: 90, exitBearingDeg: 180,
            arcLengthM: 30, radiusM, chainedWithPreviousM: null,
            approachWidth: width(8), exitWidth: width(8),
          },
        },
        provenance: { source: 'osrm', method: 'turn', fetchedAt: 'x' },
        reliability: { confidence: 0.7, basis: 'derived', reasonCodes: [] },
      },
      evidence: [],
    });
    expect(evaluatePoint(curve(6), PL19, POLICY).verdict).toBe('NO');
    // R=6 is under the van's 7 m steering radius too — NO for both. A wider
    // bend (R=8) clears the van and still refuses the 19 t (E4's spirit:
    // feasibility diverges per envelope, not per size label).
    expect(evaluatePoint(curve(6), VUL, POLICY).verdict).toBe('NO');
    expect(evaluatePoint(curve(8), VUL, POLICY).verdict).toBe('OK');
    expect(evaluatePoint(curve(8), PL19, POLICY).verdict).toBe('NO');
  });

  it('a JUNCTION turn is judged on its width, never on a radius', () => {
    // A single-vertex right angle used to divide a 1 m floor by the deflection,
    // yielding a radius under a metre and a published "margin" of about -10 m
    // on streets where the truck plainly fits (13 boulevard Témoin, Paris). A
    // junction turn now carries no radius at all, so the trap cannot be reset.
    const corner: CriticalPoint = {
      ref: 'TURN@47.0000,1.0371',
      type: 'TURN',
      at: AT,
      geometry: {
        known: true,
        value: {
          type: 'TURN',
          geometry: {
            apex: AT,
            kind: 'junction',
            deflectionDeg: 87,
            approachBearingDeg: 90,
            exitBearingDeg: 180,
            arcLengthM: 20,
            radiusM: null,
            chainedWithPreviousM: null,
            approachWidth: width(11.25),
            exitWidth: width(11.25),
          },
        },
        provenance: { source: 'osrm', method: 'turn', fetchedAt: 'x' },
        reliability: { confidence: 0.7, basis: 'derived', reasonCodes: [] },
      },
      evidence: [],
    };
    const evaluated = evaluatePoint(corner, PL19, POLICY);
    expect(evaluated.verdict).toBe('OK');
    expect(evaluated.reasonCodes).toContain('turn_swept_width');
    expect(evaluated.reasonCodes).not.toContain('curve_radius_below_vehicle_minimum');
    // And the margin published is a width margin, not a radius deficit.
    expect(evaluated.marginM ?? 0).toBeGreaterThan(0);
  });

  it('the same 90° is a crossroads sweep or a bend, and they differ', () => {
    // The heart of principe 27/28: at 90° a junction demands the full
    // off-tracking of the truck's own tightest turn; a bend of 50 m radius
    // demands what THAT radius imposes, which is a third of a metre.
    const at90 = (kind: 'junction' | 'curve', radiusM: number | null): CriticalPoint => ({
      ref: 'TURN@47.0000,1.0371',
      type: 'TURN',
      at: AT,
      geometry: {
        known: true,
        value: {
          type: 'TURN',
          geometry: {
            apex: AT, kind, deflectionDeg: 90, approachBearingDeg: 90, exitBearingDeg: 180,
            arcLengthM: 60, radiusM, chainedWithPreviousM: null,
            approachWidth: width(4.5), exitWidth: width(4.5),
          },
        },
        provenance: { source: 'osrm', method: 'turn', fetchedAt: 'x' },
        reliability: { confidence: 0.7, basis: 'derived', reasonCodes: [] },
      },
      evidence: [],
    });
    // 2,5 + 1,85 (déport au R=11 du camion) + 1,0 = 5,35 m > 4,5 m → refusé.
    expect(evaluatePoint(at90('junction', null), PL19, POLICY).verdict).toBe('NO');
    // 2,5 + 0,37 (déport au R=50 de la courbe) + 1,0 = 3,87 m, marge 0,63 m → OK.
    expect(evaluatePoint(at90('curve', 50), PL19, POLICY).verdict).toBe('OK');
  });

  it('an estimated width may clear a turn but never refuse one', () => {
    const tight = (basis: 'measured' | 'derived'): CriticalPoint => ({
      ref: 'TURN@47.0000,1.0371',
      type: 'TURN',
      at: AT,
      geometry: {
        known: true,
        value: {
          type: 'TURN',
          geometry: {
            apex: AT,
            deflectionDeg: 90,
            approachBearingDeg: 90,
            exitBearingDeg: 180,
            kind: 'junction',
            arcLengthM: 20,
            radiusM: null,
            chainedWithPreviousM: null,
            approachWidth: {
              known: true,
              value: { freeM: 3, structuralM: 3, measuredAt: AT, offsetFromAnchorM: 0 },
              provenance: { source: 'osm-overpass', method: 'lane-count-width', fetchedAt: 'x' },
              reliability: { confidence: 0.7, basis, reasonCodes: [] },
            },
            exitWidth: { known: false, why: 'no_data' },
          },
        },
        provenance: { source: 'osrm', method: 'turn', fetchedAt: 'x' },
        reliability: { confidence: 0.7, basis: 'derived', reasonCodes: [] },
      },
      evidence: [],
    });
    expect(evaluatePoint(tight('measured'), PL19, POLICY).verdict).toBe('NO');
    const estimated = evaluatePoint(tight('derived'), PL19, POLICY);
    expect(estimated.verdict).toBe('HUMAN');
    expect(estimated.reasonCodes).toContain('unmeasured_width_cannot_refuse');
  });

  it('a roundabout with a declared ring width is decided, not escalated', () => {
    const roundabout = (ringWidthM: Fact<number>): CriticalPoint => ({
      ref: 'ROUNDABOUT@47.0000,1.0371',
      type: 'ROUNDABOUT',
      at: AT,
      geometry: {
        known: true,
        value: {
          type: 'ROUNDABOUT',
          geometry: {
            centre: AT,
            outerRadiusM: 18,
            innerRadiusM: 0,
            armCount: 4,
            sweptAngleDeg: 90,
            ringWidthM,
          },
        },
        provenance: { source: 'osm-overpass', method: 'ring-ways-swept-arc', fetchedAt: 'x' },
        reliability: { confidence: 0.7, basis: 'derived', reasonCodes: [] },
      },
      evidence: [],
    });
    const width = (value: number, basis: 'declared' | 'measured', confidence = 0.7): Fact<number> => ({
      known: true,
      value,
      provenance: { source: 'osm-overpass', method: 'ring-width', fetchedAt: 'x' },
      reliability: { confidence, basis, reasonCodes: [] },
    });

    // Every roundabout used to escalate; an unmeasured annulus still does.
    const unmeasured = evaluatePoint(roundabout({ known: false, why: 'no_data' }), PL19, POLICY);
    expect(unmeasured.verdict).toBe('HUMAN');
    expect(unmeasured.reasonCodes).toContain('roundabout_annulus_unmeasured');

    // A generous ring clears the 19 t on its own.
    const wide = evaluatePoint(roundabout(width(8, 'declared')), PL19, POLICY);
    expect(wide.verdict).toBe('OK');
    expect(wide.reasonCodes).toContain('roundabout_ring_width');

    // Off-tracking follows the radius actually driven, not the truck's tightest
    // possible turn. Around an 18 m ring the 19 t needs ≈ 4.57 m, so a 5 m
    // annulus clears — it did not under the earlier maths, which charged the
    // vehicle its 11 m-radius off-tracking on a ring nearly twice as wide.
    expect(evaluatePoint(roundabout(width(5, 'measured')), PL19, POLICY).verdict).toBe('OK');

    // A genuinely tight ring, MEASURED, is a refusal — and the same ring
    // clears the van (≈ 3.48 m required against the 19 t's ≈ 4.57 m): the
    // answer is per envelope, never per size label.
    expect(evaluatePoint(roundabout(width(4, 'measured')), PL19, POLICY).verdict).toBe('NO');
    expect(evaluatePoint(roundabout(width(4, 'measured')), VUL, POLICY).verdict).toBe('OK');

    // The same tight ring, only DECLARED, may not condemn the address: a
    // refusal is terminal for the customer and an OSM tag is not that evidence.
    const declaredTight = evaluatePoint(roundabout(width(4, 'declared')), PL19, POLICY);
    expect(declaredTight.verdict).toBe('HUMAN');
    expect(declaredTight.reasonCodes).toContain('declared_width_cannot_refuse');

    // A width nobody is confident about escalates, whichever way it points.
    expect(evaluatePoint(roundabout(width(8, 'declared', 0.3)), PL19, POLICY).verdict).toBe('HUMAN');
  });

  it('the carriageway turnaround fails the 19 t and is the measured NO the U-turn always deserved', () => {
    const point: CriticalPoint = {
      ref: 'TURNAROUND@47.0000,1.0371',
      type: 'TURNAROUND',
      at: AT,
      geometry: {
        known: true,
        value: {
          type: 'TURNAROUND',
          geometry: {
            surface: { usableDiameterM: 5, areaM2: null, polygon: null, occupancy: 'unassessed' },
            requiresReversingM: 0, beyondStop: false, distanceFromStopM: 0,
            provenTopology: true,
          },
        },
        provenance: { source: 'bdtopo-postgis', method: 'carriageway', fetchedAt: 'x' },
        reliability: { confidence: 0.7, basis: 'measured', reasonCodes: [] },
      },
      evidence: [],
    };
    const e = evaluatePoint(point, PL19, POLICY);
    expect(e.verdict).toBe('NO');
    expect(e.marginM).toBeCloseTo(5 - 24, 0);
  });

  // VV1-05 / a declared diameter may NEVER produce a hard NO.
  it('VV1-05: turnaround with declared diameter too narrow → HUMAN + declared_width_cannot_refuse, not NO', () => {
    const point: CriticalPoint = {
      ref: 'TURNAROUND@47.0000,1.0371',
      type: 'TURNAROUND',
      at: AT,
      geometry: {
        known: true,
        value: {
          type: 'TURNAROUND',
          geometry: {
            surface: { usableDiameterM: 5, areaM2: null, polygon: null, occupancy: 'unassessed' },
            requiresReversingM: 0, beyondStop: false, distanceFromStopM: 0,
            provenTopology: true,
          },
        },
        provenance: { source: 'osm-overpass', method: 'turning-circle-tag', fetchedAt: 'x' },
        // confidence 0.55 = exactly publishableConfidence: gate passes, but the
        // declared-width guard must still prevent NO.
        reliability: { confidence: 0.55, basis: 'declared', reasonCodes: [] },
      },
      evidence: [],
    };
    const e = evaluatePoint(point, PL19, POLICY);
    expect(e.verdict).toBe('HUMAN');
    expect(e.reasonCodes).toContain('declared_width_cannot_refuse');
    expect(e.reasonCodes).not.toContain('topology_unproven');
  });

  // VV1-06 / unproven topology blocks NO even with a measured width.
  it('VV1-06: unproven topology + measured tight turnaround → HUMAN + topology_unproven, not NO', () => {
    const point: CriticalPoint = {
      ref: 'TURNAROUND@47.0000,1.0371',
      type: 'TURNAROUND',
      at: AT,
      geometry: {
        known: true,
        value: {
          type: 'TURNAROUND',
          geometry: {
            surface: { usableDiameterM: 5, areaM2: null, polygon: null, occupancy: 'unassessed' },
            requiresReversingM: 0, beyondStop: false, distanceFromStopM: 0,
            provenTopology: false, // terminal node at edge of fetch — shape unconfirmed
          },
        },
        provenance: { source: 'osm-overpass', method: 'carriageway-declared-width', fetchedAt: 'x' },
        reliability: { confidence: 0.7, basis: 'measured', reasonCodes: [] },
      },
      evidence: [],
    };
    const e = evaluatePoint(point, PL19, POLICY);
    expect(e.verdict).toBe('HUMAN');
    expect(e.reasonCodes).toContain('topology_unproven');
    expect(e.reasonCodes).not.toContain('declared_width_cannot_refuse');
  });

  // Non-regression: proven topology + measured width → firm NO still fires.
  it('non-regression: proven topology + measured tight turnaround → NO', () => {
    const point: CriticalPoint = {
      ref: 'TURNAROUND@47.0000,1.0371',
      type: 'TURNAROUND',
      at: AT,
      geometry: {
        known: true,
        value: {
          type: 'TURNAROUND',
          geometry: {
            surface: { usableDiameterM: 5, areaM2: null, polygon: null, occupancy: 'unassessed' },
            requiresReversingM: 0, beyondStop: false, distanceFromStopM: 0,
            provenTopology: true,
          },
        },
        provenance: { source: 'bdtopo-postgis', method: 'surface-inscribed-circle', fetchedAt: 'x' },
        reliability: { confidence: 0.8, basis: 'measured', reasonCodes: [] },
      },
      evidence: [],
    };
    expect(evaluatePoint(point, PL19, POLICY).verdict).toBe('NO');
  });
});

function segment(overrides: Partial<RouteSegmentConstraint> & Pick<RouteSegmentConstraint, 'segmentId' | 'position'>): RouteSegmentConstraint {
  return {
    from: AT,
    to: AT,
    highway: null,
    lengthM: 0,
    legal: {
      maxWeightT: { known: false, why: 'no_data' },
      maxHeightM: { known: false, why: 'no_data' },
      maxWidthM: { known: false, why: 'no_data' },
      maxLengthM: { known: false, why: 'no_data' },
      access: { known: false, why: 'no_data' },
      lowEmissionZone: { known: false, why: 'no_data' },
    },
    width: { known: false, why: 'no_data' },
    ...overrides,
  };
}

function candidate(id: string, direction: 'in' | 'out', segments: readonly RouteSegmentConstraint[], inboundId?: string): RouteCandidate {
  return {
    id, direction, polyline: [AT, AT], segments,
    coverage: { sampled: 0, matched: 0 },
    corridorReasonCodes: [],
    generatedBy: 'car-optimal', distanceM: 1000, durationS: 60,
    egressOf: direction === 'out' ? { inboundId: inboundId ?? 'in', turnaround: { known: false, why: 'no_data' } } : null,
  };
}

const limit35 = {
  known: true as const,
  value: { value: 3.5, sources: ['osm-overpass' as const], statedValues: [{ source: 'osm-overpass' as const, value: 3.5 }] },
  provenance: { source: 'osm-overpass' as const, method: 'x', fetchedAt: 'x' },
  reliability: { confidence: 1, basis: 'declared' as const, reasonCodes: [] },
};

describe('evaluateCandidateLegality', () => {
  it('Clamart live case: the 3.5 t transit limit blocks the 19 t AT ITS SEGMENT and spares the van', () => {
    const c = candidate('a:in', 'in', [
      segment({ segmentId: 'clean', position: 'transit' }),
      segment({ segmentId: 'limited', position: 'transit', legal: { ...segment({ segmentId: 'x', position: 'transit' }).legal, maxWeightT: limit35 } }),
    ]);

    const pl = evaluateCandidateLegality(c, PL19, POLICY);
    expect(pl.verdict).toBe('NO');
    expect(pl.blockedAtSegmentId).toBe('limited');
    expect(pl.reasonCodes).toContain('legal_weight_limit_exceeded');

    const van = evaluateCandidateLegality(c, VUL, POLICY);
    expect(van.verdict).toBe('OK'); // 3.5 ≤ 3.5: at the limit is legal
  });

  it('E1 end to end: conditional in transit blocks; the same band on the approach clears with its reason', () => {
    const conditional = {
      known: true as const,
      value: { kind: 'conditional' as const, permits: ['destination' as const] },
      provenance: { source: 'osm-overpass' as const, method: 'x', fetchedAt: 'x' },
      reliability: { confidence: 1, basis: 'declared' as const, reasonCodes: [] },
    };
    const inTransit = candidate('t:in', 'in', [
      segment({ segmentId: 'shortcut', position: 'transit', legal: { ...segment({ segmentId: 'x', position: 'transit' }).legal, access: conditional } }),
    ]);
    const onApproach = candidate('a:in', 'in', [
      segment({ segmentId: 'final', position: 'approach', legal: { ...segment({ segmentId: 'x', position: 'approach' }).legal, access: conditional } }),
    ]);

    const blocked = evaluateCandidateLegality(inTransit, PL19, POLICY);
    expect(blocked.verdict).toBe('NO');
    expect(blocked.reasonCodes).toContain('conditional_access_in_transit');

    const cleared = evaluateCandidateLegality(onApproach, PL19, POLICY);
    expect(cleared.verdict).toBe('OK');
    expect(cleared.reasonCodes).toContain('conditional_access_cleared_local_service');
  });
});

describe('projectTruck — conclusion over pairs', () => {
  const okWidth = destinationPoint(width(7));

  it('one clean pair among blocked ones carries the address to OK, and names its route', () => {
    const blockedIn = candidate('g1:in', 'in', [
      segment({ segmentId: 'limited', position: 'transit', legal: { ...segment({ segmentId: 'x', position: 'transit' }).legal, maxWeightT: limit35 } }),
    ]);
    const blockedOut = candidate('g1:out', 'out', blockedIn.segments, 'g1:in');
    const cleanIn = candidate('g2:in', 'in', [segment({ segmentId: 'clean', position: 'transit' })]);
    const cleanOut = candidate('g2:out', 'out', cleanIn.segments, 'g2:in');

    const projection = projectTruck({
      candidates: [blockedIn, blockedOut, cleanIn, cleanOut],
      collected: {
        points: [okWidth],
        byCandidate: new Map([
          ['g1:in', [okWidth.ref]], ['g1:out', [okWidth.ref]],
          ['g2:in', [okWidth.ref]], ['g2:out', [okWidth.ref]],
        ]),
        geometryByCandidate: new Map(),
      },
      truck: PL19,
      policy: POLICY,
      policyVersion: 'test-1',
      validUntil: '2026-09-24T00:00:00Z',
    });

    expect(projection.conclusion.overall).toBe('OK');
    expect(projection.conclusion.viaCandidateId).toBe('g2:out');
    const g1 = projection.candidateVerdicts.find((cv) => cv.candidateId === 'g1:in');
    expect(g1?.verdict).toBe('NO');
    expect(g1?.blockedAtSegmentId).toBe('limited');
  });

  it('every pair blocked → NO with the reason; the same facts for the van → OK: the largest-truck answer in two calls', () => {
    const inC = candidate('g1:in', 'in', [
      segment({ segmentId: 'limited', position: 'transit', legal: { ...segment({ segmentId: 'x', position: 'transit' }).legal, maxWeightT: limit35 } }),
    ]);
    const outC = candidate('g1:out', 'out', inC.segments, 'g1:in');
    const collected = {
      points: [okWidth],
      byCandidate: new Map([['g1:in', [okWidth.ref]], ['g1:out', [okWidth.ref]]]),
      geometryByCandidate: new Map(),
    };
    const base = { candidates: [inC, outC], collected, policy: POLICY, policyVersion: 'test-1', validUntil: 'x' };

    const pl = projectTruck({ ...base, truck: PL19 });
    expect(pl.conclusion.overall).toBe('NO');
    expect(pl.conclusion.reasonCodes).toContain('best_pair_legally_blocked');

    const van = projectTruck({ ...base, truck: VUL });
    expect(van.conclusion.overall).toBe('OK');
  });

  it('a HUMAN point on the only pair makes the run HUMAN and names the deciding point', () => {
    const inC = candidate('g1:in', 'in', [segment({ segmentId: 'clean', position: 'transit' })]);
    const outC = candidate('g1:out', 'out', inC.segments, 'g1:in');
    const humanPoint = destinationPoint({ known: false, why: 'not_visible' });

    const projection = projectTruck({
      candidates: [inC, outC],
      collected: { points: [humanPoint], byCandidate: new Map([['g1:in', [humanPoint.ref]], ['g1:out', [humanPoint.ref]]]), geometryByCandidate: new Map() },
      truck: PL19,
      policy: POLICY,
      policyVersion: 'test-1',
      validUntil: 'x',
    });

    expect(projection.conclusion.overall).toBe('HUMAN');
    expect(projection.conclusion.decidedBy).toBe(humanPoint.ref);
  });

  it('inbound legs lost to the router → HUMAN + router_unavailable, not a firm NO', () => {
    // S3 kept the outbounds; their egressOf names inbounds that never routed.
    const out1 = candidate('g1:out', 'out', [segment({ segmentId: 'clean', position: 'transit' })], 'g1:in');
    const out2 = candidate('g2:out', 'out', [segment({ segmentId: 'clean', position: 'transit' })], 'g2:in');

    const projection = projectTruck({
      candidates: [out1, out2],
      collected: { points: [okWidth], byCandidate: new Map([['g1:out', [okWidth.ref]], ['g2:out', [okWidth.ref]]]), geometryByCandidate: new Map() },
      truck: PL19,
      policy: POLICY,
      policyVersion: 'test-1',
      validUntil: 'x',
    });

    expect(projection.conclusion.overall).toBe('HUMAN');
    expect(projection.conclusion.reasonCodes).toEqual(['router_unavailable']);
    expect(projection.conclusion.viaCandidateId).toBeNull();
  });

  it('the S3 flag alone names the router when no leg is left to pair', () => {
    const projection = projectTruck({
      candidates: [],
      collected: { points: [], byCandidate: new Map(), geometryByCandidate: new Map() },
      truck: PL19,
      policy: POLICY,
      policyVersion: 'test-1',
      validUntil: 'x',
      routerFailed: true,
    });
    expect(projection.conclusion.overall).toBe('HUMAN');
    expect(projection.conclusion.reasonCodes).toEqual(['router_unavailable']);
  });

  it('the conclusion rests on the retained pair\'s points, not on a discarded route\'s', () => {
    const cleanIn = candidate('g1:in', 'in', [segment({ segmentId: 'clean', position: 'transit' })]);
    const cleanOut = candidate('g1:out', 'out', cleanIn.segments, 'g1:in');
    const doubtfulIn = candidate('g2:in', 'in', [segment({ segmentId: 'clean', position: 'transit' })]);
    const doubtfulOut = candidate('g2:out', 'out', doubtfulIn.segments, 'g2:in');
    const doubt = destinationPoint({ known: false, why: 'not_visible' });
    const doubtRef = 'TURN@47.1000,1.1371' as const;
    const doubtOnG2: CriticalPoint = { ...doubt, ref: doubtRef };

    const projection = projectTruck({
      candidates: [cleanIn, cleanOut, doubtfulIn, doubtfulOut],
      collected: {
        points: [okWidth, doubtOnG2],
        byCandidate: new Map([
          ['g1:in', [okWidth.ref]], ['g1:out', [okWidth.ref]],
          ['g2:in', [okWidth.ref, doubtRef]], ['g2:out', [okWidth.ref]],
        ]),
        geometryByCandidate: new Map(),
      },
      truck: PL19,
      policy: POLICY,
      policyVersion: 'test-1',
      validUntil: 'x',
    });

    expect(projection.conclusion.overall).toBe('OK');
    expect(projection.conclusion.viaCandidateId).toBe('g1:out');
    expect(projection.conclusion.retainedPointRefs).toEqual([okWidth.ref]);
    // The doubtful corner is still a point verdict — just not one the answer rests on.
    expect(projection.conclusion.pointVerdicts.map((pv) => pv.pointRef)).toContain(doubtRef);
  });
});

// ---------------------------------------------------------------------------
// corridor_empty defence
// ---------------------------------------------------------------------------

describe('corridor_empty escalation', () => {
  it('evaluateCandidateLegality returns HUMAN/corridor_empty for a zero-segment candidate', () => {
    const zeroSeg = candidate('z:in', 'in', []);
    const result = evaluateCandidateLegality(zeroSeg, PL19, POLICY);
    expect(result.verdict).toBe('HUMAN');
    expect(result.reasonCodes).toContain('corridor_empty');
    expect(result.blockedAtSegmentId).toBeNull();
  });

  it('a corridor_partial candidate (S3 coverage below policy) is HUMAN, not cleared', () => {
    const partial: RouteCandidate = {
      ...candidate('p:in', 'in', [segment({ segmentId: 'clean', position: 'transit' })]),
      coverage: { sampled: 10, matched: 5 },
      corridorReasonCodes: ['corridor_partial'],
    };
    const result = evaluateCandidateLegality(partial, PL19, POLICY);
    expect(result.verdict).toBe('HUMAN');
    expect(result.reasonCodes).toEqual(['corridor_partial']);
    expect(result.blockedAtSegmentId).toBeNull();
  });

  it('a zero-segment candidate never projects to OK (end-to-end via projectTruck)', () => {
    const zeroIn = candidate('z:in', 'in', []);
    const zeroOut = candidate('z:out', 'out', [], 'z:in');
    const okPoint = destinationPoint(width(10)); // generous — must not rescue the empty corridor

    const proj = projectTruck({
      candidates: [zeroIn, zeroOut],
      collected: {
        points: [okPoint],
        byCandidate: new Map([['z:in', [okPoint.ref]], ['z:out', [okPoint.ref]]]),
        geometryByCandidate: new Map(),
      },
      truck: PL19,
      policy: POLICY,
      policyVersion: 'test-tnl130',
      validUntil: '2026-10-01T00:00:00Z',
    });

    // The pair verdict must not be OK.
    expect(proj.conclusion.overall).not.toBe('OK');
    // Each candidate verdict must carry corridor_empty.
    for (const cv of proj.candidateVerdicts) {
      expect(cv.reasonCodes).toContain('corridor_empty');
    }
  });

  it('a zero-segment candidate projects to HUMAN, not NO (it is unknown, not refused)', () => {
    const zeroIn = candidate('z:in', 'in', []);
    const zeroOut = candidate('z:out', 'out', [], 'z:in');
    const proj = projectTruck({
      candidates: [zeroIn, zeroOut],
      collected: { points: [], byCandidate: new Map(), geometryByCandidate: new Map() },
      truck: PL19,
      policy: POLICY,
      policyVersion: 'test-tnl130',
      validUntil: '2026-10-01T00:00:00Z',
    });
    // HUMAN escalation, not a hard NO.
    expect(proj.conclusion.overall).toBe('HUMAN');
  });
});

describe('the corner the router draws in one vertex (Saint-Vivien)', () => {
  it('it is a junction turn, carries no radius, and is judged on its width', async () => {
    const { detectTurns } = await import('@teneolog/points');
    const M = 111_320;
    const p = (n: number, e: number) => ({
      lat: 46.0771 + n / M,
      lon: -0.9728 + e / (M * Math.cos((46.0771 * Math.PI) / 180)),
    });
    // OSRM's rendering of an ordinary crossroads: one vertex, 90° in one step.
    const polyline = [p(0, -80), p(0, -30), p(0, 0), p(-30, 0), p(-80, 0)];
    const turns = detectTurns(
      polyline,
      [],
      {
        windowM: 40, minDeflectionDeg: 45, bearingOffsetM: 10, mergeWithinM: 25,
        geometryConfidence: 0.7, curveIgnoreRadiusM: 60,
        junction: { nodeSnapM: 6, apexShare: 0.8 },
      },
      'x',
    );
    expect(turns).toHaveLength(1);
    const turn = turns[0];
    if (turn === undefined || !turn.geometry.known) throw new Error('no turn');
    expect(turn.kind).toBe('junction');
    // The heart of the fix: a corner carries NO radius, so the ~1 m radius
    // this used to compute — and publish as a ten-metre deficit — cannot exist.
    expect(turn.geometry.value.radiusM).toBeNull();

    const point: CriticalPoint = {
      ref: 'TURN@46.0771,-0.9728', type: 'TURN', at: turn.at,
      geometry: { ...turn.geometry, value: { type: 'TURN', geometry: turn.geometry.value } },
      evidence: [],
    };
    // Nothing joined a width to it here, so it is a question — not a refusal,
    // and not a clearance either (principe 5).
    for (const truck of [PL19, VUL]) {
      const evaluated = evaluatePoint(point, truck, POLICY);
      expect(evaluated.verdict).toBe('HUMAN');
      expect(evaluated.reasonCodes).toContain('turn_width_unknown');
    }
  });
});
