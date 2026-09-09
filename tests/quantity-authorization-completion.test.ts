import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { changeQuantityAuthorization } from "@/lib/manage/quantity-authorizations";

vi.mock("@/lib/manage/audit", () => ({ recordChange: vi.fn(async () => undefined) }));

const person = "10000000-0000-4000-8000-000000000001";
const id = "20000000-0000-4000-8000-000000000001";
const actor = "30000000-0000-4000-8000-000000000001";
function fixture() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM quantity_authorizations WHERE")) return { rows: [{ id, revision: 1, start_date: "2026-09-01", end_date: "2026-09-30", unit_label: "visits" }] };
    if (sql.includes("FROM quantity_usage_events WHERE id=")) return { rows: [{ id: "40000000-0000-4000-8000-000000000001", quantity: "2.0000", service_date: "2026-09-10", evidence_reference: "Original signed visit" }] };
    return { rows: [] };
  });
  const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as PgLikePool;
  const input = { action: "consume", requestId: randomUUID(), id, expectedRevision: 1, serviceDate: "2026-09-10", quantity: "2", evidence: "Signed visit record", reason: "Verified completed visits" };
  return { pool, query, input };
}

afterEach(() => vi.useRealTimers());
describe("verified quantity completion date", () => {
  it("uses New York's business date when UTC has already reached tomorrow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T02:00:00Z"));
    const { pool, query, input } = fixture();
    const result = await changeQuantityAuthorization(pool, person, input, actor);
    expect(result).toMatchObject({ ok: false, code: "validation", message: "Completed quantity cannot use a future service date." });
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO quantity_usage_events"))).toBe(false);
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it("accepts completed usage through the explicit business date", async () => {
    const { pool, query, input } = fixture();
    expect(await changeQuantityAuthorization(pool, person, input, actor, { asOf: "2026-09-10" })).toMatchObject({ ok: true, data: { id } });
    expect(query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO quantity_usage_events"))).toHaveLength(1);
  });

  it("allows reversal of a historical future-dated mistake without creating new positive usage", async () => {
    const { pool, query, input } = fixture();
    expect(await changeQuantityAuthorization(pool, person, { ...input, action: "reverse", eventId: "40000000-0000-4000-8000-000000000001" }, actor, { asOf: "2026-09-09" })).toMatchObject({ ok: true });
    const insert = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO quantity_usage_events"));
    expect(insert).toBeDefined();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO quantity_usage_events"), expect.arrayContaining(["-2.0000"]));
  });
});
