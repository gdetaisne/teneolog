/**
 * the BAN adapter carries the score through untouched, so the
 * pipeline can hold it against `geocoding.minBanScore`. The adapter itself
 * does not decide: a threshold is a policy number, and it lives upstream.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BanGeocoder, GEOPLATEFORME_GEOCODING_URL } from '../src/ban-geocoder.js';
import sevremoineRecorded from './fixtures/geoplateforme-autocomplete-sevremoine.json' with { type: 'json' };
import thaireRecorded from './fixtures/geoplateforme-search-thaire.json' with { type: 'json' };

function stubBan(features: readonly unknown[]) {
  const mock = vi.fn(async (_input: string | URL) => ({ ok: true, json: async () => ({ features }) }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

const geocoder = () => new BanGeocoder({ baseUrl: 'https://ban.test', timeoutMs: 1_000 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BanGeocoder.geocode', () => {
  it('returns the first feature as one opinion with its label and score', async () => {
    // Live 2026-09-09: "200 Rue de la Loi Bruxelles" → a French homonym at 0.537.
    stubBan([
      {
        geometry: { coordinates: [-1.4845, 47.2313] },
        properties: { label: 'Rue de Bruxelles 44300 Nantes', score: 0.537, type: 'street', id: '44109_1234' },
      },
    ]);

    const opinions = await geocoder().geocode('200 Rue de la Loi Bruxelles');

    expect(opinions).toEqual([
      {
        source: 'ban',
        point: { lat: 47.2313, lon: -1.4845 },
        score: 0.537,
        formatted: 'Rue de Bruxelles 44300 Nantes',
        banId: '44109_1234',
        positionType: 'street',
      },
    ]);
  });

  // les deux champs que `toOpinion` jetait : sans eux, rien en aval
  // ne sait dire si BAN a trouvé le numéro ou seulement la voie.
  it("garde l'id BAN et le type de position de la réponse", async () => {
    stubBan([
      {
        geometry: { coordinates: [-1.0, 46.1] },
        properties: { label: '12 Rue de l’Exemple 17290 Thairé', score: 0.97, type: 'housenumber', id: '17444_9999_00012' },
      },
    ]);

    const [opinion] = await geocoder().geocode('12 Rue de l’Exemple 17290 Thairé');

    expect(opinion?.banId).toBe('17444_9999_00012');
    expect(opinion?.positionType).toBe('housenumber');
  });

  it('un feature sans id ni type rend null, jamais undefined', async () => {
    stubBan([{ geometry: { coordinates: [1.0, 47.0] }, properties: { label: 'x', score: 0.8 } }]);
    const [opinion] = await geocoder().geocode('x');
    expect(opinion?.banId).toBeNull();
    expect(opinion?.positionType).toBeNull();
  });

  it('les suggestions portent les mêmes deux champs — le chemin nominal de /user', async () => {
    stubBan([
      {
        geometry: { coordinates: [-1.0, 46.1] },
        properties: { label: '12 Rue de l’Exemple 17290 Thairé', score: 0.97, type: 'housenumber', id: '17444_9999_00012' },
      },
      {
        geometry: { coordinates: [-1.01, 46.11] },
        properties: { label: 'Rue de l’Exemple 17290 Thairé', score: 0.71, type: 'street' },
      },
    ]);

    const suggestions = await geocoder().suggest('12 rue de l’exemple');

    expect(suggestions.map((s) => [s.banId, s.positionType])).toEqual([
      ['17444_9999_00012', 'housenumber'],
      [null, 'street'],
    ]);
  });

  it('a feature without a score is scored 0 — untrusted, never NaN', async () => {
    stubBan([{ geometry: { coordinates: [1.0, 47.0] }, properties: { label: 'x', type: 'street' } }]);
    const [opinion] = await geocoder().geocode('x');
    expect(opinion?.score).toBe(0);
  });

  it('no feature → no opinion (the pipeline reads it as no_geocoder_result)', async () => {
    stubBan([]);
    expect(await geocoder().geocode('zzzz qqqq')).toEqual([]);
  });

  // Le paramètre est absent, pas à 0 : la BAN comme la Géoplateforme activent
  // l'autocomplétion par défaut, et `geocoding.minBanScore` a été calibré le
  // 09/09 dans ce mode. Constat, gardé tel quel (principe 16).
  it('asks BAN for one result, without an autocomplete parameter', async () => {
    const mock = stubBan([]);
    await geocoder().geocode('5 rue Vivienne 75002 Paris');
    const url = new URL(String(mock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe('5 rue Vivienne 75002 Paris');
    expect(url.searchParams.get('limit')).toBe('1');
    expect(url.searchParams.get('autocomplete')).toBeNull();
  });
});

// les réponses de la Géoplateforme, enregistrées le 2026-09-25 sur
// les deux adresses de vérification. Même index que l'ancienne API : ce test
// fige ce que l'adaptateur lit de la vraie forme, pas d'une forme recopiée.
describe('BanGeocoder sur la Géoplateforme', () => {
  const live = () => new BanGeocoder({ baseUrl: GEOPLATEFORME_GEOCODING_URL, timeoutMs: 1_000 });

  it('la constante par défaut vise data.geopf.fr/geocodage/search', async () => {
    const mock = stubBan([]);
    await live().geocode('12 Rue de l’Exemple 17290 Thairé');
    const url = new URL(String(mock.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe('https://data.geopf.fr/geocodage/search');
    expect(url.searchParams.get('q')).toBe('12 Rue de l’Exemple 17290 Thairé');
  });

  it('lit le numéro de Thairé : point, libellé, score, id et type', async () => {
    stubBan(thaireRecorded.features);

    const opinions = await live().geocode('12 Rue de l’Exemple 17290 Thairé');

    expect(opinions).toEqual([
      {
        source: 'ban',
        point: { lat: 46.073482, lon: -0.965414 },
        score: 0.9493127272727272,
        formatted: '12 Rue de l’Exemple 17290 Thairé',
        banId: '17443_9999_00012',
        positionType: 'housenumber',
      },
    ]);
  });

  it("rend les cinq suggestions de la Sèvremoine dans l'ordre, en mode autocomplétion", async () => {
    const mock = stubBan(sevremoineRecorded.features);

    const suggestions = await live().suggest('7 allée des ess');

    const url = new URL(String(mock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('autocomplete')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(suggestions[0]).toEqual({
      source: 'ban',
      point: { lat: 47.125714, lon: -0.946111 },
      score: 0.8706563636363636,
      formatted: '7 Allée des Essais 49450 Sèvremoine',
      banId: '49301_9999_00007',
      positionType: 'housenumber',
    });
    expect(suggestions.map((s) => [s.banId, s.positionType])).toEqual([
      ['49301_9999_00007', 'housenumber'],
      ['72058_9999_00007', 'housenumber'],
      ['42218_9998', 'street'],
      ['69045_9998', 'street'],
      ['59656_9999_00004', 'housenumber'],
    ]);
  });
});
