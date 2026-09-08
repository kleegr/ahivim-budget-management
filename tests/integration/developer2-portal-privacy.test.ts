import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";
import { cacheControlDirectives } from "../support/cache-control";
import { canAccessPortalAgencySubject, resolvePortalAccess } from "@/lib/auth/portal-access";
import type { PortalHomeReadModel } from "@/lib/data/portal-read-model";

const session = vi.hoisted(() => ({ userId: "" }));
// Only the HTTP session adapter is replaced. The handlers, identity resolver,
// category checks, response projection, export and all SQL execute unchanged.
vi.mock("@/lib/auth/session", () => ({
  apiUser: async () => session.userId ? { id: session.userId, role: "viewer" } : null,
  requireUser: async () => ({ id: session.userId, role: "viewer" }),
}));
vi.mock("@/lib/db", () => ({ getPool: () => testPool() }));
import { GET as accessGet } from "@/app/api/portal/access/route";
import { GET as statementGet } from "@/app/api/portal/individual-statements/route";
import { POST as individualAccessPost } from "@/app/api/portal/assignments/individuals/route";
import { POST as employeeAccessPost } from "@/app/api/portal/assignments/employees/route";
import { POST as agencyAccessPost } from "@/app/api/agencies/[id]/access/route";
import AgencySettingsPage from "@/app/(app)/settings/agencies/page";
import { CreateButton } from "@/components/manage/client";

const suite = hasTestDatabase ? describe : describe.skip;
const MONTH = "2026-05";
const DAY = `${MONTH}-15`;

async function fixture() {
  const pool = testPool();
  const suffix = randomUUID();
  const insertId = async (sql: string, values: unknown[] = []) =>
    (await pool.query<{ id: string }>(sql, values)).rows[0]!.id;
  const user = async (kind: string) => insertId(
    `INSERT INTO users (email, display_name, password_hash, role)
     VALUES ($1, $2, 'test-only', 'viewer') RETURNING id`, [`${kind}-${suffix}@example.test`, kind],
  );
  const agency = async (name: string) => insertId(
    `INSERT INTO agencies (code, name) VALUES ($1, $2) RETURNING id`, [`${name}-${suffix}`, name],
  );
  const individual = async (name: string) => insertId(
    `INSERT INTO individuals (normalized_name, display_name) VALUES ($1, $2) RETURNING id`,
    [`${name.toLowerCase()}-${suffix}`, name],
  );
  const employee = async (name: string) => insertId(
    `INSERT INTO employees (normalized_name, display_name) VALUES ($1, $2) RETURNING id`,
    [`${name.toLowerCase()}-${suffix}`, name],
  );
  const agencyA = await agency("Agency A");
  const agencyB = await agency("Agency B");
  const personA = await individual("Linked Person A");
  const personB = await individual("Other Agency Person");
  const employeeA = await employee("PRIVATE EMPLOYEE IDENTITY");
  const employeeB = await employee("OUTSIDE EMPLOYEE");
  await pool.query(
    `INSERT INTO agency_individuals (agency_id, individual_id, manages_budget, bills_services, effective_from, effective_to)
     VALUES ($1,$2,false,true,'2026-05-01','2026-05-31'), ($3,$4,false,true,'2026-05-01','2026-05-31')`,
    [agencyA, personA, agencyB, personB],
  );
  await pool.query(
    `INSERT INTO agency_employees (agency_id, employee_id, effective_from, effective_to)
     VALUES ($1,$2,'2026-05-01','2026-05-31')`, [agencyA, employeeA],
  );
  const employeeUser = await user("employee");
  const agencyUser = await user("agency");
  const parentUser = await user("parent");
  await pool.query(`INSERT INTO user_portal_roles (user_id, portal_role) VALUES ($1,'employee'),($2,'parent')`, [employeeUser, parentUser]);
  await pool.query(`INSERT INTO user_employee_relationships (user_id, employee_id) VALUES ($1,$2)`, [employeeUser, employeeA]);
  await pool.query(`INSERT INTO user_agency_access (user_id, agency_id, portal_role) VALUES ($1,$2,'agency')`, [agencyUser, agencyA]);
  await pool.query(
    `INSERT INTO user_individual_relationships (user_id, individual_id, relationship_type, capability_grants)
     VALUES ($1,$2,'guardian',ARRAY['financials.self.billed_totals.read'])`, [parentUser, personA],
  );
  const program = (await pool.query<{ id: string }>(`SELECT id FROM programs WHERE code = 'COM_HAB'`)).rows[0]!.id;
  const check = async (name: string, verified = true, emp = employeeA) => insertId(
    `INSERT INTO employee_payroll_checks (employee_id, check_number, check_date, actual_gross, actual_net, verification_status)
     VALUES ($1,$2,$3,125,100,$4) RETURNING id`, [emp, name, DAY, verified ? "verified" : "unverified"],
  );
  const transaction = async ({ checkId = null, person = personA, emp = employeeA, recipient = "employee", day = DAY, amount = 50 }: {
    checkId?: string | null; person?: string; emp?: string; recipient?: string; day?: string; amount?: number;
  } = {}) => insertId(
    `INSERT INTO payroll_transactions
       (individual_id,employee_id,program_id,payroll_check_id,check_date,imported_hours,imported_amount,employee_payment_amount,payment_recipient,transaction_fingerprint)
     VALUES ($1,$2,$3,$4,$5,2,$6,$6,$7,$8) RETURNING id`,
    [person, emp, program, checkId, day, amount, recipient, randomUUID()],
  );
  const obligation = async (sourceIds: string[], checkId?: string) => insertId(
    `INSERT INTO settlement_obligations
       (source_key,kind,direction,employee_id,original_amount,check_date,calculation_metadata)
     VALUES ($1,'employee_giveback','receivable',$2,20,$3,$4::jsonb) RETURNING id`,
    [randomUUID(), employeeA, DAY, JSON.stringify({ sourceTransactionIds: sourceIds, payrollCheckId: checkId ?? null })],
  );
  return { pool, user, agencyA, agencyB, personA, personB, employeeA, employeeB, employeeUser, agencyUser, parentUser, individual, check, transaction, obligation };
}

