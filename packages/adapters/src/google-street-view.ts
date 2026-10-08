/**
 * Google Street View adapter — the driver's-eye ground still for a review
 * scene. Ground imagery is CONTEXT, never measurement: nothing is projected
 * onto these photos (there is no trustworthy geo→pixel transform into a
 * street-level panorama), so none of the frozen road-width primitives are
 * involved. The aerial frame keeps the simulation; this keeps the bollards,
 * gates and porches the orthophoto cannot show.
 *
 * Two-step fetch: the free Metadata API first (coverage, the pano's REAL
 * position, capture date), then one billed Static API image. The heading is
 * computed from the pano's actual location toward the point under review —
 * asking for the approach bearing blindly aims the camera wrong whenever the
 * pano snaps a few metres off the requested spot (the BUG-003 family of
 * heading mistakes).
 *
 * EEA Maps terms (July 2025): only `pano_id` (plus the free metadata) may be
 * cached. Stills are fetched on display, never written to disk.
 *
 * No coverage is an honest null, never an image of the wrong street.
 */
import { createHash } from 'node:crypto';

import type { GeoPoint } from '@teneolog/domain';
import { bearingDeg } from '@teneolog/topology';

export interface GoogleStreetViewOptions {
  readonly apiKey: string;
  readonly timeoutMs: number;
  /** File cache for pano_id + coverage metadata — never the image bytes. */
  readonly cacheDir?: string;
  readonly cacheTtlMs?: number;
  readonly sizePx?: number;
  readonly fovDeg?: number;
  /** How far from the requested camera point a pano may snap. */
  readonly searchRadiusM?: number;
  readonly baseUrl?: string;
}

export interface StreetViewCoverage {
  readonly panoId: string;
  /** Heading actually requested: pano location → the point under review. */
  readonly headingDeg: number;
  readonly panoLocation: GeoPoint;
  /** Pano's real position vs the requested camera point — displacement the UI can disclose. */
  readonly panoDistanceM: number;
  /** Capture month from the metadata (e.g. "2023-05"); evidence carries its age. */
  readonly capturedAt: string | null;
}

export interface StreetViewStill extends StreetViewCoverage {
  readonly jpegBase64: string;
}

const DEFAULT_TTL_MS = 14 * 24 * 3600 * 1000;
/** Below this pano↔target distance the pano→target bearing degenerates; fall back to the approach axis. */
const DEGENERATE_HEADING_M = 5;

interface MetadataResponse {
  readonly status?: string;
  readonly pano_id?: string;
  readonly location?: { readonly lat?: number; readonly lng?: number };
  readonly date?: string;
}

interface CacheEntry {
  readonly fetchedAtMs: number;
  /** Null = cached "no coverage". Images are never stored. */
  readonly coverage: StreetViewCoverage | null;
}

export class GoogleStreetView {
  constructor(private readonly options: GoogleStreetViewOptions) {}

  /**
   * Coverage + heading for the approach — Metadata API only, never billed.
   * Null when Street View has no pano within the search radius.
   */
  async lookupApproach(
    cameraAt: GeoPoint,
    lookAt: GeoPoint,
    radiusM?: number,
  ): Promise<StreetViewCoverage | null> {
    const radius = radiusM ?? this.options.searchRadiusM ?? 25;
    const cached = await this.readCache(cameraAt, lookAt, radius);
    if (cached !== undefined) return cached;

    const meta = await this.fetchMetadata(cameraAt, radius);
    if (meta === null) {
      await this.writeCache(cameraAt, lookAt, null, radius);
      return null;
    }

    const heading =
      distanceM(meta.location, lookAt) < DEGENERATE_HEADING_M
        ? bearingDeg(cameraAt, lookAt)
        : bearingDeg(meta.location, lookAt);

    const coverage: StreetViewCoverage = {
      panoId: meta.panoId,
      headingDeg: heading,
      panoLocation: meta.location,
      panoDistanceM: distanceM(meta.location, cameraAt),
      capturedAt: meta.date,
    };
    await this.writeCache(cameraAt, lookAt, coverage, radius);
    return coverage;
  }

  /**
   * The still a driver would see approaching `lookAt` from `cameraAt`.
   * Bills one Static image. Coverage metadata may come from cache; the JPEG never does.
   */
  async fetchApproachStill(cameraAt: GeoPoint, lookAt: GeoPoint): Promise<StreetViewStill | null> {
    const coverage = await this.lookupApproach(cameraAt, lookAt);
    if (coverage === null) return null;
    const jpegBase64 = await this.fetchStill(coverage.panoId, coverage.headingDeg);
    return { ...coverage, jpegBase64 };
  }

  /** One billed Static image for a known pano — the on-demand ground view. */
  async fetchStillJpeg(panoId: string, headingDeg: number): Promise<string> {
    return this.fetchStill(panoId, headingDeg);
  }

