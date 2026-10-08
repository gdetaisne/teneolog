/**
 * Comportement RÉSEAU des adaptateurs : panne, pas mapping.
 *
 * Les adaptateurs appellent le `fetch` global (aucune injection) : on le
 * remplace par un script de réponses (`vi.stubGlobal`). Le faux fetch honore
 * `init.signal` — c'est ce qui permet de vérifier qu'un timeout se traduit par
 * un rejet et non par une promesse pendante.
 *
 * Pour chaque adaptateur (Overpass, OSRM, BAN, BNZFE, Google Elevation) :
 *  - timeout      → rejet dans le délai, jamais pendant ;
 *  - 429 / 502    → rejet propre (Overpass : rejeu si retryOnce) ;
 *  - corps vide   → rejet propre (pas de résultat vide silencieux) ;
 *  - Overpass `remark` → panne, pas voisinage vide.
 *
 * Constats (voir la réponse de l'audit) : aucun adaptateur n'accepte de
 * `signal` externe ; BAN.lookup rejoue une fois toute erreur ; OSRM / BAN /
 * Elevation ne rejouent jamais ; BNZFE `features: []` est une panne.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BanGeocoder } from '../src/ban-geocoder.js';
import { BnzfeLowEmissionZones } from '../src/bnzfe.js';
import { GoogleElevation } from '../src/google-elevation.js';
import { OsrmRouting } from '../src/osrm.js';
import { OverpassHttpError, OverpassRemarkError, OverpassRoadGraph } from '../src/overpass.js';

// ─── Faux fetch scripté ─────────────────────────────────────────────────────

interface Step {
  /** Ne répond jamais : seul `signal` peut sortir de l'attente. */
  readonly hang?: true;
  readonly status?: number;
  /** Corps brut ; `''` = corps vide → `json()` lève une SyntaxError. */
  readonly text?: string;
  readonly headers?: Record<string, string>;
}

const json = (value: unknown): Step => ({ status: 200, text: JSON.stringify(value) });
const http = (status: number, headers?: Record<string, string>): Step => ({ status, text: '', ...(headers ? { headers } : {}) });
const EMPTY_BODY: Step = { status: 200, text: '' };
const HANG: Step = { hang: true };

function scriptFetch(steps: readonly Step[]): { calls: number } {
  const state = { calls: 0 };
  vi.stubGlobal('fetch', (_url: string, init?: { signal?: AbortSignal }) => {
    const step = steps[state.calls] ?? steps[steps.length - 1];
    state.calls += 1;
    if (step === undefined) throw new Error('script vide');
    const signal = init?.signal;
    if (step.hang === true) {
      return new Promise<never>((_resolve, reject) => {
        if (signal === undefined) return; // pendant pour toujours : c'est le constat cherché
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    const status = step.status ?? 200;
    const text = step.text ?? '';
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(step.headers ?? {}),
      json: async () => JSON.parse(text) as unknown,
      text: async () => text,
    } as unknown as Response);
  });
  return state;
}

/** Le rejet doit arriver avant `ms` — sinon la promesse est pendante. */
async function rejectsWithin(promise: Promise<unknown>, ms = 1_500): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => reject(new Error(`promesse encore pendante après ${ms} ms`)), ms);
  });
  try {
    await Promise.race([promise, pending]);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('promesse encore pendante')) throw err;
    return err;
  } finally {
    clearTimeout(timer);
  }
  throw new Error('la promesse a résolu alors qu’un rejet était attendu');
}

afterEach(() => vi.unstubAllGlobals());

const CENTRE = { lat: 47.0, lon: 1.0 };
const TIMEOUT_MS = 30;

// ─── Overpass ───────────────────────────────────────────────────────────────

const VALID_OVERPASS = {
  elements: [
    { type: 'way', id: 1, tags: { highway: 'residential' }, nodes: [10, 11],
      geometry: [{ lat: 47.0, lon: 1.0 }, { lat: 47.001, lon: 1.0 }] },
  ],
};

