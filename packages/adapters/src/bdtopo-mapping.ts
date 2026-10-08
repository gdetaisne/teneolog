/**
 * BDTOPO rows → RoadNeighbourhood.
 *
 * The structural difference from OSM: BDTOPO segments carry geometry but NO
 * shared node identity — two segments meeting at a junction simply have
 * endpoints at (almost) the same coordinates. The graph the topology stage
 * needs is synthesised here by clustering endpoints within a snap tolerance.
 * Get that wrong and every junction dissolves into pairs of degree-1 tips:
 * the whole network reads as confetti of dead ends.
 *
 * Field vocabulary (verified against the engine's providers, not invented):
 * - `one_way`: 'Double sens' → two-way; 'Sens direct' → forward along node
 *   order; 'Sens inverse' → backward. The engine collapsed direct/inverse
 *   into one boolean and lost the direction; kept distinct here because
 *   `entryDirection` consumes it.
 * - `nature`: 'Sentier', 'Piste cyclable', 'Escalier', 'Voie verte', 'Chemin
 *   de halage', 'Route empierrée' carry no delivery vehicle and are excluded
 *   at the mapping (accent-insensitive fragments — the engine's validated
 *   list). 'Chemin'/'Chemin rural' stay: rural tracks are delivered on.
 * - `importance`: text '1'…'6', sometimes decimal. Lower is more structuring.
 */
import type { GeoPoint } from '@teneolog/domain';
import type { RoadNeighbourhood, RoadNode, RoadWay } from '@teneolog/topology';

export interface BdtopoRoadRow {
  readonly id: string;
  readonly nature: string | null;
  readonly importance: string | number | null;
  readonly lane_count: number | null;
  readonly width_m: number | null;
  readonly one_way: string | null;
  readonly restriction_height_m: number | null;
  readonly restriction_width_m: number | null;
  readonly restriction_weight_t: number | null;
  readonly is_private: boolean | null;
  /** GeoJSON from ST_AsGeoJSON: LineString or MultiLineString. */
  readonly geom_geojson: string;
}

/**
 * the natures NO motor vehicle takes (footpath, cycle track, stair,
 * greenway, towpath): what cuts the public space (`bdtopo-road-links.ts`).
 */
const CLOSED_TO_ALL_VEHICLES_NATURE_FRAGMENTS = [
  'sentier',
  'piste cycl',
  'cyclable',
  'voie vert',
  'chemin de halage',
  'escalier',
] as const;

/**
 * The truck graph's exclusion: those, plus 'Route empierrée' — a car drives
 * it in any weather, a delivery truck is not routed on it.
 */
const NON_MOTOR_NATURE_FRAGMENTS = [
  ...CLOSED_TO_ALL_VEHICLES_NATURE_FRAGMENTS,
  'empierree',
] as const;

export interface BdtopoMappingOptions {
  /**
   * Endpoints closer than this are the same junction. BDTOPO endpoints
   * usually coincide exactly; the tolerance absorbs re-projection jitter.
   * Too large and two parallel street ends fuse into a phantom junction.
   */
  readonly junctionSnapM: number;
}

export function mapBdtopoNeighbourhood(
  rows: readonly BdtopoRoadRow[],
  centre: GeoPoint,
  radiusM: number,
  options: BdtopoMappingOptions,
): RoadNeighbourhood {
  interface PendingWay {
    readonly row: BdtopoRoadRow;
    readonly wayId: string;
    readonly points: readonly GeoPoint[];
  }

  const pending: PendingWay[] = [];
  for (const row of rows) {
    if (isNonMotorNature(row.nature)) continue;
    const lines = parseLines(row.geom_geojson);
    lines.forEach((points, index) => {
      if (points.length < 2) return;
      // A MultiLineString part gets a suffixed id so each way stays a simple chain.
      const wayId = lines.length === 1 ? row.id : `${row.id}#${index}`;
      pending.push({ row, wayId, points });
    });
  }

  const junctions = new EndpointClusters(options.junctionSnapM);
  const ways: RoadWay[] = [];
  const nodePositions = new Map<string, GeoPoint>();
  const nodeWayIds = new Map<string, string[]>();

  for (const { row, wayId, points } of pending) {
    const nodeIds = points.map((point, i) => {
      const isEndpoint = i === 0 || i === points.length - 1;
      // Only endpoints can be junctions in BDTOPO's model; interior vertices
      // are shape points, unique to their way by construction — the same
      // property the Plougoumelen guard (BUG-048a) relies on.
      return isEndpoint ? junctions.idFor(point) : `${wayId}:v${i}`;
    });

    nodeIds.forEach((nodeId, i) => {
      const point = points[i];
      if (point === undefined) return;
      if (!nodePositions.has(nodeId)) nodePositions.set(nodeId, point);
      const owners = nodeWayIds.get(nodeId) ?? [];
      if (!owners.includes(wayId)) owners.push(wayId);
      nodeWayIds.set(nodeId, owners);
    });

    ways.push({
      id: wayId,
      source: 'bdtopo-postgis',
      nodeIds,
      geometry: points,
      name: null,
      importance: parseImportance(row.importance),
      declaredWidthM: row.width_m,
      laneCount: row.lane_count,
      oneWay: oneWayFromSens(row.one_way),
      isPrivate: row.is_private === true,
      limits: {
        maxWeightT: row.restriction_weight_t,
        maxHeightM: row.restriction_height_m,
        maxWidthM: row.restriction_width_m,
        maxLengthM: null,
      },
      tags: row.nature === null ? {} : { nature: row.nature },
    });
  }

  const nodes: RoadNode[] = [...nodePositions].map(([id, at]) => ({
    id,
    at,
    wayIds: nodeWayIds.get(id) ?? [],
    tags: {},
  }));

  return { centre, radiusM, ways, nodes };
}

