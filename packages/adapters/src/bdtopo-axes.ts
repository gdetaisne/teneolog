/**
 * la BD TOPO par CLASSE D'IMPORTANCE, pour l'étage axes de S3.
 *
 * Pourquoi une requête de plus plutôt que `fetchNeighbourhood` : le voisinage
 * rend tout ce qui roule dans un disque, et l'étage axes demande jusqu'à
 * 15 km. Autour de Thairé, mesuré le 2026-09-14 à travers le tunnel, la table
 * rend 1 733 tronçons d'importance 2–3 dans les 15 km ; le disque entier en
 * rendrait deux ordres de grandeur de plus, pour n'en garder que ceux-là.
 *
 * Trois bornes, dans cet ordre :
 *  1. le préfiltre `&&` sur la boîte englobante, qui est ce qui fait travailler
 *    l'index GiST (`bdtopo_roads_geom_gix`, le seul index utile de la table) ;
 *  2. `ST_DWithin` en géographie, la vraie distance ;
 *  3. `importance` — texte dans la table, donc comparé après le préfiltre. Sans
 *    index dessus, le filtrer plus tôt ne gagnerait rien.
 *
 * `LIMIT` + `ORDER BY distance` : une requête qui rend exactement son plafond
 * a peut-être laissé quelque chose dehors, et l'appelant le DIT
 * (`AxisFetchReport.truncated`) au lieu de le taire — c'est le
 * `bdtopo_fetch_truncated` de l'engine, avec la même raison.
 *
 * Temps mesurés le 2026-09-14 tunnel réseau vers la PostGIS de
 * prod, autour de Thairé, géométries comprises : voir
 * la note de conception interne
 */
import type { GeoPoint } from '@teneolog/domain';
import type { RoadWay } from '@teneolog/topology';

import { bboxPaddingDeg, type SqlClient, type SqlQueryOptions } from './bdtopo.js';
import { mapBdtopoNeighbourhood, type BdtopoRoadRow } from './bdtopo-mapping.js';

/**
 * Les colonnes utiles à l'étage, et elles seules.
 *
 * `lane_count`, `one_way` et `restriction_height_m` ne servent ni à choisir un
 * axe ni à poser une porte : l'étage lit la géométrie, l'importance, la nature,
 * la largeur, le caractère privé et les deux restrictions qui peuvent écarter
 * une rue locale. Les trois autres sont posées à `null` PAR L'ADAPTATEUR, pas
 * laissées `undefined` : une donnée absente s'affiche comme absente
 * (principe 14), et le type ne doit pas promettre ce que la requête n'a pas
 * demandé.
 */
const AXIS_COLUMNS = `
  r.id, r.nature, r.importance, r.width_m,
  r.restriction_width_m, r.restriction_weight_t, r.is_private,
  ST_AsGeoJSON(r.geom) AS geom_geojson
`;

const AXIS_SQL = `
WITH q AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom)
SELECT ${AXIS_COLUMNS}
FROM bdtopo.roads r, q
WHERE r.geom && ST_Expand(q.geom, $4)
  AND ST_DWithin(r.geom::geography, q.geom::geography, $3)
  AND r.importance ~ '^[0-9]'
  AND left(r.importance, 1)::int BETWEEN $5 AND $6
ORDER BY ST_Distance(r.geom, q.geom), r.id
LIMIT $7
`;

export interface BdtopoAxisSourceOptions {
  /** Même tolérance de jonction que le reste du mapping BD TOPO. */
  readonly junctionSnapM: number;
  /** Budget serveur par requête, posé en `statement_timeout` par le client SQL. */
  readonly queryTimeoutMs?: number;
}

/**
 * `AxisSourcePort` de `@teneolog/routes`, sans l'importer.
 *
 * Même posture que `fetchCorridor` sur `BdtopoRoadGraph` : `packages/routes`
 * déclare l'interface et dépend de ce paquet, donc la nommer ici inverserait
 * la dépendance. La forme est vérifiée au câblage, dans l'API (hors instantané).
 */
export class BdtopoAxisSource {
  constructor(
    private readonly sql: SqlClient,
    private readonly options: BdtopoAxisSourceOptions,
  ) {}

  private budget(): SqlQueryOptions | undefined {
    return this.options.queryTimeoutMs === undefined
      ? undefined
      : { timeoutMs: this.options.queryTimeoutMs };
  }

  async fetchByImportance(
    centre: GeoPoint,
    radiusM: number,
    range: { readonly min: number; readonly max: number },
    limit: number,
  ): Promise<{ readonly ways: readonly RoadWay[]; readonly truncated: boolean }> {
    const result = await this.sql.query(
      AXIS_SQL,
      [
        centre.lon,
        centre.lat,
        radiusM,
        bboxPaddingDeg(radiusM, centre.lat),
        range.min,
        range.max,
        limit,
      ],
      this.budget(),
    );
    const raw = result.rows as readonly AxisRow[];
    const rows = raw.map(completed);
    const neighbourhood = mapBdtopoNeighbourhood(rows, centre, radiusM, {
      junctionSnapM: this.options.junctionSnapM,
    });
    return { ways: neighbourhood.ways, truncated: rows.length >= limit };
  }
}

/** Ce que la requête rend vraiment — un sous-ensemble de `BdtopoRoadRow`. */
type AxisRow = Omit<BdtopoRoadRow, 'lane_count' | 'one_way' | 'restriction_height_m'>;

/** Les trois colonnes non demandées, posées à `null` plutôt que laissées absentes. */
function completed(row: AxisRow): BdtopoRoadRow {
  return { ...row, lane_count: null, one_way: null, restriction_height_m: null };
}
