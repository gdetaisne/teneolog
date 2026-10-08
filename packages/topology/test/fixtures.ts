/**
 * Shared fixture helpers: a `RoadNeighbourhood` as a hand-drawn sketch.
 *
 * Node records are derived from the ways so a fixture cannot contradict
 * itself — a node's degree is exactly the number of ways that reference it.
 */
import type { GeoPoint } from '@teneolog/domain';

import type { RoadNeighbourhood, RoadWay } from '../src/ports.js';

const M_PER_DEG_LAT = 111_320;

/** `northM`/`eastM` metres from `base`, so a fixture reads as a sketch. */
export function at(base: GeoPoint, northM: number, eastM: number): GeoPoint {
  return {
    lat: base.lat + northM / M_PER_DEG_LAT,
    lon: base.lon + eastM / (M_PER_DEG_LAT * Math.cos((base.lat * Math.PI) / 180)),
  };
}

export interface WayOverrides {
  readonly name?: string | null;
  readonly importance?: number | null;
  readonly oneWay?: RoadWay['oneWay'];
  readonly isPrivate?: boolean;
  readonly tags?: Record<string, string>;
  /** A donor fixture needs to say who drew it and how wide it says the road is. */
  readonly source?: RoadWay['source'];
  readonly declaredWidthM?: number | null;
  readonly laneCount?: number | null;
}

export function way(
  id: string,
  nodeIds: readonly string[],
  geometry: readonly GeoPoint[],
  overrides: WayOverrides = {},
): RoadWay {
  return {
    id,
    source: overrides.source ?? 'osm-overpass',
    nodeIds,
    geometry,
    name: overrides.name ?? null,
    importance: overrides.importance ?? null,
    declaredWidthM: overrides.declaredWidthM ?? null,
    laneCount: overrides.laneCount ?? null,
    oneWay: overrides.oneWay ?? 'no',
    isPrivate: overrides.isPrivate ?? false,
    limits: { maxWeightT: null, maxHeightM: null, maxWidthM: null, maxLengthM: null },
    tags: overrides.tags ?? {},
  };
}

export function neighbourhood(
  centre: GeoPoint,
  radiusM: number,
  ways: readonly RoadWay[],
): RoadNeighbourhood {
  const positions = new Map<string, GeoPoint>();
  const wayIds = new Map<string, string[]>();
  for (const w of ways) {
    w.nodeIds.forEach((nodeId, index) => {
      const point = w.geometry[index];
      if (point !== undefined) positions.set(nodeId, point);
      const owners = wayIds.get(nodeId) ?? [];
      if (!owners.includes(w.id)) owners.push(w.id);
      wayIds.set(nodeId, owners);
    });
  }
  return {
    centre,
    radiusM,
    ways,
    nodes: [...positions].map(([id, point]) => ({
      id,
      at: point,
      wayIds: wayIds.get(id) ?? [],
      tags: {},
    })),
  };
}

/** The same neighbourhood with tags on the named nodes — a mapper's `highway=turning_loop`, say. */
export function tagged(
  hood: RoadNeighbourhood,
  tagsByNode: Readonly<Record<string, Record<string, string>>>,
): RoadNeighbourhood {
  return {
    ...hood,
    nodes: hood.nodes.map((n) => {
      const tags = tagsByNode[n.id];
      return tags === undefined ? n : { ...n, tags: { ...n.tags, ...tags } };
    }),
  };
}

/**
 * 7 Allée des Essais, 49450 Sèvremoine, as a sketch (run
 * bf60317d). North is up, the stop is the origin.
 *
 *  - `allee`: the impasse, mouth 20 m west of the stop, junction `j` 10 m
 *    east of it, closed tip 40 m east — a DEAD_END;
 *  - `parent`: the through street at the mouth (Rue Voisine MA), both ends
 *    200 m away, beyond any fetch here;
 *  - `other`: the next street (Allée Voisine JC) off the parent 40 m south
 *    of the mouth, ending at `loopOut` (OSM node 801068760) — 45 m as the
 *    crow flies from the stop, 100 m by road, and only through the mouth;
 *  - `stub`: a service way off `j`, 45 m south, ending at `loopIn` — the loop
 *    that belongs to the allée (OSM node 5867769909), 46 m as the crow flies,
 *    55 m by road.
 *
 * The two traps of the run, on purpose: `other` comes BEFORE `stub`, so
 * `loopOut` is first in the node list (as in production), and `loopOut` is
 * the nearer as the crow flies — neither the list order nor the radius picks
 * the right loop; only the road does.
 */
export function sevremoine(O: GeoPoint): readonly RoadWay[] {
  const allee = way('allee', ['mouth', 'j', 'tip'], [at(O, 0, -20), at(O, 0, 10), at(O, 0, 40)], {
    declaredWidthM: 3,
    tags: { highway: 'residential' },
  });
  const parent = way(
    'parent',
    ['p1', 'mouth', 'q', 'p2'],
    [at(O, 200, -20), at(O, 0, -20), at(O, -40, -20), at(O, -200, -20)],
    { tags: { highway: 'residential' } },
  );
  const other = way('other', ['q', 'loopOut'], [at(O, -40, -20), at(O, -40, 20)], {
    tags: { highway: 'residential' },
  });
  const stub = way('stub', ['j', 'loopIn'], [at(O, 0, 10), at(O, -45, 10)], {
    tags: { highway: 'service' },
  });
  return [allee, parent, other, stub];
}
