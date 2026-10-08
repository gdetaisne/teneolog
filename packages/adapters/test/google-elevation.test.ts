import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import { GoogleElevation } from '../src/google-elevation.js';

const A: GeoPoint = { lat: 47.0, lon: 1.0 };
const B: GeoPoint = { lat: 47.001, lon: 1.0 };

function stubFetch(handler: (url: URL) => unknown) {
  const mock = vi.fn(async (input: string | URL) => handler(new URL(String(input))));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GoogleElevation.getElevations', () => {
  it('asks for the requested points and returns heights in order', async () => {
    const fetchMock = stubFetch((url) => {
      expect(url.searchParams.get('locations')).toBe(`${A.lat},${A.lon}|${B.lat},${B.lon}`);
      expect(url.searchParams.get('key')).toBe('test-key');
      return {
        ok: true,
        json: async () => ({
          status: 'OK',
          results: [
            { elevation: 12.4, location: { lat: A.lat, lng: A.lon } },
            { elevation: 18.1, location: { lat: B.lat, lng: B.lon } },
          ],
        }),
      };
    });

    const samples = await new GoogleElevation({ apiKey: 'test-key', timeoutMs: 5_000 }).getElevations([A, B]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(samples).toEqual([
      { at: A, elevationMeters: 12.4 },
      { at: B, elevationMeters: 18.1 },
    ]);
  });

  it('throws on a non-OK status so the pipeline can keep slope unknown', async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({ status: 'REQUEST_DENIED', error_message: 'Elevation API not enabled' }),
    }));

    await expect(
      new GoogleElevation({ apiKey: 'test-key', timeoutMs: 5_000 }).getElevations([A]),
    ).rejects.toThrow(/REQUEST_DENIED/);
  });
});