export function oneWayFromSens(sens: string | null): RoadWay['oneWay'] {
  if (sens === null) return 'no';
  const lower = sens.toLowerCase();
  if (lower.includes('double')) return 'no';
  if (lower.includes('inverse')) return 'backward';
  if (lower.includes('direct')) return 'forward';
  return 'no';
}

function natureMatches(nature: string | null, fragments: readonly string[]): boolean {
  if (nature === null) return false;
  const normalised = nature
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  return fragments.some((fragment) => normalised.includes(fragment));
}

/** Not routed for the truck (the graph drops it at the mapping). */
export function isNonMotorNature(nature: string | null): boolean {
  return natureMatches(nature, NON_MOTOR_NATURE_FRAGMENTS);
}

/** Closed to every motor vehicle, whatever its access field says. */
export function isClosedToAllVehiclesNature(nature: string | null): boolean {
  return natureMatches(nature, CLOSED_TO_ALL_VEHICLES_NATURE_FRAGMENTS);
}

function parseImportance(raw: string | number | null): number | null {
  if (raw === null) return null;
  const value = typeof raw === 'number' ? raw : Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

interface GeoJsonLine {
  readonly type: string;
  readonly coordinates: unknown;
}

/** LineString → one line; MultiLineString → its parts; anything else → none. */
function parseLines(geojson: string): readonly (readonly GeoPoint[])[] {
  let parsed: GeoJsonLine;
  try {
    parsed = JSON.parse(geojson) as GeoJsonLine;
  } catch {
    return [];
  }
  if (parsed.type === 'LineString' && Array.isArray(parsed.coordinates)) {
    return [toPoints(parsed.coordinates)];
  }
  if (parsed.type === 'MultiLineString' && Array.isArray(parsed.coordinates)) {
    return parsed.coordinates
      .filter((part): part is unknown[] => Array.isArray(part))
      .map(toPoints);
  }
  return [];
}

function toPoints(coordinates: readonly unknown[]): readonly GeoPoint[] {
  const out: GeoPoint[] = [];
  for (const entry of coordinates) {
    if (!Array.isArray(entry)) continue;
    const [lon, lat] = entry as [unknown, unknown];
    if (typeof lon !== 'number' || typeof lat !== 'number') continue;
    out.push({ lat, lon });
  }
  return out;
}

/**
 * Endpoint clustering with a metre-scale tolerance.
 *
 * Grid-bucketed so lookup stays linear: a point lands in a cell of roughly
 * `snapM` metres and is compared to candidates in its own and neighbouring
 * cells. First endpoint in a cluster names it; later endpoints within the
 * tolerance adopt that name, which is what makes two BDTOPO segments meeting
 * at a corner share a node id.
 */
class EndpointClusters {
  private readonly cells = new Map<string, { readonly id: string; readonly at: GeoPoint }[]>();
  private counter = 0;

  constructor(private readonly snapM: number) {}

  idFor(point: GeoPoint): string {
    const { key, latIdx, lonIdx } = this.cellOf(point);
    for (let di = -1; di <= 1; di += 1) {
      for (let dj = -1; dj <= 1; dj += 1) {
        const bucket = this.cells.get(`${latIdx + di}:${lonIdx + dj}`);
        if (bucket === undefined) continue;
        for (const existing of bucket) {
          if (metresBetween(existing.at, point) <= this.snapM) return existing.id;
        }
      }
    }
    this.counter += 1;
    const id = `j${this.counter}`;
    const bucket = this.cells.get(key);
    if (bucket === undefined) this.cells.set(key, [{ id, at: point }]);
    else bucket.push({ id, at: point });
    return id;
  }

  private cellOf(point: GeoPoint): { key: string; latIdx: number; lonIdx: number } {
    const mPerDegLat = 111_320;
    const mPerDegLon = mPerDegLat * Math.cos((point.lat * Math.PI) / 180);
    const latIdx = Math.floor((point.lat * mPerDegLat) / this.snapM);
    const lonIdx = Math.floor((point.lon * mPerDegLon) / this.snapM);
    return { key: `${latIdx}:${lonIdx}`, latIdx, lonIdx };
  }
}

function metresBetween(a: GeoPoint, b: GeoPoint): number {
  const mPerDegLat = 111_320;
  const mPerDegLon = mPerDegLat * Math.cos((a.lat * Math.PI) / 180);
  const dLat = (a.lat - b.lat) * mPerDegLat;
  const dLon = (a.lon - b.lon) * mPerDegLon;
  return Math.hypot(dLat, dLon);
}
