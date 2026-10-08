/**
 * la pente se lit sur l'IGN (RGE ALTI), plus sur Google (principe 49,
 * complété le 2026-09-29). Le service de la Géoplateforme, sans clé :
 * `elevation.json`, ressource `ign_rge_alti_wld`. Les altitudes rendues ici sont
 * celles que le service a données le 2026-09-29 à La Crèche (3 route du Modèle :
 * l'arrêt de repli Rue Voisine B, 62,25 m ; la porte, 45,55 m).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeoPoint } from '@teneolog/domain';
import { ElevationNoDataError } from '@teneolog/pipeline';

import { IgnAltimetry, IgnAltimetryNoDataError } from '../src/ign-altimetry.js';

const STOP: GeoPoint = { lat: 46.3707484, lon: -0.2546926 };
const DOOR: GeoPoint = { lat: 46.372455, lon: -0.256067 };
const OFFSHORE: GeoPoint = { lat: 60, lon: 2 };

interface Call {
  readonly url: string;
  readonly body: Record<string, string>;
}

function stubFetch(answer: (body: Record<string, string>) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const mock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    calls.push({ url: String(input), body });
    const { status = 200, json } = answer(body);
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IgnAltimetry.getElevations', () => {
  it('asks the Géoplateforme for RGE ALTI heights, points joined by |, and returns them in order', async () => {
    const calls = stubFetch(() => ({ json: { elevations: [62.25, 45.55] } }));
    const samples = await new IgnAltimetry({ timeoutMs: 5_000 }).getElevations([STOP, DOOR]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json');
    expect(calls[0]!.body).toEqual({
      lon: `${STOP.lon}|${DOOR.lon}`,
      lat: `${STOP.lat}|${DOOR.lat}`,
      resource: 'ign_rge_alti_wld',
      zonly: 'true',
    });
    expect(samples).toEqual([
      { at: STOP, elevationMeters: 62.25 },
      { at: DOOR, elevationMeters: 45.55 },
    ]);
  });

  it('keeps what it read: the same point twice costs one request (the ground does not move)', async () => {
    const calls = stubFetch((body) => ({ json: { elevations: body['lat']!.split('|').map(() => 62.25) } }));
    const port = new IgnAltimetry({ timeoutMs: 5_000 });
    await port.getElevations([STOP]);
    const again = await port.getElevations([STOP, DOOR]);

    expect(calls).toHaveLength(2);
    // The second request asks only for the point it does not know.
    expect(calls[1]!.body['lat']).toBe(String(DOOR.lat));
    expect(again.map((s) => s.elevationMeters)).toEqual([62.25, 62.25]);
  });

  it('a small cache never loses a height mid-call: cached points read before the fetch, fetched ones kept for the answer', async () => {
    // Relecture du 2026-09-30 : la mémoire FIFO évinçait, pendant l'appel, une hauteur comptée
    // comme connue — hauteur `undefined`, pente NaN, et NaN lu « le tire-palette passe » (principe 14).
    const heightOf = (lat: string) => Math.round(Number(lat) * 1e4) / 100;
    stubFetch((body) => ({ json: { elevations: body['lat']!.split('|').map(heightOf) } }));
    const p = (i: number): GeoPoint => ({ lat: 46.37 + i * 0.001, lon: -0.29 });
    const port = new IgnAltimetry({ timeoutMs: 5_000, maxCachedPoints: 2 });
    await port.getElevations([p(0), p(1)]);
    // p(0) et p(1) sont gardés ; p(2) et p(3) les chassent pendant l'appel.
    const mixed = await port.getElevations([p(0), p(2), p(3), p(1)]);
    expect(mixed.map((s) => s.elevationMeters)).toEqual([p(0), p(2), p(3), p(1)].map((q) => heightOf(String(q.lat))));
    // Tout neuf, en requêtes d'un point : le premier lu est chassé par le troisième.
    const small = new IgnAltimetry({ timeoutMs: 5_000, maxCachedPoints: 2, maxPointsPerRequest: 1 });
    const fresh = await small.getElevations([p(4), p(5), p(6)]);
    expect(fresh.every((s) => Number.isFinite(s.elevationMeters))).toBe(true);
    expect(fresh.map((s) => s.elevationMeters)).toEqual([p(4), p(5), p(6)].map((q) => heightOf(String(q.lat))));
  });

  it('cuts a long walk in requests of at most `maxPointsPerRequest`', async () => {
    const calls = stubFetch((body) => ({ json: { elevations: body['lat']!.split('|').map(() => 50) } }));
    const points = Array.from({ length: 5 }, (_, i) => ({ lat: 46.37 + i * 0.0001, lon: -0.29 }));
    const samples = await new IgnAltimetry({ timeoutMs: 5_000, maxPointsPerRequest: 2 }).getElevations(points);

    expect(calls.map((c) => c.body['lat']!.split('|').length)).toEqual([2, 2, 1]);
    expect(samples).toHaveLength(5);
  });

  it('a point outside the model (-99999) is no data: an unknown, never a height', async () => {
    stubFetch(() => ({ json: { elevations: [62.25, -99999.0] } }));
    await expect(new IgnAltimetry({ timeoutMs: 5_000 }).getElevations([STOP, OFFSHORE])).rejects.toBeInstanceOf(
      IgnAltimetryNoDataError,
    );
    // The port's own « no data », the one S2 reads (`no_data`, not `provider_error`).
    expect(new IgnAltimetryNoDataError(1)).toBeInstanceOf(ElevationNoDataError);
  });

  it('an HTTP error or a short answer throws, so the reader keeps the slope unknown', async () => {
    stubFetch(() => ({ status: 400, json: { error: { code: 'BAD_PARAMETER' } } }));
    await expect(new IgnAltimetry({ timeoutMs: 5_000 }).getElevations([STOP])).rejects.toThrow(/HTTP 400/);

    stubFetch(() => ({ json: { elevations: [62.25] } }));
    await expect(new IgnAltimetry({ timeoutMs: 5_000 }).getElevations([STOP, DOOR])).rejects.toThrow(/1 heights for 2/);
  });

  it('no point, no request', async () => {
    const calls = stubFetch(() => ({ json: { elevations: [] } }));
    expect(await new IgnAltimetry({ timeoutMs: 5_000 }).getElevations([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
