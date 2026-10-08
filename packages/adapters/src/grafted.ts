/**
 * A road source that borrows the width a second source knows.
 *
 * The primary source stays in charge of everything: it draws the graph, it
 * names the streets, it carries the access tags and the street furniture. All
 * this wrapper does is ask a donor the same question, hand both answers to the
 * pure matcher in `@teneolog/topology`, and return the primary's ways with the
 * missing width filled in — provenance attached.
 *
 * THE DONOR IS NEVER ALLOWED TO BREAK THE ANSWER. It is racing a timer, it is
 * behind a breaker, and every failure path returns the primary's result
 * untouched, by identity. With `BDTOPO_POSTGIS_URL` unset, or the database
 * down, or the match too poor to trust, the product answers exactly what it
 * answered before this file existed. That is the whole contract, and the tests
 * state it as identity rather than equality on purpose.
 */
import type { GeoPoint } from '@teneolog/domain';
import {
  circleExtent,
  corridorExtent,
  graftDeclaredWidth,
  type GraftOptions,
  type RoadGraphPort,
  type RoadNeighbourhood,
  type RoadWay,
} from '@teneolog/topology';

/** The shape both Overpass and the BD TOPO adapter already satisfy. */
export interface RoadSource extends RoadGraphPort {
  fetchCorridor(polyline: readonly GeoPoint[], marginM: number): Promise<readonly RoadWay[]>;
  /**
   * toutes les voies d'une boîte, pour le cache par tuile.
   *
   * Optionnelle : seule la source qui dessine le graphe en a besoin, et une
   * source qui ne l'offre pas retombe sur le cercle qui couvre la boîte —
   * même ensemble de voies, une requête plus chère.
   */
  fetchWaysInBox?(box: {
    readonly south: number;
    readonly west: number;
    readonly north: number;
    readonly east: number;
  }): Promise<readonly RoadWay[]>;
}

/**
 * de combien le minuteur de cette classe passe au-dessus du budget
 * que le donneur a donné au serveur.
 *
 * Avant : ce minuteur ÉTAIT la coupe, et il ne coupait rien du tout. Il rendait
 * la main à `donorTimeoutMs` en laissant la requête SQL vivre sa vie, connexion
 * comprise, jusqu'au `statement_timeout` de la pool
 * (la note de conception interne). Maintenant la lame est côté
 * serveur — `createBdtopoSqlClient` pose `statement_timeout = donorTimeoutMs`
 * sur la connexion — et ce minuteur n'est plus que le filet en dessous.
 *
 * Il faut donc qu'il tombe APRÈS, sinon on reviendrait à abandonner sans
 * annuler : ces 500 ms sont le temps que met la réponse « annulée » à revenir
 * (~220 ms de latence à travers le tunnel réseau de la mesure, quelques ms sur le
 * réseau docker de la prod). S'il sert malgré tout, c'est que le donneur n'est
 * pas une base SQL, ou que la prise est muette — et la classe fait alors ce
 * qu'elle a toujours fait : rendre le primaire, intact.
 */
export const DONOR_NET_GRACE_MS = 500;

export interface GraftedRoadSourceOptions {
  readonly primary: RoadSource;
  /** Null when the donor is not configured: the wrapper becomes a pass-through. */
  readonly donor: RoadSource | null;
  readonly graft: GraftOptions;
  /**
   * Le budget du donneur. Ce n'est plus une patience mais une échéance : le
   * donneur SQL la pose en `statement_timeout` et le serveur coupe lui-même.
   * Ce qui reste ici est le filet, à `donorTimeoutMs + DONOR_NET_GRACE_MS`.
   */
  readonly donorTimeoutMs: number;
  /** Consecutive donor failures that open the breaker. */
  readonly breakerFailures: number;
  /** How long the breaker stays open before one probe is allowed through. */
  readonly breakerCooldownMs: number;
  /**
   * How long a donor neighbourhood answer may be reused.
   *
   * The pipeline fetches the same 80 m neighbourhood twice per analysis — once
   * to pick the street, once to collect its descriptions. Overpass absorbs the
   * repeat on its disk cache; the BD TOPO adapter has none, so the second call
   * would be a second query for an answer we already hold.
   */
  readonly memoTtlMs: number;
  /** Reported, never thrown: the caller decides whether a mute donor matters. */
  readonly onDonorFailure?: (error: unknown) => void;
}

