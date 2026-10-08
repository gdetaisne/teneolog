import { describe, expect, it } from 'vitest';
import {
  sidewalkBreakEvidence,
  sidewalkSampleBreakEvidence,
  sidewalkShadowDebugTags,
  SIDEWALK_SHADOW_DEBUG_MIN,
} from './sidewalk-boundary-shadow.js';

describe('sidewalkBreakEvidence', () => {
  const asphaltRef: [number, number, number] = [128, 125, 120];
  const asphaltLike: [number, number, number] = [130, 127, 122];
  const concreteLike: [number, number, number] = [175, 170, 165];

  it('keeps asphalt-like samples low vs central reference', () => {
    const ev = sidewalkBreakEvidence(asphaltLike, asphaltRef);
    expect(ev).toBeLessThan(0.2);
  });

  it('scores concrete-like lateral band higher than asphalt', () => {
    const asphaltEv = sidewalkBreakEvidence(asphaltLike, asphaltRef);
    const concreteEv = sidewalkBreakEvidence(concreteLike, asphaltRef);
    expect(concreteEv).toBeGreaterThan(0.45);
    expect(concreteEv).toBeGreaterThan(asphaltEv * 2);
  });

  it('does not score darker canopy or shadow as sidewalk break evidence', () => {
    const shadowLike: [number, number, number] = [92, 105, 98];

    expect(sidewalkBreakEvidence(shadowLike, asphaltRef)).toBe(0);
  });

  it('does not score darker chroma drift as sidewalk break evidence', () => {
    const chromaDrift: [number, number, number] = [116, 130, 120];

    expect(sidewalkBreakEvidence(chromaDrift, asphaltRef)).toBe(0);
  });
});

describe('sidewalkSampleBreakEvidence', () => {
  const asphaltRef: [number, number, number] = [128, 125, 120];

  it('treats white markings as sidewalk break evidence', () => {
    const whiteMarking: [number, number, number] = [230, 230, 226];

    expect(sidewalkSampleBreakEvidence(whiteMarking, asphaltRef)).toBe(1);
  });

  it('treats faded ortho markings as sidewalk break evidence', () => {
    const fadedWhiteMarking: [number, number, number] = [188, 190, 189];

    expect(sidewalkSampleBreakEvidence(fadedWhiteMarking, asphaltRef)).toBe(1);
  });

  it('keeps white markings out of the asphalt-like low bucket', () => {
    const asphaltLike: [number, number, number] = [130, 127, 122];

    expect(sidewalkSampleBreakEvidence(asphaltLike, asphaltRef)).toBeLessThan(0.2);
  });
});

describe('sidewalkShadowDebugTags', () => {
  it('emits debug reason when max exceeds threshold', () => {
    const scores = [0.1, 0.2, SIDEWALK_SHADOW_DEBUG_MIN + 0.1, 0.15];
    const tags = sidewalkShadowDebugTags(scores, [-1, 0, 2, 3]);
    expect(tags.reason).toBe('sidewalk_boundary_shadow_debug');
    expect(tags.note).toContain('sidewalk_boundary_shadow:max=');
    expect(tags.note).toContain('@2.00m');
  });

  it('returns null tags when curve stays low', () => {
    const tags = sidewalkShadowDebugTags([0.05, 0.1, 0.12]);
    expect(tags.reason).toBeNull();
    expect(tags.note).toBeNull();
  });
});
