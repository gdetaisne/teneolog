/**
 * The routed geometry as it enters the domain.
 *
 * OSRM repeats its snapped departure vertex. Two identical points are not a
 * segment, and every consumer downstream reads a bearing of 0° there — due
 * north — and believes it. That north opened the review of a perfectly
 * straight street with "le 19 t tourne-t-il ici ?".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';

import { OsrmRouting } from '../src/osrm.js';

const FROM: GeoPoint = { lat: 46.083158, lon: -0.944441 };
const TO: GeoPoint = { lat: 46.073459, lon: -0.96543 };

function stubRoutes(coordinates: readonly (readonly [number, number])[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [{ distance: 2096.3, duration: 180, geometry: { coordinates } }],
      }),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OsrmRouting.route', () => {
  it('the repeated departure vertex does not reach the domain', async () => {
    // The real head of 12 rue de l’Exemple → the snapped point, twice.
    stubRoutes([
      [-0.944441, 46.083158],
      [-0.944441, 46.083158],
      [-0.944746, 46.083047],
      [-0.945025, 46.082985],
    ]);

    const paths = await new OsrmRouting({ baseUrl: 'http://osrm', timeoutMs: 5_000 }).route(
      FROM,
      TO,
      0,
    );

    expect(paths[0]?.polyline).toEqual([
      { lat: 46.083158, lon: -0.944441 },
      { lat: 46.083047, lon: -0.944746 },
      { lat: 46.082985, lon: -0.945025 },
    ]);
  });

  it('a line with no repeat is passed through untouched, distance and duration included', async () => {
    stubRoutes([
      [-0.944441, 46.083158],
      [-0.944746, 46.083047],
    ]);

    const paths = await new OsrmRouting({ baseUrl: 'http://osrm', timeoutMs: 5_000 }).route(
      FROM,
      TO,
      0,
    );

    expect(paths).toEqual([
      {
        polyline: [
          { lat: 46.083158, lon: -0.944441 },
          { lat: 46.083047, lon: -0.944746 },
        ],
        distanceM: 2096.3,
        durationS: 180,
      },
    ]);
  });
});
