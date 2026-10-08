/**
 * L'ORDRE DES LIGNES DÉCIDE, DONC IL SE TRIE (défaut 3 ).
 *
 * Sans `ORDER BY`, PostgreSQL rend les lignes dans l'ordre où il les a
 * trouvées, et cet ordre change d'un plan à l'autre, d'un cache à l'autre,
 * d'un run à l'autre. Or il décide deux fois :
 *
 * 1. `matchAxis` (`packages/topology/src/attribution.ts:222`) retient le
 *    tronçon donneur le plus proche avec un `<` strict — **à distance égale, le
 *    premier du tableau gagne**, donc le `donorWayId` publié change d'un run à
 *    l'autre sans que rien n'ait bougé sur le terrain.
 * 2. `mapBdtopoNeighbourhood` numérote les jonctions dans l'ordre des lignes
 *    (`EndpointClusters.idFor`) : les identifiants de nœuds suivent.
 */
import { describe, expect, it } from 'vitest';

import type { BdtopoRoadRow } from '../src/bdtopo-mapping.js';
import { BdtopoRoadGraph, type SqlClient } from '../src/bdtopo.js';

const THAIRE = { lat: 46.0735, lon: -0.9654 };

function spySql(rows: readonly BdtopoRoadRow[]): SqlClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async query(text) {
      asked.push(text);
      return { rows };
    },
  };
}

/** Deux tronçons jumeaux : même rue, même largeur, identifiants différents. */
function row(id: string, eastDeg: number, widthM: number): BdtopoRoadRow {
  return {
    id,
    nature: 'Route à 1 chaussée',
    importance: '5',
    lane_count: 1,
    width_m: widthM,
    one_way: 'Double sens',
    restriction_height_m: null,
    restriction_width_m: null,
    restriction_weight_t: null,
    is_private: false,
    geom_geojson: JSON.stringify({
      type: 'LineString',
      coordinates: [
        [THAIRE.lon + eastDeg, THAIRE.lat - 0.0005],
        [THAIRE.lon + eastDeg, THAIRE.lat + 0.0005],
      ],
    }),
  };
}

describe('BdtopoRoadGraph — l\u2019ordre des lignes', () => {
  it('trie le corridor par distance puis par identifiant', () => {
    // `r.id` est l'arbitre de l'égalité : sans lui, deux tronçons à la même
    // distance restent dans un ordre que le planificateur choisit.
    const sql = spySql([]);
    void new BdtopoRoadGraph(sql, { junctionSnapM: 2 }).fetchCorridor(
      [THAIRE, { lat: THAIRE.lat + 0.001, lon: THAIRE.lon }],
      30,
    );

    expect(sql.asked[0]).toContain('ORDER BY ST_Distance(r.geom, l.geom), r.id');
  });

  it('trie le voisinage par distance puis par identifiant', () => {
    const sql = spySql([]);
    void new BdtopoRoadGraph(sql, { junctionSnapM: 2 }).fetchNeighbourhood(THAIRE, 80);

    expect(sql.asked[0]).toContain('ORDER BY ST_Distance(r.geom, q.geom), r.id');
  });

  it('n’ordonne pas avec l’opérateur `<->`, qui appellerait un parcours KNN', () => {
    // `<->` est le bon plan pour « les 10 plus proches » et le mauvais pour
    // « toutes celles de la bande », qui est la question posée ici. Le
    // prefiltre `&&` sur la bbox élargie doit rester ce qui fait le travail
    // (mesuré 2026-09-10 : 42 ms avec, dépassement du délai sans).
    const sql = spySql([]);
    void new BdtopoRoadGraph(sql, { junctionSnapM: 2 }).fetchNeighbourhood(THAIRE, 80);

    expect(sql.asked[0]).toContain('&& ST_Expand(');
    expect(sql.asked[0]).not.toContain('<->');
  });

  it('rend les voies DANS L’ORDRE du serveur — c’est donc bien le tri qui décide', async () => {
    // La propriété qui rend l'`ORDER BY` utile : le mappeur ne réordonne rien.
    // Si le serveur change d'avis, le tableau change, et avec lui le tronçon
    // qui gagne une égalité de distance.
    const rows = [row('TRONROUT-A', 0, 5.2), row('TRONROUT-B', 0.00002, 5.2)];
    const graph = new BdtopoRoadGraph(spySql(rows), { junctionSnapM: 2 });
    const reversed = new BdtopoRoadGraph(spySql([...rows].reverse()), { junctionSnapM: 2 });

    const asGiven = (await graph.fetchNeighbourhood(THAIRE, 80)).ways.map((w) => w.id);
    const asReversed = (await reversed.fetchNeighbourhood(THAIRE, 80)).ways.map((w) => w.id);

    expect(asGiven).toEqual(['TRONROUT-A', 'TRONROUT-B']);
    expect(asReversed).toEqual(['TRONROUT-B', 'TRONROUT-A']);
  });

});
