import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { changeQuantityAuthorization, listQuantityAuthorizations } from "@/lib/manage/quantity-authorizations";
import { testPool, resetSchema, truncateBusinessTables, hasTestDatabase, closeTestPool } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const actor = "00000000-0000-4000-8000-000000000001";
function unwrap<T>(result: { ok: true; data: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

suite("quantity balance and history consistency on disposable PostgreSQL", () => {
  beforeAll(resetSchema, 60_000);
  afterAll(closeTestPool);
  beforeEach(async () => {
    await truncateBusinessTables();
    await testPool().query("INSERT INTO users(id,email,display_name,password_hash,role) VALUES($1,'quantity@synthetic.test','Quantity Owner','x','admin')", [actor]);
  });

  it("keeps balance and events in one snapshot when usage commits immediately after its first read", async () => {
    const pool = testPool(), person = randomUUID();
    await pool.query("INSERT INTO individuals(id,display_name,normalized_name) VALUES($1,'Snapshot Person',$2)", [person, person]);
    const program = (await pool.query<{ id: string }>("SELECT id FROM programs WHERE code='COM_HAB'")).rows[0]!.id;
    const { id } = unwrap(await changeQuantityAuthorization(pool, person, {
      action: "create", requestId: randomUUID(), programId: program, unitLabel: "visits", authorized: "10",
      startDate: "2026-09-01", endDate: "2026-09-30", reason: "Approved ten completed visits",
    }, actor));
    let statements = 0;
    const readPool = {
      query: async (sql: string, values?: unknown[]) => {
        const result = await pool.query(sql, values);
        if (++statements === 1) {
          unwrap(await changeQuantityAuthorization(pool, person, {
            action: "consume", requestId: randomUUID(), id, expectedRevision: 1,
            serviceDate: "2026-09-09", quantity: "3", evidence: "Signed three visits", reason: "Verified completed visits",
          }, actor, { asOf: "2026-09-09" }));
        }
        return result;
      },
    } as Pick<PgLikePool, "query">;
    const snapshot = (await listQuantityAuthorizations(readPool, person))[0]!;
    expect(snapshot).toMatchObject({ used: "0", remaining: "10.0000", events: [], revision: 1 });
    expect(statements).toBe(1);
    const refreshed = (await listQuantityAuthorizations(pool, person))[0]!;
    expect(refreshed).toMatchObject({ used: "3.0000", remaining: "7.0000" });
    expect(refreshed.events.map(event => event.quantity)).toEqual(["3.0000"]);
  });
});
