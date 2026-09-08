import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fullAccess, type AccessScope } from "@/lib/auth/access";
import { createAuthorization, createBudgetPeriod } from "@/lib/manage/authorizations";
import { createIndividual } from "@/lib/manage/individuals";
import { closeTestPool, hasTestDatabase, resetSchema, testPool, truncateBusinessTables } from "../support/database";

const boundary = vi.hoisted(() => ({ operator: vi.fn() }));
vi.mock("@/lib/auth/hour-authorization-access", async (original) => ({
  ...await original<typeof import("@/lib/auth/hour-authorization-access")>(),
  getHourAuthorizationOperator: boundary.operator,
}));
import { PATCH } from "@/app/api/authorizations/[id]/route";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "a1000000-0000-4000-8000-000000000001";
const PRIVATE_NOTE = "PRIVATE-OWNER-FINANCIAL-NOTE-987654.32";
let authorizationId: string;
let periodId: string;
let programId: string;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

async function change(body: Record<string, unknown>) {
  return PATCH(new NextRequest(`http://localhost/api/authorizations/${authorizationId}`, {
    method: "PATCH", headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ reason: "Planner boundary verification", ...body }),
  }), { params: Promise.resolve({ id: authorizationId }) });
}

async function state() {
  return (await testPool().query(
    "SELECT id, status, authorized_hours, archived_at FROM budget_authorizations ORDER BY id",
  )).rows;
}

suite("planner authorization handlers with PostgreSQL resource checks", () => {
  beforeAll(resetSchema, 60_000);
  afterAll(closeTestPool);
  beforeEach(async () => {
    await truncateBusinessTables();
    const pool = testPool();
    await pool.query("INSERT INTO users(id,email,display_name,password_hash,role) VALUES($1,'planner-boundary@ahivim.test','Planner','x','viewer')", [ACTOR]);
    await pool.query("UPDATE programs SET is_active = true WHERE code = 'SH_COM_HAB'");
    const person = unwrap(await createIndividual(pool, { displayName: "Planner allowed person" }, ACTOR));
    const period = unwrap(await createBudgetPeriod(pool, {
      individualId: person.id, label: "Planner boundary period", startDate: "2026-01-01", endDate: "2026-12-31",
    }, ACTOR));
    periodId = period.id;
    programId = (await pool.query<{ id: string }>("SELECT id FROM programs WHERE code = 'SH_COM_HAB'")).rows[0]!.id;
    authorizationId = unwrap(await createAuthorization(pool, { budgetPeriodId: periodId, programId, authorizedHours: "100", notes: PRIVATE_NOTE }, ACTOR)).id;
    const scope: AccessScope = {
      ...fullAccess(ACTOR, "viewer"), full: false, canSeeMoney: false, canSeeTransactions: false,
      allIndividuals: false, individualIds: [person.id], grantedIndividualIds: [person.id],
    };
    boundary.operator.mockResolvedValue({ user: { id: ACTOR, role: "viewer" }, pool, scope, mode: "hours_only" });
  });

  it("allows an active hour revision and strips financial values from its actual response", async () => {
    const response = await change({ authorizedHours: "120" });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
    expect(Number(json.data.authorizedHours)).toBe(120);
    expect(JSON.stringify(json)).not.toContain(PRIVATE_NOTE);
    for (const key of ["authorizedDollars", "internalRate", "agencyRate", "individualRateOverride"]) expect(json.data[key]).toBeNull();
    expect((await state()).filter(row => row.status === "active")).toHaveLength(1);
  });

  it("allows active cancellation without echoing inherited private notes", async () => {
    const response = await change({ action: "cancel" });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(PRIVATE_NOTE);
    expect((await state())[0]!.status).toBe("cancelled");
  });

  it.each([
    ["closed period", "UPDATE budget_periods SET status = 'closed' WHERE id = $1", "period"],
    ["archived period", "UPDATE budget_periods SET archived_at = now() WHERE id = $1", "period"],
    ["archived authorization", "UPDATE budget_authorizations SET archived_at = now() WHERE id = $1", "authorization"],
    ["inactive program", "UPDATE programs SET is_active = false WHERE id = $1", "program"],
  ])("rejects cancel of %s without modifying business state", async (_name, sql, entity) => {
    await testPool().query(sql, [entity === "period" ? periodId : entity === "program" ? programId : authorizationId]);
    const before = await state();
    expect((await change({ action: "cancel" })).status).toBe(404);
    expect(await state()).toEqual(before);
  });

  it("rejects injected money without revising any authorization", async () => {
    const before = await state();
    expect((await change({ authorizedHours: "120", internalRate: "999123.45" })).status).toBe(403);
    expect(await state()).toEqual(before);
  });

  it("rejects another person's ID without changing either record", async () => {
    const operator = await boundary.operator();
    operator.scope.individualIds = [];
    operator.scope.grantedIndividualIds = [];
    const before = await state();
    expect((await change({ action: "cancel" })).status).toBe(404);
    expect(await state()).toEqual(before);
  });
});
