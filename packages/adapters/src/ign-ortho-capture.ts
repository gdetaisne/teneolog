/**
 * WMS GetFeatureInfo on ORTHOIMAGERY.ORTHOPHOTOS — the capture vintage the
 * Licence Ouverte requires us to print ("IGN, prise de vue <date>").
 *
 * The date does not move: one successful lookup is cached for the process.
 * Failures are not cached, so a transient WMS error is retried next time.
 */
import type { GeoPoint } from '@teneolog/domain';

export interface IgnOrthoCapture {
  /** Best known capture instant: `YYYY-MM-DD` when the flight day is known, else `YYYY`. */
  readonly capturedAt: string;
  readonly resolutionCm: number | null;
}

export interface IgnOrthoCaptureOptions {
  readonly wmsUrl: string;
  readonly timeoutMs: number;
  readonly at: GeoPoint;
}

const cache = new Map<string, IgnOrthoCapture | 'empty'>();

/** ~110 m grid — neighbouring scenes on the same street share a millésime. */
function cacheKey(at: GeoPoint): string {
  return `${at.lat.toFixed(3)},${at.lon.toFixed(3)}`;
}

export function clearIgnCaptureCache(): void {
  cache.clear();
}

/** Licence Ouverte 2.0 paternity line. Always at least "IGN". */
export function formatIgnAttributionFr(capture: IgnOrthoCapture | null): string {
  if (capture === null) return 'IGN';
  const day = capture.capturedAt.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (day) return `IGN, prise de vue ${day[3]}/${day[2]}/${day[1]}`;
  if (/^\d{4}$/.test(capture.capturedAt)) return `IGN, prise de vue ${capture.capturedAt}`;
  return 'IGN';
}

export async function fetchIgnCaptureDate(
  options: IgnOrthoCaptureOptions,
): Promise<IgnOrthoCapture | null> {
  const key = cacheKey(options.at);
  const hit = cache.get(key);
  if (hit === 'empty') return null;
  if (hit !== undefined) return hit;

  const capture = await queryWms(options);
  if (capture === undefined) return null;
  cache.set(key, capture === null ? 'empty' : capture);
  return capture;
}

/** `undefined` = transport/parse failure (do not cache). `null` = no feature. */
async function queryWms(
  options: IgnOrthoCaptureOptions,
): Promise<IgnOrthoCapture | null | undefined> {
  const url = featureInfoUrl(options);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'teneolog-app/0.1 (+https://teneolog.com)' },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) return undefined;
    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    if (contentType.includes('json')) return parseJsonFeatureInfo(body);
    return parsePlainFeatureInfo(body);
  } catch {
    return undefined;
  }
}

function featureInfoUrl(options: IgnOrthoCaptureOptions): URL {
  const halfDeg = 0.0002;
  const { lat, lon } = options.at;
  const url = new URL(options.wmsUrl);
  url.searchParams.set('SERVICE', 'WMS');
  url.searchParams.set('VERSION', '1.3.0');
  url.searchParams.set('REQUEST', 'GetFeatureInfo');
  url.searchParams.set('LAYERS', 'ORTHOIMAGERY.ORTHOPHOTOS');
  url.searchParams.set('QUERY_LAYERS', 'ORTHOIMAGERY.ORTHOPHOTOS');
  url.searchParams.set('CRS', 'EPSG:4326');
  url.searchParams.set('BBOX', `${lat - halfDeg},${lon - halfDeg},${lat + halfDeg},${lon + halfDeg}`);
  url.searchParams.set('WIDTH', '101');
  url.searchParams.set('HEIGHT', '101');
  url.searchParams.set('I', '50');
  url.searchParams.set('J', '50');
  url.searchParams.set('FORMAT', 'image/jpeg');
  url.searchParams.set('INFO_FORMAT', 'text/plain');
  url.searchParams.set('STYLES', '');
  url.searchParams.set('FEATURE_COUNT', '1');
  return url;
}

export function parsePlainFeatureInfo(body: string): IgnOrthoCapture | null {
  if (body.includes('ServiceException') || body.trim().length === 0) return null;
  const props: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (match) props[match[1]!.toLowerCase()] = match[2]!;
  }
  return captureFromProps(props);
}

export function parseJsonFeatureInfo(body: string): IgnOrthoCapture | null {
  try {
    const parsed = JSON.parse(body) as {
      features?: Array<{ properties?: Record<string, unknown> }>;
    };
    const props = parsed.features?.[0]?.properties;
    if (props === undefined) return null;
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined) continue;
      flat[key.toLowerCase()] = String(value);
    }
    return captureFromProps(flat);
  } catch {
    return null;
  }
}

function captureFromProps(props: Record<string, string>): IgnOrthoCapture | null {
  const capturedAt = pickCapturedAt(props);
  if (capturedAt === null) return null;
  const resRaw = props['res'] ?? props['resolution'] ?? props['resolution_cm'];
  const resolutionCm = resRaw !== undefined && resRaw !== '' ? Number(resRaw) : NaN;
  return {
    capturedAt,
    resolutionCm: Number.isFinite(resolutionCm) ? resolutionCm : null,
  };
}

function pickCapturedAt(props: Record<string, string>): string | null {
  for (const key of ['date_vol', 'date_acquisition', 'date']) {
    const iso = toIsoDay(props[key]);
    if (iso !== null) return iso;
  }
  for (const key of ['pva', 'annee', 'year']) {
    const year = toYear(props[key]);
    if (year !== null) return year;
  }
  return null;
}

function toIsoDay(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function toYear(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const match = raw.trim().match(/^(\d{4})/);
  return match ? match[1]! : null;
}
