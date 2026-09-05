import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fullAccess, type AccessScope } from "@/lib/auth/access";
import { canAccessReport, REPORT_ACCESS } from "@/lib/data/report-access";
import { billingWithoutBudgetReport } from "@/lib/data/report-completeness";
import { auditHistoryReport, REPORTS } from "@/lib/data/report-queries";
import type { PgLikePool } from "@/lib/import/commit";
import {
  listBilledNotScheduled,
  listScheduledForReconcile,
} from "@/lib/manage/reconciliation";
import { REPORT_LIBRARY } from "@/components/reports/report-library";
import { listTransactionsForGrid } from "@/lib/data/transactions-grid";

const EXPECTED_CATALOG = {
  Budgets: [
    "Budget utilization",
    "Budget exceptions",
    "Renewal pipeline",
    "Billing without budget",
    "Actual versus scheduled",
  ],
  Activity: [
    "Transactions",
    "Scheduled not recorded",
    "Recorded not scheduled",
    "Group services",
    "Employee activity",
  ],
  "Payroll and Money": [
    "Payroll checks",
    "Give-Back",
    "Agency-to-Employee payments",
    "Individual put-away",
    "Credits",
    "Agency Financials",
    "Billing spread by Program",
    "Employee Base by recipient",
  ],
  "Data Quality": [
    "Missing configuration",
    "Missing rates",
    "Unverified checks",
    "Import conflicts",
    "Alias and merge history",
    "Audit history",
  ],
} as const;

function ledgerRow(input: {
  id: string;
  serviceDate: string;
  programId: string;
  programCode: string;
}) {
  return {
    id: input.id,
    service_date: input.serviceDate,
    pay_to: null,
    check_date: input.serviceDate,
    check_number: "CHK-1",
    hours: "2",
    rate: "100",
    employee_rate: "60",
    gross: "200",
    total_net_pay: "150",
    verified_check_gross: null,
    verified_check_net: null,
    withholding: null,
    verification_status: "unverified",
    period_begin: input.serviceDate,
    period_end: input.serviceDate,
    program: `Program ${input.programCode}`,
    program_code: input.programCode,
    program_id: input.programId,
    individual: "Archived Historical Person",
    individual_id: "00000000-0000-4000-8000-000000000001",
    employee: "Employee One",
    employee_id: "00000000-0000-4000-8000-000000000002",
    internal_amount: "120",
    agency_additional: "80",
    payment_recipient: "employee",
    import_batch_id: null,
    import_row_id: null,
    source_file_id: null,
    source_name: "source.xlsx",
    source_sheet: "Sheet1",
    source_row_number: 5,
    has_open_rate_review: false,
    match_status: "new",
    is_group: false,
    service_session_id: null,
    group_detection_status: "single",
    is_paid: false,
    paid_at: null,
    paid_note: null,
  };
}

