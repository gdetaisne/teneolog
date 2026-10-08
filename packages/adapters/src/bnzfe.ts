/**
 * Low-emission zones, from the national consolidated base (BNZFE).
 *
 * `aires.geojson` on transport.data.gouv.fr carries every French ZFE with, per
 * vehicle class, the Crit'Air sticker at which circulation stops being allowed
 * and the hours the restriction applies. It is small — a few dozen zones — so
 * the whole file is held in memory and refreshed on a TTL rather than queried
 * per address.
 *
 * The one semantic trap is `pl_critair`, which names the cleanest sticker that
 * is ALREADY BANNED, not the worst one still admitted. It is translated once,
 * here, into `LowEmissionZone.bannedFrom`, and never re-read by hand.
 *
 * Availability posture: a zone lookup that fails answers "unknown", never "no
 * zone". Those are different sentences and only one of them is a fine.
 */
import type { CritAir, GeoPoint, LowEmissionZone } from '@teneolog/domain';

/** Ordered so a lookup can compare stickers without importing the domain order. */
const CRIT_AIR_VALUES: ReadonlySet<string> = new Set(['EL', 'V1', 'V2', 'V3', 'V4', 'V5', 'NC']);

export interface BnzfeOptions {
  /** `aires.geojson` of the national base. */
  readonly airesUrl: string;
  readonly timeoutMs: number;
  /** How long a loaded base stays fresh. ZFE decrees change on the scale of months. */
  readonly ttlMs: number;
  /** Clock, injected so the pure parts stay testable. */
  readonly now?: () => number;
}

interface Ring {
  readonly ring: readonly (readonly [number, number])[];
  readonly holes: readonly (readonly (readonly [number, number])[])[];
}

interface LoadedZone {
  readonly zone: LowEmissionZone;
  readonly polygons: readonly Ring[];
  readonly bbox: readonly [number, number, number, number];
}

interface RawFeature {
  readonly properties?: Record<string, unknown>;
  readonly geometry?: { readonly type?: string; readonly coordinates?: unknown };
}

/**
 * Zones in force at a point, for heavy goods vehicles.
 *
 * `null` is a measured absence ("we looked, there is no zone here"); a thrown
 * error is the caller's signal to publish an unknown.
 */
export class BnzfeLowEmissionZones {
  private loaded: readonly LoadedZone[] | null = null;
  private loadedAt = 0;
  private inFlight: Promise<readonly LoadedZone[]> | null = null;

  constructor(private readonly options: BnzfeOptions) {}

  /** The zone covering this point, or `null` when none does. */
  async zoneAt(point: GeoPoint): Promise<LowEmissionZone | null> {
    const zones = await this.base();
    // Smallest area first: a city zone nested inside a metropolitan one is the
    // stricter, more specific rule, and it is the one that applies on the spot.
    const hits = zones
      .filter((z) => withinBbox(point, z.bbox) && z.polygons.some((p) => inPolygon(point, p)))
      .sort((a, b) => bboxArea(a.bbox) - bboxArea(b.bbox));
    return hits[0]?.zone ?? null;
  }

