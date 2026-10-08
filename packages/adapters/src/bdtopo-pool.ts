/**
 * LE CLIENT SQL QUI REND SA CONNEXION AU DÉLAI.
 *
 * Le défaut corrigé ici (la note de conception interne, relevé par
 * ) : la greffe abandonnait une requête BD TOPO au bout de
 * `donorTimeoutMs` (2,5 s) avec un `Promise.race`, mais **un `Promise.race`
 * n'annule rien**. La requête continuait côté serveur et sa connexion restait
 * prise jusqu'au `statement_timeout` de la pool (5 s). Quelques abandons
 * immobilisaient les huit connexions ; les requêtes suivantes attendaient
 * `connectionTimeoutMillis` puis échouaient à leur tour ; trois échecs
 * ouvraient le disjoncteur et l'adresse **entière** perdait ses largeurs BD
 * TOPO — silencieusement, en continuant « sur OSM seul ». Mesuré : Paris 11e
 * passait de ~150 voies greffées à 0.
 *
 * ── La mécanique retenue, et les trois qui ne l'ont pas été ────────────────
 *
 * **Retenue : `statement_timeout` posé par requête sur une connexion sortie de
 * la pool.** C'est le serveur qui coupe, à l'échéance qu'on lui a donnée ; il
 * répond `57014 query_canceled`, et la connexion revient **propre et
 * immédiatement réutilisable**. C'est la seule mécanique qui ne dépend de rien
 * d'autre : ni d'une connexion libre, ni d'un aller-retour supplémentaire au
 * moment où tout va mal.
 *
 * **Pas `pg_cancel_backend` depuis une seconde connexion.** Il en faut une
 * libre exactement quand la pool est saturée — c'est-à-dire la panne qu'on
 * corrige. Et l'annulation est consultative : PostgreSQL ne l'honore que
 * pendant l'exécution. `statement_timeout`, c'est la même annulation, émise
 * par le serveur pour lui-même, sans connexion.
 *
 * **Pas `AbortSignal`.** `pg` 8.23 n'en prend aucun sur `query`.
 *
 * **Pas `query_timeout` de `pg`.** Il est pire qu'inutile ici : il rend la main
 * à l'appelant **sans** rien annuler, puis `_pulseQueryQueue` envoie la requête
 * suivante sur la même connexion pendant que le serveur travaille encore sur
 * la précédente (`node_modules/pg/lib/client.js:702-730`). C'est exactement le
 * fantôme qu'on cherche à supprimer.
 *
 * ── Le filet, au-dessus de la lame ─────────────────────────────────────────
 *
 * Le serveur ne peut couper que s'il parle encore. Reste le cas où la prise
 * elle-même est muette (tunnel coupé, serveur parti sans dire au revoir) : un
 * minuteur client à `budget + graceMs` le rattrape et **détruit** la connexion
 * (`release(true)` ⇒ `pg-pool._remove`, qui la sort de `_clients` avant même le
 * `end()`) au lieu de rendre un fantôme à la pool. La place est libre tout de
 * suite ; une connexion neuve la remplacera.
 *
 * L'ordre est donc toujours : **le serveur coupe le premier, le filet ne sert
 * jamais.** Si le filet sert, ce n'est pas une requête lente, c'est une
 * connexion morte.
 *
 * ── Le coût : zéro aller-retour en régime établi ───────────────────────────
 *
 * `SET statement_timeout` n'est envoyé que lorsque la connexion ne porte pas
 * déjà la valeur voulue — la valeur appliquée est mémorisée sur l'objet client.
 * Une connexion paie donc UN aller-retour à sa première requête, puis plus
 * aucun tant que le budget ne change pas. Les TROIS lecteurs de cette pool ont
 * trois budgets (la greffe `roadAttributes.donorTimeoutMs`, les bâtiments
 * `buildings.timeoutMs`, l'étage axes `gates.axes.queryTimeoutMs` depuis
 * ); avec huit connexions, une requête bâtiments et une poignée de
 * requêtes d'axes par analyse, le va-et-vient reste négligeable. Aucune valeur
 * ne vient de l'extérieur : c'est un entier arrondi ici même, jamais une
 * entrée.
 *
 * **Ce qui reste à revérifier à l'activation de l'étage axes** : une analyse
 * tient jusqu'à six connexions pour ses corridors, une pour les bâtiments et
 * une pour les axes — huit, soit exactement le `max` de la pool
 * (l'API (hors instantané)). À deux analyses concurrentes, une requête attend
 * donc son tour AVANT de partir, et cette attente-là n'est bornée par aucun
 * `statement_timeout` ; seul `gates.axes.stageTimeoutMs` la borne, pour
 * l'étage. Non mesuré : l'étage est en silence, et le corpus ne fait tourner
 * qu'un run à la fois.
 */
import type { SqlClient, SqlQueryOptions } from './bdtopo.js';

/** La tranche de `pg.PoolClient` dont ce module a besoin. */
export interface PooledSqlConnection {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
  /**
   * `release(true)` **détruit** la connexion au lieu de la rendre : c'est la
   * porte de sortie du filet ci-dessus, et la seule qui libère la place d'une
   * connexion qui ne répond plus.
   */
  release(destroy?: boolean): void;
}

/** La tranche de `pg.Pool` dont ce module a besoin. */
export interface SqlConnectionPool {
  connect(): Promise<PooledSqlConnection>;
}

