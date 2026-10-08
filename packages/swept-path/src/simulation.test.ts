import { describe, expect, it } from 'vitest';
import {
  PL_19T_TRUCK,
  headingChangeDeg,
  requiredWidthForTurnM,
  simulateStreet,
  simulateTurn,
  steadyStateOfftrackingM,
} from './index.js';

describe('@teneolog/swept-path P0', () => {
  it('matches the existing SAE/WHI off-tracking formula order of magnitude', () => {
    const offtrack = steadyStateOfftrackingM(PL_19T_TRUCK.turnRadiusM, PL_19T_TRUCK.wheelbaseM);
    expect(offtrack).toBeCloseTo(1.85, 1);
    expect(requiredWidthForTurnM(90, PL_19T_TRUCK, 1)).toBeCloseTo(5.35, 1);
  });

  it('computes heading change in degrees', () => {
    expect(headingChangeDeg(0, 90)).toBe(90);
    expect(headingChangeDeg(350, 10)).toBe(20);
  });

  it('passes a straight street when road width exceeds truck width plus margin', () => {
    const result = simulateStreet({
      kind: 'street',
      truck: PL_19T_TRUCK,
      streetWidthM: 4.5,
      lengthM: 30,
      safetyMarginM: 1,
    });
    expect(result.verdict).toBe('pass');
    expect(result.minClearanceM).toBeGreaterThan(0.4);
    expect(result.reasonCodes).toContain('street_mode');
    expect(result.rearAxlePath).toHaveLength(result.drivenPath.length);
    expect(result.frontAxlePath).toHaveLength(result.drivenPath.length);
    expect(result.frontAxlePath[0]!.x - result.rearAxlePath[0]!.x).toBeCloseTo(
      PL_19T_TRUCK.wheelbaseM,
      3,
    );
  });

  it('fails a straight street when the editable width is too narrow', () => {
    const result = simulateStreet({
      kind: 'street',
      truck: PL_19T_TRUCK,
      streetWidthM: 3.0,
      lengthM: 30,
      safetyMarginM: 1,
    });
    expect(result.verdict).toBe('fail');
    expect(result.minClearanceM).toBeLessThan(0);
    expect(result.biteSamples.length).toBeGreaterThan(0);
  });

  it('runs a turn simulation with a deterministic offset grid search', () => {
    const result = simulateTurn({
      kind: 'turn',
      truck: PL_19T_TRUCK,
      apex: { x: 0, y: 0 },
      incomingBearingDeg: 0,
      outgoingBearingDeg: 90,
      incomingWidthM: 7,
      outgoingWidthM: 7,
      safetyMarginM: 1,
      candidateOffsetsM: [-1.5, -0.75, 0, 0.75, 1.5],
    });
    expect(result.kind).toBe('turn');
    expect(result.optimization?.candidates).toHaveLength(5);
    expect(result.optimization?.apexOffsetM).toBeTypeOf('number');
    expect(result.envelopePolygon.length).toBeGreaterThanOrEqual(4);
    expect(result.requiredWidthM1d).toBeGreaterThan(5);
    expect(result.frontAxlePath.length).toBe(result.rearAxlePath.length);
  });

  it('surfaces a fail on a narrow right-angle turn', () => {
    const result = simulateTurn({
      kind: 'turn',
      truck: PL_19T_TRUCK,
      apex: { x: 0, y: 0 },
      incomingBearingDeg: 0,
      outgoingBearingDeg: 90,
      incomingWidthM: 3.2,
      outgoingWidthM: 3.2,
      safetyMarginM: 1,
      candidateOffsetsM: [-0.25, 0, 0.25],
    });
    expect(result.verdict).toBe('fail');
    expect(result.overlapAreaM2).toBeGreaterThan(0);
  });
});