describe("complete report catalog", () => {
  it("publishes exactly the 24 requested labels in the four requested groups", () => {
    expect(Object.fromEntries(REPORT_LIBRARY.map((group) => [
      group.heading,
      group.reports.map((report) => report.title),
    ]))).toEqual(EXPECTED_CATALOG);

    const reports = REPORT_LIBRARY.flatMap((group) => group.reports);
    expect(reports).toHaveLength(24);
    expect(new Set(reports.map((report) => report.title)).size).toBe(24);
    for (const report of reports) {
      expect(report.question.trim()).not.toBe("");
      expect(report.timeBasis.trim()).not.toBe("");
      expect(REPORT_ACCESS[report.key]).toBeDefined();
      if (!report.href) {
        expect(REPORTS[report.key]).toBeDefined();
        expect(Array.isArray(REPORTS[report.key].filters)).toBe(true);
      }
    }
  });

  it("keeps Missing configuration and Missing rates as separate questions", () => {
    expect(REPORTS["missing-config"].description).toContain("assignment");
    expect(REPORTS["missing-rates"].description).toContain("rate schedule");
    expect(REPORTS["import-conflicts"].description).toContain("resolution history");
    expect(REPORTS["alias-decisions"].description).toContain("merge lineage");
  });

  it("gives every native catalog table a truthful relative source", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as PgLikePool;
    for (const report of REPORT_LIBRARY.flatMap((group) => group.reports)) {
      if (report.href) continue;
      const tables = await REPORTS[report.key].run(pool, {});
      expect(tables.length, report.title).toBeGreaterThan(0);
      for (const table of tables) {
        expect(table.source?.href, `${report.title} / ${table.title ?? table.key}`).toMatch(/^\/(?!\/)/);
        expect(table.source?.href).not.toContain("#report-source");
        expect(table.source?.label.trim()).not.toBe("");
      }
    }
  });

  it("frames the owner workspace with its exact question, date basis, totals, source links, and exports", () => {
    const page = readFileSync("src/app/(app)/reports/agency-financials/page.tsx", "utf8");
    const workspace = readFileSync("src/components/reports/agency-financial-workspace.tsx", "utf8");
    expect(page).toContain("What actual income came in, what actual expenses apply, and what remains for the agency?");
    expect(page).toContain("Selected month, using recorded actuals");
    expect(workspace).toContain("Date basis:");
    expect(workspace).toContain("Total income");
    expect(workspace).toContain("Total expenses");
    expect(workspace).toContain("/api/agency-financials/export?format=csv");
    expect(workspace).toContain("/api/agency-financials/export?format=xlsx");
    expect(workspace).toContain("collectionsPayrollCheckFocusHref");
  });
});

describe("report authorization boundaries", () => {
  const manager = fullAccess("manager-1", "manager");

  it.each([
    ["employee-payable", "canSeeEmployeeAmounts"],
    ["agency-earnings", "canSeeAgencySpread"],
    ["payroll-checks", "canSeeCheckNet"],
    ["unverified-checks", "canSeeCheckGross"],
    ["unverified-checks", "canSeeTaxes"],
    ["give-back", "canSeeSettlements"],
  ] as const)("denies %s when %s is explicitly denied", (report, permission) => {
    const denied = { ...manager, [permission]: false } as AccessScope;
    expect(canAccessReport(report, denied, "manager")).toBe(false);
  });

  it("fails closed for scoped accounts, unreviewed report keys, and non-owner financials", () => {
    expect(canAccessReport("transactions", {
      ...manager,
      full: false,
      allIndividuals: true,
      allEmployees: false,
    }, "manager")).toBe(false);
    expect(canAccessReport("new-unreviewed-report", manager, "manager")).toBe(false);
    expect(canAccessReport("agency-financials", manager, "manager")).toBe(false);
    expect(canAccessReport("agency-financials", fullAccess("owner-1", "admin"), "admin")).toBe(true);
  });

  it("gates the manager-only hub, direct report, and both report export paths", () => {
    const hub = readFileSync("src/app/(app)/reports/page.tsx", "utf8");
    const detail = readFileSync("src/app/(app)/reports/[report]/page.tsx", "utf8");
    const serverExport = readFileSync("src/app/api/reports/[report]/export/route.ts", "utf8");
    const gridExport = readFileSync("src/app/api/grid/export/route.ts", "utf8");
    const grid = readFileSync("src/components/reports/report-grid.tsx", "utf8");

    expect(hub).toContain('requireUser("manager")');
    expect(hub).toContain("canAccessReport(report.key, access.data, user.role)");
    expect(detail.indexOf("canAccessReport(report, scope, user.role)")).toBeLessThan(
      detail.indexOf("def.run(pool, filters)"),
    );
    expect(detail).toContain("duplicateIndividuals.add(row.display_name)");
    expect(detail).toContain("indMap.delete(row.display_name)");
    expect(detail).toContain("duplicateEmployees.add(row.display_name)");
    expect(detail).toContain("empMap.delete(row.display_name)");
    expect(serverExport.indexOf("canAccessReport(report, scope, user.role)")).toBeLessThan(
      serverExport.indexOf("def.run(pool, filters)"),
    );
    expect(grid).toContain("/api/grid/export?report=${encodeURIComponent(reportKey)}");
    expect(gridExport).toContain('request.nextUrl.searchParams.get("report")');
    expect(gridExport).toContain("canAccessReport(reportKey, scope, user.role)");
    expect(gridExport).toContain('user.role === "viewer"');
  });
});

