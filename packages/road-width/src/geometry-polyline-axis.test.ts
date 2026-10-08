import { describe, expect, it } from 'vitest';
import { buildRoadAxisFromPolylinePx } from './geometry.js';

describe('buildRoadAxisFromPolylinePx', () => {
  it('builds axisAt along a straight polyline', () => {
    const axis = buildRoadAxisFromPolylinePx(
      [
        [100, 200],
        [300, 200],
      ],
      10,
      [200, 200],
    );
    expect(axis).not.toBeNull();
    const at0 = axis!.axisAt(0);
    expect(at0.cx).toBeCloseTo(200, 0);
    expect(at0.cy).toBeCloseTo(200, 0);
    const at10 = axis!.axisAt(10);
    expect(at10.cx).toBeGreaterThan(at0.cx);
  });

  it('orients polyline toward a target point', () => {
    const axis = buildRoadAxisFromPolylinePx(
      [
        [50, 100],
        [250, 100],
      ],
      10,
      [150, 100],
      [250, 100],
    );
    expect(axis).not.toBeNull();
    expect(axis!.axisAt(5).cx).toBeGreaterThan(axis!.axisAt(0).cx);
  });
});
