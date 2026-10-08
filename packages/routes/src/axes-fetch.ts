/**
 * /434 — CE QUE L'ÉTAGE DEMANDE AUX DONNÉES, et ce qu'il refuse de
 * redemander.
 *
 * Sorti de `axes-stage.ts` le 2026-09-15 parce que la tâche du jour y
 * touchait et que le fichier est gelé (principe 26 : « ce qui dépasse se
 * découpe quand on y touche »). La coupure est celle du sujet — ici on PARLE À
 * LA SOURCE (les vagues d'axes, le pool de rues locales, le chapelet le long
 * d'un axe), là-bas on ORDONNE la recherche. Aucune règle n'a changé de valeur
 * dans le déplacement : les deux mémoires, le budget global et la comptabilité
 * de `AxisFetchReport` sont mot pour mot ceux du 2026-09-14.
 */
import type { AxisCorridor, AxisFetchReport, GeoPoint } from '@teneolog/domain';
import { haversineM, type RoadWay } from '@teneolog/topology';

import { prepareAxisNetwork, type AxisNetwork } from './axes-network.js';
import { RESCUE_PARALLEL } from './axes-rescue.js';

/**
 * La source des tronçons BD TOPO par classe d'importance.
 *
 * Séparée de `RoadGraphPort` à dessein : le voisinage rend TOUT ce qui roule
 * dans un disque, et le demander à 15 km rendrait la ville entière. Ici on
 * demande une CLASSE, et le nombre de lignes est borné.
 */
export interface AxisSourcePort {
  fetchByImportance(
    centre: GeoPoint,
    radiusM: number,
    range: { readonly min: number; readonly max: number },
    limit: number,
  ): Promise<{ readonly ways: readonly RoadWay[]; readonly truncated: boolean }>;
}

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Ce que les deux mémoires ont besoin de savoir de l'étage, et rien de plus. */
export interface AxisFetchParams {
  readonly localImportance: { readonly min: number; readonly max: number };
  readonly maxAxisSegmentsPerFetch: number;
  readonly maxLocalSegmentsPerFetch: number;
  readonly localFetchRadiusM: number;
  readonly localFetchSpacingM: number;
  readonly localFetchMaxPointsPerAxis: number;
  /** Plafond global de requêtes locales, toutes axes confondues (engine : 48). */
  readonly localFetchMaxPoints: number;
  readonly sectorCount: number;
}

/** Le réseau d'une vague, préparé une fois : ses tronçons placés, et qui touche qui. */
export interface AxisWave {
  readonly network: AxisNetwork;
  readonly axisWays: ReadonlyMap<string, RoadWay>;
}

interface FetchInput {
  readonly source: AxisSourcePort;
  readonly stop: GeoPoint;
  readonly params: AxisFetchParams;
  readonly report: Mutable<AxisFetchReport>;
  readonly clock: () => number;
}

/**
 * LES VAGUES D'AXES, DEMANDÉES UNE SEULE FOIS.
 *
 * Les temps de l'étage repassent sur les mêmes rayons : le cercle demande la
 * vague de 5 000 m pour atteindre l'anneau de 2 000 m, et l'escalade la relit
 * pour l'anneau de 5 000 m. Sans mémoire, cette seconde lecture coûterait une
 * requête BD TOPO entière (2,4 à 6,9 s mesurées à travers le tunnel) pour
 * rendre exactement les mêmes tronçons. La clé est le couple (rayon, plage
 * d'importance) : la passe de classe 4 ne demande QUE la classe 4
 * (`importanceMax + 1` … `circleFallbackImportanceMax`), donc elle ne partage
 * aucune ligne avec la passe structurante, et c'est voulu. La plage est la clé,
 * et non la passe entière : la bande ne demande aucune rue locale (elle n'a pas
 * de jonction à faire), donc elle n'a rien à dire sur `localImportance`.
 *
 * Le réseau (`prepareAxisNetwork`) est préparé avec la vague, pour la même
 * raison : les anneaux le relisent sans le reconstruire.
 */
export class AxisWaves {
  private readonly memo = new Map<string, AxisWave>();

  constructor(private readonly input: FetchInput) {}

