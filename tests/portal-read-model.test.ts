import { describe, expect, it, vi } from "vitest";
import { agencyMonth } from "@/lib/business/agency-time";
import { getPortalHomeReadModel, normalizePortalMonth } from "@/lib/data/portal-read-model";
import type { PortalAccessContext } from "@/lib/auth/portal-access";
import type { PgLikePool } from "@/lib/import/commit";

const AGENCY_A = "00000000-0000-4000-8000-000000000001";
const AGENCY_B = "00000000-0000-4000-8000-000000000002";
const INDIVIDUAL = "00000000-0000-4000-8000-000000000003";
const EMPLOYEE = "00000000-0000-4000-8000-000000000004";
const AGENCY_A_INDIVIDUAL = "00000000-0000-4000-8000-000000000005";
const AGENCY_B_INDIVIDUAL = "00000000-0000-4000-8000-000000000006";
const OUTSIDE_INDIVIDUAL = "00000000-0000-4000-8000-000000000007";
const AGENCY_A_EMPLOYEE = "00000000-0000-4000-8000-000000000008";
const AGENCY_B_EMPLOYEE = "00000000-0000-4000-8000-000000000009";
const PROGRAM = "00000000-0000-4000-8000-000000000010";

describe("portal-safe home read model", () => {
  it("includes strategy-backed hours on every scoped surface without widening category access", async () => {
    const context: PortalAccessContext = {
      userId: "user",
      globalRoles: [{ role: "parent", grants: [], denials: [] }],
      individualLinks: [{
        individualId: INDIVIDUAL,
        relationship: "guardian",
        grants: [
          "financials.self.billed_totals.read",
          "financials.self.direct_checks.read",
          "financials.self.agency_paid.read",
        ],
        denials: [],
      }],
      employeeLinks: [],
      agencyAccess: [
        {
          agencyId: AGENCY_A,
          agencyCode: "A",
          agencyName: "Agency A",
          role: "collector",
          grants: [],
          denials: [],
        },
        {
          agencyId: AGENCY_B,
          agencyCode: "B",
          agencyName: "Agency B",
          role: "scheduler",
          grants: [],
          denials: [],
        },
      ],
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void params;
      if (sql.includes("FROM individuals")) {
        return { rows: [{ id: INDIVIDUAL, name: "Authorized Child" }] };
      }
      if (sql.includes("JOIN individuals individual")) {
        return { rows: [
          { agency_id: AGENCY_A, person_id: AGENCY_A_INDIVIDUAL, name: "Agency A Individual", manages_budget: true, bills_services: true },
          { agency_id: AGENCY_B, person_id: AGENCY_B_INDIVIDUAL, name: "Agency B Individual", manages_budget: true, bills_services: true },
          { agency_id: "00000000-0000-4000-8000-000000000099", person_id: OUTSIDE_INDIVIDUAL, name: "Outside Individual", manages_budget: true, bills_services: true },
        ] };
      }
      if (sql.includes("JOIN employees employee")) {
        return { rows: [
          { agency_id: AGENCY_A, person_id: AGENCY_A_EMPLOYEE, name: "Agency A Employee" },
          { agency_id: AGENCY_B, person_id: AGENCY_B_EMPLOYEE, name: "Agency B Employee" },
        ] };
      }
      if (sql.includes("effective_hours.individual_id AS scope_id")) {
        return { rows: [{
          scope_id: INDIVIDUAL,
          authorized_hours: "120",
          used_hours: "42",
          remaining_hours: "78",
          program_breakdown: [{ id: PROGRAM, code: "COMHAB", name: "Community Habilitation", authorized: "120", used: "42", remaining: "78" }],
        }] };
      }
      if (sql.includes("FROM payroll_transactions")
        && sql.includes("COALESCE(sum(imported_amount), 0)::text AS amount")
        && !sql.includes("AS person_id")) {
        return { rows: [{ scope_id: INDIVIDUAL, amount: "250", program_breakdown: [{ id: PROGRAM, code: "COMHAB", name: "Community Habilitation", amount: "250" }] }] };
      }
      if (sql.includes("transaction.individual_id AS scope_id")
        && sql.includes("= 'employee'")) {
        return { rows: [{ scope_id: INDIVIDUAL, amount: "250", program_breakdown: [{ id: PROGRAM, code: "COMHAB", name: "Community Habilitation", amount: "250" }] }] };
      }
      if (sql.includes("transaction.individual_id AS scope_id")
        && sql.includes("= 'excellent_staffing'")) {
        return { rows: [{ scope_id: INDIVIDUAL, amount: "250", program_breakdown: [{ id: PROGRAM, code: "COMHAB", name: "Community Habilitation", amount: "250" }] }] };
      }
      if (sql.includes("FROM agencies a")) {
        return { rows: [
          {
            id: AGENCY_A,
            code: "A",
            name: "Agency A",
            individual_count: 12,
            employee_count: 8,
            managed_budget_count: 9,
            billing_without_budget_count: 3,
          },
          {
            id: AGENCY_B,
            code: "B",
            name: "Agency B",
            individual_count: 7,
            employee_count: 4,
            managed_budget_count: 5,
            billing_without_budget_count: 2,
          },
        ] };
      }
      if (sql.includes("membership.individual_id AS person_id")
        && sql.includes("physical_authorization_base AS")
        && sql.includes("authorized_hours")) {
        return { rows: [{
          agency_id: AGENCY_B,
          person_id: AGENCY_B_INDIVIDUAL,
          authorized_hours: "70",
          used_hours: "30",
          remaining_hours: "40",
          program_breakdown: [{ id: PROGRAM, code: "RESPITE", name: "Respite", authorized: "70", used: "30", remaining: "40" }],
        }] };
      }
      if (sql.includes("event.individual_id AS person_id")) {
        return { rows: [{ agency_id: AGENCY_A, person_id: AGENCY_A_INDIVIDUAL, amount: "25" }] };
      }
      if (sql.includes("transaction.individual_id AS person_id") && sql.includes("= 'employee'")) {
        return { rows: [{ agency_id: AGENCY_A, person_id: AGENCY_A_INDIVIDUAL, amount: "90", program_breakdown: [{ id: PROGRAM, code: "COMHAB", name: "Community Habilitation", amount: "90" }] }] };
      }
      if (sql.includes("transaction.individual_id AS person_id") && sql.includes("= 'excellent_staffing'")) {
        return { rows: [{ agency_id: AGENCY_A, person_id: AGENCY_A_INDIVIDUAL, amount: "40", program_breakdown: [{ id: PROGRAM, code: "COMHAB", name: "Community Habilitation", amount: "40" }] }] };
      }
      if (sql.includes("checks.employee_id AS person_id")) {
        return { rows: [{
          agency_id: AGENCY_A,
          person_id: AGENCY_A_EMPLOYEE,
          gross: null,
          net: "1200",
          checks: [{
            id: "00000000-0000-4000-8000-000000000011",
            checkNumber: "201",
            checkDate: "2026-05-22",
            periodBegin: "2026-05-01",
            periodEnd: "2026-05-15",
            serviceDate: "2026-05-01",
            actualGross: null,
            actualNet: "1200",
          }],
        }] };
      }
      if (sql.includes("obligation.employee_id AS person_id")) {
        return { rows: [{
          agency_id: AGENCY_A,
          person_id: AGENCY_A_EMPLOYEE,
          due_this_month: "10",
          collected_this_month: "5",
          remaining: "75",
        }] };
      }
      if (sql.includes("membership.agency_id AS scope_id")
        && sql.includes("physical_authorization_base AS")) {
        return { rows: [{
          scope_id: AGENCY_B,
          authorized_hours: "700",
          used_hours: "300",
          remaining_hours: "400",
          authorized_dollars: null,
          used_dollars: "0",
          remaining_dollars: null,
        }] };
      }
      if (sql.includes("FROM unnest")) {
        return { rows: [{
          scope_id: AGENCY_A,
          billed_this_month: null,
          set_aside_this_month: "125",
          agency_paid_this_month: "400",
          payroll_gross_this_month: null,
          payroll_net_this_month: "1200",
          giveback_remaining: "75",
        }] };
      }
      throw new Error(`Unexpected portal query: ${sql}`);
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    const model = await getPortalHomeReadModel(pool, context, "2026-05");

    expect(model.month).toBe("2026-05");
    expect(model.directProfiles).toEqual({ individualCount: 1, employeeCount: 0 });
    expect(model.individuals[0]).toMatchObject({
      id: INDIVIDUAL,
      name: "Authorized Child",
      hours: { authorized: "120.0000", used: "42.0000", remaining: "78.0000" },
      dollars: null,
      billedThisMonth: "250.0000",
      setAsideThisMonth: null,
      directChecksThisMonth: "250.0000",
      agencyPaidThisMonth: "250.0000",
      programs: [{
        id: PROGRAM,
        hours: { authorized: "120.0000", used: "42.0000", remaining: "78.0000" },
        dollars: null,
        billedThisMonth: "250.0000",
        directChecksThisMonth: "250.0000",
        agencyPaidThisMonth: "250.0000",
      }],
    });
    expect(model.agencies[0]).toMatchObject({
      id: AGENCY_A,
      individualCount: 1,
      employeeCount: 1,
      managedBudgetCount: null,
      billingWithoutBudgetCount: null,
      individuals: [{
        id: AGENCY_A_INDIVIDUAL,
        hours: null,
        dollars: null,
        billedThisMonth: null,
        setAsideThisMonth: "25.0000",
        directChecksThisMonth: "90.0000",
        agencyPaidThisMonth: "40.0000",
        programs: [{
          id: PROGRAM,
          hours: null,
          billedThisMonth: null,
          directChecksThisMonth: "90.0000",
          agencyPaidThisMonth: "40.0000",
        }],
      }],
      employees: [{
        id: AGENCY_A_EMPLOYEE,
        payrollGrossThisMonth: null,
        payrollNetThisMonth: "1200.0000",
        checks: [{
          checkNumber: "201",
          serviceDate: "2026-05-01",
          actualGross: null,
          actualNet: "1200.0000",
        }],
        giveBack: { dueThisMonth: "10.0000", collectedThisMonth: "5.0000", remaining: "75.0000" },
      }],
    });
    expect(model.agencies[1]).toMatchObject({
      id: AGENCY_B,
      individualCount: 1,
      employeeCount: 1,
      managedBudgetCount: 5,
      billingWithoutBudgetCount: 2,
      budgetHours: { authorized: "700.0000", used: "300.0000", remaining: "400.0000" },
      individuals: [{
        id: AGENCY_B_INDIVIDUAL,
        hours: { authorized: "70.0000", used: "30.0000", remaining: "40.0000" },
        dollars: null,
        billedThisMonth: null,
        setAsideThisMonth: null,
        directChecksThisMonth: null,
        agencyPaidThisMonth: null,
        programs: [{
          id: PROGRAM,
          hours: { authorized: "70.0000", used: "30.0000", remaining: "40.0000" },
          billedThisMonth: null,
          directChecksThisMonth: null,
          agencyPaidThisMonth: null,
        }],
      }],
      employees: [{
        id: AGENCY_B_EMPLOYEE,
        payrollGrossThisMonth: null,
        payrollNetThisMonth: null,
        giveBack: null,
      }],
    });
    for (const agency of model.agencies) {
      expect(agency.individualCount).toBe(agency.individuals?.length);
      expect(agency.employeeCount).toBe(agency.employees?.length);
    }
    expect(JSON.stringify(model)).not.toContain("Outside Individual");
    expect(JSON.stringify(model)).not.toMatch(/employeeName|taxWithheld|connected/i);
    const sql = query.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).not.toMatch(/service_allocations|assignments/i);
    const agencyBudgetSql = query.mock.calls.find(([statement]) =>
      statement.includes("membership.agency_id AS scope_id")
      && statement.includes("effective_budget_authorizations_at"),
    )?.[0];
    const agencyFinancialCall = query.mock.calls.find(([statement]) => statement.includes("FROM unnest"));
    const agencyRosterCall = query.mock.calls.find(([statement]) => statement.includes("FROM agencies a"));
    const directBilledCall = query.mock.calls.find(([statement]) =>
      statement.includes("FROM payroll_transactions")
      && statement.includes("COALESCE(sum(imported_amount), 0)::text AS amount"),
    );
    const portalSql = query.mock.calls.map(([statement]) => statement).join("\n");
    expect(agencyBudgetSql).toContain("membership.manages_budget = true");
    expect(agencyFinancialCall?.[0].match(/membership\.bills_services = true/g)).toHaveLength(2);
    expect(agencyFinancialCall?.[0]).toContain("membership.manages_budget = true");
    expect(agencyFinancialCall?.[0]).toContain("membership.effective_from <= canonical_service_date(");
    expect(agencyFinancialCall?.[0]).toContain("membership.effective_from <= event.occurred_on");
    expect(agencyFinancialCall?.[0]).toContain("transaction.period_begin, transaction.check_date, transaction.period_end");
    expect(agencyFinancialCall?.[0]).toContain("checks.period_begin, checks.check_date, checks.period_end");
    expect(agencyFinancialCall?.[0]).toContain("obligation.period_begin, obligation.check_date, obligation.period_end");
    expect(agencyFinancialCall?.[0]).toContain("checks.verification_status = 'verified'");
    expect(agencyFinancialCall?.[0]).toContain("count(*) FILTER (WHERE checks.actual_gross IS NULL) > 0");
    expect(portalSql).toContain("jsonb_agg(jsonb_build_object(");
    expect(agencyFinancialCall?.[0]).not.toContain("checks.verification_status <> 'void'");
    expect(agencyFinancialCall?.[0].match(/AND EXISTS \(/g)?.length).toBeGreaterThanOrEqual(6);
    expect(agencyFinancialCall?.[0]).not.toMatch(/JOIN agency_(?:individuals|employees) membership/);
    expect(portalSql.match(/effective_payment_recipient\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(portalSql).not.toMatch(/\btransaction\.payment_recipient\s*=\s*'(?:employee|excellent_staffing)'/);
    expect(portalSql).not.toContain("created_at::date");
    expect(portalSql).not.toMatch(/authorized_dollars|consumed_dollars|remaining_dollars/);
    expect(portalSql.match(/canonical_service_date\(/g)?.length).toBeGreaterThanOrEqual(12);
    expect(portalSql).toContain("AT TIME ZONE 'America/New_York'");
    expect(agencyFinancialCall?.[1]?.[6]).toBe("2026-05-01");
    expect(directBilledCall?.[1]?.[1]).toBe("2026-05-01");
    const memberPeopleCall = query.mock.calls.find(([statement]) => statement.includes("JOIN individuals individual"));
    expect(memberPeopleCall?.[1]?.[0]).toEqual([AGENCY_A, AGENCY_B]);
    expect(memberPeopleCall?.[1]?.[1]).toBe("2026-05-01");
    expect(memberPeopleCall?.[0]).toContain("membership.is_active = true");
    expect(memberPeopleCall?.[0]).toContain("membership.effective_from < ($2::date + interval '1 month')");
    expect(memberPeopleCall?.[0]).toContain("WHERE responsibility_rank = 1");
    expect(memberPeopleCall?.[0]).not.toContain("bool_or(");
    const memberHoursCall = query.mock.calls.find(([statement]) =>
      statement.includes("membership.individual_id AS person_id")
      && statement.includes("physical_authorization_base AS")
      && statement.includes("authorized_hours"),
    );
    expect(memberHoursCall?.[1]?.[0]).toEqual([AGENCY_B]);
    expect(memberHoursCall?.[0]).not.toMatch(/dollar/i);
    const hourCalls = query.mock.calls.filter(([statement]) => statement.includes("effective_budget_authorizations_at"));
    expect(hourCalls).toHaveLength(3);
    for (const [statement] of hourCalls) {
      expect(statement).toContain("FROM budget_authorizations physical_auth");
      expect(statement).toContain("JOIN portal_scope scope ON scope.individual_id = physical_auth.individual_id");
      expect(statement).toContain("JOIN budget_periods period ON period.id = physical_auth.budget_period_id");
      expect(statement).toContain("physical_auth.status = 'active'");
      expect(statement).toContain("physical_auth.archived_at IS NULL");
      expect(statement).toContain("period.status = 'active'");
      expect(statement).toContain("period.archived_at IS NULL");
      expect(statement).toContain("physical_payroll_usage AS");
      expect(statement).toContain("FROM physical_authorization_base physical");
      expect(statement).toContain("LEFT JOIN payroll_transactions payroll");
      expect(statement).toContain("physical.consumption_source IN ('payroll', 'mixed')");
      expect(statement).toContain("WHEN physical.rate_scope = 'per_group'");
      expect(statement).toContain("/ physical.internal_rate");
      expect(statement).toContain("), 0)::numeric(10, 4) AS used_hours");
      expect(statement).toContain("physical_event_usage AS");
      expect(statement).toContain("LEFT JOIN program_budget_events event");
      expect(statement).toContain("COALESCE(sum(event.hours), 0)::numeric(10, 4) AS used_hours");
      expect(statement).toContain("COALESCE(payroll.used_hours, 0) + COALESCE(event.used_hours, 0)");
      expect(statement).toContain(")::numeric(10, 4) AS used_hours");
      expect(statement).toContain("JOIN portal_scope scope ON scope.individual_id = budget_auth.individual_id");
      expect(statement).toContain("budget_auth.source = 'calculation_strategy'");
      expect(statement).toContain("NOT EXISTS (");
      expect(statement).toContain("FROM physical_authorizations physical");
      expect(statement).toContain("FROM synthetic_authorizations synthetic");
      expect(statement).toContain("JOIN payroll_transactions payroll");
      expect(statement).not.toContain("FROM payroll_transactions payroll");
      expect(statement).toContain("synthetic.consumption_source IN ('payroll', 'mixed')");
      expect(statement).toContain("canonical_service_date(");
      expect(statement).toContain("row_number() OVER (");
      expect(statement).toContain("PARTITION BY payroll.id");
      expect(statement).toContain("ORDER BY synthetic.start_date DESC");
      expect(statement).toContain("WHERE match_rank = 1");
      expect(statement).toContain("WHEN rate_scope = 'per_group'");
      expect(statement).toContain("payroll.calculated_internal_amount");
      expect(statement).toContain("payroll.spreadsheet_internal_amount");
      expect(statement).toContain("internal_rate_applied * imported_hours");
      expect(statement).toContain("/ internal_rate");
      expect(statement).toContain("COALESCE(sum(synthetic.authorized_hours), 0)");
      expect(statement).toContain("effective_hours.authorized_hours - effective_hours.used_hours");
      expect(statement).not.toContain("effective_billed_hours");
      expect(statement).not.toContain("program_budget_balances");
      expect(statement).not.toMatch(/undated_usage|authorized_dollars|consumed_dollars|remaining_dollars/);
      expect(statement).not.toMatch(/DAY_HAB|SUPP_GROUP_DAY_HAB/);
      expect(statement).not.toMatch(/dollar/i);
    }
    const directHourCall = hourCalls.find(([statement]) =>
      statement.includes("effective_hours.individual_id AS scope_id"),
    );
    expect(directHourCall?.[0]).toContain("SELECT unnest($1::uuid[]) AS individual_id");
    const agencyHourCalls = hourCalls.filter(([statement]) =>
      statement.includes("SELECT DISTINCT membership.individual_id"),
    );
    expect(agencyHourCalls).toHaveLength(2);
    for (const [statement] of agencyHourCalls) {
      expect(statement).toContain("membership.agency_id = ANY($1::uuid[])");
      expect(statement).toContain("membership.is_active = true");
      expect(statement).toContain("membership.manages_budget = true");
      expect(statement).toContain("membership.effective_from <= (now() AT TIME ZONE 'America/New_York')::date");
      expect(statement).toContain("membership.effective_to >= (now() AT TIME ZONE 'America/New_York')::date");
    }
    expect(query.mock.calls.some(([statement]) =>
      statement.includes("membership.individual_id AS person_id")
      && statement.includes("LEFT JOIN program_budget_balances")
      && statement.includes("authorized_dollars"),
    )).toBe(false);
    const memberFinancialCalls = query.mock.calls.filter(([statement]) =>
      statement.includes("AS person_id")
      && !statement.includes("JOIN individuals individual")
      && !statement.includes("JOIN employees employee")
      && !statement.includes("physical_authorization_base"),
    );
    expect(memberFinancialCalls.length).toBeGreaterThan(0);
    for (const call of memberFinancialCalls) expect(call[1]?.[0]).toEqual([AGENCY_A]);
    expect(query.mock.calls.some(([statement]) =>
      statement.includes("transaction.individual_id AS person_id")
      && statement.includes("sum(transaction.imported_amount)"),
    )).toBe(false);
    expect(agencyRosterCall?.[0]).not.toMatch(/individual_count|employee_count/);
    expect(agencyRosterCall?.[0]).not.toContain("FROM agency_employees");
    const memberCheckCall = query.mock.calls.find(([statement]) => statement.includes("checks.employee_id AS person_id"));
    expect(memberCheckCall?.[0]).toContain("count(*) FILTER (WHERE checks.actual_gross IS NULL) > 0");
    expect(memberCheckCall?.[0]).not.toContain("COALESCE(sum(checks.actual_gross), 0)::text AS gross");
    const memberGiveBackCall = query.mock.calls.find(([statement]) => statement.includes("obligation.employee_id AS person_id"));
    const memberDueFilter = memberGiveBackCall?.[0].match(
      /sum\(obligation\.original_amount\) FILTER \(([\s\S]*?)\), 0\)::text AS due_this_month/,
    )?.[1];
    expect(memberDueFilter).toContain("obligation.status = 'active'");
  });

  it("hides whole checks with ambiguous agency ownership unless every linked row resolves to one agency", async () => {
    const context: PortalAccessContext = {
      userId: "multi-agency-collector",
      globalRoles: [],
      individualLinks: [],
      employeeLinks: [],
      agencyAccess: [
        {
          agencyId: AGENCY_A,
          agencyCode: "A",
          agencyName: "Agency A",
          role: "collector",
          grants: [],
          denials: [],
        },
        {
          agencyId: AGENCY_B,
          agencyCode: "B",
          agencyName: "Agency B",
          role: "collector",
          grants: [],
          denials: [],
        },
      ],
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM agencies a")) {
        return {
          rows: [
            {
              id: AGENCY_A,
              code: "A",
              name: "Agency A",
              managed_budget_count: 0,
              billing_without_budget_count: 0,
            },
            {
              id: AGENCY_B,
              code: "B",
              name: "Agency B",
              managed_budget_count: 0,
              billing_without_budget_count: 0,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    await getPortalHomeReadModel(pool, context, "2026-05");

    const memberCheckSql = query.mock.calls.find(([sql]) =>
      sql.includes("checks.employee_id AS person_id"),
    )?.[0];
    const memberGiveBackSql = query.mock.calls.find(([sql]) =>
      sql.includes("obligation.employee_id AS person_id"),
    )?.[0];
    const agencyFinancialSql = query.mock.calls.find(([sql]) => sql.includes("FROM unnest"))?.[0];
    expect(memberCheckSql).toBeDefined();
    expect(memberGiveBackSql).toBeDefined();
    expect(agencyFinancialSql).toBeDefined();

    for (const sql of [memberCheckSql!, agencyFinancialSql!]) {
      expect(sql).toContain("count(DISTINCT candidate_membership.agency_id)");
      expect(sql).toContain("SELECT count(*) > 0");
      expect(sql).toContain("source_transaction.payroll_check_id = checks.id");
      expect(sql).toContain("bool_and(");
      expect(sql).toContain("attribution.agency_count = 1");
      expect(sql).toContain("attribution.requested_agency_count = 1");
      expect(sql).toContain("source_agency.bills_services = true");
    }
    expect(memberCheckSql).toContain("source_agency.agency_id = membership.agency_id");
    expect(agencyFinancialSql?.match(
      /source_agency\.agency_id = requested\.agency_id/g,
    )).toHaveLength(3);

    for (const sql of [memberGiveBackSql!, agencyFinancialSql!]) {
      expect(sql).toContain("calculation_metadata->'sourceTransactionIds'");
      expect(sql).toContain("jsonb_array_elements_text(");
      expect(sql).toContain("source_transaction.id = CASE");
      expect(sql).toContain("THEN source_id.value::uuid");
      expect(sql).toContain("attribution.agency_count = 1");
      expect(sql).toContain("attribution.requested_agency_count = 1");
    }
    expect(memberGiveBackSql).toContain("source_agency.agency_id = membership.agency_id");
    expect(agencyFinancialSql).toContain("source_agency.agency_id = requested.agency_id");
  });

  it("keeps physical dollar balances separate from effective hour authorization totals", async () => {
    const context: PortalAccessContext = {
      userId: "individual-budget-user",
      globalRoles: [{ role: "parent", grants: [], denials: [] }],
      individualLinks: [{
        individualId: INDIVIDUAL,
        relationship: "guardian",
        grants: ["dollar_budgets.self.read"],
        denials: [],
      }],
      employeeLinks: [],
      agencyAccess: [],
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM individuals")) {
        return { rows: [{ id: INDIVIDUAL, name: "Individual Budget" }] };
      }
      if (sql.includes("effective_hours.individual_id AS scope_id")) {
        return { rows: [{
          scope_id: INDIVIDUAL,
          authorized_hours: "100",
          used_hours: "40",
          remaining_hours: "60",
        }] };
      }
      if (sql.includes("FROM program_budget_balances") && sql.includes("authorized_dollars")) {
        return { rows: [{
          scope_id: INDIVIDUAL,
          authorized_dollars: "2000",
          used_dollars: "500",
          remaining_dollars: "1500",
        }] };
      }
      throw new Error(`Unexpected individual budget query: ${sql}`);
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    const model = await getPortalHomeReadModel(pool, context, "2026-05");

    expect(model.individuals[0]).toMatchObject({
      hours: { authorized: "100.0000", used: "40.0000", remaining: "60.0000" },
      dollars: { authorized: "2000.0000", used: "500.0000", remaining: "1500.0000" },
    });
    const hourCall = query.mock.calls.find(([sql]) => sql.includes("effective_budget_authorizations_at"));
    const dollarCall = query.mock.calls.find(([sql]) => sql.includes("authorized_dollars"));
    expect(hourCall?.[0]).not.toMatch(/dollar/i);
    expect(dollarCall?.[0]).toContain("FROM program_budget_balances");
    expect(dollarCall?.[0]).not.toMatch(/authorized_hours|consumed_hours|remaining_hours|effective_billed_hours/);
  });

  it("uses one selected-month responsibility instead of combining it with current membership", async () => {
    const context: PortalAccessContext = {
      userId: "historical-agency-user",
      globalRoles: [],
      individualLinks: [],
      employeeLinks: [],
      agencyAccess: [{
        agencyId: AGENCY_A,
        agencyCode: "A",
        agencyName: "Agency A",
        role: "scheduler",
        grants: [],
        denials: [],
      }],
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM agencies a")) {
        return { rows: [{
          id: AGENCY_A,
          code: "A",
          name: "Agency A",
          individual_count: 1,
          employee_count: 0,
          managed_budget_count: 0,
          billing_without_budget_count: 1,
        }] };
      }
      if (sql.includes("JOIN individuals individual")) {
        return { rows: [{
          agency_id: AGENCY_A,
          person_id: AGENCY_A_INDIVIDUAL,
          name: "Responsibility Changed",
          manages_budget: params?.[1] === `${agencyMonth()}-01`,
          bills_services: true,
        }] };
      }
      if (sql.includes("JOIN employees employee")) return { rows: [] };
      if (sql.includes("program_budget_balances") || sql.includes("physical_authorization_base")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected historical portal query: ${sql}`);
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    const historicalModel = await getPortalHomeReadModel(pool, context, "2024-02");
    const currentModel = await getPortalHomeReadModel(pool, context, agencyMonth());

    expect(historicalModel.agencies[0]?.individuals?.[0]).toMatchObject({
      id: AGENCY_A_INDIVIDUAL,
      managesBudget: false,
      billsServices: true,
      hours: null,
      dollars: null,
    });
    expect(currentModel.agencies[0]?.individuals?.[0]).toMatchObject({
      id: AGENCY_A_INDIVIDUAL,
      managesBudget: true,
      billsServices: true,
    });
    const responsibilityCalls = query.mock.calls.filter(([sql]) => sql.includes("JOIN individuals individual"));
    expect(responsibilityCalls[0]?.[0]).toContain("row_number() OVER");
    expect(responsibilityCalls[0]?.[0]).toContain("WHERE responsibility_rank = 1");
    expect(responsibilityCalls[0]?.[0]).not.toContain("bool_or(");
    expect(responsibilityCalls[0]?.[0]).not.toContain("now() AT TIME ZONE");
    expect(responsibilityCalls[0]?.[1]).toEqual([[AGENCY_A], "2024-02-01"]);
    expect(responsibilityCalls[1]?.[0]).toContain("membership.effective_from < ($2::date + interval '1 month')");
    expect(responsibilityCalls[1]?.[0]).not.toContain("now() AT TIME ZONE");
    expect(responsibilityCalls[1]?.[1]).toEqual([[AGENCY_A], `${agencyMonth()}-01`]);
  });

  it("reconciles mid-month responsibility facts without gating them by the latest badge", async () => {
    const context: PortalAccessContext = {
      userId: "mid-month-agency-user",
      globalRoles: [],
      individualLinks: [],
      employeeLinks: [],
      agencyAccess: [{
        agencyId: AGENCY_A,
        agencyCode: "A",
        agencyName: "Agency A",
        role: "agency",
        grants: [],
        denials: [
          "dollar_budgets.agency.read",
          "financials.agency.direct_checks.read",
          "financials.agency.agency_paid.read",
          "settlements.agency.read",
        ],
      }],
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void params;
      if (sql.includes("FROM agencies a")) {
        return { rows: [{
          id: AGENCY_A,
          code: "A",
          name: "Agency A",
          individual_count: 1,
          employee_count: 0,
          managed_budget_count: 0,
          billing_without_budget_count: 1,
        }] };
      }
      if (sql.includes("JOIN individuals individual")) {
        return { rows: [{
          agency_id: AGENCY_A,
          person_id: AGENCY_A_INDIVIDUAL,
          name: "Changed Mid-month",
          manages_budget: false,
          bills_services: true,
        }] };
      }
      if (sql.includes("JOIN employees employee")) return { rows: [] };
      if (sql.includes("FROM unnest")) {
        return { rows: [{
          scope_id: AGENCY_A,
          billed_this_month: "70",
          set_aside_this_month: "30",
          agency_paid_this_month: null,
          payroll_gross_this_month: null,
          payroll_net_this_month: null,
          giveback_remaining: null,
        }] };
      }
      if (sql.includes("membership.individual_id AS person_id") && sql.includes("authorized_hours")) {
        return { rows: [] };
      }
      if (sql.includes("transaction.individual_id AS person_id")
        && sql.includes("sum(transaction.imported_amount)")) {
        return { rows: [{ agency_id: AGENCY_A, person_id: AGENCY_A_INDIVIDUAL, amount: "70" }] };
      }
      if (sql.includes("event.individual_id AS person_id")) {
        return { rows: [{ agency_id: AGENCY_A, person_id: AGENCY_A_INDIVIDUAL, amount: "30" }] };
      }
      if (sql.includes("membership.agency_id AS scope_id")
        && sql.includes("physical_authorization_base")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected mid-month portal query: ${sql}`);
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    const model = await getPortalHomeReadModel(pool, context, "2024-06");
    const agency = model.agencies[0];
    const individual = agency?.individuals?.[0];

    expect(individual).toMatchObject({
      managesBudget: false,
      billsServices: true,
      billedThisMonth: "70.0000",
      setAsideThisMonth: "30.0000",
    });
    expect(individual?.billedThisMonth).toBe(agency?.billedThisMonth);
    expect(individual?.setAsideThisMonth).toBe(agency?.setAsideThisMonth);
    const billedCall = query.mock.calls.find(([sql]) =>
      sql.includes("transaction.individual_id AS person_id")
      && sql.includes("sum(transaction.imported_amount)"),
    );
    const reserveCall = query.mock.calls.find(([sql]) => sql.includes("event.individual_id AS person_id"));
    expect(billedCall?.[0]).toContain("membership.bills_services = true");
    expect(billedCall?.[0]).toContain("BETWEEN membership.effective_from");
    expect(reserveCall?.[0]).toContain("membership.manages_budget = true");
    expect(reserveCall?.[0]).toContain("BETWEEN membership.effective_from");
  });

  it("keeps an archived former employee when an outstanding give-back is in agency totals", async () => {
    const context: PortalAccessContext = {
      userId: "collector-user",
      globalRoles: [],
      individualLinks: [],
      employeeLinks: [],
      agencyAccess: [{
        agencyId: AGENCY_A,
        agencyCode: "A",
        agencyName: "Agency A",
        role: "collector",
        grants: [],
        denials: [
          "financials.agency.cuts_set_asides.read",
          "financials.agency.direct_checks.read",
          "financials.agency.agency_paid.read",
        ],
      }],
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void params;
      if (sql.includes("FROM agencies a")) {
        return { rows: [{
          id: AGENCY_A,
          code: "A",
          name: "Agency A",
          individual_count: 0,
          employee_count: 0,
          managed_budget_count: 0,
          billing_without_budget_count: 0,
        }] };
      }
      if (sql.includes("JOIN individuals individual")) return { rows: [] };
      if (sql.includes("JOIN employees employee")) {
        return { rows: [{
          agency_id: AGENCY_A,
          person_id: AGENCY_A_EMPLOYEE,
          name: "Archived Employee",
        }] };
      }
      if (sql.includes("FROM unnest")) {
        return { rows: [{
          scope_id: AGENCY_A,
          billed_this_month: null,
          set_aside_this_month: null,
          agency_paid_this_month: null,
          payroll_gross_this_month: null,
          payroll_net_this_month: null,
          giveback_remaining: "75",
        }] };
      }
      if (sql.includes("obligation.employee_id AS person_id")) {
        return { rows: [{
          agency_id: AGENCY_A,
          person_id: AGENCY_A_EMPLOYEE,
          due_this_month: "0",
          collected_this_month: "0",
          remaining: "75",
        }] };
      }
      throw new Error(`Unexpected archived-employee portal query: ${sql}`);
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    const model = await getPortalHomeReadModel(pool, context, "2024-01");
    const agency = model.agencies[0];
    const employee = agency?.employees?.[0];

    expect(employee).toMatchObject({
      id: AGENCY_A_EMPLOYEE,
      name: "Archived Employee",
      giveBack: { remaining: "75.0000" },
    });
    expect(employee?.giveBack?.remaining).toBe(agency?.giveBackRemaining);
    expect(agency?.employeeCount).toBe(agency?.employees?.length);
    expect(agency?.employeeCount).toBe(1);
    const rosterCall = query.mock.calls.find(([sql]) => sql.includes("JOIN employees employee"));
    expect(rosterCall?.[0]).toContain("obligation.status = 'active'");
    expect(rosterCall?.[0]).not.toContain("employee.status <> 'archived'");
    expect(rosterCall?.[0]).not.toContain("now() AT TIME ZONE");
  });

  it("accepts only a real YYYY-MM reporting month", () => {
    expect(normalizePortalMonth("2025-12")).toBe("2025-12");
    expect(normalizePortalMonth("2025-13")).toBe(agencyMonth());
    expect(normalizePortalMonth("0000-01")).toBe(agencyMonth());
    expect(normalizePortalMonth("not-a-month")).toBe(agencyMonth());
  });

  it("returns every verified employee check in the selected month without widening field access", async () => {
    const context: PortalAccessContext = {
      userId: "employee-user",
      globalRoles: [{
        role: "employee",
        grants: [],
        denials: [
          "employee_checks.self.gross.read",
          "employee_checks.self.tax.read",
        ],
      }],
      individualLinks: [],
      employeeLinks: [{ employeeId: EMPLOYEE, relationship: "self", grants: [], denials: [] }],
      agencyAccess: [],
    };
    const rows = Array.from({ length: 13 }, (_, index) => ({
      id: `check-${index + 1}`,
      employee_id: EMPLOYEE,
      check_number: `${1000 + index}`,
      check_date: `2024-02-${String(index + 1).padStart(2, "0")}`,
      period_begin: "2024-02-01",
      period_end: "2024-02-29",
      actual_gross: "125.00",
      actual_net: "100.00",
      tax_withheld: "25.00",
    }));
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void params;
      if (sql.includes("FROM employees")) return { rows: [{ id: EMPLOYEE, name: "Employee One" }] };
      if (sql.includes("FROM employee_payroll_checks c")) return { rows };
      if (sql.includes("FROM payroll_transactions transaction")) {
        return { rows: [{
          id: "direct-service-1",
          employee_id: EMPLOYEE,
          service_date: "2024-02-12",
          check_number: "1002",
          individual_name: "Individual One",
          program_code: "COMHAB",
          program_name: "Community Habilitation",
          hours: "6.5",
          gross_service_value: "136.50",
        }] };
      }
      if (sql.includes("FROM settlement_obligations o")) {
        return { rows: [{ scope_id: EMPLOYEE, due_this_month: "50", collected_this_month: "25", remaining: "25" }] };
      }
      throw new Error(`Unexpected employee portal query: ${sql}`);
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    const model = await getPortalHomeReadModel(pool, context, "2024-02");

    expect(model.employees[0]).toMatchObject({
      id: EMPLOYEE,
      month: "2024-02",
      checkVisibility: { gross: false, net: true, tax: false },
    });
    expect(model.employees[0]?.checks).toHaveLength(13);
    expect(model.employees[0]?.checks?.[0]).toMatchObject({
      serviceDate: "2024-02-01",
      actualNet: "100.0000",
    });
    expect(model.employees[0]?.checks?.[0]).not.toHaveProperty("actualGross");
    expect(model.employees[0]?.checks?.[0]).not.toHaveProperty("taxWithheld");
    expect(model.employees[0]?.directPay).toEqual([{
      id: "direct-service-1",
      serviceDate: "2024-02-12",
      checkNumber: "1002",
      individualName: "Individual One",
      programCode: "COMHAB",
      programName: "Community Habilitation",
      hours: "6.5000",
      grossServiceValue: "136.5000",
    }]);

    const checkCall = query.mock.calls.find(([sql]) => sql.includes("FROM employee_payroll_checks c"));
    expect(checkCall?.[0]).toContain("date_trunc('month', canonical_service_date(");
    expect(checkCall?.[0]).toContain("= $5::date");
    expect(checkCall?.[0]).not.toMatch(/portal_row|row_number/i);
    expect(checkCall?.[1]?.[4]).toBe("2024-02-01");
    const directPayCall = query.mock.calls.find(([sql]) => sql.includes("FROM payroll_transactions transaction"));
    expect(directPayCall?.[0]).toContain("checks.verification_status = 'verified'");
    expect(directPayCall?.[0]).toContain("effective_payment_recipient(");
    expect(directPayCall?.[0]).toContain("= 'employee'");
    expect(directPayCall?.[0]).toContain("transaction.employee_id = ANY($1::uuid[])");
    expect(directPayCall?.[1]).toEqual([[EMPLOYEE], "2024-02-01"]);
    const giveBackCall = query.mock.calls.find(([sql]) => sql.includes("FROM settlement_obligations o"));
    const dueFilter = giveBackCall?.[0].match(
      /sum\(o\.original_amount\) FILTER \(([\s\S]*?)\), 0\)::text AS due_this_month/,
    )?.[1];
    expect(dueFilter).toContain("o.status = 'active'");
  });

  it("does not query or return direct-pay services when that employee capability is denied", async () => {
    const context: PortalAccessContext = {
      userId: "employee-with-limited-view",
      globalRoles: [{
        role: "employee",
        grants: [],
        denials: [
          "employee_pay.self.read",
          "employee_checks.self.gross.read",
          "employee_checks.self.net.read",
          "employee_checks.self.tax.read",
          "employee_giveback.self.read",
        ],
      }],
      individualLinks: [],
      employeeLinks: [{ employeeId: EMPLOYEE, relationship: "self", grants: [], denials: [] }],
      agencyAccess: [],
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM employees")) return { rows: [{ id: EMPLOYEE, name: "Employee One" }] };
      throw new Error(`Unexpected limited employee portal query: ${sql}`);
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    const model = await getPortalHomeReadModel(pool, context, "2024-02");

    expect(model.employees[0]).toMatchObject({
      checks: null,
      directPay: null,
      giveBack: null,
    });
    expect(query.mock.calls.map(([sql]) => sql).join("\n")).not.toContain("payroll_transactions");
  });
});
