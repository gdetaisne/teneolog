/**
 * OverpassRoadGraph — cache + remark behaviour.
 *
 * an Overpass remark (HTTP 200 + { remark, elements:[] }) must throw
 *   OverpassRemarkError and must NOT be written to the disk cache.
 *
 * (a) expired cache entries are ignored and re-fetched;
 *           (b) empty payloads are never written;
 *           (c) cache entries beyond cacheMaxEntries are evicted (oldest first).
 */
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OverpassHttpError, OverpassRoadGraph, OverpassRemarkError } from '../src/overpass.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CENTRE = { lat: 47.0, lon: 1.0 };

/** Minimal valid Overpass payload with one highway way so `elements` is non-empty. */
const VALID_PAYLOAD = {
  elements: [
    {
      type: 'way' as const,
      id: 1,
      tags: { highway: 'residential' },
      nodes: [10, 11],
      geometry: [
        { lat: 47.0, lon: 1.0 },
        { lat: 47.001, lon: 1.0 },
      ],
    },
  ],
};

/** Overpass "timeout" response — HTTP 200 but unusable. */
const REMARK_PAYLOAD = {
  remark: 'runtime error: Query timed out after 25 seconds',
  elements: [],
};

/** Genuine empty area — HTTP 200, no remark, elements truly empty. */
const EMPTY_PAYLOAD = { elements: [] };

function makeFetch(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_: string) => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'overpass-test-'));
}

function adapter(
  cacheDir: string,
  overrides: Partial<ConstructorParameters<typeof OverpassRoadGraph>[0]> = {},
) {
  return new OverpassRoadGraph({
    interpreterUrl: 'http://overpass.test/api/interpreter',
    timeoutMs: 5_000,
    retryOnce: false,
    retryDelayMs: 0, // keep tests fast; explicit tests override this
    cacheDir,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// remark handling
// ---------------------------------------------------------------------------

describe('OverpassRemarkError', () => {
  it('throws OverpassRemarkError when Overpass returns a remark (timeout)', async () => {
    vi.stubGlobal('fetch', makeFetch(REMARK_PAYLOAD));
    const g = adapter(tmpDir());
    await expect(g.fetchNeighbourhood(CENTRE, 200)).rejects.toBeInstanceOf(OverpassRemarkError);
  });

  it('the remark text is surfaced in the error', async () => {
    vi.stubGlobal('fetch', makeFetch(REMARK_PAYLOAD));
    const g = adapter(tmpDir());
    await expect(g.fetchNeighbourhood(CENTRE, 200)).rejects.toMatchObject({
      remark: expect.stringContaining('timed out'),
    });
  });

  it('nothing is written to cache when Overpass returns a remark', async () => {
    const dir = tmpDir();
    vi.stubGlobal('fetch', makeFetch(REMARK_PAYLOAD));
    const g = adapter(dir);
    await expect(g.fetchNeighbourhood(CENTRE, 200)).rejects.toBeInstanceOf(OverpassRemarkError);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(0);
  });

  it('retryOnce replays once on a remark — still throws if retry also has remark', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => REMARK_PAYLOAD, text: async () => '' };
    }));
    const g = adapter(tmpDir(), { retryOnce: true });
    await expect(g.fetchNeighbourhood(CENTRE, 200)).rejects.toBeInstanceOf(OverpassRemarkError);
    expect(calls).toBe(2); // initial + one retry
  });

  it('retryOnce succeeds when only the first attempt has a remark', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      const body = calls === 1 ? REMARK_PAYLOAD : VALID_PAYLOAD;
      return { ok: true, status: 200, json: async () => body, text: async () => '' };
    }));
    const g = adapter(tmpDir(), { retryOnce: true });
    // Should NOT throw; retry returns a valid payload
    await expect(g.fetchNeighbourhood(CENTRE, 200)).resolves.not.toThrow();
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// cache TTL, empty-payload guard, eviction
// ---------------------------------------------------------------------------