  async at(radiusM: number, range: { readonly min: number; readonly max: number }): Promise<AxisWave> {
    const key = `${radiusM}:${range.min}-${range.max}`;
    const held = this.memo.get(key);
    if (held !== undefined) return held;

    const { source, stop, params, report, clock } = this.input;
    const asked = clock();
    const answer = await source.fetchByImportance(
      stop,
      radiusM,
      range,
      params.maxAxisSegmentsPerFetch,
    );
    report.radiiM = [...report.radiiM, radiusM];
    report.queries += 1;
    report.ms += clock() - asked;
    report.truncated = report.truncated || answer.truncated;
    report.axisSegments = answer.ways.length;

    const wave: AxisWave = {
      network: prepareAxisNetwork(stop, answer.ways, params.sectorCount),
      axisWays: new Map(answer.ways.map((way) => [way.id, way])),
    };
    this.memo.set(key, wave);
    return wave;
  }
}

/**
 * LE POOL CUMULATIF DE RUES LOCALES : un disque n'est demandé qu'une
 * fois, et ce qui est entré ne sort plus.
 *
 * Le critère d'arrêt compte les DIRECTIONS DES PORTES RETENUES
 * (`axes-rings.ts`), donc les filtres de porte tournent à CHAQUE anneau, et
 * chaque anneau voudrait ses rues locales. Sans mémoire, l'anneau de 250 m
 * redemanderait le disque de l'anneau de 50 m, et le coût serait multiplié par
 * le nombre d'anneaux. Deux règles, et le compte de requêtes reste du même
 * ordre qu'avant :
 *
 *  1. **Un centre déjà demandé à un rayon AU MOINS AUSSI GRAND ne se redemande
 *     pas.** La requête est `ORDER BY ST_Distance … LIMIT n`
 *     (`packages/adapters/src/bdtopo-axes.ts`). *Relu le 2026-09-14* : dire
 *     que les `n` plus proches d'un disque de rayon R contiennent forcément
 *     les `n` plus proches de tout disque r ≤ R serait trop fort — le filtre
 *     est géodésique et le tri, en pratique, en degrés, donc l'inclusion
 *     stricte n'est pas garantie au mètre près sur les bords. Ce que la règle
 *     2 ci-dessous fait, en revanche, rend la question SANS OBJET : le pool
 *     ne rejette jamais ce qu'un disque plus petit a rapporté, donc même une
 *     inclusion imparfaite ne perd rien.
 *  2. **Le pool est cumulatif** : un anneau juge ses portes sur TOUT ce qui a
 *     été rapporté jusque-là, pas seulement sur ses propres disques. Un anneau
 *     plus large ne perd donc jamais ce qu'un anneau plus court avait trouvé.
 *
 * Le budget de requêtes le long des axes (`localFetchMaxPoints`, 48 chez
 * l'engine) reste GLOBAL à l'étage : c'est lui qui borne le coût quand la
 * recherche monte jusqu'à 15 km, et `stageTimeoutMs` est le plafond de dernier
 * recours.
 */
export class LocalWayPool {
  private readonly byId = new Map<string, RoadWay>();
  /** Le plus grand rayon déjà demandé à chaque centre. */
  private readonly asked = new Map<string, number>();
  /**
   * les centres dont le disque a rendu son plafond de
   * lignes. « Déjà demandé plus large » n'y veut pas dire « déjà tout vu » :
   * c'est exactement le trou que le sauvetage BUG-045 vient boucher.
   */
  private readonly truncatedAt = new Set<string>();
  /** Les centres déjà sauvés : un disque de sauvetage ne se demande qu'une fois. */
  private readonly rescued = new Set<string>();
  private alongBudget: number;

  constructor(private readonly input: FetchInput) {
    this.alongBudget = input.params.localFetchMaxPoints;
  }

  /** Les rues locales d'un anneau : le disque de l'arrêt, puis le chapelet des axes. */
  async forRing(
    axes: readonly AxisCorridor[],
    ringM: number,
    fetchRadiusM: number,
  ): Promise<readonly RoadWay[]> {
    const { params, stop, report } = this.input;
    // Le disque de l'arrêt suit l'ANNEAU, pas le rayon de requête : sonder
    // l'anneau de 50 m ne doit pas rapatrier les rues locales de 18 km.
    await this.fetchDisc(stop, Math.min(ringM, fetchRadiusM) * 1.2);
    for (const axis of axes) {
      const points = alongAxis(axis, params.localFetchSpacingM, params.localFetchMaxPointsPerAxis);
      for (const at of points) {
        if (this.alongBudget <= 0) break;
        if (await this.fetchDisc(at, params.localFetchRadiusM)) this.alongBudget -= 1;
      }
    }
    report.localSegments = this.byId.size;
    return [...this.byId.values()];
  }

