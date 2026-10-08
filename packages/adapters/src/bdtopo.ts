/**
 * BDTOPO PostGIS adapter — `RoadGraphPort` over the self-hosted snapshot.
 *
 * The SQL client is injected as a two-method interface rather than a `pg`
 * dependency: the adapter stays testable on canned rows, and the pool, the
 * network tunnel and the connection string are the application's business.
 *
 * Primary source posture (data-assets.md): BDTOPO first, Overpass as the
 * fallback — 8–70 ms per query, no rate limit, and the width/restriction
 * attributes OSM mostly lacks. What BDTOPO lacks in exchange: street
 * furniture (turning-circle nodes, barriers) and names on many segments, so
 * a production composition will merge both.
 */
import type { GeoPoint } from '@teneolog/domain';
import type { RoadGraphPort, RoadNeighbourhood, RoadWay } from '@teneolog/topology';

import {
  mapBdtopoNeighbourhood,
  type BdtopoMappingOptions,
  type BdtopoRoadRow,
} from './bdtopo-mapping.js';

/**
 * ce que l'appelant demande au serveur pour CETTE requête.
 *
 * Un budget, pas une patience : l'implémentation de production
 * (`createBdtopoSqlClient`) le pose en `statement_timeout` sur la connexion,
 * de sorte que le serveur coupe lui-même et rende la connexion. Un client de
 * test qui l'ignore reste un client valide — c'est une demande, pas un
 * contrat de durée.
 */
export interface SqlQueryOptions {
  readonly timeoutMs?: number;
}

/** The slice of a SQL client this adapter needs. `pg.Pool` satisfies it. */
export interface SqlClient {
  query(
    text: string,
    params: readonly unknown[],
    options?: SqlQueryOptions,
  ): Promise<{ readonly rows: readonly unknown[] }>;
}

const BBOX_SAFETY = 1.15;

/** Degrees of padding for a GiST `&&` prefilter. Same formula as address-intel. */
export function bboxPaddingDeg(radiusM: number, atLat: number): number {
  const mPerDegLat = 111_195;
  const mPerDegLon = mPerDegLat * Math.cos((atLat * Math.PI) / 180);
  const tightest = Math.max(1, Math.min(mPerDegLat, mPerDegLon));
  return (radiusM * BBOX_SAFETY) / tightest;
}

/** The columns every query below returns, so the row mapper has one shape. */
const ROAD_COLUMNS = `
  r.id, r.nature, r.importance, r.lane_count, r.width_m, r.one_way,
  r.restriction_height_m, r.restriction_width_m, r.restriction_weight_t,
  r.is_private,
  ST_AsGeoJSON(r.geom) AS geom_geojson
`;

/**
 * Every road within `marginM` of a routed polyline.
 *
 * `ST_DWithin` against a LineString is the exact analogue of Overpass's
 * `around:` along a path — a Minkowski buffer, far tighter than the bounding
 * box of a route that bends. The `&&` prefilter on the expanded bbox is what
 * lets the GiST index do the work; without it the geography distance is
 * evaluated row by row and the statement times out (measured 2026-09-10: a
 * 900 m neighbourhood without the prefilter exceeded the 8 s statement
 * timeout, and 42 ms with it).
 */
/**
 * POURQUOI CES DEUX REQUÊTES SONT TRIÉES (défaut 3 ).
 *
 * Sans `ORDER BY`, PostgreSQL rend les lignes dans l'ordre où il les a
 * trouvées, et cet ordre change d'un plan à l'autre, d'un cache à l'autre,
 * d'un run à l'autre. Or il décide — deux fois :
 *
 * 1. `matchAxis` (`packages/topology/src/attribution.ts:222`) retient le
 *    tronçon donneur le plus proche avec un `<` strict : **à distance égale, le
 *    premier du tableau gagne.** Deux tronçons jumeaux d'une même rue, et c'est
 *    l'ordre des lignes qui choisit le `donorWayId` publié.
 * 2. `mapBdtopoNeighbourhood` numérote les jonctions dans l'ordre des lignes
 *    (`EndpointClusters.idFor`) : les identifiants de nœuds changent avec lui.
 *
 * Le tri est donc `distance, puis identifiant` : la distance parce que c'est la
 * question posée, l'identifiant parce qu'il est unique et qu'il faut bien que
 * l'égalité soit tranchée par quelque chose de stable.
 *
 * `ST_Distance` planaire, et non l'opérateur `<->` : `<->` invite le planificateur
 * à un parcours KNN de l'index, qui est le bon plan pour « les 10 plus proches »
 * et le mauvais pour « toutes celles de la bande », qui est ce qu'on demande.
 * La forme planaire n'ordonne pas en mètres — elle ordonne en degrés — et c'est
 * sans importance : on ne publie pas cette distance, on s'en sert pour que
 * l'égalité ait un arbitre.
 */
