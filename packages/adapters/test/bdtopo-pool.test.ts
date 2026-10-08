/**
 * LE CONTRAT D'ANNULATION, ÉNONCÉ COMME UN TEST.
 *
 * Le défaut corrigé (la note de conception interne) n'était pas une
 * lenteur, c'était un engrenage : un abandon client laissait une requête vivre
 * côté serveur, la connexion restait prise jusqu'au `statement_timeout` de la
 * pool, les suivantes s'empilaient, et le disjoncteur finissait par priver
 * l'adresse ENTIÈRE de ses largeurs BD TOPO — Paris 11e, de ~150 voies greffées
 * à 0.
 *
 * Le faux serveur ci-dessous est donc écrit pour reproduire l'engrenage, pas
 * pour le contourner : il a un nombre FINI de connexions, il HONORE le
 * `statement_timeout` qu'on lui pose, et il sait aussi ne rien honorer du tout
 * (la prise muette). C'est la seule façon de prouver qu'une place se libère.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBdtopoSqlClient,
  isStatementTimeout,
  PG_QUERY_CANCELED,
  SqlConnectionMuteError,
  type PooledSqlConnection,
  type SqlConnectionPool,
} from '../src/bdtopo-pool.js';

/** L'erreur que PostgreSQL rend quand il coupe lui-même. */
class QueryCanceled extends Error {
  readonly code = PG_QUERY_CANCELED;
  constructor() {
    super('canceling statement due to statement timeout');
  }
}

interface FakeConnection extends PooledSqlConnection {
  readonly id: number;
  readonly sent: string[];
  /** Posé par `release(true)` : la connexion est sortie du monde. */
  destroyed: boolean;
  released: boolean;
}

/**
 * Une pool qui se bouche vraiment.
 *
 * `max` connexions ; au-delà, `connect()` attend qu'une place se libère —
 * exactement ce que fait `pg-pool`, et exactement ce qui n'arrivait jamais
 * avant le correctif, parce qu'aucune place ne se libérait.
 */
class FakePool implements SqlConnectionPool {
  /** Toutes celles qui ont été ouvertes, y compris les détruites. */
  readonly opened: FakeConnection[] = [];
  /** Rendues et réutilisables — c'est par là que le budget se mémorise. */
  private readonly idle: FakeConnection[] = [];
  /** Combien de connexions sont sorties et pas encore rendues. */
  private held = 0;
  private readonly waiting: (() => void)[] = [];
  private nextId = 1;

  constructor(
    private readonly max: number,
    /** Ce que le serveur fait de la question, une fois le budget posé. */
    private readonly answer: (connection: FakeConnection, text: string) => Promise<unknown[]>,
  ) {}

  async connect(): Promise<PooledSqlConnection> {
    while (this.held >= this.max && this.idle.length === 0) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.held += 1;
    const reused = this.idle.pop();
    if (reused !== undefined) {
      reused.released = false;
      return reused;
    }
    return this.open();
  }

  private open(): FakeConnection {
    const pool = this;
    const connection: FakeConnection = {
      id: this.nextId++,
      sent: [],
      destroyed: false,
      released: false,
      async query(text: string): Promise<{ readonly rows: readonly unknown[] }> {
        connection.sent.push(text);
        if (text.startsWith('SET ')) return { rows: [] };
        return { rows: await pool.answer(connection, text) };
      },
      release(destroy?: boolean): void {
        if (connection.released) throw new Error('released twice');
        connection.released = true;
        pool.held -= 1;
        // `release(true)` la sort du monde : elle ne retourne pas au vivier,
        // et la place qu'elle occupait est rendue tout de suite.
        if (destroy === true) connection.destroyed = true;
        else pool.idle.push(connection);
        pool.waiting.shift()?.();
      },
    };
    this.opened.push(connection);
    return connection;
  }

  /** Combien de places sont prises en ce moment. */
  get inUse(): number {
    return this.held;
  }
}

/** Le budget que la connexion porte, lu dans ce qu'on lui a envoyé. */
function budgetOn(connection: FakeConnection): number | null {
  const last = [...connection.sent].reverse().find((text) => text.startsWith('SET '));
  if (last === undefined) return null;
  return Number(last.replace('SET statement_timeout = ', ''));
}

/**
 * Un serveur qui honore son `statement_timeout` : il travaille `workMs`, et si
 * le budget tombe avant, il rend `57014` — comme PostgreSQL.
 */
function honestServer(workMs: number) {
  return async (connection: FakeConnection): Promise<unknown[]> => {
    const budget = budgetOn(connection) ?? Number.POSITIVE_INFINITY;
    const cutAt = Math.min(workMs, budget);
    await new Promise<void>((resolve) => setTimeout(resolve, cutAt));
    if (budget <= workMs) throw new QueryCanceled();
    return [{ ok: true }];
  };
}

const OPTIONS = { defaultTimeoutMs: 2_500, graceMs: 500 };