function overpass(retryOnce: boolean): OverpassRoadGraph {
  return new OverpassRoadGraph({ interpreterUrl: 'http://overpass.test', timeoutMs: TIMEOUT_MS, retryOnce, retryDelayMs: 0 });
}

describe('Overpass — pannes réseau', () => {
  it('timeout → rejet dans le délai, un seul appel sans retryOnce', async () => {
    const calls = scriptFetch([HANG]);
    const err = await rejectsWithin(overpass(false).fetchNeighbourhood(CENTRE, 80));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('TimeoutError');
    expect(calls.calls).toBe(1);
  });

  it('timeout avec retryOnce → un rejeu, puis succès', async () => {
    const calls = scriptFetch([HANG, json(VALID_OVERPASS)]);
    const hood = await overpass(true).fetchNeighbourhood(CENTRE, 80);
    expect(hood.ways).toHaveLength(1);
    expect(calls.calls).toBe(2);
  });

  it.each([429, 502])('HTTP %i sans retryOnce → OverpassHttpError portant le statut', async (status) => {
    const calls = scriptFetch([http(status)]);
    const err = await rejectsWithin(overpass(false).fetchNeighbourhood(CENTRE, 80));
    expect(err).toBeInstanceOf(OverpassHttpError);
    expect((err as OverpassHttpError).status).toBe(status);
    expect(calls.calls).toBe(1);
  });

  it.each([429, 502])('HTTP %i avec retryOnce → rejoué une fois, succès', async (status) => {
    const calls = scriptFetch([http(status), json(VALID_OVERPASS)]);
    const hood = await overpass(true).fetchNeighbourhood(CENTRE, 80);
    expect(hood.ways).toHaveLength(1);
    expect(calls.calls).toBe(2);
  });

  it('HTTP 400 avec retryOnce → pas de rejeu (même requête invalide)', async () => {
    const calls = scriptFetch([http(400), json(VALID_OVERPASS)]);
    const err = await rejectsWithin(overpass(true).fetchNeighbourhood(CENTRE, 80));
    expect((err as OverpassHttpError).status).toBe(400);
    expect(calls.calls).toBe(1);
  });

  it('429 + Retry-After lisible → exposé en ms sur l’erreur', async () => {
    scriptFetch([http(429, { 'retry-after': '2' })]);
    const err = await rejectsWithin(overpass(false).fetchNeighbourhood(CENTRE, 80));
    expect((err as OverpassHttpError).retryAfterMs).toBe(2_000);
  });

  it('corps vide (HTTP 200) → rejet propre, jamais un voisinage vide', async () => {
    scriptFetch([EMPTY_BODY]);
    const err = await rejectsWithin(overpass(false).fetchSurfaces(CENTRE, 80));
    expect(err).toBeInstanceOf(SyntaxError);
  });

  it('remark (timeout serveur en HTTP 200) → OverpassRemarkError, pas un voisinage vide', async () => {
    const calls = scriptFetch([json({ elements: [], remark: 'runtime error: Query timed out' })]);
    const err = await rejectsWithin(overpass(false).fetchNeighbourhood(CENTRE, 80));
    expect(err).toBeInstanceOf(OverpassRemarkError);
    expect((err as OverpassRemarkError).remark).toMatch(/timed out/);
    expect(calls.calls).toBe(1);
  });

  it('remark avec retryOnce → rejoué ; deux remarks → toujours une panne', async () => {
    const ok = scriptFetch([json({ elements: [], remark: 'x' }), json(VALID_OVERPASS)]);
    expect((await overpass(true).fetchStructuring(CENTRE, 500)).ways).toHaveLength(1);
    expect(ok.calls).toBe(2);
    vi.unstubAllGlobals();
    const twice = scriptFetch([json({ elements: [], remark: 'x' })]);
    const err = await rejectsWithin(overpass(true).fetchStructuring(CENTRE, 500));
    expect(err).toBeInstanceOf(OverpassRemarkError);
    expect(twice.calls).toBe(2);
  });

  it('fetchBuildingFootprints avale la panne → vide (posture affichage, documentée)', async () => {
    scriptFetch([http(502)]);
    const result = await overpass(false).fetchBuildingFootprints(CENTRE, 40);
    expect(result).toEqual({ footprints: [], addressPoints: [] });
  });
});

