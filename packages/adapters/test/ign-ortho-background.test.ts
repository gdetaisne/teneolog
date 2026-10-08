import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStitchedCanvasMetrics } from '@teneolog/road-width';

import { IgnOrtho } from '../src/ign-ortho.js';

/** Engine parity constant, duplicated on purpose: the test pins the convention. */
const WMS_METERS_PER_DEG_LAT = 111_100;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IgnOrtho.fetchFrameBackground', () => {
  it('asks the WMS for the exact pixel frame of the stitch, in the tiles\' bbox convention', async () => {
    // A diagonal stitch: tiles B and C offset down-right, the bounding box
    // much larger than the union — the black-corner case.
    const tile = { latA: 46.0735, lngA: -0.9654, dx2Px: 271.5, dy2Px: 271.5, dx3Px: 543, dy3Px: 543 };
    const pxPerM = 512 / 50;
    const metrics = getStitchedCanvasMetrics(tile);

    let seen: URL | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        seen = new URL(String(input));
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'image/jpeg' }),
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        };
      }),
    );

    const out = await new IgnOrtho({ wmsUrl: 'https://wms.test/wms-r', timeoutMs: 1000 }).fetchFrameBackground({
      tile,
      pxPerM,
    });

    expect(out.widthPx).toBe(metrics.width);
    expect(out.heightPx).toBe(metrics.height);
    expect(out.jpegBase64).toBe(Buffer.from([1, 2, 3]).toString('base64'));

    const url = seen as URL | null;
    expect(url).not.toBeNull();
    expect(url!.searchParams.get('WIDTH')).toBe(String(metrics.width));
    expect(url!.searchParams.get('HEIGHT')).toBe(String(metrics.height));

    const [south, west, north, east] = url!.searchParams.get('BBOX')!.split(',').map(Number);
    const mPerPx = 1 / pxPerM;
    const dLat = mPerPx / WMS_METERS_PER_DEG_LAT;
    const dLon = mPerPx / (WMS_METERS_PER_DEG_LAT * Math.cos((tile.latA * Math.PI) / 180));
    // Tile A's centre must sit exactly at (tileACanvasX, tileACanvasY) of the frame.
    expect(north).toBeCloseTo(tile.latA + metrics.tileACanvasY * dLat, 9);
    expect(south).toBeCloseTo(tile.latA - (metrics.height - metrics.tileACanvasY) * dLat, 9);
    expect(west).toBeCloseTo(tile.lngA - metrics.tileACanvasX * dLon, 9);
    expect(east).toBeCloseTo(tile.lngA + (metrics.width - metrics.tileACanvasX) * dLon, 9);
    // And the frame really is the whole box, not three tiles: wider than one tile.
    expect(metrics.width).toBeGreaterThan(512);
  });
});