describe('createBdtopoSqlClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pose le budget sur la connexion, puis ne le repose plus', async () => {
    // Un aller-retour par CONNEXION, pas par requête : le chemin chaud de la
    // greffe (des dizaines de corridors par adresse) n'en paie aucun.
    const pool = new FakePool(1, honestServer(10));
    const sql = createBdtopoSqlClient(pool, OPTIONS);

    await vi.advanceTimersByTimeAsync(0);
    const first = sql.query('select 1', []);
    await vi.advanceTimersByTimeAsync(20);
    await first;
    const second = sql.query('select 2', []);
    await vi.advanceTimersByTimeAsync(20);
    await second;

    const connection = pool.opened[0];
    expect(connection?.sent.filter((t) => t.startsWith('SET '))).toEqual([
      'SET statement_timeout = 2500',
    ]);
    expect(connection?.sent).toHaveLength(3);
  });

  it('repose le budget quand l’appelant en demande un autre', async () => {
    // Les bâtiments (1 500 ms) et la greffe (2 500 ms) partagent cette pool.
    const pool = new FakePool(1, honestServer(10));
    const sql = createBdtopoSqlClient(pool, OPTIONS);

    const first = sql.query('select 1', [], { timeoutMs: 1_500 });
    await vi.advanceTimersByTimeAsync(20);
    await first;
    const second = sql.query('select 2', []);
    await vi.advanceTimersByTimeAsync(20);
    await second;

    expect(pool.opened[0]?.sent.filter((t) => t.startsWith('SET '))).toEqual([
      'SET statement_timeout = 1500',
      'SET statement_timeout = 2500',
    ]);
  });

  it('au budget, le SERVEUR coupe et la connexion revient VIVANTE à la pool', async () => {
    // Le cœur du correctif. Avant : la place restait prise 5 s (le
    // `statement_timeout` de pool) pour une requête abandonnée à 2,5 s.
    const pool = new FakePool(8, honestServer(60_000));
    const sql = createBdtopoSqlClient(pool, OPTIONS);

    const pending = sql.query('select pg_sleep(60)', []);
    const seen = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_500);
    const error = await seen;

    expect(isStatementTimeout(error)).toBe(true);
    expect((error as { code?: string }).code).toBe(PG_QUERY_CANCELED);
    // Rendue, pas détruite : une connexion coupée par le serveur est propre.
    expect(pool.opened[0]?.destroyed).toBe(false);
    expect(pool.inUse).toBe(0);
  });

  it('les requêtes suivantes ne s’empilent pas derrière une requête trop lourde', async () => {
    // L'engrenage du §7.4, reproduit : UNE connexion, trois corridors trop
    // lourds. Chacun doit rendre sa place à son budget, donc les trois doivent
    // être répondus en ~3 × 2,5 s — et non jamais, comme avant, où la première
    // gardait la place et les deux autres expiraient à l'acquisition.
    const pool = new FakePool(1, honestServer(60_000));
    const sql = createBdtopoSqlClient(pool, OPTIONS);
    const started = Date.now();

    const done: number[] = [];
    const three = [0, 1, 2].map((i) =>
      sql
        .query(`select ${i}`, [])
        .catch(() => undefined)
        .then(() => done.push(Date.now() - started)),
    );

    await vi.advanceTimersByTimeAsync(3 * 2_500 + 10);
    await Promise.all(three);

    expect(done).toEqual([2_500, 5_000, 7_500]);
    expect(pool.inUse).toBe(0);
    // Aucune destruction : le serveur a parlé les trois fois.
    expect(pool.opened.every((c) => !c.destroyed)).toBe(true);
  });

  it('une prise muette est DÉTRUITE au filet, et la place est libre aussitôt', async () => {
    // Le serveur ne peut couper que s'il parle encore. Ici il ne parle plus du
    // tout : le filet à budget + grâce sort la connexion du monde plutôt que
    // de rendre un fantôme à la pool.
    const pool = new FakePool(1, () => new Promise<unknown[]>(() => {}));
    const destroyed: number[] = [];
    const sql = createBdtopoSqlClient(pool, {
      ...OPTIONS,
      onConnectionDestroyed: ({ budgetMs }) => destroyed.push(budgetMs),
    });

    const pending = sql.query('select 1', []);
    const seen = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_499);
    expect(pool.inUse).toBe(1);
    await vi.advanceTimersByTimeAsync(501);

    const error = await seen;
    expect(error).toBeInstanceOf(SqlConnectionMuteError);
    expect(pool.opened[0]?.destroyed).toBe(true);
    expect(pool.inUse).toBe(0);
    expect(destroyed).toEqual([2_500]);

    // Et la place libérée sert : la requête suivante obtient une connexion
    // NEUVE sans attendre que la précédente daigne répondre.
    const next = sql.query('select 2', []);
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.opened).toHaveLength(2);
    void next.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(3_000);
  });

  it('le filet tombe APRÈS le serveur, jamais avant', async () => {
    // La cohérence des deux délais : si le filet tombait le premier on serait
    // revenu au défaut — abandonner sans annuler.
    const pool = new FakePool(1, honestServer(60_000));
    const sql = createBdtopoSqlClient(pool, OPTIONS);

    const seen = sql.query('select 1', []).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_500);

    // Le serveur a répondu à 2 500, le filet était armé à 3 000.
    expect((await seen) instanceof SqlConnectionMuteError).toBe(false);
    expect(pool.opened[0]?.destroyed).toBe(false);
  });

  it('un budget absurde est ramené à un budget', async () => {
    // `statement_timeout = 0` veut dire « aucune limite » : c'est exactement le
    // défaut qu'on corrige, il ne doit pas pouvoir rentrer par la fenêtre.
    const pool = new FakePool(1, honestServer(1));
    const sql = createBdtopoSqlClient(pool, OPTIONS);

    const pending = sql.query('select 1', [], { timeoutMs: 0 });
    await vi.advanceTimersByTimeAsync(10);
    await pending;

    expect(budgetOn(pool.opened[0] as FakeConnection)).toBe(50);
  });
});