const CORRIDOR_SQL = `
WITH l AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom)
SELECT ${ROAD_COLUMNS}
FROM bdtopo.roads r, l
WHERE r.geom && ST_Expand(l.geom, $3)
  AND ST_DWithin(r.geom::geography, l.geom::geography, $2)
ORDER BY ST_Distance(r.geom, l.geom), r.id
`;

const NEIGHBOURHOOD_SQL = `
WITH q AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom)
SELECT ${ROAD_COLUMNS}
FROM bdtopo.roads r, q
WHERE r.geom && ST_Expand(q.geom, $4)
  AND ST_DWithin(r.geom::geography, q.geom::geography, $3)
ORDER BY ST_Distance(r.geom, q.geom), r.id
`;

/**
 * le budget que le donneur donne au serveur, en plus du découpage.
 *
 * `queryTimeoutMs` porte `roadAttributes.donorTimeoutMs` jusqu'au
 * `statement_timeout` de la connexion : c'est ce qui fait que l'abandon de la
 * greffe rend la connexion au lieu de la garder. Absent, le client SQL applique
 * son budget par défaut — et un client de test n'en applique aucun.
 */
export interface BdtopoRoadGraphOptions extends BdtopoMappingOptions {
  readonly queryTimeoutMs?: number;
}

export class BdtopoRoadGraph implements RoadGraphPort {
  constructor(
    private readonly sql: SqlClient,
    private readonly options: BdtopoRoadGraphOptions,
  ) {}

  /** Le budget serveur de chaque requête de ce donneur, ou rien à dire. */
  private budget(): SqlQueryOptions | undefined {
    return this.options.queryTimeoutMs === undefined
      ? undefined
      : { timeoutMs: this.options.queryTimeoutMs };
  }

  async fetchNeighbourhood(centre: GeoPoint, radiusM: number): Promise<RoadNeighbourhood> {
    const result = await this.sql.query(
      NEIGHBOURHOOD_SQL,
      [centre.lon, centre.lat, radiusM, bboxPaddingDeg(radiusM, centre.lat)],
      this.budget(),
    );
    return mapBdtopoNeighbourhood(result.rows as readonly BdtopoRoadRow[], centre, radiusM, this.options);
  }

  /**
   * Every road within `marginM` of `polyline`, as the corridor scan wants it.
   *
   * Structurally a `CorridorPort` without importing one: `packages/routes`
   * declares that interface and depends on this package, so naming it here
   * would invert the dependency. Overpass exposes the same method the same
   * way.
   */
  async fetchCorridor(polyline: readonly GeoPoint[], marginM: number): Promise<readonly RoadWay[]> {
    if (polyline.length < 2) return [];
    const geojson = JSON.stringify({
      type: 'LineString',
      coordinates: polyline.map((p) => [p.lon, p.lat]),
    });
    const midLat = polyline[Math.floor(polyline.length / 2)]?.lat ?? polyline[0]?.lat ?? 0;
    const result = await this.sql.query(
      CORRIDOR_SQL,
      [geojson, marginM, bboxPaddingDeg(marginM, midLat)],
      this.budget(),
    );
    // The centre only labels the neighbourhood; the corridor caller reads ways.
    const anchor = polyline[0] ?? { lat: midLat, lon: 0 };
    return mapBdtopoNeighbourhood(
      result.rows as readonly BdtopoRoadRow[],
      anchor,
      marginM,
      this.options,
    ).ways;
  }
}
