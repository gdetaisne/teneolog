/**
 * OSRM adapter — `RoutingPort` over the self-hosted instance.
 *
 * The car profile posture is deliberate and documented
 * (routing-legality-and-largest-truck.md §2): a truck profile prunes
 * `access=destination` ways — the very streets deliveries happen on — and
 * per-vehicle routing breaks the measure-once invariant. The router
 * generates; the annotated segments judge.
 */
import type { GeoPoint } from '@teneolog/domain';
import type { RoutedPath, RoutingPort } from '@teneolog/routes';
import { withoutDegenerateSegments } from '@teneolog/topology';

export interface OsrmOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

interface OsrmRoute {
  readonly distance: number;
  readonly duration: number;
  readonly geometry: { readonly coordinates: readonly (readonly [number, number])[] };
}

export class OsrmRouting implements RoutingPort {
  constructor(private readonly options: OsrmOptions) {}

  async route(from: GeoPoint, to: GeoPoint, alternatives: number): Promise<readonly RoutedPath[]> {
    const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
    const url =
      `${this.options.baseUrl}/route/v1/driving/${coords}` +
      `?alternatives=${alternatives > 0 ? String(alternatives) : 'false'}` +
      `&overview=full&geometries=geojson&steps=false`;

    const response = await fetch(url, {
      headers: { 'user-agent': 'teneolog-app/0.1 (+https://teneolog.com)' },
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new Error(`OSRM ${response.status}`);
    const payload = (await response.json()) as { readonly code: string; readonly routes?: readonly OsrmRoute[] };
    if (payload.code !== 'Ok' || payload.routes === undefined) {
      // "NoRoute" is an answer about the address; every other code is an
      // infrastructure failure. Both surface as errors here and the caller
      // separates them by the candidate-set fact it publishes.
      throw new Error(`OSRM ${payload.code}`);
    }
    return payload.routes.map((route) => ({
      // OSRM repeats its snapped departure vertex — entry legs carry it at
      // index 1, exit legs before the last. Two identical points are not a
      // segment; every consumer downstream reads a bearing of 0° there and
      // believes it. The line is compacted once, here.
      polyline: withoutDegenerateSegments(
        route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
      ),
      distanceM: route.distance,
      durationS: route.duration,
    }));
  }
}
