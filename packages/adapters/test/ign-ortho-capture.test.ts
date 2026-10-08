import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearIgnCaptureCache,
  fetchIgnCaptureDate,
  formatIgnAttributionFr,
  parseJsonFeatureInfo,
  parsePlainFeatureInfo,
} from '../src/ign-ortho-capture.js';

afterEach(() => {
  vi.unstubAllGlobals();
  clearIgnCaptureCache();
});

const PARIS_PLAIN = `Results for FeatureType 'http://ORTHOIMAGERY.ORTHOPHOTOS.GRAPHE-MOSAIQUAGE:graphe_bdortho':
--------------------------------------------
dep = 75
pva = 2024
res = 20
echelle = 50
date_vol = 2024-08-22Z
ordre_debu = 719
ordre_fin = 9999
--------------------------------------------
`;

describe('parsePlainFeatureInfo', () => {
  it('reads date_vol, year and 20 cm resolution from the Géoplateforme graphe', () => {
    expect(parsePlainFeatureInfo(PARIS_PLAIN)).toEqual({
      capturedAt: '2024-08-22',
      resolutionCm: 20,
    });
  });

  it('returns null on a WMS exception', () => {
    expect(parsePlainFeatureInfo('<ServiceExceptionReport></ServiceExceptionReport>')).toBeNull();
  });

  it('falls back to the PVA year when the flight day is absent', () => {
    expect(parsePlainFeatureInfo('pva = 2022\nres = 20\n')).toEqual({
      capturedAt: '2022',
      resolutionCm: 20,
    });
  });
});

describe('parseJsonFeatureInfo', () => {
  it('reads the same properties off a GeoJSON FeatureCollection', () => {
    expect(
      parseJsonFeatureInfo(
        JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { dep: '75', pva: 2024, res: 20, date_vol: '2024-08-22Z' },
            },
          ],
        }),
      ),
    ).toEqual({ capturedAt: '2024-08-22', resolutionCm: 20 });
  });
});

describe('formatIgnAttributionFr', () => {
  it('prints the Licence Ouverte line with a French day', () => {
    expect(formatIgnAttributionFr({ capturedAt: '2024-08-22', resolutionCm: 20 })).toBe(
      'IGN, prise de vue 22/08/2024',
    );
  });

  it('keeps IGN when the vintage is unknown', () => {
    expect(formatIgnAttributionFr(null)).toBe('IGN');
  });
});

describe('fetchIgnCaptureDate', () => {
  it('asks GetFeatureInfo at the pixel centre and caches a hit', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('REQUEST')).toBe('GetFeatureInfo');
      expect(url.searchParams.get('LAYERS')).toBe('ORTHOIMAGERY.ORTHOPHOTOS');
      expect(url.searchParams.get('I')).toBe('50');
      expect(url.searchParams.get('J')).toBe('50');
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: async () => PARIS_PLAIN,
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const options = {
      wmsUrl: 'https://wms.test/wms-r',
      timeoutMs: 1000,
      at: { lat: 48.867, lon: 2.33 },
    };
    const first = await fetchIgnCaptureDate(options);
    const second = await fetchIgnCaptureDate({ ...options, at: { lat: 48.8671, lon: 2.3302 } });

    expect(first).toEqual({ capturedAt: '2024-08-22', resolutionCm: 20 });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