describe('cache TTL', () => {
  it('an expired cache entry is ignored and re-fetched', async () => {
    const dir = tmpDir();
    const fetch1 = makeFetch(VALID_PAYLOAD);
    vi.stubGlobal('fetch', fetch1);

    // First fetch: populates cache.
    const g = adapter(dir, { cacheTtlMs: 1_000 });
    await g.fetchNeighbourhood(CENTRE, 200);
    expect(fetch1).toHaveBeenCalledTimes(1);

    // Backdate the cache file so it appears expired.
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const oldDate = new Date(Date.now() - 2_000); // 2 s ago, TTL is 1 s
    utimesSync(join(dir, files[0]!), oldDate, oldDate);

    // Second fetch: cache expired → must call fetch again.
    const fetch2 = makeFetch(VALID_PAYLOAD);
    vi.stubGlobal('fetch', fetch2);
    await g.fetchNeighbourhood(CENTRE, 200);
    expect(fetch2).toHaveBeenCalledTimes(1);
  });

  it('a valid fresh cache entry is reused without a network call', async () => {
    const dir = tmpDir();
    const fetch1 = makeFetch(VALID_PAYLOAD);
    vi.stubGlobal('fetch', fetch1);

    const g = adapter(dir, { cacheTtlMs: 60_000 });
    await g.fetchNeighbourhood(CENTRE, 200);
    expect(fetch1).toHaveBeenCalledTimes(1);

    const fetch2 = makeFetch(VALID_PAYLOAD);
    vi.stubGlobal('fetch', fetch2);
    await g.fetchNeighbourhood(CENTRE, 200);
    expect(fetch2).not.toHaveBeenCalled();
  });
});

describe('empty payload not cached', () => {
  it('a genuinely empty response (no remark) is NOT written to cache', async () => {
    const dir = tmpDir();
    vi.stubGlobal('fetch', makeFetch(EMPTY_PAYLOAD));
    const g = adapter(dir);
    // fetchSurfaces can legitimately return empty; it should not throw.
    await g.fetchSurfaces(CENTRE, 200);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(0);
  });

  it('a second call re-fetches when the response was empty (not cached)', async () => {
    const dir = tmpDir();
    const fetchMock = makeFetch(EMPTY_PAYLOAD);
    vi.stubGlobal('fetch', fetchMock);
    const g = adapter(dir);
    await g.fetchSurfaces(CENTRE, 200);
    await g.fetchSurfaces(CENTRE, 200);
    // Both calls went to the network — the empty response was never cached.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('cache eviction', () => {
  it('entries beyond cacheMaxEntries are evicted (oldest first)', async () => {
    const dir = tmpDir();
    const MAX = 3;

    // Pre-populate 4 fake cache files with different mtimes.
    for (let i = 0; i < 4; i += 1) {
      const name = `overpass-fake${String(i).padStart(2, '0')}0000000000000000000000.json`;
      const p = join(dir, name);
      writeFileSync(p, JSON.stringify(VALID_PAYLOAD));
      const t = new Date(Date.now() - (4 - i) * 1_000); // oldest = fake00
      utimesSync(p, t, t);
    }

    // Writing a fifth entry should evict the oldest (fake00).
    vi.stubGlobal('fetch', makeFetch(VALID_PAYLOAD));
    const g = adapter(dir, { cacheMaxEntries: MAX });
    await g.fetchNeighbourhood(CENTRE, 200);

    const remaining = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(remaining).toHaveLength(MAX);
    // The oldest pre-populated file should be gone.
    expect(remaining).not.toContain('overpass-fake000000000000000000000000.json');
  });
});

// ---------------------------------------------------------------------------
// corridor buffer: around polyline instead of bbox
// ---------------------------------------------------------------------------

describe('fetchCorridor: around polyline, not bbox', () => {
  it('a straight polyline produces an `around:` query — no bbox pattern', async () => {
    const captured: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      captured.push(body.get('data') ?? '');
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => VALID_PAYLOAD, text: async () => '' };
    }));
    const g = adapter(tmpDir());
    await g.fetchCorridor(
      [{ lat: 47.0, lon: 1.0 }, { lat: 47.005, lon: 1.0 }, { lat: 47.01, lon: 1.0 }],
      30,
    );
    expect(captured.length).toBeGreaterThan(0);
    for (const q of captured) {
      expect(q).toContain('around:30');
      // Old bbox format was `way(S,W,N,E)` — must be gone
      expect(q).not.toMatch(/way\(\d+\.\d+,\d+\.\d+,\d+\.\d+,\d+\.\d+\)/);
    }
  });

  it('an L-shaped polyline still uses around: in every chunk', async () => {
    const captured: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      captured.push(body.get('data') ?? '');
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => VALID_PAYLOAD, text: async () => '' };
    }));
    const g = adapter(tmpDir());
    // L-shape: north leg then east leg
    await g.fetchCorridor(
      [{ lat: 47.0, lon: 1.0 }, { lat: 47.01, lon: 1.0 }, { lat: 47.01, lon: 1.02 }],
      30,
    );
    expect(captured.length).toBeGreaterThan(0);
    for (const q of captured) {
      expect(q).toContain('around:30');
      expect(q).not.toMatch(/way\(\d+\.\d+,\d+\.\d+,\d+\.\d+,\d+\.\d+\)/);
    }
  });

  it('a long polyline is split into multiple chunks', async () => {
    // ~5 km straight polyline (51 points × ~110 m ≈ 5.5 km)
    const points = Array.from({ length: 51 }, (_, i) => ({ lat: 47.0 + i * 0.001, lon: 1.0 }));
    const captured: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      captured.push(body.get('data') ?? '');
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => VALID_PAYLOAD, text: async () => '' };
    }));
    const g = adapter(tmpDir());
    await g.fetchCorridor(points, 30);
    // At 2 000 m chunks, a 5.5 km route must produce ≥ 2 chunks
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const q of captured) expect(q).toContain('around:30');
  });

  it('ways are deduplicated across chunks (same id returned by every chunk)', async () => {
    // VALID_PAYLOAD always returns way id=1
    const points = Array.from({ length: 51 }, (_, i) => ({ lat: 47.0 + i * 0.001, lon: 1.0 }));
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      void body; // consumed for side effect only
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => VALID_PAYLOAD, text: async () => '' };
    }));
    const g = adapter(tmpDir());
    const ways = await g.fetchCorridor(points, 30);
    // Even though every chunk returns way id=1, the final list has exactly one entry
    expect(ways.filter((w) => w.id === '1')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// in-flight dedup + retry backoff
// ---------------------------------------------------------------------------

describe('in-flight dedup', () => {
  it('two concurrent calls with the same query hit the network only once', async () => {
    let fetchCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCount += 1;
      // Yield to the microtask queue so the second caller registers before this resolves.
      await new Promise<void>((r) => setTimeout(r, 0));
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => VALID_PAYLOAD, text: async () => '' };
    }));
    const g = adapter(tmpDir());
    const [a, b] = await Promise.all([
      g.fetchNeighbourhood(CENTRE, 200),
      g.fetchNeighbourhood(CENTRE, 200),
    ]);
    expect(fetchCount).toBe(1);
    expect(a.ways.length).toBe(b.ways.length);
  });
});

