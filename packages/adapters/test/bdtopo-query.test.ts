/**
 * LE BUDGET QUE LE DONNEUR DONNE AU SERVEUR.
 *
 * `roadAttributes.donorTimeoutMs` n'a de sens que s'il arrive jusqu'au client
 * SQL, qui seul peut le poser en `statement_timeout` sur la connexion. Sans ce
 * passage de relais, le donneur redeviendrait ce qu'il était : une requête
 * qu'on abandonne sans l'annuler, et une connexion prise pour rien
 * (la note de conception interne).
 */
import { describe, expect, it } from 'vitest';

import { BdtopoRoadGraph, type SqlClient, type SqlQueryOptions } from '../src/bdtopo.js';

const THAIRE = { lat: 46.0735, lon: -0.9654 };

interface Asked {
  readonly text: string;
  readonly params: readonly unknown[];
  readonly options: SqlQueryOptions | undefined;
}

function spySql(rows: readonly unknown[]): SqlClient & { asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    async query(text, params, options) {
      asked.push({ text, params, options });
      return { rows };
    },
  };
}

describe('BdtopoRoadGraph — la requête', () => {
  it('emporte son budget jusqu’au client SQL, corridor comme voisinage', async () => {
    // Sans ce passage de relais, `createBdtopoSqlClient` appliquerait son
    // budget par défaut et `donorTimeoutMs` ne voudrait plus rien dire.
    const sql = spySql([]);
    const graph = new BdtopoRoadGraph(sql, { junctionSnapM: 2, queryTimeoutMs: 2_500 });

    await graph.fetchNeighbourhood(THAIRE, 80);
    await graph.fetchCorridor([THAIRE, { lat: THAIRE.lat + 0.001, lon: THAIRE.lon }], 30);

    expect(sql.asked.map((a) => a.options)).toEqual([{ timeoutMs: 2_500 }, { timeoutMs: 2_500 }]);
  });

  it('sans budget déclaré, ne demande rien — le client SQL décide', async () => {
    const sql = spySql([]);
    await new BdtopoRoadGraph(sql, { junctionSnapM: 2 }).fetchNeighbourhood(THAIRE, 80);

    expect(sql.asked[0]?.options).toBeUndefined();
  });
});