  /**
   * LES DISQUES DE SAUVETAGE (`axes-rescue.ts`), trois par
   * trois. Ce qui entre ne sort plus, comme pour le reste du pool ; mais la
   * mémoire des centres n'est PAS la même : un centre déjà demandé plus large
   * n'est sauté que si ce disque-là était complet. Un disque de 1 500 m tronqué
   * au même centre n'a pas « déjà vu » les 300 m — c'est le défaut même que le
   * sauvetage corrige, et `alongAxis` pose ses centres sur des sommets d'axe,
   * donc parfois exactement sur un bout de tronçon. Cette règle ne vaut que
   * pour le sauvetage : `forRing` garde la sienne, au bit près, et la règle de
   * secteurs avec elle.
   *
   * Hors du budget du chapelet (`localFetchMaxPoints`) : l'engine plafonne le
   * sauvetage par axe, pas globalement, et `stageTimeoutMs` reste le plafond de
   * dernier recours. Rend le nombre de rues locales NOUVELLES.
   */
  async rescueAt(points: readonly GeoPoint[], radiusM: number): Promise<number> {
    const { report } = this.input;
    const before = this.byId.size;
    let queries = 0;
    for (let i = 0; i < points.length; i += RESCUE_PARALLEL) {
      const batch = points.slice(i, i + RESCUE_PARALLEL);
      const asked = await Promise.all(batch.map(async (at) => this.rescueDisc(at, radiusM)));
      queries += asked.filter(Boolean).length;
    }
    const fresh = this.byId.size - before;
    const held = report.rescue ?? { queries: 0, newLocalWays: 0 };
    report.rescue = { queries: held.queries + queries, newLocalWays: held.newLocalWays + fresh };
    report.localSegments = this.byId.size;
    return fresh;
  }

  /** Rend vrai quand la requête a vraiment été faite ; faux quand le disque était déjà couvert. */
  private async fetchDisc(at: GeoPoint, radiusM: number): Promise<boolean> {
    const key = keyOf(at);
    if ((this.asked.get(key) ?? 0) >= radiusM) return false;
    this.asked.set(key, radiusM);
    if (await this.query(at, radiusM)) this.truncatedAt.add(key);
    return true;
  }

  /** Un disque de sauvetage : sauté s'il a déjà été sauvé, ou si un disque complet plus large le couvre. */
  private async rescueDisc(at: GeoPoint, radiusM: number): Promise<boolean> {
    const key = keyOf(at);
    if (this.rescued.has(key)) return false;
    if ((this.asked.get(key) ?? 0) >= radiusM && !this.truncatedAt.has(key)) return false;
    this.rescued.add(key);
    await this.query(at, radiusM);
    return true;
  }

  /** La requête elle-même, comptée ; rend vrai quand la source a rendu son plafond de lignes. */
  private async query(at: GeoPoint, radiusM: number): Promise<boolean> {
    const { source, params, report, clock } = this.input;
    const start = clock();
    const answer = await source.fetchByImportance(
      at,
      radiusM,
      params.localImportance,
      params.maxLocalSegmentsPerFetch,
    );
    report.queries += 1;
    report.ms += clock() - start;
    report.truncated = report.truncated || answer.truncated;
    for (const way of answer.ways) this.byId.set(way.id, way);
    return answer.truncated;
  }
}

/** La clé d'un centre de disque, au micro-degré. */
function keyOf(at: GeoPoint): string {
  return `${at.lat.toFixed(6)},${at.lon.toFixed(6)}`;
}

/** Des points espacés le long de la corde d'un axe, le premier à son point le plus proche. */
function alongAxis(axis: AxisCorridor, spacingM: number, maxPoints: number): readonly GeoPoint[] {
  const out: GeoPoint[] = [];
  let carried = spacingM;
  for (let i = 0; i < axis.geometry.length; i += 1) {
    const point = axis.geometry[i];
    const previous = axis.geometry[i - 1];
    carried += previous === undefined ? spacingM : haversineM(previous, point as GeoPoint);
    if (point !== undefined && carried >= spacingM) {
      out.push(point);
      carried = 0;
      if (out.length >= maxPoints) break;
    }
  }
  return out;
}