describe('retry backoff', () => {
  it('HTTP 400 is not retried (invalid query)', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      return { ok: false, status: 400, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
    }));
    const g = adapter(tmpDir(), { retryOnce: true });
    await expect(g.fetchNeighbourhood(CENTRE, 200)).rejects.toBeInstanceOf(OverpassHttpError);
    expect(calls).toBe(1); // no retry
  });

  it('HTTP 429 is retried after retryDelayMs', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => VALID_PAYLOAD, text: async () => '' };
    }));
    // No cacheDir: readCache short-circuits synchronously so the chain reaches
    // sleep() before we advance fake timers (avoids real-I/O / timer interplay).
    const g = new OverpassRoadGraph({
      interpreterUrl: 'http://overpass.test/api/interpreter',
      timeoutMs: 5_000,
      retryOnce: true,
      retryDelayMs: 500,
    });
    const p = g.fetchNeighbourhood(CENTRE, 200);
    await vi.advanceTimersByTimeAsync(600);
    await p;
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it('Retry-After header overrides retryDelayMs on 429', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: (h: string) => (h === 'retry-after' ? '3' : null) },
          json: async () => ({}),
          text: async () => '',
        };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => VALID_PAYLOAD, text: async () => '' };
    }));
    // retryDelayMs: 100, but Retry-After: 3 → sleep 3 000 ms instead.
    // No cacheDir so real I/O doesn't interfere with fake timers.
    const g = new OverpassRoadGraph({
      interpreterUrl: 'http://overpass.test/api/interpreter',
      timeoutMs: 5_000,
      retryOnce: true,
      retryDelayMs: 100,
    });
    const p = g.fetchNeighbourhood(CENTRE, 200);
    // Flush microtasks (readCache no-op + first fetch) so sleep() is registered.
    await Promise.resolve();
    await Promise.resolve();
    // Advance only 2 900 ms → Retry-After 3 s timer not yet elapsed.
    await vi.advanceTimersByTimeAsync(2_900);
    expect(calls).toBe(1);
    // Advance past the 3 s mark → retry fires.
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it('HTTP 503 is retried (5xx = retryable)', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => VALID_PAYLOAD, text: async () => '' };
    }));
    const g = adapter(tmpDir(), { retryOnce: true, retryDelayMs: 0 });
    await expect(g.fetchNeighbourhood(CENTRE, 200)).resolves.not.toThrow();
    expect(calls).toBe(2);
  });
});