describe("report completeness and source truth", () => {
  it("checks exact Program authorization on each canonical service date, including historical people", async () => {
    const uncoveredId = "00000000-0000-4000-8000-000000000010";
    const coveredOtherProgramId = "00000000-0000-4000-8000-000000000011";
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("SELECT activity.id")) return { rows: [{ id: uncoveredId }] };
      return {
        rows: [
          ledgerRow({
            id: uncoveredId,
            serviceDate: "2025-01-15",
            programId: "00000000-0000-4000-8000-000000000020",
            programCode: "PROGRAM-A",
          }),
          ledgerRow({
            id: coveredOtherProgramId,
            serviceDate: "2025-01-15",
            programId: "00000000-0000-4000-8000-000000000021",
            programCode: "PROGRAM-B",
          }),
        ],
      };
    });
    const pool = { query } as unknown as PgLikePool;

    const rows = await billingWithoutBudgetReport(pool, {
      from: "2025-01-01",
      to: "2025-01-31",
    });

    expect(rows).toEqual([expect.objectContaining({
      individualName: "Archived Historical Person",
      programCode: "PROGRAM-A",
      transactionCount: 1,
      recordedHours: "2.0000",
      funderBilled: "200.0000",
    })]);
    const coverageCall = query.mock.calls.find(([sql]) => sql.includes("SELECT activity.id"));
    expect(coverageCall?.[1]).toEqual(["2025-01-01", "2025-01-31", null, null]);
    const coverageSql = String(coverageCall?.[0]);
    expect(coverageSql).toContain("effective_budget_authorizations_at(activity.service_date)");
    expect(coverageSql).toContain("historical.individual_id = activity.individual_id");
    expect(coverageSql).toContain("historical.program_id = activity.program_id");
    expect(coverageSql).toContain("activity.service_date BETWEEN historical.start_date AND historical.end_date");
    expect(coverageSql).toContain("historical.required_auth_type = 'dollars'");
    expect(coverageSql).toContain("effective_program.required_auth_type = 'hours'");
    expect(coverageSql).not.toContain("individual.status = 'active'");
    expect(rows[0].sourceHref).toContain("programCode=PROGRAM-A");
  });

  it("requests complete unmatched result sets while preserving bounded operational defaults", async () => {
    const scheduledQuery = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    const scheduledPool = { query: scheduledQuery } as unknown as PgLikePool;
    await listScheduledForReconcile(
      scheduledPool,
      { from: "2026-01-01", to: "2026-01-31" },
      true,
      null,
    );
    expect(String(scheduledQuery.mock.calls[0][0])).not.toMatch(/\bLIMIT\b/);
    expect(scheduledQuery.mock.calls[0][1]).toHaveLength(5);

    const billedQuery = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    const billedPool = { query: billedQuery } as unknown as PgLikePool;
    await listBilledNotScheduled(
      billedPool,
      { from: "2026-01-01", to: "2026-01-31" },
      null,
    );
    expect(String(billedQuery.mock.calls[0][0])).not.toMatch(/\bLIMIT\b/);
    expect(billedQuery.mock.calls[0][1]).toHaveLength(4);

    const boundedQuery = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    await listBilledNotScheduled(
      { query: boundedQuery } as unknown as PgLikePool,
      { from: "2026-01-01", to: "2026-01-31" },
    );
    expect(String(boundedQuery.mock.calls[0][0])).toContain("LIMIT $5");
    expect(boundedQuery.mock.calls[0][1]).toEqual([
      "2026-01-01",
      "2026-01-31",
      null,
      null,
      200,
    ]);
  });

  it("uses truthful relative drilldowns, preserves link URLs for export, and has no self-anchor sources", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{
          ts: "2026-09-04 09:15",
          actor: "Owner",
          action: "document_saved",
          entity_type: "document",
          entity_id: "doc id/with spaces",
          reason: "Updated",
        }],
      })),
    } as unknown as PgLikePool;
    await expect(auditHistoryReport(pool)).resolves.toEqual([
      expect.objectContaining({
        sourceHref: "/documents/pdf-editor?id=doc%20id%2Fwith%20spaces",
      }),
    ]);

    const grid = readFileSync("src/components/reports/report-grid.tsx", "utf8");
    expect(grid).toContain('value.startsWith("/")');
    expect(grid).toContain("return tableSource ?? null");
    expect(grid).toContain("if (rows.length === 0) return tableSource ?? null");
    expect(grid).not.toContain("#report-source");
    expect(grid).toContain("accessor: (r) => (r[c.key] == null ? null : String(r[c.key]))");
  });

  it("exports a source URL while retaining transaction IDs as non-visible row metadata", async () => {
    const transactionId = "00000000-0000-4000-8000-000000000010";
    const payrollPool = {
      query: vi.fn(async () => ({ rows: [ledgerRow({
        id: transactionId,
        serviceDate: "2026-08-10",
        programId: "00000000-0000-4000-8000-000000000020",
        programCode: "PROGRAM-A",
      })] })),
    } as unknown as PgLikePool;
    const [payroll] = await REPORTS["payroll-checks"].run(payrollPool, {});
    expect(payroll.columns.at(-1)).toMatchObject({
      key: "sourceHref",
      linkLabel: "Open transaction",
    });
    expect(payroll.rows[0]).toMatchObject({
      transactionId,
      sourceHref: `/transactions?transactionId=${transactionId}`,
    });

    const unmatchedPool = {
      query: vi.fn(async () => ({ rows: [{
        id: transactionId,
        service_date: "2026-08-10",
        period_begin: "2026-08-10",
        period_end: "2026-08-10",
        program_code: "PROGRAM-A",
        individual_name: "Person One",
        imported_hours: "2",
        imported_amount: "200",
      }] })),
    } as unknown as PgLikePool;
    const [unmatched] = await REPORTS["unscheduled-billing"].run(unmatchedPool, {});
    expect(unmatched.columns.at(-1)).toMatchObject({
      key: "sourceHref",
      linkLabel: "Open transaction",
    });
    expect(unmatched.rows[0]).toMatchObject({
      transactionId,
      sourceHref: `/transactions?transactionId=${transactionId}`,
    });
  });

  it("shows open import conflicts separately from resolved history with retained source URLs", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [
        {
          id: "open-1",
          type: "changed",
          status: "open",
          individual_name: "Person One",
          employee_name: "Employee One",
          program_name: "Program One",
          detail: "Amount changed",
          resolution: null,
          resolution_note: null,
          resolved_by: null,
          created_at: "2026-08-01T10:00:00Z",
          resolved_at: null,
          payroll_transaction_id: "00000000-0000-4000-8000-000000000010",
          import_row_id: null,
          source_file_id: null,
        },
        {
          id: "resolved-1",
          type: "missing",
          status: "accepted_missing",
          individual_name: "Person Two",
          employee_name: "Employee Two",
          program_name: "Program Two",
          detail: "Row no longer present",
          resolution: "accepted_missing",
          resolution_note: "Confirmed",
          resolved_by: "Owner",
          created_at: "2026-07-01T10:00:00Z",
          resolved_at: "2026-07-02T10:00:00Z",
          payroll_transaction_id: null,
          import_row_id: "00000000-0000-4000-8000-000000000020",
          source_file_id: "00000000-0000-4000-8000-000000000021",
        },
      ] })),
    } as unknown as PgLikePool;

    const tables = await REPORTS["import-conflicts"].run(pool, {});
    expect(tables.map((table) => table.title)).toEqual(["Open conflicts", "Resolved / history"]);
    expect(tables[0].rows).toEqual([expect.objectContaining({
      status: "open",
      sourceHref: "/transactions?transactionId=00000000-0000-4000-8000-000000000010",
    })]);
    expect(tables[1].rows).toEqual([expect.objectContaining({
      status: "accepted_missing",
      resolutionNote: "Confirmed",
      resolvedBy: "Owner",
      sourceHref: expect.stringMatching(/^\//),
    })]);
  });

  it("keeps unverified check amounts out of both screen and export columns", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{
        id: "00000000-0000-4000-8000-000000000030",
        employee_id: "00000000-0000-4000-8000-000000000002",
        employee_name: "Employee One",
        check_number: "CHK-9",
        check_date: "2026-08-10",
        period_begin: "2026-08-01",
        period_end: "2026-08-15",
        source: "manual",
        source_ref: "review-1",
        linked_transactions: "2",
        created_at: "2026-08-10T12:00:00Z",
      }] })),
    } as unknown as PgLikePool;
    const [table] = await REPORTS["unverified-checks"].run(pool, {});
    expect(table.rows).toHaveLength(1);
    expect(table.columns.map((column) => column.key)).not.toEqual(
      expect.arrayContaining(["gross", "net", "withholding", "tax"]),
    );
    expect(table.columns.at(-1)).toMatchObject({
      key: "sourceHref",
      linkLabel: "Open check",
    });
    expect(table.rows[0].sourceHref).toMatch(/^\//);
  });

  it("keeps unknown Employee base and Agency spread null and exports completeness columns", async () => {
    let ledgerSql = "";
    const ledgerPool = {
      query: vi.fn(async (sql: string) => {
        ledgerSql = sql;
        return { rows: [] };
      }),
    } as unknown as PgLikePool;
    await listTransactionsForGrid(ledgerPool, fullAccess("manager-1", "manager"));
    expect(ledgerSql).toContain("t.spreadsheet_internal_amount");
    expect(ledgerSql).toContain("t.internal_rate_applied * t.imported_hours))::text AS agency_additional");
    expect(ledgerSql).not.toContain("t.internal_rate_applied * t.imported_hours, 0))::text AS agency_additional");

    const emptyPool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as PgLikePool;
    const [transactions] = await REPORTS.transactions.run(emptyPool, {});
    expect(transactions.note).toContain("Money check");
    expect(transactions.columns.map((column) => column.key)).toContain("moneyReconciliation");

    const [spread] = await REPORTS["agency-earnings"].run(emptyPool, {});
    expect(spread.note).toContain("excluded");
    expect(spread.columns.map((column) => column.key)).toContain("excludedRows");

    const [base] = await REPORTS["employee-payable"].run(emptyPool, {});
    expect(base.note).toContain("Missing base rows");
    expect(base.columns.map((column) => column.key)).toContain("missingBaseRows");

    const [comparison] = await REPORTS["actual-vs-scheduled"].run(emptyPool, {});
    expect(comparison.note).toContain("stays blank");
    expect(comparison.columns.map((column) => column.key)).toEqual(expect.arrayContaining([
      "scheduledBaseMissingRows",
      "actualBaseMissingRows",
    ]));

    const transactionGrid = readFileSync("src/components/transactions/transactions-grid.tsx", "utf8");
    const reportGrid = readFileSync("src/components/reports/report-grid.tsx", "utf8");
    expect(transactionGrid).toContain("incomplete money");
    expect(transactionGrid).toContain('key: "moneyReconciliation"');
    expect(reportGrid).toContain('header: "Excluded money rows"');
  });
});