/**
 * LE DISJONCTEUR RECALIBRÉ : deux preuves, deux comptes.
 *
 * Il était dimensionné contre une base MORTE : « trois attentes
 * perdues plutôt qu'une par analyse, pour toujours ». Puis il s'est mis à
 * s'ouvrir sur autre chose — des dépassements de délai — et c'est ce qui
 * privait une adresse entière de ses largeurs (§7.4 de l'A/B). La raison était
 * mécanique : un abandon immobilisait une connexion, la pool se bouchait, et
 * les trois échecs consécutifs arrivaient en quelques secondes.
 *
 * Le correctif (1) supprime cet engrenage : un dépassement ne coûte plus que sa
 * propre requête, et il rend sa connexion. Les deux preuves ne valent donc plus
 * la même chose :
 *
 * - **La base ne répond pas** (connexion refusée, pool saturée, prise détruite)
 *   — rien ne changera d'ici la requête suivante. Seuil inchangé,
 *   `breakerFailures` (3), et la pleine minute de repos.
 * - **La base a dépassé son budget** — ce corridor-là était trop gros ; le
 *   suivant est peut-être une impasse de 80 m. Il en faut le double
 *   (`TIMEOUT_BREAKER_FACTOR`) pour conclure que la base ne suit plus, et le
 *   repos est alors court : `donorTimeoutMs × TIMEOUT_COOLDOWN_FACTOR`, soit
 * 5 s avec la policy de référence.
 *
 * **La minute était le vrai défaut de calibrage, et il est indépendant de (1).**
 * Une analyse dure de 8 à 36 s (§7.1) : un disjoncteur ouvert 60 s ne prive pas
 * quelques corridors de leurs largeurs, il prive l'adresse entière — et, le
 * processus étant partagé, la suivante aussi. Un repos plus court que l'analyse
 * rend au contraire la largeur en cours de route. Pour une base morte, la
 * minute reste juste : la panne, elle, dure plus longtemps que l'analyse.
 */
const TIMEOUT_BREAKER_FACTOR = 2;
const TIMEOUT_COOLDOWN_FACTOR = 2;

/**
 * `57014 query_canceled` — le serveur a coupé à l'échéance qu'on lui a donnée.
 * Reconnu par son code, pas par son texte, qui est traduit.
 */
const PG_QUERY_CANCELED = '57014';

/**
 * Ce qu'une pool dit quand elle n'a pas réussi à ouvrir une connexion À TEMPS.
 *
 * Ces deux-là n'ont pas de code, seulement un texte — `pg-pool` les fabrique
 * lui-même (`node_modules/pg-pool/index.js`). Les reconnaître au texte est
 * fragile, et c'est pourtant le bon compromis : une poignée de main trop lente
 * est une preuve de congestion, pas de mort, et la classer en panne coûtait un
 * run entier. Mesuré le 2026-09-11 : ouvrir une connexion à travers le tunnel
 * réseau coûte 1,4 s, le premier run en a manqué huit, et trois
 * d'affilée suffisaient à ouvrir le disjoncteur pour une minute. Si le texte
 * change, le pire est de reclasser en panne ce qui l'est presque : le seuil de
 * trois et la minute, c'est-à-dire le comportement d'avant.
 */
const POOL_ACQUISITION_TIMEOUTS = [
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
] as const;

/**
 * Le budget a-t-il expiré, ou la base est-elle morte ?
 *
 * Reconnu sans rien importer de la couche SQL : cette classe ne sait pas que
 * son donneur est une base, et c'est ce qui lui permet d'en accepter un autre.
 */
