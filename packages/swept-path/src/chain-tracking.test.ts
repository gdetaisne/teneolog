import { describe, expect, it } from 'vitest';
import { convexHull, polygonArea } from './geometry.js';
import { simulateChainAlongGuide } from './chain-tracking.js';
import { rasterFootprintEnvelope } from './footprint-raster.js';
import type { Point, VehicleChain } from './types.js';

const rigid: VehicleChain = {
  links: [{ lengthM: 4, widthM: 2.5, frontOverhangM: 1.2, rearOverhangM: 1.7, refDistM: 2.8 }],
};

function lTurnGuide(): Point[] {
  const guide: Point[] = [];
  for (let i = 0; i < 30; i++) guide.push({ x: 0, y: -i * 0.5 });
  for (let i = 1; i < 30; i++) guide.push({ x: i * 0.5, y: -14.5 });
  return guide;
}

describe('rasterFootprintEnvelope', () => {
  it('produces a tighter envelope than convex hull on an L-turn', () => {
    const sim = simulateChainAlongGuide({ guideM: lTurnGuide(), chain: rigid, dsM: 0.25 });
    const footprints = sim.links.flatMap((lk) => lk.bodyFootprints.map((fp) => [...fp]));
    const t0 = performance.now();
    const { envelope, ok } = rasterFootprintEnvelope(footprints);
    const ms = performance.now() - t0;
    const hullArea = polygonArea(convexHull(footprints.flat()));

    expect(ok).toBe(true);
    expect(envelope.length).toBeGreaterThanOrEqual(4);
    expect(polygonArea(envelope)).toBeLessThan(hullArea * 0.95);
    expect(ms).toBeLessThan(500);
  });
});

describe('simulateChainAlongGuide — envelope policy', () => {
  it('defers metric envelope on the hot path (UI evenodd)', () => {
    const sim = simulateChainAlongGuide({ guideM: lTurnGuide(), chain: rigid, dsM: 0.25 });
    expect(sim.reasonCodes).toContain('swept_envelope_evenodd_ui');
    expect(sim.envelopePolygon).toHaveLength(0);
  });
});
