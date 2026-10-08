/**
 * Google Maps Elevation API — two (or a few) points per address, one billed
 * request. The pipeline asks for elevations on the delivery-street axis; this
 * adapter only resolves heights. Docs:
 * https://developers.google.com/maps/documentation/elevation/overview
 */
import type { GeoPoint } from '@teneolog/domain';
import type { ElevationPort, ElevationSample } from '@teneolog/pipeline';

export interface GoogleElevationOptions {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly endpoint?: string;
}

const DEFAULT_ENDPOINT = 'https://maps.googleapis.com/maps/api/elevation/json';
const MAX_LOCATIONS = 512;

interface ElevationResult {
  readonly elevation?: number;
  readonly location?: { readonly lat?: number; readonly lng?: number };
}

interface ElevationResponse {
  readonly status?: string;
  readonly results?: readonly ElevationResult[];
  readonly error_message?: string;
}

export class GoogleElevation implements ElevationPort {
  readonly source = 'google-elevation';

  constructor(private readonly options: GoogleElevationOptions) {}

  async getElevations(points: readonly GeoPoint[]): Promise<readonly ElevationSample[]> {
    if (points.length === 0) return [];
    if (points.length > MAX_LOCATIONS) {
      throw new Error(`Google Elevation: ${points.length} points exceeds ${MAX_LOCATIONS}`);
    }

    const locations = points.map((p) => `${p.lat},${p.lon}`).join('|');
    const params = new URLSearchParams({ locations, key: this.options.apiKey });
    const url = `${this.options.endpoint ?? DEFAULT_ENDPOINT}?${params.toString()}`;

    const response = await fetch(url, { signal: AbortSignal.timeout(this.options.timeoutMs) });
    if (!response.ok) throw new Error(`Google Elevation HTTP ${response.status}`);

    const payload = (await response.json()) as ElevationResponse;
    if (payload.status !== 'OK') {
      throw new Error(
        `Google Elevation status=${payload.status ?? 'missing'}${
          payload.error_message ? ` (${payload.error_message})` : ''
        }`,
      );
    }

    const results = payload.results ?? [];
    if (results.length !== points.length) {
      throw new Error(
        `Google Elevation returned ${results.length} results for ${points.length} points`,
      );
    }

    return results.map((result, i) => {
      const requested = points[i];
      if (requested === undefined || typeof result.elevation !== 'number') {
        throw new Error('Google Elevation result missing elevation');
      }
      return {
        at: {
          lat: result.location?.lat ?? requested.lat,
          lon: result.location?.lng ?? requested.lon,
        },
        elevationMeters: result.elevation,
      };
    });
  }
}
