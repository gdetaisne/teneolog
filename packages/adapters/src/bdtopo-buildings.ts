/**
 * le cadre bâti et le bâtiment le plus proche, en UNE
 * requête PostGIS sur la BD TOPO bâti.
 *
 * Pourquoi un module de plus alors que `bdtopo-site.ts` sait déjà faire les
 * deux : parce qu'il les fait en DEUX allers-retours (`fetchBuiltEnvironment`
 * + `fetchNearestBuilding`). Ici les deux agrégats sont deux CTE sur le même
 * point et le même index GiST, et le serveur ne répond qu'une fois. Sur le
 * chemin de `/user` la requête tourne DERRIÈRE la première réponse
 * (`compat.ts`, bloc asynchrone) : le coût vu par l'opérateur est nul.
 *
 * Les seuils ne sont pas inventés ici : ce sont exactement ceux du chargeur,
 * recopiés avec leur origine —
 * `classifySetting` : l'API (hors instantané)`
 * seuils de cadre : l'API (hors instantané)`
 * `classifyHousing` : l'API (hors instantané)`
 * seuil pavillon : l'API (hors instantané)`
 * rayons 200 m / 40 m: l'API (hors instantané)`
 *
 * CE QUE LA TABLE NE PORTE PAS. Relevé sur la base de prod le 2026-09-11 :
 * `bdtopo.buildings` a trois colonnes, `id`, `nature`, `geom`. Ni `NB_ETAGES`,
 * ni `HAUTEUR`, ni `USAGE1`, ni `DATE_APP` n'ont survécu à l'ingestion. Le
 * nombre de niveaux et l'époque de construction n'ont donc AUCUN producteur,
 * et ce module se garde de les déclarer : un champ toujours nul est
 * exactement le « champ fantôme » que la fiche d'étage reproche au reste du
 * fil (S1-S2-arret.md §8.A). Les rétablir se fait à l'ingestion, pas ici.
 */
import type { GeoPoint } from '@teneolog/domain';

import {
  fetchBuildingRings,
  type BuildingRingsOptions,
  type BuildingRingsPort,
  type BuildingRingsReading,
} from './bdtopo-building-rings.js';
import {
  fetchStopSurroundings,
  type StopSurroundingsPort,
  type StopSurroundingsReading,
  type StopSurroundingsRequest,
} from './bdtopo-stop-surroundings.js';
import { DEFAULT_STATEMENT_GRACE_MS, isStatementTimeout } from './bdtopo-pool.js';
import { bboxPaddingDeg, type SqlClient } from './bdtopo.js';

/** Le vocabulaire du chargeur, mot pour mot (`deliverability-contract/src/enums.ts:94-101`). */
export type BuildingsSettingKind = 'dense' | 'urbain' | 'bourg' | 'periurbain' | 'rural' | 'inconnu';

/** Idem (`deliverability-contract/src/enums.ts:104`). */
export type BuildingsHousingKind = 'maison' | 'immeuble' | 'inconnu';

/** `constants.ts:18-21` — la part bâtie du disque, du plus dense au plus vide. */
export const SETTING_DENSE_MIN_RATIO = 0.4;
export const SETTING_URBAN_MIN_RATIO = 0.3;
export const SETTING_BOURG_MIN_RATIO = 0.2;
export const SETTING_PERIURBAN_MIN_RATIO = 0.12;
/** `constants.ts:16` — au-dessus, ce n'est plus un pavillon. */
export const PAVILLON_MAX_AREA_M2 = 200;

export interface BuildingsInsight {
  readonly setting: {
    readonly kind: BuildingsSettingKind;
    /** Part du disque de `densityRadiusM` couverte par une emprise bâtie. */
    readonly builtRatio: number | null;
    readonly buildingCount: number;
  };
  readonly housing: {
    readonly kind: BuildingsHousingKind;
    /** L'emprise au sol du bâtiment le plus proche — le nombre derrière `kind`. */
    readonly footprintM2: number | null;
  };
  readonly building: {
    /** Distance du point de livraison au bâti le plus proche. Null : aucun bâtiment dans le rayon. */
    readonly distanceM: number | null;
    /** Nature BD TOPO : neuf fois sur dix « Indifférenciée », mais les 10 % restants parlent. */
    readonly nature: string | null;
    readonly source: 'bdtopo';
  };
  /** Le temps réel de l'aller-retour, publié pour que l'onglet puisse le montrer. */
  readonly queryMs: number;
  readonly densityRadiusM: number;
  readonly buildingRadiusM: number;
}

