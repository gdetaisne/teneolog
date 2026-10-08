/**
 * IGN RGE ALTI — heights from the Géoplateforme altimetry service, free and
 * keyless (`elevation.json`, resource `ign_rge_alti_wld`)..
 *
 * Why not Google: principe 49, completed on 2026-09-29 (« 3. oui IGN »). At La
 * Crèche Google's Elevation, on a 153 m mesh, read 3,3 % at the door (« le
 * tire-palette passe ») where the RGE ALTI, on a 1 to 5 m grid, reads 6 to 8 %
 * and about 10 % over 80 m of the walk. This adapter only resolves heights,
 * like `GoogleElevation`, behind the same port — the reading of a grade is the
 * caller's (`@teneolog/constraints`, `walk-slope.ts`). the engine's own
 * port too (l'API (hors instantané)), so the door's slope (S2) and the walk's
 * read the same ground, one instance, one cache.
 *
 * What it keeps: the heights it has read, by point, for the life of the
 * process — the ground does not move, and a walk re-analysed asks nothing
 * again. Nothing else: no failure is kept, so a service that was down is asked
 * again next time.
 *
 * What it does not say (principe 14): a point the model does not cover comes
 * back as `-99999`. That is not a height; the whole request is then an
 * `IgnAltimetryNoDataError`, and the reader says « pente inconnue », never 0 %.
 */
import type { GeoPoint } from '@teneolog/domain';
import { ElevationNoDataError, type ElevationPort, type ElevationSample } from '@teneolog/pipeline';

export const IGN_ALTIMETRY_URL = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';

export interface IgnAltimetryOptions {
  readonly timeoutMs: number;
  readonly endpoint?: string;
  /**
   * Points per request. The service documents 5 000; a request stays far
   * below so that one slow answer never holds a whole walk.
   */
  readonly maxPointsPerRequest?: number;
  /** Heights kept in memory, by point. A bound, not a measure. */
  readonly maxCachedPoints?: number;
}

/** The value the service returns where the model has no height. */
const NO_DATA_BELOW_M = -1000;
const DEFAULT_MAX_POINTS = 200;
const DEFAULT_MAX_CACHED = 50_000;

/**
 * A point the RGE ALTI does not cover (the sea, abroad): no height, said as
 * such — the port's `ElevationNoDataError`, which S2 reads `no_data`.
 */
export class IgnAltimetryNoDataError extends ElevationNoDataError {
  constructor(missing: number) {
    super(missing);
    this.message = `IGN altimetry: no height at ${missing} point(s)`;
    this.name = 'IgnAltimetryNoDataError';
  }
}

interface ElevationResponse {
  readonly elevations?: readonly unknown[];
}

export class IgnAltimetry implements ElevationPort {
  readonly source = 'ign-rge-alti';
  private readonly heights = new Map<string, number>();

  constructor(private readonly options: IgnAltimetryOptions) {}

  /**
   * The answer is built from this call's own heights — the cached ones read
   * BEFORE fetching, then the fetched ones — never from the cache afterwards:
   * a bounded cache may evict, mid-call, a height counted as known (relecture
   * du 2026-09-30 : `undefined`, a NaN grade, read « le tire-palette passe »).
   */
  async getElevations(points: readonly GeoPoint[]): Promise<readonly ElevationSample[]> {
    const known = new Map<string, number>();
    const unknown = new Map<string, GeoPoint>();
    for (const p of points) {
      const key = keyOf(p);
      const cached = this.heights.get(key);
      if (cached !== undefined) known.set(key, cached);
      else unknown.set(key, p);
    }
    const toFetch = [...unknown.entries()];
    const size = this.options.maxPointsPerRequest ?? DEFAULT_MAX_POINTS;
    for (let i = 0; i < toFetch.length; i += size) {
      const chunk = toFetch.slice(i, i + size);
      const heights = await this.fetchHeights(chunk.map(([, p]) => p));
      chunk.forEach(([key], k) => {
        const height = heights[k] as number;
        known.set(key, height);
        this.remember(key, height);
      });
    }
    return points.map((at) => {
      const elevationMeters = known.get(keyOf(at));
      if (elevationMeters === undefined) throw new Error('IGN altimetry: a height went missing within one call');
      return { at, elevationMeters };
    });
  }

  private async fetchHeights(points: readonly GeoPoint[]): Promise<readonly number[]> {
    const response = await fetch(this.options.endpoint ?? IGN_ALTIMETRY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lon: points.map((p) => p.lon).join('|'),
        lat: points.map((p) => p.lat).join('|'),
        resource: 'ign_rge_alti_wld',
        zonly: 'true',
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new Error(`IGN altimetry HTTP ${response.status}`);
    const body = (await response.json()) as ElevationResponse;
    const heights = body.elevations ?? [];
    if (heights.length !== points.length) {
      throw new Error(`IGN altimetry returned ${heights.length} heights for ${points.length} points`);
    }
    if (heights.some((z) => typeof z !== 'number' || !Number.isFinite(z))) {
      throw new Error('IGN altimetry returned a height that is not a number');
    }
    const missing = (heights as readonly number[]).filter((z) => z < NO_DATA_BELOW_M).length;
    if (missing > 0) throw new IgnAltimetryNoDataError(missing);
    return heights as readonly number[];
  }

  private remember(key: string, height: number): void {
    if (this.heights.size >= (this.options.maxCachedPoints ?? DEFAULT_MAX_CACHED)) {
      const oldest = this.heights.keys().next().value;
      if (oldest !== undefined) this.heights.delete(oldest);
    }
    this.heights.set(key, height);
  }
}

/** ~1 cm: the same point asked twice is the same key. */
function keyOf(p: GeoPoint): string {
  return `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
}
