/**
 * Overpass adapter — the network side of `RoadGraphPort` and `SurfacePort`.
 *
 * The interpreter endpoint is a constructor argument: production points at the
 * self-hosted France import (the public instances are the flaky dependency
 * ADR-030 refused to ship on), development at whatever is reachable.
 */
import { createHash } from 'node:crypto';

import type { GeoPoint } from '@teneolog/domain';
import type { RoadGraphPort, RoadNeighbourhood, Surface, SurfacePort } from '@teneolog/topology';

import { mapRoadNeighbourhood, mapSurfaces, type OverpassPayload } from './overpass-mapping.js';
import { mapNonDrivableAreas, nonDrivableQuery, type NonDrivableAreasPort, type NonDrivableBox } from './overpass-non-drivable.js';

/**
 * Overpass returned HTTP 200 with a `remark` field (timeout / out-of-memory).
 * This is NOT a valid result — `elements` is always empty in that case.
 * It must never be cached and must propagate to the caller as an error.
 */
export class OverpassRemarkError extends Error {
  readonly remark: string;
  constructor(remark: string) {
    super(`Overpass remark: ${remark}`);
    this.name = 'OverpassRemarkError';
    this.remark = remark;
  }
}

/**
 * Overpass returned a non-2xx HTTP status.
 * Carries `status` so the retry policy can distinguish 429/5xx (retryable)
 * from 400 (invalid query, not retryable), and `retryAfterMs` when the server
 * supplied a `Retry-After` header.
 */
