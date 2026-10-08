/**
 * BnzfeLowEmissionZones : stale-while-revalidate
 *
 * The base is fetched once (cold start) and then served stale while a
 * background reload runs after TTL expiry. A failed reload keeps the old base.
 */
import { describe, expect, it, vi } from 'vitest';
import { BnzfeLowEmissionZones } from '../src/bnzfe.js';

/** Minimal GeoJSON with one zone around Paris. */
function makeGeoJson(id: string): object {
  return {
    features: [
      {
        properties: {
          id,
          nom: `ZFE ${id}`,
          date_debut: '2021-01-01',
          pl_critair: 'V5',
          pl_horaires: null,
          date_fin: null,
          url_arrete: null,
          url_site_information: null,
          date_maj: null,
        },
        geometry: {
          type: 'Polygon',
          // Small square around Paris centre
          coordinates: [[[2.3, 48.8], [2.4, 48.8], [2.4, 48.9], [2.3, 48.9], [2.3, 48.8]]],
        },
      },
    ],
  };
}

function mockFetch(response: object): () => Promise<Response> {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => response,
    } as Response);
}

function mockFetchFail(message: string): () => Promise<never> {
  return () => Promise.reject(new Error(message));
}

describe('BnzfeLowEmissionZones stale-while-revalidate', () => {
  it('serves stale data immediately after TTL expires and reloads in background', async () => {
    let now = 1_000_000;
    let fetchCount = 0;

    const zfe = new BnzfeLowEmissionZones({
      airesUrl: 'https://example.com/aires.geojson',
      timeoutMs: 5_000,
      ttlMs: 1_000,
      now: () => now,
    });

    // Patch global fetch
    vi.stubGlobal('fetch', () => {
      fetchCount++;
      return mockFetch(makeGeoJson(`v${fetchCount}`))();
    });

    // Cold start — first fetch
    const r1 = await zfe.zoneAt({ lat: 48.85, lon: 2.35 });
    expect(r1?.zoneId).toBe('v1');
    expect(fetchCount).toBe(1);

    // Still within TTL — no new fetch
    now += 500;
    const r2 = await zfe.zoneAt({ lat: 48.85, lon: 2.35 });
    expect(r2?.zoneId).toBe('v1');
    expect(fetchCount).toBe(1);

    // TTL expired — stale-while-revalidate: answer immediately with v1,
    // trigger background reload.
    now += 600; // total: 1100 ms > ttlMs=1000
    const r3 = await zfe.zoneAt({ lat: 48.85, lon: 2.35 });
    // Must answer immediately with the old base (v1), not wait for reload
    expect(r3?.zoneId).toBe('v1');
    // Reload triggered — wait for it to settle
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchCount).toBe(2);

    // Next call should use the freshly loaded v2
    now += 1; // still within new TTL window
    const r4 = await zfe.zoneAt({ lat: 48.85, lon: 2.35 });
    expect(r4?.zoneId).toBe('v2');

    vi.unstubAllGlobals();
  });

  it('keeps old base when the background reload fails', async () => {
    let now = 1_000_000;
    let fetchCount = 0;

    const zfe = new BnzfeLowEmissionZones({
      airesUrl: 'https://example.com/aires.geojson',
      timeoutMs: 5_000,
      ttlMs: 1_000,
      now: () => now,
    });

    vi.stubGlobal('fetch', () => {
      fetchCount++;
      if (fetchCount >= 2) return mockFetchFail('network error')();
      return mockFetch(makeGeoJson('v1'))();
    });

    // Cold start
    await zfe.zoneAt({ lat: 48.85, lon: 2.35 });
    expect(fetchCount).toBe(1);

    // Expire TTL
    now += 1_100;

    // Stale answer comes back immediately
    const stale = await zfe.zoneAt({ lat: 48.85, lon: 2.35 });
    expect(stale?.zoneId).toBe('v1');

    // Let the failing reload settle
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchCount).toBe(2);

    // Old base still in place — no crash
    now += 1; // within the stale window (loadedAt unchanged)
    const r2 = await zfe.zoneAt({ lat: 48.85, lon: 2.35 });
    // After a failed reload, loadedAt was not updated so TTL is still expired;
    // another background reload is triggered but old data is returned.
    expect(r2?.zoneId).toBe('v1');

    vi.unstubAllGlobals();
  });

  it('does not fire multiple concurrent reloads under parallel lookups', async () => {
    let now = 1_000_000;
    let fetchCount = 0;
    let resolveSecond!: (v: Response) => void;

    const zfe = new BnzfeLowEmissionZones({
      airesUrl: 'https://example.com/aires.geojson',
      timeoutMs: 5_000,
      ttlMs: 1_000,
      now: () => now,
    });

    vi.stubGlobal('fetch', () => {
      fetchCount++;
      if (fetchCount === 1) {
        // Instant first load
        return mockFetch(makeGeoJson('v1'))();
      }
      // Slow second reload — hold it open
      return new Promise<Response>((resolve) => { resolveSecond = resolve; });
    });

    // Cold start
    await zfe.zoneAt({ lat: 48.85, lon: 2.35 });

    // Expire TTL
    now += 1_100;

    // Three parallel lookups after expiry — only ONE reload should fire
    await Promise.all([
      zfe.zoneAt({ lat: 48.85, lon: 2.35 }),
      zfe.zoneAt({ lat: 48.85, lon: 2.35 }),
      zfe.zoneAt({ lat: 48.85, lon: 2.35 }),
    ]);

    expect(fetchCount).toBe(2); // one cold load + one background reload

    // Let the reload finish
    resolveSecond({ ok: true, status: 200, json: async () => makeGeoJson('v2') } as Response);
    await new Promise((resolve) => setTimeout(resolve, 10));

    vi.unstubAllGlobals();
  });
});
