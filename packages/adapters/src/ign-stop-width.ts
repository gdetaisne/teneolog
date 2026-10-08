/**
 * `StopWidthPort` over IGN imagery: project the stop onto the street axis,
 * take the local bearing there, stitch three tiles anchored AT that point,
 * hand the frame to the D10 core.
 *
 * Anchoring at the projected stop is the whole point (imagery.md §5): the
 * width the report publishes is the width where the truck stands, and any
 * residual offset is carried by the fact, not hidden by a window search.
 */
import type { Fact, GeoPoint, Width } from '@teneolog/domain';
import { measureD10StopWidth } from '@teneolog/constraints';
import type { StopWidthPort } from '@teneolog/pipeline';
import { bearingDeg, closestPointOnPolyline, type RoadWay } from '@teneolog/topology';

import { IgnOrtho } from './ign-ortho.js';

export interface IgnStopWidthOptions {
  readonly wmsUrl: string;
  readonly timeoutMs: number;
  /** Zoom of the measurement frame. 19 → 50 m field, ~0.1 m/px at 512. */
  readonly zoom: number;
  readonly sizePx: number;
}

export class IgnStopWidth implements StopWidthPort {
  private readonly ortho: IgnOrtho;

  constructor(private readonly options: IgnStopWidthOptions) {
    this.ortho = new IgnOrtho({ wmsUrl: options.wmsUrl, timeoutMs: options.timeoutMs });
  }

  async measureStopWidth(at: GeoPoint, street: RoadWay): Promise<Fact<Width>> {
    const projection = closestPointOnPolyline(street.geometry, at);
    if (projection === null) return { known: false, why: 'no_data' };

    const from = street.geometry[projection.segmentIndex];
    const to = street.geometry[projection.segmentIndex + 1];
    if (from === undefined || to === undefined) return { known: false, why: 'no_data' };

    const [stitched, capture] = await Promise.all([
      this.ortho.fetchStitched(
        projection.point,
        bearingDeg(from, to),
        this.options.zoom,
        this.options.sizePx,
      ),
      this.ortho.fetchCaptureDate(projection.point).catch(() => null),
    ]);

    return measureD10StopWidth({
      stitched: stitched.rgb,
      frame: stitched.tile,
      pxPerM: stitched.pxPerM,
      bearingDeg: stitched.bearingDeg,
      streetGeometry: street.geometry,
      anchor: at,
      fetchedAt: new Date().toISOString(),
      imageryDate: capture?.capturedAt ?? null,
    });
  }
}
