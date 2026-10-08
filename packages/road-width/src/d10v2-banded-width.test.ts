import { describe, expect, it } from 'vitest';
import {
  bdtopoV2WidthBand,
  findBandKerbCandidates,
  pickBestKerbPair,
  resolveD10v2StructuralWidth,
  BDTOPO_V2_BAND_HALF_M,
} from './d10v2-banded-width.js';

function makeOffsets(fromM: number, toM: number, stepM: number): number[] {
  const out: number[] = [];
  for (let o = fromM; o <= toM + stepM * 0.01; o += stepM) {
    out.push(Math.round(o * 1000) / 1000);
  }
  return out;
}

function kerbPeakScores(offsetsM: number[], leftKerbM: number, rightKerbM: number): number[] {
  return offsetsM.map((o) => {
    if (Math.abs(o - leftKerbM) <= 0.12 || Math.abs(o - rightKerbM) <= 0.12) return 0.75;
    if (Math.abs(o) < 0.5) return 0.1;
    if (o > leftKerbM && o < rightKerbM) return 0.12;
    return 0.05;
  });
}

describe('bdtopoV2WidthBand', () => {
  it('uses 1.5 m total spread', () => {
    const b = bdtopoV2WidthBand(7);
    expect(b.bandLoM).toBe(6.25);
    expect(b.bandHiM).toBe(7.75);
    expect(b.leftEdgeOuterM).toBe(-3.875);
    expect(b.rightEdgeOuterM).toBe(3.875);
  });
});

describe('resolveD10v2StructuralWidth', () => {
  it('picks kerb pair when both edges visible in band', () => {
    const offsetsM = makeOffsets(-5, 5, 0.05);
    const leftKerb = -3.5;
    const rightKerb = 3.5;
    const r = resolveD10v2StructuralWidth({
      bdtopoWidthM: 7,
      offsetsM,
      sidewalkBoundaryScore: kerbPeakScores(offsetsM, leftKerb, rightKerb),
      roadMatchProfile: offsetsM.map(() => 0.8),
    });
    expect(r.source).toBe('kerb_pair');
    expect(r.largeurRueM).toBeCloseTo(7, 0);
    expect(r.leftEdgeM).toBeLessThan(0);
    expect(r.rightEdgeM).toBeGreaterThan(0);
  });

  it('falls back to BDTOPO when no kerbs in band (Paris arbres pattern)', () => {
    const offsetsM = makeOffsets(-5, 5, 0.25);
    const r = resolveD10v2StructuralWidth({
      bdtopoWidthM: 7,
      offsetsM,
      sidewalkBoundaryScore: offsetsM.map(() => 0.05),
      roadMatchProfile: offsetsM.map(() => 0.2),
    });
    expect(r.source).toBe('bdtopo_fallback');
    expect(r.largeurRueM).toBe(7);
    expect(r.bandLoM).toBe(6.25);
    expect(r.bandHiM).toBe(7.75);
  });

  it('rejects kerb pair outside band width', () => {
    const offsetsM = makeOffsets(-6, 6, 0.25);
    const band = bdtopoV2WidthBand(4);
    const left = findBandKerbCandidates('left', {
      offsetsM,
      sidewalkBoundaryScore: kerbPeakScores(offsetsM, -2.5, 2.5),
      band,
    });
    const right = findBandKerbCandidates('right', {
      offsetsM,
      sidewalkBoundaryScore: kerbPeakScores(offsetsM, -2.5, 2.5),
      band,
    });
    const pick = pickBestKerbPair(left, right, band, 4);
    expect(pick).toBeNull();
  });

  it('returns unavailable without BDTOPO', () => {
    const r = resolveD10v2StructuralWidth({
      bdtopoWidthM: null,
      offsetsM: [],
      sidewalkBoundaryScore: [],
    });
    expect(r.source).toBe('unavailable');
    expect(r.largeurRueM).toBeNull();
  });

  it('band half matches guided experiment', () => {
    expect(BDTOPO_V2_BAND_HALF_M).toBe(0.75);
  });
});
