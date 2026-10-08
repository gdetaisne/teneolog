import { describe, expect, it } from 'vitest';
import { buildRoadWidthVerdict, widthsCorroborateBdtopo } from './verdict.js';

describe('widthsCorroborateBdtopo', () => {
  it('accepts within absolute tolerance on narrow roads', () => {
    expect(widthsCorroborateBdtopo(2.8, 3)).toBe(true);
    expect(widthsCorroborateBdtopo(2.2, 3)).toBe(false);
  });

  it('accepts within relative tolerance on wider roads', () => {
    expect(widthsCorroborateBdtopo(6.9, 7)).toBe(true);
    expect(widthsCorroborateBdtopo(6.0, 7)).toBe(false);
  });
});

describe('buildRoadWidthVerdict — BDTOPO corroboration lift', () => {
  const base = {
    widthM: 7,
    confidence: 0.45,
    reasonCodes: ['too_narrow'] as const,
    yoloStatus: 'empty' as const,
    asphaltSampleCount: 40,
    parkingSensitive: false,
  };

  it('promotes needs_review to usable when measure matches BDTOPO', () => {
    const verdict = buildRoadWidthVerdict({
      ...base,
      widthM: 2.85,
      reasonCodes: ['too_narrow'],
      bdtopoWidthM: 3,
    });
    expect(verdict.status).toBe('usable');
    expect(verdict.degradedReasons).toContain('bdtopo_width_corroborated_lift');
  });

  it('does not promote when measure and BDTOPO diverge', () => {
    const verdict = buildRoadWidthVerdict({
      ...base,
      widthM: 2.75,
      reasonCodes: ['too_narrow'],
      bdtopoWidthM: 4,
    });
    expect(verdict.status).toBe('needs_review');
    expect(verdict.degradedReasons).toContain('width_out_of_plausible_range');
  });

  it('does not promote when YOLO blocks parking-sensitive entries', () => {
    const verdict = buildRoadWidthVerdict({
      ...base,
      widthM: 3,
      reasonCodes: [],
      bdtopoWidthM: 3,
      yoloStatus: 'timeout',
      parkingSensitive: true,
    });
    expect(verdict.status).toBe('needs_review');
    expect(verdict.blockingReasons).toContain('yolo_unreliable_parking_sensitive');
  });

  it('does not promote unavailable verdicts', () => {
    const verdict = buildRoadWidthVerdict({
      ...base,
      widthM: null,
      reasonCodes: ['no_plateau'],
      bdtopoWidthM: 5,
    });
    expect(verdict.status).toBe('unavailable');
  });
});