export class OverpassHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  constructor(status: number, url: string, retryAfterMs?: number) {
    super(`Overpass HTTP ${status} from ${url}`);
    this.name = 'OverpassHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Throw if the payload carries an Overpass runtime error. */
function assertNoRemark(payload: OverpassPayload): void {
  if (payload.remark !== undefined) {
    throw new OverpassRemarkError(payload.remark);
  }
}

/**
 * True when a fetch error is worth a single transparent retry.
 * - OverpassRemarkError (server-side timeout / OOM) → yes
 * - HTTP 429 (rate-limit) and 5xx (server error) → yes
 * - HTTP 400 (invalid query) → NO — retrying sends the same bad query
 * - Network / AbortError (no `status`) → yes
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof OverpassRemarkError) return true;
  if (err instanceof OverpassHttpError) return err.status === 429 || err.status >= 500;
  return true; // network / timeout errors
}

/**
 * How long to wait before the retry.
 * Honours `Retry-After` from the server (if ≤ 10 s); otherwise falls back to
 * the caller-supplied default.
 */
function getRetryDelayMs(err: unknown, defaultMs: number): number {
  if (err instanceof OverpassHttpError && err.retryAfterMs !== undefined) return err.retryAfterMs;
  return defaultMs;
}

/** Parse a `Retry-After` header value (seconds) into milliseconds. Capped at 10 s. */
function parseRetryAfterMs(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const s = Number.parseInt(raw, 10);
  if (!Number.isFinite(s) || s <= 0 || s > 10) return undefined;
  return s * 1_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 30 days in milliseconds — matches the comment in the original code. */
const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

/** Default delay before a transparent retry (rate-limit / transient failure). */
const DEFAULT_RETRY_DELAY_MS = 1_000;

/** Evict oldest entries when the cache directory holds more than this many files. */
const DEFAULT_CACHE_MAX_ENTRIES = 2_000;

export interface OverpassOptions {
  readonly interpreterUrl: string;
  readonly timeoutMs: number;
  /** One transparent retry on a transient failure; Overpass hiccups routinely. */
  readonly retryOnce: boolean;
  /**
   * Milliseconds to wait before the retry. Defaults to 1 000 ms.
   * Set to 0 in tests to avoid real delays. Overridden by `Retry-After` header
   * on 429 responses (capped at 10 s).
   */
  readonly retryDelayMs?: number;
  /**
   * Optional on-disk response cache, keyed by query hash. The public
   * instances rate-limit by IP and a corpus day burns the budget fast; the
   * same posture as the engine's provider cache (30-day TTL for Overpass),
   * scaled down to a harness. Production will use the self-hosted instance
   * AND a cache — this is not either/or.
   */
  readonly cacheDir?: string;
  /**
   * Maximum age of a cached entry in milliseconds. Defaults to 30 days.
   * Entries older than this are ignored and re-fetched.
   */
  readonly cacheTtlMs?: number;
  /**
   * Maximum number of files to keep in `cacheDir`. When exceeded at write
   * time, the oldest entries (by mtime) are deleted first. Defaults to 2 000.
   */
  readonly cacheMaxEntries?: number;
}

/** An OSM building way with the address tags it happens to carry. */
export interface OsmBuildingFootprint {
  readonly id: string;
  readonly nature: string;
  /** `addr:housenumber` verbatim — "5", "5 bis", "3-5"; absent on most ways. */
  readonly houseNumber: string | null;
  readonly street: string | null;
  readonly rings: Array<Array<{ lat: number; lon: number }>>;
}

/** An OSM node tagged with a house number — one door. */
export interface OsmAddressPoint {
  readonly point: GeoPoint;
  readonly houseNumber: string;
  readonly street: string | null;
}

export interface OsmBuildingNeighbourhood {
  readonly footprints: readonly OsmBuildingFootprint[];
  readonly addressPoints: readonly OsmAddressPoint[];
}

export class OverpassRoadGraph implements RoadGraphPort, SurfacePort, NonDrivableAreasPort {
  constructor(private readonly options: OverpassOptions) {}

  /**
   * Tracks in-flight network requests by query string.
   * Two concurrent callers with an identical query share a single fetch; the
   * second awaits the first's Promise instead of opening a duplicate connection.
   * The entry is removed in `finally` so a failed request is not re-used.
   */
  private readonly inFlight = new Map<string, Promise<OverpassPayload>>();

  async fetchNeighbourhood(centre: GeoPoint, radiusM: number): Promise<RoadNeighbourhood> {
    // `way[highway]` catches the carriageway; the node clauses catch the
    // street furniture the topology stage reads (circles, loops, barriers).
    const query = `[out:json][timeout:${Math.ceil(this.options.timeoutMs / 1000)}];
(
  way(around:${radiusM},${centre.lat},${centre.lon})[highway];
  node(around:${radiusM},${centre.lat},${centre.lon})[barrier];
  node(around:${radiusM},${centre.lat},${centre.lon})[highway=turning_circle];
  node(around:${radiusM},${centre.lat},${centre.lon})[highway=turning_loop];
);
out body geom;`;
    const payload = await this.run(query);
    return mapRoadNeighbourhood(payload, centre, radiusM);
  }

  /**
   * toutes les voies d'une BOÎTE, pour le cache par tuile.
   *
   * `way(s,w,n,e)[highway]` et non `way(around:R,lat,lon)[highway]` : la boîte
   * est le filtre spatial qu'Overpass sert le mieux, et le cercle qui couvre un
   * carré de 500 m en demande deux fois l'aire. Sémantique inchangée pour
   * autant — Overpass rend la voie entière dès qu'elle touche l'emprise, comme
   * avec `around` — et la clé de cache reste le texte de la requête.
   */
  async fetchWaysInBox(box: {
    readonly south: number;
    readonly west: number;
    readonly north: number;
    readonly east: number;
  }): Promise<readonly import('@teneolog/topology').RoadWay[]> {
    const bbox = [box.south, box.west, box.north, box.east].map((v) => v.toFixed(7)).join(',');
    const query = `[out:json][timeout:${Math.ceil(this.options.timeoutMs / 1000)}];
way(${bbox})[highway];
out body geom;`;
    const payload = await this.run(query);
    const centre: GeoPoint = { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 };
    // Le rayon n'étiquette que le voisinage ; l'appelant lit les voies.
    return mapRoadNeighbourhood(payload, centre, 0).ways;
  }

  /** les aires où un camion ne manœuvre pas, dans une boîte (`overpass-non-drivable.ts`); rejette en panne. */
  async fetchNonDrivableAreas(box: NonDrivableBox): Promise<readonly (readonly GeoPoint[])[]> {
    return mapNonDrivableAreas(await this.run(nonDrivableQuery(box, Math.ceil(this.options.timeoutMs / 1000))));
  }

  async fetchSurfaces(centre: GeoPoint, radiusM: number): Promise<readonly Surface[]> {
    const query = `[out:json][timeout:${Math.ceil(this.options.timeoutMs / 1000)}];
(
  way(around:${radiusM},${centre.lat},${centre.lon})[amenity=parking];
  way(around:${radiusM},${centre.lat},${centre.lon})[place=square];
  way(around:${radiusM},${centre.lat},${centre.lon})["area:highway"];
);
out body geom;`;
    const payload = await this.run(query);
    return mapSurfaces(payload);
  }

  /**
   * Only the structuring network — what gate discovery consumes. A dense
   * urban 2 km fetch of every highway is megabytes and times out; the
   * arterials alone are a few hundred ways anywhere in France.
   */
  async fetchStructuring(centre: GeoPoint, radiusM: number): Promise<RoadNeighbourhood> {
    const query = `[out:json][timeout:${Math.ceil(this.options.timeoutMs / 1000)}];
way(around:${radiusM},${centre.lat},${centre.lon})[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified)(_link)?$"];
out body geom;`;
    const payload = await this.run(query);
    return mapRoadNeighbourhood(payload, centre, radiusM);
  }

  /**
   * Every road way within `marginM` of the polyline — `CorridorPort` for the
   * S3 legality scan. Uses Overpass `around:<marginM>,lat,lon,...` which
   * describes a true buffer strip along the polyline — far smaller than a
   * bounding box for any L- or U-shaped route (the previous implementation).
   *
   * The polyline is split into chunks of at most `CHUNK_M` metres (keeping the
   * last point of each chunk as the first of the next, for continuity), plus a
   * hard cap on point count to guard against very dense GPS tracks. Ways are
   * deduplicated by id across chunks.
   *
   * NOTE: the cache key is the full Overpass query string (SHA-256). Switching
   * from bbox to `around` changes the query text, so all prior corridor cache
   * entries are invalidated automatically — this is intentional.
   */
  async fetchCorridor(
    polyline: readonly GeoPoint[],
    marginM: number,
  ): Promise<import('@teneolog/topology').RoadWay[]> {
    const CHUNK_M = 2_000;
    const CHUNK_POINTS_MAX = 200; // guard against very dense GPS tracks
    const chunks: GeoPoint[][] = [];
    let current: GeoPoint[] = [];
    let travelled = 0;
    for (let i = 0; i < polyline.length; i += 1) {
      const point = polyline[i];
      if (point === undefined) continue;
      const previous = current[current.length - 1];
      if (previous !== undefined) {
        const dLat = (point.lat - previous.lat) * 111_320;
        const dLon = (point.lon - previous.lon) * 111_320 * Math.cos((point.lat * Math.PI) / 180);
        travelled += Math.hypot(dLat, dLon);
      }
      current.push(point);
      if (travelled >= CHUNK_M || current.length >= CHUNK_POINTS_MAX) {
        chunks.push(current);
        current = [point]; // overlap: last point of chunk N is first of chunk N+1
        travelled = 0;
      }
    }
    if (current.length > 1) chunks.push(current);
    if (chunks.length === 0 && polyline.length > 0) chunks.push([...polyline]);

    const byId = new Map<string, import('@teneolog/topology').RoadWay>();
    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      // `around:R,lat1,lon1,lat2,lon2,...` = Minkowski buffer of radius R along
      // the polyline. Vastly smaller than a bbox for non-straight routes.
      const coordList = chunk.map((p) => `${p.lat},${p.lon}`).join(',');
      const query = `[out:json][timeout:${Math.ceil(this.options.timeoutMs / 1000)}];
way(around:${marginM},${coordList})[highway];
out body geom;`;
      const centre = chunk[Math.floor(chunk.length / 2)]!;
      const payload = await this.run(query);
      const mapped = mapRoadNeighbourhood(payload, centre, marginM);
      for (const way of mapped.ways) byId.set(way.id, way);
    }
    return [...byId.values()];
  }

  /**
   * Building footprints near a delivery point — display/portage only, not a
   * measurement input. Empty on Overpass failure (the destination visual
   * still works without the house outline).
   */
  /**
   * Building outlines plus the address nodes around them, in one query.
   *
   * Both are needed to pin the right house: a geocoder point routinely lands
   * between two footprints, and `addr:housenumber` on the way is rare outside
   * cities, while the nodes are mapped door by door.
   */
  async fetchBuildingFootprints(
    centre: GeoPoint,
    radiusM: number,
  ): Promise<OsmBuildingNeighbourhood> {
    const query = `[out:json][timeout:${Math.ceil(this.options.timeoutMs / 1000)}];
(
  way(around:${radiusM},${centre.lat},${centre.lon})[building];
  node(around:${radiusM},${centre.lat},${centre.lon})["addr:housenumber"];
);
out body geom;`;
    const payload = await this.run(query).catch(() => ({ elements: [] }));
    const footprints: OsmBuildingFootprint[] = [];
    const addressPoints: OsmAddressPoint[] = [];
    for (const el of payload.elements) {
      if (el.type === 'node') {
        const houseNumber = el.tags?.['addr:housenumber'];
        if (houseNumber === undefined || el.lat === undefined || el.lon === undefined) continue;
        addressPoints.push({
          point: { lat: el.lat, lon: el.lon },
          houseNumber,
          street: el.tags?.['addr:street'] ?? null,
        });
        continue;
      }
      if (el.type !== 'way' || el.geometry === undefined || el.geometry.length < 3) continue;
      const ring = el.geometry.map((g) => ({ lat: g.lat, lon: g.lon }));
      footprints.push({
        id: String(el.id),
        nature: el.tags?.['building'] ?? 'yes',
        houseNumber: el.tags?.['addr:housenumber'] ?? null,
        street: el.tags?.['addr:street'] ?? null,
        rings: [ring],
      });
    }
    return { footprints, addressPoints };
  }

  private async run(query: string): Promise<OverpassPayload> {
    const cached = await this.readCache(query);
    if (cached !== null) return cached;

    // In-flight dedup: an identical concurrent request shares the same fetch.
    const existing = this.inFlight.get(query);
    if (existing !== undefined) return existing;

    const promise = this.execute(query);
    this.inFlight.set(query, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(query);
    }
  }

  /**
   * Performs the actual network call (with optional retry) and caches the
   * result. Separated from `run()` so the in-flight Map holds the full
   * execution, not just the first `post()`.
   */
  private async execute(query: string): Promise<OverpassPayload> {
    let payload: OverpassPayload;
    try {
      payload = await this.post(query);
      // An Overpass remark (timeout / OOM) arrives as HTTP 200 with an empty
      // elements array — not a valid result. Throw before caching so the
      // retryOnce logic can replay, and so the bad payload is never persisted.
      assertNoRemark(payload);
    } catch (err) {
      if (!this.options.retryOnce || !isRetryable(err)) throw err;
      // One transparent retry with backoff. 429 and 5xx honour Retry-After.
      const delayMs = getRetryDelayMs(err, this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
      if (delayMs > 0) await sleep(delayMs);
      payload = await this.post(query);
      assertNoRemark(payload);
    }
    await this.writeCache(query, payload);
    return payload;
  }

  private cachePath(query: string): string | null {
    if (this.options.cacheDir === undefined) return null;
    const hash = createHash('sha256').update(query).digest('hex').slice(0, 24);
    return `${this.options.cacheDir}/overpass-${hash}.json`;
  }

  private async readCache(query: string): Promise<OverpassPayload | null> {
    const path = this.cachePath(query);
    if (path === null) return null;
    try {
      const { readFile, stat } = await import('node:fs/promises');
      const st = await stat(path);
      const ttl = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
      if (Date.now() - st.mtimeMs > ttl) return null; // expired — re-fetch
      return JSON.parse(await readFile(path, 'utf8')) as OverpassPayload;
    } catch {
      return null;
    }
  }

  private async writeCache(query: string, payload: OverpassPayload): Promise<void> {
    const path = this.cachePath(query);
    if (path === null) return;
    // Never persist an empty payload: it is either an Overpass error (remark
    // already thrown before we get here) or a genuinely empty area — either
    // way, a stale empty entry would silently wipe the corridor on the next run.
    if (payload.elements.length === 0) return;
    try {
      const { mkdir, writeFile, readdir, stat, unlink } = await import('node:fs/promises');
      const dir = this.options.cacheDir ?? '.';
      await mkdir(dir, { recursive: true });
      await writeFile(path, JSON.stringify(payload));
      // Evict oldest entries when the directory is over the size cap.
      await this.evictOldestIfNeeded(dir, { readdir, stat, unlink });
    } catch {
      // A cache write failure must never fail the fetch it was meant to save.
    }
  }

  private async evictOldestIfNeeded(
    dir: string,
    fs: {
      readdir: (dir: string) => Promise<string[]>;
      stat: (path: string) => Promise<{ mtimeMs: number }>;
      unlink: (path: string) => Promise<void>;
    },
  ): Promise<void> {
    const maxEntries = this.options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith('overpass-') && f.endsWith('.json'));
    if (files.length <= maxEntries) return;
    // Sort by mtime ascending; delete the excess oldest entries.
    const withMtime = await Promise.all(
      files.map(async (f) => {
        const st = await fs.stat(`${dir}/${f}`).catch(() => ({ mtimeMs: 0 }));
        return { f, mtimeMs: st.mtimeMs };
      }),
    );
    withMtime.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toDelete = withMtime.slice(0, files.length - maxEntries);
    await Promise.all(toDelete.map(({ f }) => fs.unlink(`${dir}/${f}`).catch(() => undefined)));
  }

  private async post(query: string): Promise<OverpassPayload> {
    const response = await fetch(this.options.interpreterUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Overpass etiquette — and the FR instance 403s an anonymous agent.
        'user-agent': 'teneolog-app/0.1 (+https://teneolog.com)',
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      throw new OverpassHttpError(response.status, this.options.interpreterUrl, retryAfterMs);
    }
    return (await response.json()) as OverpassPayload;
  }
}