  private async base(): Promise<readonly LoadedZone[]> {
    const now = (this.options.now ?? Date.now)();

    // Fresh: serve immediately.
    if (this.loaded !== null && now - this.loadedAt < this.options.ttlMs) return this.loaded;

    // Stale-while-revalidate: serve the old base immediately and
    // refresh in the background. The caller never waits for the download after
    // the first load; a failed refresh keeps the old base until the next tick.
    if (this.loaded !== null) {
      this.triggerReload();
      return this.loaded;
    }

    // Cold start: no base yet — wait for the first load.
    if (this.inFlight === null) {
      this.inFlight = this.fetchBase()
        .then((zones) => {
          this.loaded = zones;
          this.loadedAt = (this.options.now ?? Date.now)();
          return zones;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  /**
   * Fire-and-forget background reload. Only one reload at a time (guarded by
   * `inFlight`). On failure the old base is kept; the next call to `base()`
   * will trigger another attempt (no tight retry loop: the caller drives the
   * pace via `zoneAt` call frequency).
   */
  private triggerReload(): void {
    if (this.inFlight !== null) return; // reload already in progress
    this.inFlight = this.fetchBase()
      .then((zones) => {
        this.loaded = zones;
        this.loadedAt = (this.options.now ?? Date.now)();
        return zones;
      })
      .catch(() => {
        // Keep old base; inFlight cleared in finally so the next caller retries.
        return this.loaded ?? [];
      })
      .finally(() => {
        this.inFlight = null;
      });
  }

  private async fetchBase(): Promise<readonly LoadedZone[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(this.options.airesUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(`bnzfe: HTTP ${response.status}`);
      const body = (await response.json()) as { features?: readonly RawFeature[] };
      const features = body.features ?? [];
      if (features.length === 0) throw new Error('bnzfe: empty base');
      return features.map(parseFeature).filter((z): z is LoadedZone => z !== null);
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseFeature(feature: RawFeature): LoadedZone | null {
  const p = feature.properties ?? {};
  const id = typeof p['id'] === 'string' ? p['id'] : null;
  const since = typeof p['date_debut'] === 'string' ? p['date_debut'] : null;
  if (id === null || since === null) return null;

  const polygons = readPolygons(feature.geometry);
  if (polygons.length === 0) return null;

  const zone: LowEmissionZone = {
    zoneId: id,
    name: str(p['nom']),
    // The schema's `pl_critair` is the sticker circulation stops at. Translated
    // here, once, so no reader downstream has to remember the direction.
    bannedFrom: critAir(p['pl_critair']),
    hours: str(p['pl_horaires']),
    since,
    until: str(p['date_fin']),
    decreeUrl: str(p['url_arrete']),
    infoUrl: str(p['url_site_information']),
    dataUpdatedAt: str(p['date_maj']),
  };
  return { zone, polygons, bbox: bboxOf(polygons) };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function critAir(value: unknown): CritAir | null {
  return typeof value === 'string' && CRIT_AIR_VALUES.has(value) ? (value as CritAir) : null;
}

function readPolygons(geometry: RawFeature['geometry']): readonly Ring[] {
  const coords = geometry?.coordinates;
  const toRing = (raw: unknown): readonly (readonly [number, number])[] =>
    Array.isArray(raw)
      ? raw
          .filter((p): p is readonly number[] => Array.isArray(p) && p.length >= 2)
          .map((p) => [p[0] as number, p[1] as number] as const)
      : [];
  const toPolygon = (raw: unknown): Ring | null => {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const ring = toRing(raw[0]);
    if (ring.length < 4) return null;
    return { ring, holes: raw.slice(1).map(toRing).filter((h) => h.length >= 4) };
  };

  if (geometry?.type === 'Polygon') {
    const polygon = toPolygon(coords);
    return polygon === null ? [] : [polygon];
  }
  if (geometry?.type === 'MultiPolygon' && Array.isArray(coords)) {
    return coords.map(toPolygon).filter((p): p is Ring => p !== null);
  }
  return [];
}

function bboxOf(polygons: readonly Ring[]): readonly [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const polygon of polygons) {
    for (const [lon, lat] of polygon.ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}

function bboxArea(bbox: readonly [number, number, number, number]): number {
  return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
}

function withinBbox(point: GeoPoint, bbox: readonly [number, number, number, number]): boolean {
  return point.lon >= bbox[0] && point.lon <= bbox[2] && point.lat >= bbox[1] && point.lat <= bbox[3];
}

/** Even-odd ray casting, holes subtracted. Zones are flat enough for planar maths. */
function inPolygon(point: GeoPoint, polygon: Ring): boolean {
  if (!inRing(point, polygon.ring)) return false;
  return !polygon.holes.some((hole) => inRing(point, hole));
}

function inRing(point: GeoPoint, ring: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) continue;
    const [xi, yi] = a;
    const [xj, yj] = b;
    if (yi > point.lat !== yj > point.lat) {
      const x = ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
      if (point.lon < x) inside = !inside;
    }
  }
  return inside;
}