// ─── OSRM ───────────────────────────────────────────────────────────────────

describe('OSRM — pannes réseau (aucun rejeu)', () => {
  const osrm = () => new OsrmRouting({ baseUrl: 'http://osrm.test', timeoutMs: TIMEOUT_MS });
  const A = { lat: 47.0, lon: 1.0 };
  const B = { lat: 47.01, lon: 1.01 };

  it('timeout → rejet dans le délai', async () => {
    const calls = scriptFetch([HANG]);
    const err = await rejectsWithin(osrm().route(A, B, 1));
    expect((err as Error).name).toBe('TimeoutError');
    expect(calls.calls).toBe(1);
  });

  it.each([429, 502])('HTTP %i → Error « OSRM <status> », un seul appel', async (status) => {
    const calls = scriptFetch([http(status), json({ code: 'Ok', routes: [] })]);
    const err = await rejectsWithin(osrm().route(A, B, 1));
    expect((err as Error).message).toBe(`OSRM ${status}`);
    expect(calls.calls).toBe(1);
  });

  it('corps vide → rejet propre', async () => {
    scriptFetch([EMPTY_BODY]);
    expect(await rejectsWithin(osrm().route(A, B, 1))).toBeInstanceOf(SyntaxError);
  });

  it('code ≠ Ok (NoRoute) → Error « OSRM NoRoute », pas une liste vide', async () => {
    scriptFetch([json({ code: 'NoRoute' })]);
    expect(((await rejectsWithin(osrm().route(A, B, 1))) as Error).message).toBe('OSRM NoRoute');
  });
});

// ─── BAN ────────────────────────────────────────────────────────────────────

describe('BAN — pannes réseau', () => {
  const ban = () => new BanGeocoder({ baseUrl: 'http://ban.test', timeoutMs: TIMEOUT_MS });

  it('geocode : timeout → rejet ; lookup rejoue une fois toute erreur (2 appels)', async () => {
    const calls = scriptFetch([HANG]);
    const err = await rejectsWithin(ban().geocode('1 rue test'));
    expect((err as Error).name).toBe('TimeoutError');
    expect(calls.calls).toBe(2);
  });

  it.each([429, 502])('geocode : HTTP %i deux fois → Error « BAN <status> » après 2 appels', async (status) => {
    const calls = scriptFetch([http(status)]);
    const err = await rejectsWithin(ban().geocode('1 rue test'));
    expect((err as Error).message).toBe(`BAN ${status}`);
    expect(calls.calls).toBe(2);
  });

  it('geocode : 502 puis 200 → le rejeu sauve la requête', async () => {
    const feature = { geometry: { coordinates: [1.0, 47.0] }, properties: { label: '1 Rue Test', score: 0.9, type: 'housenumber' } };
    const calls = scriptFetch([http(502), json({ features: [feature] })]);
    const opinions = await ban().geocode('1 rue test');
    expect(opinions).toHaveLength(1);
    expect(calls.calls).toBe(2);
  });

  it('geocode : corps vide deux fois → rejet propre', async () => {
    scriptFetch([EMPTY_BODY]);
    expect(await rejectsWithin(ban().geocode('1 rue test'))).toBeInstanceOf(SyntaxError);
  });

  it('suggest : aucun rejeu — 429 → Error « BAN 429 » au premier appel', async () => {
    const calls = scriptFetch([http(429)]);
    const err = await rejectsWithin(ban().suggest('1 rue', 5));
    expect((err as Error).message).toBe('BAN 429');
    expect(calls.calls).toBe(1);
  });

  it('suggest : timeout → rejet dans le délai', async () => {
    scriptFetch([HANG]);
    expect(((await rejectsWithin(ban().suggest('1 rue', 5))) as Error).name).toBe('TimeoutError');
  });
});

