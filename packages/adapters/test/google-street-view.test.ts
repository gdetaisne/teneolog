/**
 * The Street View adapter's contract: metadata first (free), one billed image
 * only on coverage, heading computed from the pano's REAL position toward the
 * point, and honest nulls — cached, so "no coverage" is never re-asked.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import { GoogleStreetView } from '../src/google-street-view.js';

const CAMERA: GeoPoint = { lat: 47.0, lon: 1.0 };
const M = 111_320;
/** ~20 m due east of the camera. */
const LOOK_AT: GeoPoint = { lat: 47.0, lon: 1.0 + 20 / (M * Math.cos((47.0 * Math.PI) / 180)) };

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

function metadataResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function imageResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'image/jpeg' }),
    json: async () => ({}),
    text: async () => '',
    arrayBuffer: async () => JPEG_BYTES.buffer.slice(0),
  };
}

function stubFetch(handler: (url: URL) => unknown) {
  const mock = vi.fn(async (input: string | URL) => handler(new URL(String(input))));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function adapter(overrides: Partial<ConstructorParameters<typeof GoogleStreetView>[0]> = {}) {
  return new GoogleStreetView({ apiKey: 'test-key', timeoutMs: 5_000, ...overrides });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GoogleStreetView.fetchApproachStill', () => {
  it('returns the driver-eye still: heading from the real pano toward the point, dated', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.pathname.endsWith('/metadata')) {
        expect(url.searchParams.get('location')).toBe(`${CAMERA.lat},${CAMERA.lon}`);
        expect(url.searchParams.get('source')).toBe('outdoor');
        // The pano snapped exactly onto the camera point: heading must be the
        // pano→lookAt bearing, due east.
        return metadataResponse({
          status: 'OK',
          pano_id: 'pano-1',
          location: { lat: CAMERA.lat, lng: CAMERA.lon },
          date: '2023-05',
        });
      }
      expect(url.searchParams.get('pano')).toBe('pano-1');
      expect(Number(url.searchParams.get('heading'))).toBeCloseTo(90, 0);
      return imageResponse();
    });

    const still = await adapter().fetchApproachStill(CAMERA, LOOK_AT);

    expect(still).not.toBeNull();
    expect(still!.jpegBase64).toBe(Buffer.from(JPEG_BYTES).toString('base64'));
    expect(still!.panoId).toBe('pano-1');
    expect(still!.headingDeg).toBeCloseTo(90, 0);
    expect(still!.capturedAt).toBe('2023-05');
    expect(still!.panoDistanceM).toBeCloseTo(0, 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null on ZERO_RESULTS without billing an image', async () => {
    const fetchMock = stubFetch(() => metadataResponse({ status: 'ZERO_RESULTS' }));

    expect(await adapter().fetchApproachStill(CAMERA, LOOK_AT)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-coverage metadata failure instead of degrading silently', async () => {
    stubFetch(() => metadataResponse({ status: 'REQUEST_DENIED' }));

    await expect(adapter().fetchApproachStill(CAMERA, LOOK_AT)).rejects.toThrow('REQUEST_DENIED');
  });

  it('caches coverage metadata, never the JPEG — a repeat still re-fetches the image', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'sv-cache-'));
    const fetchMock = stubFetch((url) =>
      url.pathname.endsWith('/metadata')
        ? metadataResponse({
            status: 'OK',
            pano_id: 'pano-1',
            location: { lat: CAMERA.lat, lng: CAMERA.lon },
            date: null,
          })
        : imageResponse(),
    );
    const sv = adapter({ cacheDir });

    const first = await sv.fetchApproachStill(CAMERA, LOOK_AT);
    const second = await sv.fetchApproachStill(CAMERA, LOOK_AT);

    expect(second?.panoId).toBe(first?.panoId);
    expect(second?.jpegBase64).toBe(first?.jpegBase64);
    // 1 metadata + 2 billed stills. The JPEG must not be replayed from disk.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const { readFile, readdir } = await import('node:fs/promises');
    const files = await readdir(cacheDir);
    const cached = JSON.parse(await readFile(`${cacheDir}/${files[0]}`, 'utf8')) as {
      coverage: { panoId: string } | null;
      still?: unknown;
    };
    expect(cached.still).toBeUndefined();
    expect(cached.coverage?.panoId).toBe('pano-1');
    expect(JSON.stringify(cached)).not.toMatch(/ffd8|jpegBase64/i);

    const noCoverage: GeoPoint = { lat: 48.0, lon: 2.0 };
    fetchMock.mockImplementation(async () => metadataResponse({ status: 'ZERO_RESULTS' }));
    expect(await sv.fetchApproachStill(noCoverage, LOOK_AT)).toBeNull();
    expect(await sv.fetchApproachStill(noCoverage, LOOK_AT)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('lookupApproach is metadata-only — no billed image', async () => {
    const fetchMock = stubFetch((url) => {
      expect(url.pathname.endsWith('/metadata')).toBe(true);
      return metadataResponse({
        status: 'OK',
        pano_id: 'pano-1',
        location: { lat: CAMERA.lat, lng: CAMERA.lon },
        date: '2023-05',
      });
    });

    const coverage = await adapter().lookupApproach(CAMERA, LOOK_AT);
    expect(coverage?.panoId).toBe('pano-1');
    expect(coverage?.capturedAt).toBe('2023-05');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