/**
 * Volontairement PAS un `Fact<T>` du domaine : `Fact.why` est une
 * `UnknownReason` fermée (`no_data` | `provider_error` | …) et les causes
 * utiles ici — « pas de BD TOPO configurée », « le minuteur a coupé » — n'y
 * sont pas. Élargir l'enum du domaine pour un fait d'affichage coûterait plus
 * cher que cette enveloppe de deux lignes.
 */
export type BuildingsReading =
  | { readonly known: true; readonly value: BuildingsInsight }
  | { readonly known: false; readonly why: BuildingsUnknown; readonly queryMs: number | null };

export type BuildingsUnknown = 'no_bdtopo' | 'timeout' | 'provider_error';

export interface BuildingsPort {
  /** Une passe : cadre bâti et bâtiment le plus proche autour du point de livraison. */
  lookup(centre: GeoPoint): Promise<BuildingsReading>;
}

export interface BdtopoBuildingsOptions {
  /** Rayon du disque sur lequel se mesure `builtRatio` (chargeur : 200 m). */
  readonly densityRadiusM: number;
  /** Rayon de recherche du bâtiment le plus proche (chargeur : 40 m). */
  readonly buildingRadiusM: number;
  /** Au-delà, on rend `timeout` plutôt que de faire attendre l'enrichissement. */
  readonly timeoutMs: number;
}

/**
 * Les deux agrégats en une passe. `q` est évalué une fois et sert aux deux
 * CTE ; `env` est une agrégation sans GROUP BY, donc toujours exactement une
 * ligne — le LEFT JOIN garantit un résultat même quand aucun bâtiment n'entre
 * dans `buildingRadiusM`. Le prefiltre `&&` sur la bbox élargie est ce qui
 * laisse l'index GiST faire le travail (même raison qu'en `bdtopo.ts`).
 */
const BUILDINGS_SQL = `
WITH q AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom),
env AS (
  SELECT count(*)::int AS n,
         coalesce(sum(ST_Area(b.geom::geography)), 0)::float8 AS built_m2
  FROM bdtopo.buildings b, q
  WHERE b.geom && ST_Expand(q.geom, $4)
    AND ST_DWithin(b.geom::geography, q.geom::geography, $3)
),
near AS (
  SELECT b.nature AS nature,
         ST_Area(b.geom::geography) AS area_m2,
         ST_Distance(b.geom::geography, q.geom::geography) AS distance_m
  FROM bdtopo.buildings b, q
  WHERE b.geom && ST_Expand(q.geom, $6)
    AND ST_DWithin(b.geom::geography, q.geom::geography, $5)
  ORDER BY b.geom <-> q.geom
  LIMIT 1
)
SELECT env.n, env.built_m2, near.nature, near.area_m2, near.distance_m
FROM env LEFT JOIN near ON true
`;

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `rules.ts:66-73` du chargeur, à la ligne près. */
export function classifySetting(builtRatio: number | null): BuildingsSettingKind {
  if (builtRatio === null || !Number.isFinite(builtRatio)) return 'inconnu';
  if (builtRatio >= SETTING_DENSE_MIN_RATIO) return 'dense';
  if (builtRatio >= SETTING_URBAN_MIN_RATIO) return 'urbain';
  if (builtRatio >= SETTING_BOURG_MIN_RATIO) return 'bourg';
  if (builtRatio >= SETTING_PERIURBAN_MIN_RATIO) return 'periurbain';
  return 'rural';
}

/** `rules.ts:117-120` du chargeur, à la ligne près. */
export function classifyHousing(areaM2: number | null): BuildingsHousingKind {
  if (areaM2 === null || areaM2 <= 0) return 'inconnu';
  return areaM2 < PAVILLON_MAX_AREA_M2 ? 'maison' : 'immeuble';
}

/**
 * `rules.ts:75-77` du chargeur — un bourg compte comme urbain. C'est contre
 * l'intuition (un village n'est pas une ville) et c'est pourtant la règle
 * qu'il faut reprendre telle quelle : la question posée n'est pas « est-ce
 * une ville » mais « y a-t-il du monde autour quand le camion bloque la rue ».
 */
export function isUrbanSetting(kind: BuildingsSettingKind): boolean {
  return kind === 'dense' || kind === 'urbain' || kind === 'bourg';
}