export interface BdtopoSqlClientOptions {
  /**
   * Budget serveur quand l'appelant n'en demande pas.
   *
   * À poser égal au `statement_timeout` de la pool : la pool est la ceinture
   * (elle s'applique même si ce module était contourné), ce budget est la
   * bretelle (il s'applique par requête).
   */
  readonly defaultTimeoutMs: number;
  /**
   * De combien le filet client passe au-dessus du budget serveur.
   *
   * Assez pour que la réponse « annulée » ait le temps de revenir par le
   * réseau — 500 ms couvre les ~220 ms de latence d'un tunnel réseau et les
   * quelques ms du réseau docker de la prod — et pas plus, parce que tout ce
   * temps est du temps où la place reste prise.
   */
  readonly graceMs?: number;
  /**
   * Signalé, jamais lancé. Une connexion détruite est un événement rare et il
   * mérite une ligne : c'est le signe que le serveur ne parle plus du tout.
   */
  readonly onConnectionDestroyed?: (context: { readonly budgetMs: number }) => void;
}

export const DEFAULT_STATEMENT_GRACE_MS = 500;

/**
 * Le budget minimal qu'on accepte de donner au serveur. Un `statement_timeout`
 * à 0 voudrait dire « pas de limite », qui est exactement le défaut corrigé.
 */
const MIN_BUDGET_MS = 50;

/** La valeur de `statement_timeout` que porte déjà cette connexion. */
const APPLIED_TIMEOUT = Symbol('teneolog.bdtopo.statement_timeout');

type MarkedConnection = PooledSqlConnection & { [APPLIED_TIMEOUT]?: number };

/** Levée par le filet, jamais par le serveur. Nommée pour être reconnaissable. */
export class SqlConnectionMuteError extends Error {
  constructor(budgetMs: number, graceMs: number) {
    super(
      `bdtopo: aucune réponse ${budgetMs + graceMs} ms après l'envoi ` +
        `(budget serveur ${budgetMs} ms) — connexion détruite`,
    );
    this.name = 'SqlConnectionMuteError';
  }
}

/**
 * `57014 query_canceled` — PostgreSQL a coupé à l'échéance qu'on lui a donnée.
 * C'est la réponse NORMALE d'un budget dépassé, et elle se distingue d'une base
 * en panne : l'appelant a le droit de dire « le délai a été dépassé » plutôt
 * que « la base n'a pas répondu ».
 */
export const PG_QUERY_CANCELED = '57014';

/** Vrai pour la coupe du serveur comme pour celle du filet : même cause, même récit. */
export function isStatementTimeout(error: unknown): boolean {
  if (error instanceof SqlConnectionMuteError) return true;
  if (typeof error !== 'object' || error === null) return false;
  return (error as { readonly code?: unknown }).code === PG_QUERY_CANCELED;
}

/**
 * Un `SqlClient` qui borne le travail du serveur, pas seulement la patience du
 * client.
 *
 * Chaque appel sort une connexion de la pool, lui pose le budget demandé, pose
 * la question, et rend la connexion — dans tous les cas, y compris celui où
 * l'appelant a déjà renoncé plus haut. C'est ce « dans tous les cas » qui
 * manquait.
 */
export function createBdtopoSqlClient(
  pool: SqlConnectionPool,
  options: BdtopoSqlClientOptions,
): SqlClient {
  const graceMs = options.graceMs ?? DEFAULT_STATEMENT_GRACE_MS;
  const fallbackMs = budgetOf(options.defaultTimeoutMs);

  return {
    async query(
      text: string,
      params: readonly unknown[],
      queryOptions?: SqlQueryOptions,
    ): Promise<{ readonly rows: readonly unknown[] }> {
      const budgetMs =
        queryOptions?.timeoutMs === undefined ? fallbackMs : budgetOf(queryOptions.timeoutMs);
      // Une connexion qu'on n'obtient pas n'est pas une connexion qu'on
      // immobilise : `connectionTimeoutMillis` échoue sans rien retenir, et il
      // n'y a donc rien à annuler sur ce chemin.
      const client: MarkedConnection = await pool.connect();
      let handed = false;
      /** Rendre la connexion, une seule fois, propre ou détruite. */
      const hand = (destroy: boolean): void => {
        if (handed) return;
        handed = true;
        client.release(destroy);
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Le `SET` fait partie du travail surveillé : une connexion muette
        // l'est dès le premier octet, pas seulement sur la vraie question.
        const work = (async () => {
          if (client[APPLIED_TIMEOUT] !== budgetMs) {
            await client.query(`SET statement_timeout = ${budgetMs}`);
            client[APPLIED_TIMEOUT] = budgetMs;
          }
          return client.query(text, [...params]);
        })();

        const result = await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // On détruit AVANT de rejeter : la place doit être libre au
              // moment où l'appelant apprend l'échec, pas après qu'il ait
              // relancé.
              hand(true);
              options.onConnectionDestroyed?.({ budgetMs });
              reject(new SqlConnectionMuteError(budgetMs, graceMs));
            }, budgetMs + graceMs);
          }),
        ]);
        return { rows: result.rows };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        // Le cas normal, y compris quand le serveur a coupé lui-même : la
        // connexion revient à la pool, utilisable tout de suite.
        hand(false);
      }
    },
  };
}

function budgetOf(ms: number): number {
  return Math.max(MIN_BUDGET_MS, Math.round(ms));
}