function isBudgetOverrun(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.message === 'donor_timeout') return true;
    if (POOL_ACQUISITION_TIMEOUTS.some((text) => error.message.includes(text))) return true;
  }
  if (typeof error !== 'object' || error === null) return false;
  return (error as { readonly code?: unknown }).code === PG_QUERY_CANCELED;
}

export class GraftedRoadSource implements RoadSource {
  /** La base ne répond pas — la preuve qui dure. */
  private unavailable = 0;
  /** La base a dépassé son budget — la preuve qui passe. */
  private overruns = 0;
  private openedAt: number | null = null;
  /** Le repos que l'ouverture en cours s'est donné : il dépend de sa cause. */
  private cooldownMs = 0;
  private readonly memo = new Map<string, { at: number; ways: readonly RoadWay[] }>();

  constructor(private readonly options: GraftedRoadSourceOptions) {}

  async fetchNeighbourhood(centre: GeoPoint, radiusM: number): Promise<RoadNeighbourhood> {
    const primary = await this.options.primary.fetchNeighbourhood(centre, radiusM);
    const donors = await this.donorWays(
      `n:${centre.lat.toFixed(5)}:${centre.lon.toFixed(5)}:${radiusM}`,
      async (donor) => (await donor.fetchNeighbourhood(centre, radiusM)).ways,
    );
    if (donors === null) return primary;
    // The donor was asked inside the circle; the primary returns a way whole
    // as soon as one node touches it. The match is judged where both looked.
    const ways = graftDeclaredWidth(
      primary.ways,
      donors,
      this.options.graft,
      circleExtent(centre, radiusM),
    );
    // `graftDeclaredWidth` returns the same array when nothing was grafted, so
    // an unhelpful donor costs the caller nothing — not even a new object.
    return ways === primary.ways ? primary : { ...primary, ways };
  }

  /**
   * les voies du graphe dans une boîte, LA GREFFE NON FAITE.
   *
   * C'est ce que le cache par tuile (`@teneolog/routes`, `way-tiles.ts`)
   * consomme. Le graphe et le donneur reviennent par deux chemins séparés, et
   * c'est le point : la largeur retenue par `graftDeclaredWidth` dépend de
   * l'ÉTENDUE jugée, donc du corridor, et pas seulement de la voie. Mettre en
   * cache une voie déjà greffée donnerait une largeur juste pour la première
   * jambe rencontrée et fausse pour les suivantes — le défaut n° 2 de l'annexe
   * de l'A/B (la note de conception interne). Le cache tient donc la
   * matière première ; la greffe se rejoue par corridor.
   */
  async fetchGraphWays(box: {
    readonly south: number;
    readonly west: number;
    readonly north: number;
    readonly east: number;
  }): Promise<readonly RoadWay[]> {
    const { primary } = this.options;
    if (primary.fetchWaysInBox !== undefined) return primary.fetchWaysInBox(box);
    // Repli : le cercle qui couvre la boîte. Même ensemble de voies — Overpass
    // rend une voie entière dès qu'elle touche l'emprise — mais plus d'aire
    // demandée, donc plus cher. Personne n'emprunte ce chemin en production.
    const centre: GeoPoint = { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 };
    const halfLatM = ((box.north - box.south) / 2) * 111_320;
    const halfLonM = ((box.east - box.west) / 2) * 111_320 * Math.cos((centre.lat * Math.PI) / 180);
    return (await primary.fetchNeighbourhood(centre, Math.hypot(halfLatM, halfLonM))).ways;
  }

  /**
   * Les tronçons du donneur le long d'un corridor, bruts et NON greffés.
   *
   * Exactement la requête que `fetchCorridor` fait déjà — même bande, même
   * minuteur, même disjoncteur — à la greffe près, qui est justement ce que le
   * cache par tuile refait lui-même sur les voies qu'il a assemblées. Le
   * donneur n'est pas tuilé : un disque de 414 m à Paris rend des milliers de
   * tronçons quand la bande d'un corridor entier en rend quelques centaines,
   * et c'est le `donorTimeoutMs` qui tombe (mesuré le 2026-09-11).
   *
   * Vide quand il n'y a rien — donneur absent, disjoncteur ouvert, minuteur
   * dépassé : l'appelant a une branche, et c'est la sûre.
   */
  async fetchDonorCorridor(
    polyline: readonly GeoPoint[],
    marginM: number,
  ): Promise<readonly RoadWay[]> {
    const donors = await this.donorWays(null, (donor) => donor.fetchCorridor(polyline, marginM));
    return donors ?? [];
  }