/** La ligne du milieu : des lignes SQL à l'objet publié. Testable sans base. */
export function mapBuildingsRow(
  row: Record<string, unknown> | undefined,
  options: BdtopoBuildingsOptions,
  queryMs: number,
): BuildingsInsight {
  const count = row === undefined ? 0 : (toNumber(row['n']) ?? 0);
  const builtAreaM2 = row === undefined ? 0 : (toNumber(row['built_m2']) ?? 0);
  const discM2 = Math.PI * options.densityRadiusM * options.densityRadiusM;
  const builtRatio = discM2 > 0 ? builtAreaM2 / discM2 : null;

  const rawArea = row === undefined ? null : toNumber(row['area_m2']);
  const footprintM2 = rawArea === null || rawArea <= 0 ? null : Math.round(rawArea);
  const distanceM = row === undefined ? null : toNumber(row['distance_m']);
  const nature = typeof row?.['nature'] === 'string' ? (row['nature'] as string) : null;

  return {
    setting: { kind: classifySetting(builtRatio), builtRatio, buildingCount: count },
    housing: { kind: classifyHousing(footprintM2), footprintM2 },
    building: {
      // Pas d'emprise dans le rayon ⇒ pas de distance : un 0 voudrait dire
      // « le point est sur le bâtiment », qui est l'inverse de la vérité.
      distanceM: footprintM2 === null ? null : distanceM,
      nature: footprintM2 === null ? null : nature,
      source: 'bdtopo',
    },
    queryMs,
    densityRadiusM: options.densityRadiusM,
    buildingRadiusM: options.buildingRadiusM,
  };
}

export class BdtopoBuildings implements BuildingsPort, BuildingRingsPort, StopSurroundingsPort {
  constructor(
    private readonly sql: SqlClient,
    private readonly options: BdtopoBuildingsOptions,
  ) {}

  /**
   * les emprises du bâti pour la carte du demi-tour
   * (`bdtopo-building-rings.ts`) : même client, même pool, même délai que le
   * cadre bâti — c'est ce qui permet de la brancher sans toucher à
   * `buildPorts` (gelée, principe 26).
   */
  rings(centre: GeoPoint, options: BuildingRingsOptions): Promise<BuildingRingsReading> {
    return fetchBuildingRings(this.sql, centre, { ...options, timeoutMs: this.options.timeoutMs });
  }

  /** ce qui entoure l'arrêt (`bdtopo-stop-surroundings.ts`), même pool, même délai. */
  stopSurroundings(request: StopSurroundingsRequest): Promise<StopSurroundingsReading> {
    return fetchStopSurroundings(this.sql, request, this.options.timeoutMs);
  }

  async lookup(centre: GeoPoint): Promise<BuildingsReading> {
    const started = Date.now();
    const params = [
      centre.lon,
      centre.lat,
      this.options.densityRadiusM,
      bboxPaddingDeg(this.options.densityRadiusM, centre.lat),
      this.options.buildingRadiusM,
      bboxPaddingDeg(this.options.buildingRadiusM, centre.lat),
    ];

    // MÊME DISCIPLINE QUE LA GREFFE, et pour la même raison : cette
    // requête partage la pool de `bdtopo.ts`. Le `Promise.race` qui
    // était seul ici rendait la main à `timeoutMs` sans rien annuler — la
    // connexion restait prise jusqu'au `statement_timeout` de la pool, 3,5 s de
    // plus, contre la greffe qui en a besoin.
    //
    // Le budget part donc maintenant AVEC la requête : le serveur coupe à
    // `timeoutMs` et rend la connexion. Le minuteur reste, décalé au-dessus du
    // budget serveur — il n'est plus la lame mais le filet, pour le client SQL
    // qui ignorerait le budget (un double de test, par exemple). Même forme
    // qu'en `grafted.ts`, exprès.
    //
    // `timeout` reste un verdict distinct de `provider_error` : la coupe du
    // serveur (57014) dit autre chose qu'une base muette, et l'onglet aussi.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race([
        this.sql
          .query(BUILDINGS_SQL, params, { timeoutMs: this.options.timeoutMs })
          .then((r) => ({ kind: 'rows' as const, rows: r.rows })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timer = setTimeout(
            () => resolve({ kind: 'timeout' }),
            this.options.timeoutMs + DEFAULT_STATEMENT_GRACE_MS,
          );
        }),
      ]);
      if (raced.kind === 'timeout') {
        return { known: false, why: 'timeout', queryMs: Date.now() - started };
      }
      const row = raced.rows[0] as Record<string, unknown> | undefined;
      return { known: true, value: mapBuildingsRow(row, this.options, Date.now() - started) };
    } catch (error) {
      const queryMs = Date.now() - started;
      if (isStatementTimeout(error)) return { known: false, why: 'timeout', queryMs };
      // Une base muette dégrade un affichage, elle n'interrompt aucune analyse.
      return { known: false, why: 'provider_error', queryMs };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
