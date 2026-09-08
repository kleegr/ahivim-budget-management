import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { closeTestPool, hasTestDatabase, resetSchema, testPool, truncateBusinessTables } from "../support/database";

const cookieValues = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (key: string) => cookieValues.has(key) ? { value: cookieValues.get(key) } : undefined,
  set: (key: string, value: string) => { cookieValues.set(key, value); },
}) }));
vi.mock("@/lib/db", () => ({ getPool: () => testPool() }));

import { POST as createAccount, GET as listAccounts } from "@/app/api/admin/users/route";
import { PATCH as editAccount } from "@/app/api/admin/users/[id]/route";
import { POST as startAs } from "@/app/api/auth/impersonation/start/route";
import { POST as returnAs } from "@/app/api/auth/impersonation/stop/route";
import { authenticate, createUser, findUserById, getUserAccessConfig, setUserPassword, updateManagedUser } from "@/lib/auth/users";
import { currentUser, createSessionCookie, SESSION_COOKIE } from "@/lib/auth/session";
import { resolveAccessScope } from "@/lib/auth/access";
import { ACCOUNT_PRESETS } from "@/lib/auth/account-presets";
import { signSession } from "@/lib/auth/crypto";
import { resolvePortalAccess } from "@/lib/auth/portal-access";
import { GET as individualProfile } from "@/app/api/individuals/[id]/route";
import { GET as portalHome } from "@/app/api/portal/access/route";
import { GET as individualStatement } from "@/app/api/portal/individual-statements/route";

