/**
 * qui touche qui, par les BOUTS, à importance égale.
 *
 * Sorti de `axes-network.ts` : la grille imbrique quatre boucles (les tronçons,
 * leurs deux bouts, les neuf cases voisines, les bouts de chaque case) et
 * touchait deux bornes du cliquet à la fois (principe 26). La coupure est celle
 * du sujet — ici on noue le graphe, là-bas on choisit les axes.
 *
 * POURQUOI LES BOUTS ET NON TOUS LES SOMMETS. L'engine compare les 60 m entre
 * TOUTES les paires de sommets de toutes les paires de tronçons
 * (`minVertexDistanceMeters`) : à 15 km le corpus rend 1 733 tronçons, soit
 * 1,5 million de paires. Or la BD TOPO ne raccorde qu'aux bouts — c'est dit
 * dans `packages/adapters/src/bdtopo-mapping.ts` (« Only endpoints can be
 * junctions in BDTOPO's model ») et c'est ce que fait déjà `EndpointClusters`
 * au moment de fabriquer les nœuds. Même seuil, même graphe, temps linéaire.
 */
import type { GeoPoint } from '@teneolog/domain';
import { haversineM, type RoadWay } from '@teneolog/topology';

/** Deux bouts plus proches que ça, à importance égale, sont le même axe. */
const AXIS_LINK_GAP_M = 60;

interface Endpoint {
  readonly wayId: string;
  readonly at: GeoPoint;
  readonly importance: number;
}

/** Les deux bouts d'une voie, avec son importance. Une voie sans géométrie n'en a pas. */
function endpointsOf(way: RoadWay): readonly Endpoint[] {
  const first = way.geometry[0];
  const last = way.geometry[way.geometry.length - 1];
  const importance = way.importance;
  if (first === undefined || last === undefined || importance === null) return [];
  const head = { wayId: way.id, at: first, importance };
  return way.geometry.length < 2 ? [head] : [head, { wayId: way.id, at: last, importance }];
}

const M_PER_DEG_LAT = 111_320;

/** La case de la grille d'un point, décalée de `(di, dj)`. */
function cellKey(at: GeoPoint, di: number, dj: number): string {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((at.lat * Math.PI) / 180);
  const i = Math.floor((at.lat * M_PER_DEG_LAT) / AXIS_LINK_GAP_M) + di;
  const j = Math.floor((at.lon * mPerDegLon) / AXIS_LINK_GAP_M) + dj;
  return `${i}:${j}`;
}

/** Les bouts déjà posés dans les neuf cases autour d'un point. */
function neighboursOf(
  cells: ReadonlyMap<string, Endpoint[]>,
  at: GeoPoint,
): readonly Endpoint[] {
  const found: Endpoint[] = [];
  for (let di = -1; di <= 1; di += 1) {
    for (let dj = -1; dj <= 1; dj += 1) {
      found.push(...(cells.get(cellKey(at, di, dj)) ?? []));
    }
  }
  return found;
}

/** Le graphe des voies qui se touchent : une liste d'identifiants par identifiant. */
export function endpointAdjacency(ways: readonly RoadWay[]): ReadonlyMap<string, readonly string[]> {
  const cells = new Map<string, Endpoint[]>();
  const linked = new Map<string, Set<string>>();

  for (const way of ways) {
    linked.set(way.id, new Set());
    for (const endpoint of endpointsOf(way)) {
      for (const other of neighboursOf(cells, endpoint.at)) {
        if (touches(endpoint, other)) link(linked, endpoint.wayId, other.wayId);
      }
      const key = cellKey(endpoint.at, 0, 0);
      const bucket = cells.get(key);
      if (bucket === undefined) cells.set(key, [endpoint]);
      else bucket.push(endpoint);
    }
  }

  return new Map([...linked].map(([id, set]) => [id, [...set]]));
}

function touches(a: Endpoint, b: Endpoint): boolean {
  return a.wayId !== b.wayId && a.importance === b.importance && haversineM(a.at, b.at) <= AXIS_LINK_GAP_M;
}

function link(linked: Map<string, Set<string>>, a: string, b: string): void {
  linked.get(a)?.add(b);
  linked.get(b)?.add(a);
}