  private async fetchMetadata(
    cameraAt: GeoPoint,
    radiusM: number,
  ): Promise<{ panoId: string; location: GeoPoint; date: string | null } | null> {
    const url = new URL(`${this.baseUrl()}/metadata`);
    url.searchParams.set('location', `${cameraAt.lat},${cameraAt.lon}`);
    url.searchParams.set('radius', String(radiusM));
    url.searchParams.set('source', 'outdoor');
    url.searchParams.set('key', this.options.apiKey);

    const response = await fetch(url, { signal: AbortSignal.timeout(this.options.timeoutMs) });
    if (!response.ok) throw new Error(`Street View metadata HTTP ${response.status}`);
    const body = (await response.json()) as MetadataResponse;

    if (body.status === 'ZERO_RESULTS' || body.status === 'NOT_FOUND') return null;
    if (body.status !== 'OK')
      throw new Error(`Street View metadata status ${body.status ?? 'missing'}`);
    if (
      body.pano_id === undefined ||
      body.location?.lat === undefined ||
      body.location.lng === undefined
    ) {
      throw new Error('Street View metadata OK but incomplete');
    }
    return {
      panoId: body.pano_id,
      location: { lat: body.location.lat, lon: body.location.lng },
      date: body.date ?? null,
    };
  }

  private async fetchStill(panoId: string, headingDeg: number): Promise<string> {
    const size = this.options.sizePx ?? 640;
    const url = new URL(this.baseUrl());
    url.searchParams.set('size', `${size}x${size}`);
    url.searchParams.set('pano', panoId);
    url.searchParams.set('heading', headingDeg.toFixed(1));
    url.searchParams.set('fov', String(this.options.fovDeg ?? 90));
    url.searchParams.set('return_error_code', 'true');
    url.searchParams.set('key', this.options.apiKey);

    const response = await fetch(url, { signal: AbortSignal.timeout(this.options.timeoutMs) });
    if (!response.ok) throw new Error(`Street View static HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (
      contentType.includes('xml') ||
      contentType.includes('text') ||
      contentType.includes('json')
    ) {
      throw new Error(`Street View non-image response: ${(await response.text()).slice(0, 120)}`);
    }
    return Buffer.from(await response.arrayBuffer()).toString('base64');
  }

  private baseUrl(): string {
    return this.options.baseUrl ?? 'https://maps.googleapis.com/maps/api/streetview';
  }

  private cachePath(cameraAt: GeoPoint, lookAt: GeoPoint, radiusM: number): string | null {
    if (this.options.cacheDir === undefined) return null;
    // ~1 m rounding: the same scene re-analysed lands on the same entry.
    const key = [
      cameraAt.lat.toFixed(5),
      cameraAt.lon.toFixed(5),
      lookAt.lat.toFixed(5),
      lookAt.lon.toFixed(5),
      this.options.sizePx ?? 640,
      this.options.fovDeg ?? 90,
      radiusM,
    ].join('|');
    const hash = createHash('sha1').update(key).digest('hex');
    return `${this.options.cacheDir}/streetview-${hash}.json`;
  }

  /** `undefined` = no usable cache; `null` = cached "no coverage". */
  private async readCache(
    cameraAt: GeoPoint,
    lookAt: GeoPoint,
    radiusM: number,
  ): Promise<StreetViewCoverage | null | undefined> {
    const path = this.cachePath(cameraAt, lookAt, radiusM);
    if (path === null) return undefined;
    try {
      const { readFile } = await import('node:fs/promises');
      const entry = JSON.parse(await readFile(path, 'utf8')) as CacheEntry & {
        still?: StreetViewStill | null;
      };
      const ttl = this.options.cacheTtlMs ?? DEFAULT_TTL_MS;
      if (Date.now() - entry.fetchedAtMs > ttl) return undefined;
      if (entry.coverage !== undefined) return entry.coverage;
      // Pre- entries stored the JPEG; pano_id was not kept. Ignore them.
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async writeCache(
    cameraAt: GeoPoint,
    lookAt: GeoPoint,
    coverage: StreetViewCoverage | null,
    radiusM: number,
  ): Promise<void> {
    const path = this.cachePath(cameraAt, lookAt, radiusM);
    if (path === null) return;
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(this.options.cacheDir ?? '.', { recursive: true });
      const entry: CacheEntry = { fetchedAtMs: Date.now(), coverage };
      await writeFile(path, JSON.stringify(entry));
    } catch {
      // A cache miss next time re-asks metadata (free), never fails the scene.
    }
  }
}

/** Equirectangular metres — exact enough for pano-vs-point distances under 100 m. */
function distanceM(a: GeoPoint, b: GeoPoint): number {
  const cos = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const dx = (b.lon - a.lon) * 111_320 * cos;
  const dy = (b.lat - a.lat) * 111_320;
  return Math.hypot(dx, dy);
}