const suite = hasTestDatabase ? describe : describe.skip;
const PASSWORD = "isolated role test password";
function request(path: string, body: Record<string, unknown>, method = "POST") {
  return new NextRequest(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
async function owner() {
  const created = await createUser(testPool(), { email: "owner@roles.test", displayName: "Owner", password: PASSWORD, role: "admin" }, null);
  if (!created.ok) throw new Error("Owner seed failed");
  await createSessionCookie(created.user);
  return created.user;
}
async function provision(preset: string, extra: Record<string, unknown> = {}) {
  const response = await createAccount(request("/api/admin/users", {
    preset, email: `${preset}@roles.test`, displayName: preset, password: PASSWORD, ...extra,
  }));
  expect(response.status).toBe(201);
  const body = await response.json();
  return body.user.id as string;
}
async function signIn(id: string) {
  const record = await findUserById(testPool(), id);
  if (!record) throw new Error("Missing login");
  cookieValues.clear();
  const result = await authenticate(testPool(), record.email, PASSWORD);
  expect(result.ok).toBe(true);
  if (result.ok) await createSessionCookie(result.user);
}

suite("account lifecycle authorization through real handlers and PostgreSQL", () => {
  beforeAll(async () => { process.env.AUTH_SECRET = "isolated-auth-lifecycle-secret"; await resetSchema(); }, 60_000);
  beforeEach(async () => { cookieValues.clear(); await truncateBusinessTables(); });
  afterAll(closeTestPool);

  it("applies preset-only changes and preserves unrelated grants in a partial denial", async () => {
    await owner();
    const id = await provision("money_collector");
    expect((await getUserAccessConfig(testPool(), id))?.canSeeMoney).toBe(true);
    expect((await editAccount(request(`/api/admin/users/${id}`, { preset: "budget_planner" }, "PATCH"), { params: Promise.resolve({ id }) })).status).toBe(200);
    expect(await getUserAccessConfig(testPool(), id)).toMatchObject({ canSeeMoney: false, canSeeTransactions: false, canPlan: true, canSeeBudgets: true });
    expect((await editAccount(request(`/api/admin/users/${id}`, { canSeeBudgets: false }, "PATCH"), { params: Promise.resolve({ id }) })).status).toBe(200);
    expect(await getUserAccessConfig(testPool(), id)).toMatchObject({ canPlan: true, canSeeHours: true, canSeeBudgets: false, canSeeMoney: false });
    expect((await editAccount(request(`/api/admin/users/${id}`, { preset: "custom_access" }, "PATCH"), { params: Promise.resolve({ id }) })).status).toBe(200);
    expect(await getUserAccessConfig(testPool(), id)).toMatchObject({ canPlan: false, canSeeMoney: false, seeAllIndividuals: false, seeAllEmployees: false });
  });

  it("provisions all roles, rejects every non-owner at user administration, and retains direct-login identity", async () => {
    const actor = await owner();
    const individual = (await testPool().query<{ id: string }>("INSERT INTO individuals (normalized_name, display_name) VALUES ('direct', 'Direct') RETURNING id")).rows[0]!.id;
    const employee = (await testPool().query<{ id: string }>("INSERT INTO employees (normalized_name, display_name) VALUES ('employee', 'Employee') RETURNING id")).rows[0]!.id;
    const agency = (await testPool().query<{ id: string }>("INSERT INTO agencies (code, name) VALUES ('TEST', 'Test') RETURNING id")).rows[0]!.id;
    for (const preset of ACCOUNT_PRESETS.filter((value) => value.id !== "owner")) {
      await signIn(actor.id);
      const id = await provision(preset.id, { individualId: individual, relationship: "parent", employeeId: employee, agencyId: agency });
      await signIn(id);
      expect(await currentUser()).toMatchObject({ id, role: preset.role, accountPreset: preset.id });
      expect((await listAccounts()).status).toBe(403);
      expect((await createAccount(request("/api/admin/users", { preset: "owner", role: "admin", owner: true }))).status).toBe(403);
      expect((await editAccount(request(`/api/admin/users/${id}`, { role: "admin" }, "PATCH"), { params: Promise.resolve({ id }) })).status).toBe(403);
      expect((await startAs(request("/api/auth/impersonation/start", { targetUserId: actor.id }))).status).toBe(403);
    }
  }, 30_000);

  it("atomically creates multiple direct relationships and rolls everything back if the second person is invalid", async () => {
    await owner();
    const people = (await testPool().query<{ id: string }>("INSERT INTO individuals (normalized_name, display_name) VALUES ('first', 'First'), ('second', 'Second') RETURNING id")).rows;
    const id = await provision("individual_parent", { individuals: people.map(({ id }) => ({ individualId: id, relationship: "guardian" })) });
    expect((await testPool().query("SELECT individual_id FROM user_individual_relationships WHERE user_id = $1", [id])).rows).toHaveLength(2);
    expect((await testPool().query("SELECT individual_id FROM user_individual_access WHERE user_id = $1", [id])).rows).toHaveLength(0);
    const invalid = await createAccount(request("/api/admin/users", { preset: "individual_parent", email: "invalid@roles.test", password: PASSWORD, individuals: [
      { individualId: people[0]!.id, relationship: "parent" },
      { individualId: "00000000-0000-4000-8000-000000000099", relationship: "parent" },
    ] }));
    expect(invalid.status).toBe(404);
    expect((await testPool().query("SELECT id FROM users WHERE email = 'invalid@roles.test'")).rows).toHaveLength(0);
  });

  it("uses live role and active state even when the access caller supplies an owner role", async () => {
    const actor = await owner();
    const id = await provision("custom_access");
    expect(await resolveAccessScope(testPool(), { id, role: "admin" })).toMatchObject({ role: "viewer", full: false, canSeeMoney: false });
    await updateManagedUser(testPool(), id, { isActive: false }, actor.id);
    expect(await resolveAccessScope(testPool(), { id, role: "admin" })).toMatchObject({ full: false, canSeeMoney: false });
  });

  it("serves both directly bound parent profiles through portal handlers and removes them for the same session after a downgrade", async () => {
    const actor = await owner();
    const people = (await testPool().query<{ id: string; display_name: string }>(
      "INSERT INTO individuals (normalized_name, display_name) VALUES ('first bound', 'First bound'), ('second bound', 'Second bound'), ('unrelated', 'Unrelated private') RETURNING id, display_name",
    )).rows;
    const bound = people.filter((person) => person.display_name !== "Unrelated private");
    const unrelated = people.find((person) => person.display_name === "Unrelated private")!;
    const id = await provision("individual_parent", { individuals: bound.map((person) => ({ individualId: person.id, relationship: "parent" })) });
    await signIn(id);
    const parentCookie = cookieValues.get(SESSION_COOKIE)!;
    // Portal relationships never grant the internal profile/workspace API.
    for (const person of people) {
      expect((await individualProfile(new NextRequest(`http://localhost/api/individuals/${person.id}`), { params: Promise.resolve({ id: person.id }) })).status).toBe(404);
    }
    const readPortal = () => portalHome(new NextRequest("http://localhost/api/portal/access?month=2026-09"));
    const statement = (individualId: string) => individualStatement(new NextRequest(`http://localhost/api/portal/individual-statements?individualId=${individualId}&month=2026-09&scope=month`));
    const before = await readPortal();
    expect(before.status).toBe(200);
    const beforeBody = await before.json();
    expect(beforeBody.data.individuals.map((person: { id: string }) => person.id).sort()).toEqual(bound.map((person) => person.id).sort());
    expect(JSON.stringify(beforeBody)).not.toContain(unrelated.display_name);
    for (const person of bound) {
      const response = await statement(person.id);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(person.display_name);
    }
    expect((await statement(unrelated.id)).status).toBe(404);
    await signIn(actor.id);
    expect((await editAccount(request(`/api/admin/users/${id}`, { preset: "custom_access" }, "PATCH"), { params: Promise.resolve({ id }) })).status).toBe(200);
    cookieValues.clear();
    cookieValues.set(SESSION_COOKIE, parentCookie);
    expect((await currentUser())?.id).toBe(id);
    const after = await readPortal();
    expect(after.status).toBe(200);
    expect((await after.json()).data).toMatchObject({ individuals: [], employees: [], agencies: [], globalRoles: [] });
    for (const person of bound) expect((await statement(person.id)).status).toBe(404);
  });

  it.each(["individual_parent", "employee", "agency"])("replaces previous portal authority when switching %s to Custom Access", async (preset) => {
    const actor = await owner();
    const individualId = (await testPool().query<{ id: string }>("INSERT INTO individuals (normalized_name, display_name) VALUES ('bound', 'Bound') RETURNING id")).rows[0]!.id;
    const employeeId = (await testPool().query<{ id: string }>("INSERT INTO employees (normalized_name, display_name) VALUES ('bound', 'Bound') RETURNING id")).rows[0]!.id;
    const agencyId = (await testPool().query<{ id: string }>("INSERT INTO agencies (code, name) VALUES ('BOUND', 'Bound') RETURNING id")).rows[0]!.id;
    const id = await provision(preset, { individualId, employeeId, agencyId, relationship: "parent" });
    await signIn(id);
    const before = await resolvePortalAccess(testPool(), { id });
    expect(before.individualLinks.length + before.employeeLinks.length + before.agencyAccess.length).toBe(1);
    await signIn(actor.id);
    expect((await editAccount(request(`/api/admin/users/${id}`, { preset: "custom_access" }, "PATCH"), { params: Promise.resolve({ id }) })).status).toBe(200);
    const portal = await resolvePortalAccess(testPool(), { id });
    expect(portal.individualLinks).toHaveLength(0);
    expect(portal.employeeLinks).toHaveLength(0);
    expect(portal.agencyAccess).toHaveLength(0);
    expect(portal.globalRoles).toHaveLength(0);
    const table = preset === "individual_parent" ? "user_individual_relationships" : preset === "employee" ? "user_employee_relationships" : "user_agency_access";
    expect((await testPool().query(`SELECT user_id FROM ${table} WHERE user_id = $1 AND is_active = false`, [id])).rows).toHaveLength(1);
    expect((await testPool().query("SELECT id FROM audit_logs WHERE entity_id = $1 AND action = 'user_portal_access_replaced'", [id])).rows).toHaveLength(1);
  });

  it("revokes old login cookies after reset or disable, including after re-enabling", async () => {
    const actor = await owner();
    const id = await provision("budget_planner");
    await signIn(id);
    expect((await currentUser())?.id).toBe(id);
    await updateManagedUser(testPool(), id, { isActive: false }, actor.id);
    expect(await currentUser()).toBeNull();
    await updateManagedUser(testPool(), id, { isActive: true }, actor.id);
    expect(await currentUser()).toBeNull();
    await signIn(id);
    expect((await currentUser())?.id).toBe(id);
    await setUserPassword(testPool(), id, "new isolated password", actor.id);
    expect(await currentUser()).toBeNull();
    cookieValues.set(SESSION_COOKIE, signSession({ userId: id, role: "admin", displayName: "Legacy", exp: Date.now() + 60_000 }));
    expect(await currentUser()).toBeNull();
  });

  it("matches target permissions during Sign In As, records the owner actor, and rejects reset owner return proofs", async () => {
    const actor = await owner();
    const id = await provision("class_billing");
    await signIn(id);
    const direct = await resolveAccessScope(testPool(), (await currentUser())!);
    await signIn(actor.id);
    expect((await startAs(request("/api/auth/impersonation/start", { targetUserId: id }))).status).toBe(200);
    const effective = (await currentUser())!;
    expect(effective).toMatchObject({ id, actorId: actor.id, role: "viewer" });
    expect(await resolveAccessScope(testPool(), effective)).toEqual(direct);
    expect((await listAccounts()).status).toBe(403);
    expect((await startAs(request("/api/auth/impersonation/start", { targetUserId: actor.id }))).status).toBe(403);
    expect((await testPool().query<{ user_id: string }>("SELECT user_id FROM audit_logs WHERE action = 'user_impersonation_started'")).rows[0]?.user_id).toBe(actor.id);
    await setUserPassword(testPool(), actor.id, "replacement owner password", actor.id);
    expect(await currentUser()).toBeNull();
    expect((await returnAs(request("/api/auth/impersonation/stop", {}))).status).toBe(403);
    expect(await currentUser()).toBeNull();
  });
});
