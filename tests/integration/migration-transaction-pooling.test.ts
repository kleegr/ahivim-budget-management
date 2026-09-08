import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { closeTestPool, hasTestDatabase, testPool } from "../support/database";
import { MIGRATION_ADVISORY_LOCK, MigrationLockUnavailableError, runMigrations } from "@/lib/db/migrate";

const fixture = vi.hoisted(() => ({ migrations: [] as Array<{ name: string; sql: string }> }));
vi.mock("@/lib/db/migrations.generated", () => ({ MIGRATIONS: fixture.migrations }));

const suite = hasTestDatabase ? describe : describe.skip;
const base = { name: "0000_pooling_base.sql", sql: "CREATE TABLE pooling_facts (id integer PRIMARY KEY, note text); INSERT INTO pooling_facts VALUES (1, 'retained');" };
const next = { name: "0001_pooling_next.sql", sql: "ALTER TABLE pooling_facts ADD COLUMN label text; INSERT INTO pooling_facts VALUES (2, 'next', 'new');" };
const last = { name: "0002_pooling_last.sql", sql: "INSERT INTO pooling_facts VALUES (3, 'last', 'new');" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Real PostgreSQL backends rotate after autocommit and remain pinned in BEGIN. */
async function transactionPool(afterQuery?: (sql: string, params: unknown[]) => Promise<void>) {
  const backends = await Promise.all([testPool().connect(), testPool().connect()]);
  const available = [...backends];
  const waiting: Array<(backend: PgLikeClient) => void> = [];
  const observations: Array<{ sql: string; pid: number; locked: boolean }> = [];
  const lease = () => available.length
    ? Promise.resolve(available.shift()!)
    : new Promise<PgLikeClient>((done) => waiting.push(done));
  const giveBack = (backend: PgLikeClient) => {
    const waiter = waiting.shift();
    if (waiter) waiter(backend); else available.push(backend);
  };
  const pooled: PgLikePool = {
    async query<T>(sql: string, params: unknown[] = []) {
      const client = await pooled.connect();
      try { return await client.query<T>(sql, params); } finally { client.release(); }
    },
    async connect() {
      let pinned: PgLikeClient | null = null;
      return {
        async query<T>(sql: string, params: unknown[] = []) {
          const backend = pinned ?? await lease();
          const starts = /^\s*BEGIN\b/i.test(sql);
          const ends = /^\s*(COMMIT|ROLLBACK)\b/i.test(sql);
          try {
            if (!starts && !ends && !/pg_(try_)?advisory_(xact_)?(lock|unlock)/i.test(sql)) {
              const observed = await backend.query<{ pid: number; locked: boolean }>(
                `SELECT pg_backend_pid() AS pid, EXISTS (
                  SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
                    AND classid = 0 AND objid = $1::oid AND objsubid = 1 AND granted
                ) AS locked`, [MIGRATION_ADVISORY_LOCK],
              );
              observations.push({ sql, ...observed.rows[0] });
            }
            const result = await backend.query<T>(sql, params);
            if (starts) pinned = backend;
            return result;
          } finally {
            if (ends) pinned = null;
            if (!pinned) giveBack(backend);
            if (afterQuery) await afterQuery(sql, params);
          }
        },
        release() {
          if (pinned) throw new Error("Logical connection released with an open transaction");
        },
      };
    },
  };
  return { pool: pooled, observations, async close() {
    for (const backend of backends) {
      // Also clean up a session lock left by the pre-fix runner during red tests.
      await backend.query("ROLLBACK");
      await backend.query("SELECT pg_advisory_unlock_all()");
      backend.release();
    }
  } };
}

suite("migration transaction-pooling integrity (real PostgreSQL)", () => {
  beforeEach(async () => {
    await testPool().query("DROP SCHEMA IF EXISTS public CASCADE");
    await testPool().query("CREATE SCHEMA public");
    fixture.migrations.splice(0, fixture.migrations.length, base, next, last);
  });
  afterAll(closeTestPool);

  it("holds the lock on every ledger and DDL backend through all pending files", async () => {
    const proxy = await transactionPool();
    try {
      expect(await runMigrations(proxy.pool)).toMatchObject({ applied: 3, skipped: 0 });
      expect(proxy.observations.length).toBeGreaterThan(5);
      expect(proxy.observations.filter((row) => !row.locked)).toEqual([]);
      expect(new Set(proxy.observations.map((row) => row.pid)).size).toBe(1);
      expect((await testPool().query("SELECT id FROM pooling_facts ORDER BY id")).rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    } finally { await proxy.close(); }
  });

  it("fails a nonblocking contender before reading or changing a behind ledger, then retries", async () => {
    const holder = await testPool().connect();
    const proxy = await transactionPool();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_ADVISORY_LOCK]);
      await expect(runMigrations(proxy.pool, { waitForLock: false })).rejects.toBeInstanceOf(MigrationLockUnavailableError);
      expect(proxy.observations).toEqual([]);
      expect((await testPool().query("SELECT to_regclass('_ahivim_migrations') AS ledger")).rows).toEqual([{ ledger: null }]);
      await holder.query("ROLLBACK");
      expect(await runMigrations(proxy.pool, { waitForLock: false })).toMatchObject({ applied: 3, skipped: 0 });
    } finally { await holder.query("ROLLBACK"); holder.release(); await proxy.close(); }
  });

  it("serializes pooled contenders and publishes all pending schema and ledger rows only at commit", async () => {
    const firstRecorded = deferred();
    const releaseFirst = deferred();
    let paused = false;
    const proxy = await transactionPool(async (sql, params) => {
      if (!paused && sql.includes("INSERT INTO _ahivim_migrations") && params[0] === base.name) {
        paused = true; firstRecorded.resolve(); await releaseFirst.promise;
      }
    });
    const first = runMigrations(proxy.pool);
    let second: ReturnType<typeof runMigrations> | null = null;
    try {
      await Promise.race([firstRecorded.promise, first.then(() => { throw new Error("Holder finished before its pause"); })]);
      expect((await testPool().query("SELECT to_regclass('_ahivim_migrations') AS ledger")).rows).toEqual([{ ledger: null }]);
      second = runMigrations(proxy.pool);
      await expect.poll(async () => (await testPool().query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory'
          AND classid = 0 AND objid = $1::oid AND objsubid = 1 AND NOT granted`, [MIGRATION_ADVISORY_LOCK],
      )).rows[0].count).toBe(1);
      releaseFirst.resolve();
      expect(await first).toMatchObject({ applied: 3, skipped: 0 });
      expect(await second).toMatchObject({ applied: 0, skipped: 3 });
      expect((await testPool().query("SELECT count(*)::int AS count FROM _ahivim_migrations")).rows).toEqual([{ count: 3 }]);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      await proxy.close();
    }
  });

  it("rolls back every pending file on failure while preserving prior history and allowing a clean retry", async () => {
    fixture.migrations.splice(1);
    await runMigrations(testPool());
    const before = (await testPool().query("SELECT to_jsonb(t)::text AS fact FROM pooling_facts t ORDER BY id")).rows;
    const ledger = (await testPool().query("SELECT to_jsonb(t)::text AS fact FROM _ahivim_migrations t ORDER BY name")).rows;
    fixture.migrations.push(next, { ...last, sql: "SELECT 1 / 0" });
    const proxy = await transactionPool();
    try {
      await expect(runMigrations(proxy.pool)).rejects.toThrow(/0002_pooling_last.*rolled back/);
      expect((await testPool().query("SELECT to_jsonb(t)::text AS fact FROM pooling_facts t ORDER BY id")).rows).toEqual(before);
      expect((await testPool().query("SELECT to_jsonb(t)::text AS fact FROM _ahivim_migrations t ORDER BY name")).rows).toEqual(ledger);
      fixture.migrations[2] = last;
      expect(await runMigrations(proxy.pool)).toMatchObject({ applied: 2, skipped: 1 });
      expect(await runMigrations(proxy.pool)).toMatchObject({ applied: 0, skipped: 3 });
      expect((await testPool().query("SELECT id FROM pooling_facts ORDER BY id")).rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    } finally { await proxy.close(); }
  });

  it("replays an uncertain commit without duplicating committed schema or history", async () => {
    let loseResponse = true;
    const pool: PgLikePool = {
      query: testPool().query.bind(testPool()),
      async connect() {
        const backend = await testPool().connect();
        return {
          async query<T>(sql: string, params?: unknown[]) {
            const result = await backend.query<T>(sql, params);
            if (sql === "COMMIT" && loseResponse) {
              loseResponse = false;
              throw Object.assign(new Error("Simulated lost COMMIT response"), { code: "ECONNRESET" });
            }
            return result;
          },
          release: backend.release.bind(backend),
        };
      },
    };
    await expect(runMigrations(pool)).rejects.toThrow(/lost COMMIT response/);
    const before = (await testPool().query("SELECT to_jsonb(t)::text AS fact FROM _ahivim_migrations t ORDER BY name")).rows;
    expect(before).toHaveLength(3);
    expect(await runMigrations(pool)).toMatchObject({ applied: 0, skipped: 3 });
    expect((await testPool().query("SELECT to_jsonb(t)::text AS fact FROM _ahivim_migrations t ORDER BY name")).rows).toEqual(before);
    expect((await testPool().query("SELECT id FROM pooling_facts ORDER BY id")).rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("discards a connection when rollback fails so its transaction and lock cannot be reused", async () => {
    fixture.migrations[2] = { ...last, sql: "SELECT 1 / 0" };
    let discarded = false;
    const pool: PgLikePool = {
      query: testPool().query.bind(testPool()),
      async connect() {
        const backend = await testPool().connect();
        return {
          async query<T>(sql: string, params?: unknown[]) {
            if (sql === "ROLLBACK") throw new Error("Simulated failed rollback transport");
            return backend.query<T>(sql, params);
          },
          release(error?: Error | boolean) {
            discarded = Boolean(error);
            backend.release(error);
          },
        };
      },
    };
    await expect(runMigrations(pool)).rejects.toThrow(/0002_pooling_last/);
    expect(discarded).toBe(true);
    expect((await testPool().query("SELECT to_regclass('_ahivim_migrations') AS ledger")).rows).toEqual([{ ledger: null }]);
    fixture.migrations[2] = last;
    expect(await runMigrations(testPool(), { waitForLock: false })).toMatchObject({ applied: 3, skipped: 0 });
  });
});
