/**
 * BAN geocoder — `GeocodePort` over the Base Adresse Nationale, served by the
 * Géoplateforme (IGN). Public, keyless, and the reference for French
 * addresses; Google joins later as a second opinion so a 247 m disagreement
 * (Aubagne, BUG-016) becomes a fact instead of a silent choice.
 */
import type { GeocodeOpinion } from '@teneolog/domain';
import type { GeocodePort } from '@teneolog/topology';

/**
 * the one default for every caller (`/user`, the chargeur, the
 * scripts); `BAN_URL` still overrides it in `/user` and the chargeur (the
 * `verify-*` scripts never read it). api-adresse.data.gouv.fr was retired
 * on 2026-01-31 and only relays here now (`x-infra: gpf`, `sunset`): same
 * index, same answers — 52 queries compared on 2026-09-25, not one differed —
 * one hop less, and no outage the day the relay goes dark.
 */
export const GEOPLATEFORME_GEOCODING_URL = 'https://data.geopf.fr/geocodage';

export interface BanGeocoderOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

interface BanFeature {
  readonly geometry: { readonly coordinates: readonly [number, number] };
  readonly properties: {
    readonly label: string;
    readonly score: number;
    readonly type: string;
    readonly id?: string;
  };
}

export interface BanHit {
  readonly label: string;
  readonly point: { readonly lat: number; readonly lon: number };
  readonly score: number;
  readonly id: string | null;
  readonly type: string | null;
}

export class BanGeocoder implements GeocodePort {
  constructor(private readonly options: BanGeocoderOptions) {}

  async geocode(address: string): Promise<readonly GeocodeOpinion[]> {
    const hit = await this.lookup(address);
    return hit === null ? [] : [toOpinion(hit)];
  }

  /** Same BAN search as `geocode`, plus the numéro id the fiche needs. */
  async lookup(address: string): Promise<BanHit | null> {
    try {
      return await this.fetchHit(address);
    } catch {
      return this.fetchHit(address);
    }
  }

  /**
   * Address-bar suggestions: BAN's autocomplete mode, several candidates, no
   * retry — a stale suggestion list is worthless by the next keystroke.
   */
  async suggest(query: string, limit = 5): Promise<readonly GeocodeOpinion[]> {
    const url = `${this.options.baseUrl}/search?q=${encodeURIComponent(query)}&limit=${limit}&autocomplete=1`;
    const response = await fetch(url, {
      headers: { 'user-agent': 'teneolog-app/0.1 (+https://teneolog.com)' },
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new Error(`BAN ${response.status}`);
    const payload = (await response.json()) as { readonly features: readonly BanFeature[] };
    return payload.features.map((feature) => {
      const [lon, lat] = feature.geometry.coordinates;
      return {
        point: { lat, lon },
        formatted: feature.properties.label,
        score: feature.properties.score ?? 0.5,
        source: 'ban',
        // a clicked suggestion is the nominal path of `/user`. What
        // BAN knew about it — the numéro id and what it posed the point on —
        // stops here unless the suggestion carries it back at start.
        banId: feature.properties.id ?? null,
        positionType: feature.properties.type ?? null,
      };
    });
  }

  private async fetchHit(address: string): Promise<BanHit | null> {
    const url = `${this.options.baseUrl}/search?q=${encodeURIComponent(address)}&limit=1`;
    const response = await fetch(url, {
      headers: { 'user-agent': 'teneolog-app/0.1 (+https://teneolog.com)' },
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new Error(`BAN ${response.status}`);
    const payload = (await response.json()) as { readonly features: readonly BanFeature[] };
    const feature = payload.features[0];
    if (feature === undefined) return null;
    const [lon, lat] = feature.geometry.coordinates;
    return {
      label: feature.properties.label,
      point: { lat, lon },
      // the score travels with the hit — the pipeline holds it against
      // `geocoding.minBanScore`. A feature without one is not trusted: 0, so
      // the threshold refuses it rather than a NaN slipping past every compare.
      score: typeof feature.properties.score === 'number' ? feature.properties.score : 0,
      id: feature.properties.id ?? null,
      type: feature.properties.type ?? null,
    };
  }
}

/**
 * the id and the position type travel with the opinion.
 *
 * They were parsed by `fetchHit` and thrown away here — so nothing downstream
 * could say whether BAN had found the door or merely the street it is on,
 * although that is exactly the difference between measuring a frontage and
 * measuring the middle of a carriageway.
 */
function toOpinion(hit: BanHit): GeocodeOpinion {
  return {
    source: 'ban',
    point: hit.point,
    score: hit.score,
    formatted: hit.label,
    banId: hit.id,
    positionType: hit.type,
  };
}