// ─── BNZFE ──────────────────────────────────────────────────────────────────

describe('BNZFE — pannes réseau (démarrage à froid)', () => {
  const bnzfe = () => new BnzfeLowEmissionZones({ airesUrl: 'http://bnzfe.test/aires.geojson', timeoutMs: TIMEOUT_MS, ttlMs: 60_000 });
  const PARIS = { lat: 48.8566, lon: 2.3893 };

  it('timeout → zoneAt rejette (inconnu, jamais « pas de zone ») et la panne ne colle pas', async () => {
    const calls = scriptFetch([HANG, HANG]);
    const zones = bnzfe();
    const err = await rejectsWithin(zones.zoneAt(PARIS));
    expect((err as Error).name).toBe('AbortError');
    expect(calls.calls).toBe(1);
    // Un second appel retente le chargement : inFlight a bien été libéré.
    await rejectsWithin(zones.zoneAt(PARIS));
    expect(calls.calls).toBe(2);
  });

  it.each([429, 502])('HTTP %i → Error « bnzfe: HTTP <status> »', async (status) => {
    scriptFetch([http(status)]);
    expect(((await rejectsWithin(bnzfe().zoneAt(PARIS))) as Error).message).toBe(`bnzfe: HTTP ${status}`);
  });

  it('corps vide → rejet propre', async () => {
    scriptFetch([EMPTY_BODY]);
    expect(await rejectsWithin(bnzfe().zoneAt(PARIS))).toBeInstanceOf(SyntaxError);
  });

  it('base sans feature → panne (« empty base »), pas une France sans ZFE', async () => {
    scriptFetch([json({ features: [] })]);
    expect(((await rejectsWithin(bnzfe().zoneAt(PARIS))) as Error).message).toBe('bnzfe: empty base');
  });
});

// ─── Google Elevation ───────────────────────────────────────────────────────

describe('Google Elevation — pannes réseau (aucun rejeu)', () => {
  const elevation = () => new GoogleElevation({ apiKey: 'k', timeoutMs: TIMEOUT_MS, endpoint: 'http://elevation.test' });
  const POINTS = [{ lat: 47.0, lon: 1.0 }, { lat: 47.0, lon: 1.001 }];

  it('timeout → rejet dans le délai (la pipeline publie provider_error)', async () => {
    const calls = scriptFetch([HANG]);
    expect(((await rejectsWithin(elevation().getElevations(POINTS))) as Error).name).toBe('TimeoutError');
    expect(calls.calls).toBe(1);
  });

  it.each([429, 502])('HTTP %i → Error « Google Elevation HTTP <status> », un seul appel', async (status) => {
    const calls = scriptFetch([http(status)]);
    expect(((await rejectsWithin(elevation().getElevations(POINTS))) as Error).message).toBe(`Google Elevation HTTP ${status}`);
    expect(calls.calls).toBe(1);
  });

  it('corps vide → rejet propre', async () => {
    scriptFetch([EMPTY_BODY]);
    expect(await rejectsWithin(elevation().getElevations(POINTS))).toBeInstanceOf(SyntaxError);
  });

  it('status OVER_QUERY_LIMIT en HTTP 200 → panne nommée, pas des altitudes vides', async () => {
    scriptFetch([json({ status: 'OVER_QUERY_LIMIT', error_message: 'quota' })]);
    const err = (await rejectsWithin(elevation().getElevations(POINTS))) as Error;
    expect(err.message).toMatch(/OVER_QUERY_LIMIT/);
    expect(err.message).toMatch(/quota/);
  });
});