async function portal(userId: string, month = MONTH, extraQuery = "") {
  session.userId = userId;
  const response = await accessGet(new NextRequest(`http://localhost/api/portal/access?month=${month}${extraQuery}`));
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  const cacheDirectives = cacheControlDirectives(response.headers.get("cache-control"));
  expect(cacheDirectives).toEqual(expect.arrayContaining(["private", "no-store"]));
  expect(cacheDirectives).not.toContain("public");
  return body.data as PortalHomeReadModel;
}

function elementsIn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elementsIn(child.props.children as ReactNode)] : []);
}

suite("Developer 2 portal privacy through handlers and PostgreSQL", () => {
  beforeAll(resetSchema, 60_000);
  afterAll(closeTestPool);

  it.each(["individual", "employee", "agency", "collector", "scheduler", "staffing_manager"] as const)("updates Approved documents for an existing %s relationship without erasing other policy", async (kind) => {
    const f = await fixture();
    const owner = await f.user("owner");
    await f.pool.query(`UPDATE users SET role='admin' WHERE id=$1`, [owner]);
    await f.pool.query(`INSERT INTO user_portal_roles (user_id,portal_role) VALUES ($1,'owner')`, [owner]);
    const isHoursRole = kind === "scheduler" || kind === "staffing_manager";
    const isAgency = kind === "agency" || kind === "collector" || isHoursRole;
    const userId = isAgency ? f.agencyUser : kind === "individual" ? f.parentUser : f.employeeUser;
    const table = isAgency ? "user_agency_access" : kind === "individual" ? "user_individual_relationships" : "user_employee_relationships";
    const grant = isHoursRole ? "hours_budgets.agency.read" : isAgency ? "financials.agency.billed_totals.read" : kind === "individual" ? "financials.self.billed_totals.read" : "employee_pay.self.read";
    const denial = isHoursRole ? "schedules.agency.read" : isAgency ? "financials.agency.direct_checks.read" : kind === "individual" ? "schedules.self.read" : "employee_checks.self.gross.read";
    if (isAgency) await f.pool.query(`UPDATE user_agency_access SET portal_role=$2 WHERE user_id=$1`, [userId, kind]);
    await f.pool.query(`UPDATE ${table} SET capability_grants=$2::text[],capability_denials=$3::text[] WHERE user_id=$1`, [userId, [grant], [denial]]);
    const body = isAgency ? { userId, role: kind } : kind === "individual" ? { userId, individualId: f.personA, relationship: "guardian" } : { userId, employeeId: f.employeeA };
    const write = async (fields: Record<string, unknown>) => {
      const request = new NextRequest("http://localhost/api/portal/assignments", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ ...body, ...fields }) });
      return isAgency ? agencyAccessPost(request, { params: Promise.resolve({ id: f.agencyA }) }) : kind === "individual" ? individualAccessPost(request) : employeeAccessPost(request);
    };
    const saved = async () => (await f.pool.query<{ capability_grants: string[]; capability_denials: string[] }>(`SELECT capability_grants,capability_denials FROM ${table} WHERE user_id=$1`, [userId])).rows[0]!;
    session.userId = userId;
    expect((await write({ approvedDocuments: "show" })).status).toBe(403);
    session.userId = owner;
    expect((await write({ approvedDocuments: "show" })).status).toBe(200);
    expect(await saved()).toEqual({ capability_grants: [grant, "documents.self.read"], capability_denials: [denial] });
    if (isHoursRole) {
      expect(await (await write({ billedTotals: "show" })).json()).toMatchObject({ ok: false, code: "validation" });
      expect(await saved()).toEqual({ capability_grants: [grant, "documents.self.read"], capability_denials: [denial] });
      const page = await AgencySettingsPage({ searchParams: Promise.resolve({}) });
      const editors = elementsIn(page).filter((element) => element.type === CreateButton
        && (element.props.hidden as { userId?: string; role?: string } | undefined)?.userId === userId
        && (element.props.hidden as { role?: string }).role === kind);
      expect(editors).toHaveLength(1);
      const controls = renderToStaticMarkup(editors[0]!.props.fields as ReactNode);
      expect(controls).toContain('name="approvedDocuments"');
      expect(controls).toContain('value="show" selected=""');
      expect(controls).not.toMatch(/name="(?:dollarBudgets|billedTotals|directChecks|agencyPaidAmounts|cutsSetAsides)"/);
    }
    expect((await write({ approvedDocuments: "hide" })).status).toBe(200);
    expect(await saved()).toEqual({ capability_grants: [grant], capability_denials: [denial, "documents.self.read"] });
    expect((await write({ isActive: false })).status).toBe(200);
    expect(await saved()).toEqual({ capability_grants: [grant], capability_denials: [denial, "documents.self.read"] });
    expect((await write({ isActive: true, approvedDocuments: "default" })).status).toBe(200);
    expect(await saved()).toEqual({ capability_grants: [grant], capability_denials: [denial] });
  });

  it("shows verified direct checks and services while hiding routed, mixed, unverified, unknown-source and foreign-employee checks", async () => {
    const f = await fixture();
    const direct = await f.check("DIRECT CHECK");
    await f.transaction({ checkId: direct });
    const routed = await f.check("ROUTED CHECK");
    await f.transaction({ checkId: routed, recipient: "excellent_staffing" });
    const mixed = await f.check("MIXED CHECK");
    await f.transaction({ checkId: mixed });
    await f.transaction({ checkId: mixed, recipient: "excellent_staffing" });
    const unverified = await f.check("UNVERIFIED CHECK", false);
    await f.transaction({ checkId: unverified });
    await f.check("UNKNOWN SOURCE CHECK");
    const foreign = await f.check("FOREIGN SOURCE CHECK");
    await f.transaction({ checkId: foreign, emp: f.employeeB });
    const outside = await f.check("OTHER EMPLOYEE CHECK", true, f.employeeB);
    await f.transaction({ checkId: outside, emp: f.employeeB });
    const model = await portal(f.employeeUser, MONTH, `&employeeId=${f.employeeB}&role=owner`);
    expect(model.employees.map((entry) => entry.id)).toEqual([f.employeeA]);
    expect(model.employees[0]!.checks!.map((entry) => entry.id)).toEqual([direct]);
    expect(model.employees[0]!.checks![0]).toMatchObject({ actualGross: "125.0000", actualNet: "100.0000", taxWithheld: "25.0000" });
    expect(model.employees[0]!.directPay).toHaveLength(2); // safe direct components remain usable
    expect(JSON.stringify(model)).not.toMatch(/ROUTED CHECK|UNVERIFIED CHECK|UNKNOWN SOURCE CHECK|FOREIGN SOURCE CHECK|OTHER EMPLOYEE CHECK|OUTSIDE EMPLOYEE/);
  });

  it("re-resolves independent check and category denials on an existing session", async () => {
    const f = await fixture();
    const direct = await f.check("DIRECT");
    await f.transaction({ checkId: direct });
    await portal(f.employeeUser);
    await f.pool.query(
      `UPDATE user_employee_relationships SET capability_denials = ARRAY['employee_checks.self.gross.read','employee_checks.self.tax.read','employee_giveback.self.read','employee_pay.self.read'] WHERE user_id = $1`, [f.employeeUser],
    );
    const employee = (await portal(f.employeeUser)).employees[0]!;
    expect(employee.checks![0]).toMatchObject({ actualNet: "100.0000" });
    expect(employee.checks![0]).not.toHaveProperty("actualGross");
    expect(employee.checks![0]).not.toHaveProperty("taxWithheld");
    expect(employee.checks![0]).not.toHaveProperty("giveBackDue");
    expect(employee.directPay).toBeNull();
    expect(employee.giveBack).toBeNull();
    await f.pool.query(`UPDATE user_portal_roles SET is_active = false WHERE user_id = $1`, [f.employeeUser]);
    await f.pool.query(`UPDATE user_employee_relationships SET capability_grants = ARRAY['people.self.read','employee_checks.self.net.read'] WHERE user_id = $1`, [f.employeeUser]);
    expect((await portal(f.employeeUser)).employees).toEqual([]);
  });

  it("never uses a sole employee membership as a fallback for mixed or unrelated check and give-back sources", async () => {
    const f = await fixture();
    const own = await f.check("OWN CHECK");
    const ownSource = await f.transaction({ checkId: own });
    await f.obligation([ownSource], own);
    const other = await f.check("OTHER AGENCY CHECK");
    const otherSource = await f.transaction({ checkId: other, person: f.personB });
    await f.obligation([otherSource], other);
    const mixed = await f.check("MIXED AGENCY CHECK");
    const first = await f.transaction({ checkId: mixed });
    const second = await f.transaction({ checkId: mixed, person: f.personB });
    await f.obligation([first, second], mixed);
    await f.check("MISSING SOURCE CHECK");
    await f.obligation([]);
    await f.obligation([randomUUID()]);
    await f.obligation(["invalid source id"]);
    // Contradictory canonical links and complete-check sources defeat an
    // incomplete metadata list that contains only the allowed transaction.
    const linked = await f.obligation([ownSource]);
    await f.pool.query(`INSERT INTO settlement_obligation_transactions (settlement_obligation_id,payroll_transaction_id) VALUES ($1,$2)`, [linked, otherSource]);
    await f.obligation([first], mixed);
    const agency = (await portal(f.agencyUser)).agencies[0]!;
    expect(agency.payrollGrossThisMonth).toBe("125.0000");
    expect(agency.payrollNetThisMonth).toBe("100.0000");
    expect(agency.giveBackRemaining).toBe("20.0000");
    expect(agency.employees![0]!.checks!.map((entry) => entry.id)).toEqual([own]);
    expect(agency.employees![0]!.giveBack!.remaining).toBe("20.0000");
    expect(agency.individuals!.map((entry) => entry.id)).toEqual([f.personA]);
    expect(JSON.stringify(agency)).not.toContain("Other Agency Person");
  });

  it("preserves uniquely attributed checks with concurrent employment while rejecting overlapping billing attribution", async () => {
    const f = await fixture();
    await f.pool.query(`INSERT INTO agency_employees (agency_id,employee_id,effective_from,effective_to) VALUES ($1,$2,'2026-05-01','2026-05-31')`, [f.agencyB, f.employeeA]);
    const own = await f.check("UNIQUE CHECK");
    const source = await f.transaction({ checkId: own });
    await f.obligation([source], own);
    expect((await portal(f.agencyUser)).agencies[0]!.payrollNetThisMonth).toBe("100.0000");
    await f.pool.query(`INSERT INTO agency_individuals (agency_id,individual_id,manages_budget,bills_services,effective_from,effective_to) VALUES ($1,$2,false,true,'2026-05-01','2026-05-31')`, [f.agencyB, f.personA]);
    const agency = (await portal(f.agencyUser)).agencies[0]!;
    expect(agency.payrollNetThisMonth).toBe("0.0000");
    expect(agency.giveBackRemaining).toBe("0.0000");
    expect(agency.employees![0]!.checks).toEqual([]);
  });

  it("filters by source dates before totals and isolates category denials from other agencies", async () => {
    const f = await fixture();
    await f.transaction({ amount: 50 });
    await f.transaction({ day: "2026-04-30", amount: 700 });
    await f.transaction({ day: "2026-06-01", amount: 800 });
    await f.transaction({ person: f.personB, amount: 900 });
    const may = (await portal(f.agencyUser)).agencies[0]!;
    expect(may.billedThisMonth).toBe("50.0000");
    expect(may.individuals![0]!.billedThisMonth).toBe("50.0000");
    expect((await portal(f.agencyUser, "2026-04")).agencies[0]!.individuals).toEqual([]);
    expect((await portal(f.agencyUser, "2026-06")).agencies[0]!.billedThisMonth).toBe("0.0000");
    await f.pool.query(`INSERT INTO user_agency_access (user_id,agency_id,portal_role) VALUES ($1,$2,'agency')`, [f.agencyUser, f.agencyB]);
    await f.pool.query(`UPDATE user_agency_access SET capability_denials = ARRAY['financials.agency.billed_totals.read','financials.agency.direct_checks.read'] WHERE user_id=$1 AND agency_id=$2`, [f.agencyUser, f.agencyA]);
    const scoped = (await portal(f.agencyUser)).agencies;
    expect(scoped.find((entry) => entry.id === f.agencyA)!.billedThisMonth).toBeNull();
    expect(scoped.find((entry) => entry.id === f.agencyA)!.employees![0]!.checks).toBeNull();
    expect(scoped.find((entry) => entry.id === f.agencyB)!.billedThisMonth).toBe("900.0000");
  });

  it("uses exact dated agency membership for document subjects without connected-person expansion", async () => {
    const f = await fixture();
    const context = await resolvePortalAccess(f.pool, { id: f.agencyUser });
    await expect(canAccessPortalAgencySubject(f.pool, context, f.agencyA, { individualId: f.personA }, DAY)).resolves.toBe(true);
    await expect(canAccessPortalAgencySubject(f.pool, context, f.agencyA, { individualId: f.personB }, DAY)).resolves.toBe(false);
    await expect(canAccessPortalAgencySubject(f.pool, context, f.agencyB, { individualId: f.personB }, DAY)).resolves.toBe(false);
    await expect(canAccessPortalAgencySubject(f.pool, context, f.agencyA, { individualId: f.personA }, "2026-06-01")).resolves.toBe(false);
    await expect(canAccessPortalAgencySubject(f.pool, context, f.agencyA, { employeeId: f.employeeA }, DAY)).resolves.toBe(true);
    await expect(canAccessPortalAgencySubject(f.pool, context, f.agencyA, { employeeId: f.employeeA }, "2026-02-31")).resolves.toBe(false);
  });

  it("keeps group schedules useful to a parent without exposing employee, other participant, notes, money or source IDs", async () => {
    const f = await fixture();
    const created = await f.pool.query<{ id: string }>(
      `INSERT INTO scheduled_sessions
         (employee_id,program_id,session_date,start_time,end_time,duration_hours,is_group,group_size,notes,expected_rate)
       SELECT $1,id,(now() AT TIME ZONE 'America/New_York')::date + 1,'09:00','11:00',2,true,2,'PRIVATE EMPLOYEE AND PAYROLL NOTES',999
         FROM programs WHERE code='COM_HAB' RETURNING id`, [f.employeeA],
    );
    await f.pool.query(`INSERT INTO scheduled_allocations (scheduled_session_id,individual_id,allocation_hours) VALUES ($1,$2,2),($1,$3,2)`, [created.rows[0]!.id, f.personA, f.personB]);
    const person = (await portal(f.parentUser)).individuals[0]!;
    expect(person.upcomingSchedule!.status).toBe("ready");
    expect(person.upcomingSchedule!.items).toHaveLength(1);
    expect(person.upcomingSchedule!.items[0]).toMatchObject({ durationHours: "2.0000", isGroup: true });
    expect(JSON.stringify(person.upcomingSchedule)).not.toMatch(/PRIVATE EMPLOYEE|Other Agency Person|999|individualIds|employeeId|employeeName|programId|seriesId|notes/);
    expect(JSON.stringify(person.upcomingSchedule)).not.toContain(created.rows[0]!.id);
    await f.pool.query(`UPDATE user_individual_relationships SET capability_denials=ARRAY['schedules.self.read'] WHERE user_id=$1`, [f.parentUser]);
    expect((await portal(f.parentUser)).individuals[0]!.upcomingSchedule).toBeNull();
  });

  it("allows multiple directly linked children, respects each denial, and keeps HTML/CSV statements free of employee details", async () => {
    const f = await fixture();
    const second = await f.individual("Second Linked Child");
    await f.pool.query(`INSERT INTO user_individual_relationships (user_id,individual_id,relationship_type,capability_grants,capability_denials) VALUES ($1,$2,'parent',ARRAY['financials.self.billed_totals.read'],ARRAY['financials.self.billed_totals.read'])`, [f.parentUser, second]);
    const check = await f.check("PRIVATE CHECK NUMBER");
    await f.transaction({ checkId: check, amount: 50 });
    await f.transaction({ person: second, amount: 600 });
    await f.transaction({ person: f.personB, amount: 900 });
    const model = await portal(f.parentUser, MONTH, `&individualId=${f.personB}&role=owner`);
    expect(model.individuals.map((entry) => entry.id).sort()).toEqual([f.personA, second].sort());
    expect(model.individuals.find((entry) => entry.id === f.personA)!.billedThisMonth).toBe("50.0000");
    expect(model.individuals.find((entry) => entry.id === second)!.billedThisMonth).toBeNull();
    expect(JSON.stringify(model)).not.toMatch(/PRIVATE EMPLOYEE|PRIVATE CHECK|Other Agency Person|actualGross|actualNet/);
    session.userId = f.parentUser;
    for (const format of ["html", "csv"]) {
      const response = await statementGet(new NextRequest(`http://localhost/api/portal/individual-statements?individualId=${f.personA}&month=${MONTH}&format=${format}`));
      expect(response.status).toBe(200);
      const cacheDirectives = cacheControlDirectives(response.headers.get("cache-control"));
      expect(cacheDirectives).toEqual(expect.arrayContaining(["private", "no-store"]));
      expect(cacheDirectives).not.toContain("public");
      const content = await response.text();
      expect(content).toContain("Linked Person A");
      expect(content).not.toMatch(/PRIVATE EMPLOYEE|PRIVATE CHECK|Other Agency Person|600\.00|900\.00/);
      const forbidden = await statementGet(new NextRequest(`http://localhost/api/portal/individual-statements?individualId=${f.personB}&month=${MONTH}&format=${format}`));
      expect(forbidden.status).toBe(404);
      const denied = await statementGet(new NextRequest(`http://localhost/api/portal/individual-statements?individualId=${second}&month=${MONTH}&format=${format}`));
      expect(denied.status).toBe(403);
    }
  });
});
