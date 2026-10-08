/**
 * Overpass payload → RoadNeighbourhood. Pure: the fetch lives next door, the
 * mapping is testable on a captured payload.
 *
 * Mapping rules that carry field knowledge:
 *
 * - `oneway=yes|1|true` is forward, `-1|reverse` is backward, everything else
 *   two-way. A `junction=roundabout` with no oneway stated is implicitly
 *   forward — OSM's own convention, and getting it wrong flips every
 *   roundabout's entry direction.
 * - Legal limits keep the SMALLEST readable value across the tag spellings
 *   (`maxweight`, `maxweight:hgv`, `maxweightrating:hgv`) — the engine's
 *   restriction reader had this rule right and it is preserved as
 *   specification. Non-numeric values (`default`, `none`, `unsigned`) are no
 *   reading, never zero.
 * - `access=private` is recorded, not filtered: a commissioned delivery to a
 *   private way is the normal case.
 * - Node degree is computed over the returned ways. A node's `wayIds` speaks
 *   only for what the payload contains, which is exactly the semantics the
 *   topology stage assumes when it checks interiority against `radiusM`.
 */
import type { GeoPoint } from '@teneolog/domain';
import type { DeclaredLimits, OneWay, RoadNeighbourhood, RoadNode, RoadWay, Surface } from '@teneolog/topology';

export interface OverpassElementGeom {
  readonly lat: number;
  readonly lon: number;
}

export interface OverpassElement {
  readonly type: 'way' | 'node' | 'relation';
  readonly id: number;
  readonly tags?: Readonly<Record<string, string>>;
  readonly nodes?: readonly number[];
  readonly geometry?: readonly OverpassElementGeom[];
  readonly lat?: number;
  readonly lon?: number;
  /** Les membres d'une relation (`out body geom` : avec leur géométrie). */
  readonly members?: readonly {
    readonly type: 'way' | 'node' | 'relation';
    readonly ref: number;
    readonly role: string;
    readonly geometry?: readonly OverpassElementGeom[];
  }[];
}

export interface OverpassPayload {
  readonly elements: readonly OverpassElement[];
  /**
   * Overpass sets this field on timeout / out-of-memory instead of returning a
   * non-2xx status. The response is HTTP 200 and `elements` is empty — it is
   * NOT a valid empty result. Callers must treat any `remark` as an error.
   */
  readonly remark?: string;
}

export function mapRoadNeighbourhood(
  payload: OverpassPayload,
  centre: GeoPoint,
  radiusM: number,
): RoadNeighbourhood {
  const ways: RoadWay[] = [];
  const nodePositions = new Map<string, GeoPoint>();
  const nodeWayIds = new Map<string, string[]>();
  const nodeTags = new Map<string, Readonly<Record<string, string>>>();

  for (const el of payload.elements) {
    if (el.type === 'way' && el.nodes !== undefined && el.geometry !== undefined) {
      // Overpass occasionally returns a way whose geometry array is shorter
      // than its node list (a deleted node mid-history). A misaligned pair
      // would silently shift every vertex, so the way is dropped whole and the
      // fetch's honesty about its own reach covers the gap.
      if (el.nodes.length !== el.geometry.length) continue;

      const id = String(el.id);
      const tags = el.tags ?? {};
      const nodeIds = el.nodes.map(String);
      const geometry = el.geometry.map((g) => ({ lat: g.lat, lon: g.lon }));

      nodeIds.forEach((nodeId, i) => {
        const point = geometry[i];
        if (point === undefined) return;
        nodePositions.set(nodeId, point);
        const owners = nodeWayIds.get(nodeId) ?? [];
        if (!owners.includes(id)) owners.push(id);
        nodeWayIds.set(nodeId, owners);
      });

      ways.push({
        id,
        source: 'osm-overpass',
        nodeIds,
        geometry,
        name: tags['name'] ?? null,
        // OSM has no BDTOPO importance class; the highway tag carries rank.
        importance: null,
        declaredWidthM: parseMetres(tags['width'] ?? tags['est_width']),
        laneCount: parsePositiveInt(tags['lanes']),
        oneWay: parseOneWay(tags),
        isPrivate: tags['access'] === 'private',
        limits: parseLimits(tags),
        tags,
      });
      continue;
    }

    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      const id = String(el.id);
      nodePositions.set(id, { lat: el.lat, lon: el.lon });
      if (el.tags !== undefined) nodeTags.set(id, el.tags);
    }
  }

  const nodes: RoadNode[] = [...nodePositions].map(([id, at]) => ({
    id,
    at,
    wayIds: nodeWayIds.get(id) ?? [],
    tags: nodeTags.get(id) ?? {},
  }));

  return { centre, radiusM, ways, nodes };
}

