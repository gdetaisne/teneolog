import { describe, expect, it } from 'vitest';
import type { CarZone } from './car-zone.js';
import type { D10v2StructuralResult } from './d10v2-banded-width.js';
import { attachD10v2Rollable } from './d10v2-rollable-width.js';

function structural(overrides: Partial<D10v2StructuralResult> = {}): D10v2StructuralResult {
  return {
    largeurRueM: 5,
    source: 'bdtopo_fallback',
    leftEdgeM: -2.5,
    rightEdgeM: 2.5,
    bandLoM: 4.25,
    bandHiM: 5.75,
    confidence: 0.4,
    reasonCodes: ['d10v2:bdtopo_fallback'],
    ...overrides,
  };
}

function carZone(side: 'left' | 'right', inner: number, outer: number): CarZone {
  return {
    side,
    innerEdgeM: inner,
    outerEdgeM: outer,
    widthM: Math.abs(outer - inner),
    level: 'certain',
    confidence: 0.9,
    notes: ['test'],
  };
}

describe('attachD10v2Rollable', () => {
  it('keeps structural width when no parking evidence', () => {
    const r = attachD10v2Rollable(structural(), {
      carZones: [],
      parkingSideCount: 0,
      parkedCarCount: 0,
    });
    expect(r.largeurExploitableM).toBe(5);
    expect(r.rollableSource).toBe('structural_unchanged');
    expect(r.leftRollableM).toBe(-2.5);
    expect(r.rightRollableM).toBe(2.5);
  });

  it('keeps structural width when parking polygons but YOLO did not clamp (no blind penalty)', () => {
    const r = attachD10v2Rollable(structural(), {
      carZones: [],
      parkingSideCount: 2,
      parkedCarCount: 0,
    });
    expect(r.largeurExploitableM).toBe(5);
    expect(r.rollableSource).toBe('structural_unchanged');
  });

  it('clamps rollable width inward with YOLO car zones', () => {
    const r = attachD10v2Rollable(structural({ source: 'kerb_pair' }), {
      carZones: [carZone('right', 2.0, 3.5)],
      parkingSideCount: 0,
      parkedCarCount: 1,
    });
    expect(r.rollableSource).toBe('yolo_clamp');
    expect(r.largeurExploitableM).toBeLessThan(5);
    expect(r.rightRollableM).toBeLessThan(2.5);
  });

  it('uses D10 final when narrower and parking evidence (LR parking pattern)', () => {
    const r = attachD10v2Rollable(structural(), {
      carZones: [],
      parkingSideCount: 2,
      parkedCarCount: 3,
      d10WidthFinalM: 2,
    });
    expect(r.largeurExploitableM).toBe(2);
    expect(r.rollableSource).toBe('d10_corroborated');
  });

  it('prefers YOLO clamp over BDTOPO penalty when cars overlap structural span', () => {
    const r = attachD10v2Rollable(structural(), {
      carZones: [carZone('left', -2.0, -3.5), carZone('right', 2.0, 3.5)],
      parkingSideCount: 2,
      parkedCarCount: 4,
    });
    expect(r.rollableSource).toBe('yolo_clamp');
    expect(r.largeurExploitableM).toBeLessThan(5);
  });

  it('returns unavailable when structural is unavailable', () => {
    const r = attachD10v2Rollable(
      structural({ source: 'unavailable', largeurRueM: null, leftEdgeM: null, rightEdgeM: null }),
      { carZones: [], parkingSideCount: 0, parkedCarCount: 0 },
    );
    expect(r.largeurExploitableM).toBeNull();
    expect(r.rollableSource).toBe('unavailable');
  });
});