  async fetchCorridor(
    polyline: readonly GeoPoint[],
    marginM: number,
  ): Promise<readonly RoadWay[]> {
    const primary = await this.options.primary.fetchCorridor(polyline, marginM);
    const donors = await this.donorWays(null, (donor) => donor.fetchCorridor(polyline, marginM));
    if (donors === null) return primary;
    // Same rule along a route: the side street of a turn leaves the corridor
    // by construction, and only its stretch inside the margin was answered.
    return graftDeclaredWidth(
      primary,
      donors,
      this.options.graft,
      corridorExtent(polyline, marginM),
    );
  }

  /**
   * The donor's ways, or `null` for "carry on without them".
   *
   * Null is returned for every reason a donor can fail to help: not
   * configured, breaker open, timed out, threw, or simply had nothing. The
   * caller has one branch, and it is the safe one.
   */
  private async donorWays(
    memoKey: string | null,
    fetch: (donor: RoadSource) => Promise<readonly RoadWay[]>,
  ): Promise<readonly RoadWay[] | null> {
    const { donor } = this.options;
    if (donor === null) return null;
    if (this.breakerOpen()) return null;

    if (memoKey !== null) {
      const hit = this.memo.get(memoKey);
      if (hit !== undefined && Date.now() - hit.at < this.options.memoTtlMs) return hit.ways;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ways = await Promise.race([
        fetch(donor),
        new Promise<never>((_, reject) => {
          // Le filet, pas la lame : voir `DONOR_NET_GRACE_MS`. Le serveur a
          // déjà coupé à `donorTimeoutMs` et rendu sa connexion ; ce minuteur
          // ne rattrape qu'une prise qui ne parle plus.
          timer = setTimeout(
            () => reject(new Error('donor_timeout')),
            this.options.donorTimeoutMs + DONOR_NET_GRACE_MS,
          );
        }),
      ]);
      this.unavailable = 0;
      this.overruns = 0;
      this.openedAt = null;
      if (memoKey !== null) this.remember(memoKey, ways);
      return ways;
    } catch (error) {
      this.count(error);
      this.options.onDonorFailure?.(error);
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Compter l'échec dans la bonne colonne, et ouvrir si cette colonne déborde.
   *
   * Les deux comptes sont consécutifs : une réponse les remet à zéro tous les
   * deux. Une base qui répond une fois sur deux n'est pas une base en panne.
   */
  private count(error: unknown): void {
    if (isBudgetOverrun(error)) {
      this.overruns += 1;
      if (this.overruns >= this.options.breakerFailures * TIMEOUT_BREAKER_FACTOR) {
        this.open(this.options.donorTimeoutMs * TIMEOUT_COOLDOWN_FACTOR);
      }
      return;
    }
    this.unavailable += 1;
    if (this.unavailable >= this.options.breakerFailures) {
      this.open(this.options.breakerCooldownMs);
    }
  }

  private open(cooldownMs: number): void {
    this.openedAt = Date.now();
    this.cooldownMs = cooldownMs;
  }

  /** Open until the cooldown elapses, then one probe is let through. */
  private breakerOpen(): boolean {
    if (this.openedAt === null) return false;
    if (Date.now() - this.openedAt < this.cooldownMs) return true;
    this.openedAt = null;
    this.unavailable = 0;
    this.overruns = 0;
    return false;
  }

  private remember(key: string, ways: readonly RoadWay[]): void {
    // A handful of anchors per analysis; the cap is a leak guard, not a policy.
    if (this.memo.size > 64) this.memo.clear();
    this.memo.set(key, { at: Date.now(), ways });
  }
}