const SURFACE_KIND: ReadonlyArray<readonly [tag: string, value: string, kind: Surface['kind']]> = [
  ['amenity', 'parking', 'parking'],
  ['place', 'square', 'square'],
  ['area:highway', '*', 'area_highway'],
];

export function mapSurfaces(payload: OverpassPayload): readonly Surface[] {
  const out: Surface[] = [];
  for (const el of payload.elements) {
    if (el.type !== 'way' || el.geometry === undefined) continue;
    const tags = el.tags ?? {};
    const kind = surfaceKindOf(tags);
    if (kind === null) continue;
    // Only closed ways describe an area; an open "parking" way is an entrance
    // or an aisle, which has no measurable footprint.
    const first = el.geometry[0];
    const last = el.geometry[el.geometry.length - 1];
    if (first === undefined || last === undefined) continue;
    if (first.lat !== last.lat || first.lon !== last.lon) continue;

    out.push({
      id: String(el.id),
      kind,
      polygon: el.geometry.map((g) => ({ lat: g.lat, lon: g.lon })),
      isPrivate: tags['access'] === 'private' || tags['access'] === 'customers',
      source: 'osm-overpass',
    });
  }
  return out;
}

function surfaceKindOf(tags: Readonly<Record<string, string>>): Surface['kind'] | null {
  for (const [tag, value, kind] of SURFACE_KIND) {
    const actual = tags[tag];
    if (actual === undefined) continue;
    if (value === '*' || actual === value) return kind;
  }
  return null;
}

function parseOneWay(tags: Readonly<Record<string, string>>): OneWay {
  const raw = tags['oneway'];
  if (raw === 'yes' || raw === '1' || raw === 'true') return 'forward';
  if (raw === '-1' || raw === 'reverse') return 'backward';
  if (raw === 'no' || raw === '0' || raw === 'false') return 'no';
  // OSM convention: an unstated oneway on a roundabout ring means forward.
  if (raw === undefined && tags['junction'] === 'roundabout') return 'forward';
  return 'no';
}

function parseLimits(tags: Readonly<Record<string, string>>): DeclaredLimits {
  return {
    maxWeightT: smallest([
      parseTonnes(tags['maxweight:hgv']),
      parseTonnes(tags['maxweightrating:hgv']),
      parseTonnes(tags['maxweight']),
    ]),
    maxHeightM: smallest([parseMetres(tags['maxheight']), parseMetres(tags['maxheight:physical'])]),
    maxWidthM: smallest([parseMetres(tags['maxwidth']), parseMetres(tags['maxwidth:physical'])]),
    maxLengthM: parseMetres(tags['maxlength']),
  };
}

function smallest(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : Math.min(...known);
}

/** `3.5`, `3,5`, `3.5 m`, `3.5m`. `default`/`none`/`unsigned` are no reading. */
function parseMetres(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*m?\s*$/.exec(raw);
  if (match === null || match[1] === undefined) return null;
  const value = Number.parseFloat(match[1].replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** `3.5`, `3,5`, `3.5 t`, `3.5t`. Imperial spellings are rare in FR and skipped. */
function parseTonnes(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*t?\s*$/.exec(raw);
  if (match === null || match[1] === undefined) return null;
  const value = Number.parseFloat(match[1].replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}
