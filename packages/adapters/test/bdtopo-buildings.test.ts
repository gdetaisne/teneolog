/**
 * la requête bâtiments : le SQL est figé, le mapping est
 * vérifié, et les seuils de cadre sont rejoués sur les mêmes cas que le
 * chargeur (l'API (hors instantané), 117-120`). Aucune base :
 * le client SQL est un bouchon, c'est tout l'intérêt de l'avoir injecté.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  BdtopoBuildings,
  classifyHousing,
  classifySetting,
  isUrbanSetting,
  mapBuildingsRow,
  type BdtopoBuildingsOptions,
} from '../src/bdtopo-buildings.js';
import { DEFAULT_STATEMENT_GRACE_MS } from '../src/bdtopo-pool.js';
import type { SqlClient, SqlQueryOptions } from '../src/bdtopo.js';

const OPTIONS: BdtopoBuildingsOptions = {
  densityRadiusM: 200,
  buildingRadiusM: 40,
  timeoutMs: 1_500,
};

const THAIRE = { lat: 46.0874, lon: -0.9660 };

interface SqlCall {
  readonly text: string;
  readonly params: readonly unknown[];
  readonly options: SqlQueryOptions | undefined;
}

function stubSql(rows: readonly unknown[]): SqlClient & { calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  return {
    calls,
    query(text: string, params: readonly unknown[], options?: SqlQueryOptions) {
      calls.push({ text, params, options });
      return Promise.resolve({ rows });
    },
  };
}

describe('classifySetting — les seuils du chargeur, rejoués', () => {
  // Les mêmes bornes que `constants.ts:18-21`, testées de part et d'autre.
  it.each([
    [0.55, 'dense'],
    [0.4, 'dense'],
    [0.399, 'urbain'],
    [0.3, 'urbain'],
    [0.299, 'bourg'],
    [0.2, 'bourg'],
    [0.199, 'periurbain'],
    [0.12, 'periurbain'],
    [0.119, 'rural'],
    [0, 'rural'],
  ])('%s → %s', (ratio, kind) => {
    expect(classifySetting(ratio as number)).toBe(kind);
  });

  it('sans part bâtie, le cadre est inconnu — jamais « rural » par défaut', () => {
    expect(classifySetting(null)).toBe('inconnu');
    expect(classifySetting(Number.NaN)).toBe('inconnu');
  });

  it('un bourg compte comme urbain, comme chez le chargeur', () => {
    expect(isUrbanSetting('bourg')).toBe(true);
    expect(isUrbanSetting('periurbain')).toBe(false);
    expect(isUrbanSetting('rural')).toBe(false);
    expect(isUrbanSetting('inconnu')).toBe(false);
  });
});

describe('classifyHousing — le seuil pavillon du chargeur', () => {
  it.each([
    [137, 'maison'],
    [199, 'maison'],
    [200, 'immeuble'],
    [12_303, 'immeuble'],
  ])('%s m² → %s', (area, kind) => {
    expect(classifyHousing(area as number)).toBe(kind);
  });

  it('sans emprise, le type est inconnu', () => {
    expect(classifyHousing(null)).toBe('inconnu');
    expect(classifyHousing(0)).toBe('inconnu');
  });
});

describe('mapBuildingsRow', () => {
  it('assemble cadre, logement et bâtiment depuis une ligne (cas Thairé)', () => {
    const insight = mapBuildingsRow(
      { n: 362, built_m2: 34_970, nature: 'Indifférenciée', area_m2: 137.4, distance_m: 1.93 },
      OPTIONS,
      42,
    );
    expect(insight.setting.kind).toBe('bourg');
    expect(insight.setting.builtRatio).toBeCloseTo(34_970 / (Math.PI * 200 * 200), 6);
    expect(insight.setting.buildingCount).toBe(362);
    expect(insight.housing).toEqual({ kind: 'maison', footprintM2: 137 });
    expect(insight.building).toEqual({ distanceM: 1.93, nature: 'Indifférenciée', source: 'bdtopo' });
    expect(insight.queryMs).toBe(42);
    expect(insight.densityRadiusM).toBe(200);
  });

  it('un gros bâti commercial est un immeuble (cas Auxerre)', () => {
    const insight = mapBuildingsRow(
      {
        n: 195,
        built_m2: 34_690,
        nature: 'Industriel, agricole ou commercial',
        area_m2: 12_303,
        distance_m: 5.9,
      },
      OPTIONS,
      51,
    );
    expect(insight.housing.kind).toBe('immeuble');
    expect(insight.building.nature).toBe('Industriel, agricole ou commercial');
  });

  it('aucun bâtiment dans le rayon : distance nulle plutôt que zéro', () => {
    // Zéro dirait « le point est POSÉ sur le bâtiment » — l'inverse de la vérité.
    const insight = mapBuildingsRow(
      { n: 3, built_m2: 900, nature: null, area_m2: null, distance_m: null },
      OPTIONS,
      12,
    );
    expect(insight.housing).toEqual({ kind: 'inconnu', footprintM2: null });
    expect(insight.building.distanceM).toBeNull();
    expect(insight.building.nature).toBeNull();
    // Le cadre, lui, reste mesuré : 900 m² sur le disque, c'est rural.
    expect(insight.setting.kind).toBe('rural');
    expect(insight.setting.buildingCount).toBe(3);
  });

  it('les agrégats Postgres rendus en texte sont lus comme des nombres', () => {
    const insight = mapBuildingsRow(
      { n: '362', built_m2: '34970', nature: 'Indifférenciée', area_m2: '137.4', distance_m: '1.93' },
      OPTIONS,
      1,
    );
    expect(insight.setting.buildingCount).toBe(362);
    expect(insight.housing.footprintM2).toBe(137);
  });

  it('une ligne absente reste un objet honnête, pas une exception', () => {
    const insight = mapBuildingsRow(undefined, OPTIONS, 5);
    expect(insight.setting.kind).toBe('rural');
    expect(insight.setting.buildingCount).toBe(0);
    expect(insight.housing.kind).toBe('inconnu');
  });
});

describe('BdtopoBuildings — un seul aller-retour', () => {
  it('interroge la base UNE fois et rend le cadre et le bâtiment ensemble', async () => {
    const sql = stubSql([
      { n: 362, built_m2: 34_970, nature: 'Indifférenciée', area_m2: 137.4, distance_m: 1.93 },
    ]);
    const reading = await new BdtopoBuildings(sql, OPTIONS).lookup(THAIRE);

    expect(sql.calls).toHaveLength(1);
    expect(reading.known).toBe(true);
    if (!reading.known) throw new Error('unreachable');
    expect(reading.value.setting.kind).toBe('bourg');
    expect(reading.value.housing.kind).toBe('maison');
  });

  it('le SQL porte les deux agrégats et le prefiltre bbox des deux rayons', () => {
    const sql = stubSql([]);
    void new BdtopoBuildings(sql, OPTIONS).lookup(THAIRE);
    const text = sql.calls[0]?.text ?? '';
    expect(text).toContain('WITH q AS');
    expect(text).toContain('env AS');
    expect(text).toContain('near AS');
    expect(text).toContain('LEFT JOIN near ON true');
    // Sans le `&&`, l'index GiST ne sert pas et la requête dépasse le timeout.
    expect(text.match(/ST_Expand\(q\.geom/g)).toHaveLength(2);
    expect(text).toContain('ORDER BY b.geom <-> q.geom');
  });

  it('passe lon puis lat, les deux rayons et leurs marges de bbox', async () => {
    const sql = stubSql([{ n: 0, built_m2: 0, nature: null, area_m2: null, distance_m: null }]);
    await new BdtopoBuildings(sql, OPTIONS).lookup(THAIRE);
    const params = sql.calls[0]?.params ?? [];
    expect(params[0]).toBe(THAIRE.lon);
    expect(params[1]).toBe(THAIRE.lat);
    expect(params[2]).toBe(200);
    expect(params[4]).toBe(40);
    expect(params[3] as number).toBeGreaterThan(params[5] as number);
  });

  it('au-delà du minuteur, un inconnu daté — pas une attente', async () => {
    // le minuteur est passé de lame à filet : il tombe à
    // `timeoutMs + DEFAULT_STATEMENT_GRACE_MS`, au-dessus du budget que le
    // serveur a reçu, pour ne jamais abandonner une requête qui n'a pas encore
    // été annulée. Ce client-là ignore le budget : c'est le filet qui sert.
    vi.useFakeTimers();
    try {
      const slow: SqlClient = { query: () => new Promise(() => {}) };
      const port = new BdtopoBuildings(slow, { ...OPTIONS, timeoutMs: 50 });
      const pending = port.lookup(THAIRE);
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(DEFAULT_STATEMENT_GRACE_MS + 10);
      const reading = await pending;
      expect(reading).toMatchObject({ known: false, why: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('emporte son budget jusqu’au client SQL — même pool que la greffe', async () => {
    // cette requête partage la pool de `bdtopo.ts`. elle
    // doit donc partager la discipline, sans quoi une requête bâtiments
    // abandonnée immobiliserait une connexion dont la greffe a besoin.
    const sql = stubSql([{ n: 0, built_m2: 0 }]);
    await new BdtopoBuildings(sql, OPTIONS).lookup(THAIRE);

    expect(sql.calls[0]?.options).toEqual({ timeoutMs: 1_500 });
  });

  it('la coupe du serveur rend `timeout`, pas `provider_error`', async () => {
    // 57014 : le serveur a coupé à l'échéance qu'on lui a donnée. Ce n'est pas
    // la même nouvelle qu'une base muette, et l'onglet n'en dit pas la même
    // chose.
    const canceled: SqlClient = {
      query: () =>
        Promise.reject(
          Object.assign(new Error('canceling statement due to statement timeout'), {
            code: '57014',
          }),
        ),
    };
    const reading = await new BdtopoBuildings(canceled, OPTIONS).lookup(THAIRE);
    expect(reading).toMatchObject({ known: false, why: 'timeout' });
  });

  it('une base muette rend provider_error, jamais une exception', async () => {
    const broken: SqlClient = { query: () => Promise.reject(new Error('ECONNREFUSED')) };
    const reading = await new BdtopoBuildings(broken, OPTIONS).lookup(THAIRE);
    expect(reading).toMatchObject({ known: false, why: 'provider_error' });
  });
});
