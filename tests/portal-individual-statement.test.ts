import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PortalAccessContext, PortalCapability } from "@/lib/auth/portal-access";
import { getPortalIndividualStatement } from "@/lib/data/portal-individual-statement";
import {
  portalIndividualStatementCsv,
  portalIndividualStatementHtml,
} from "@/lib/export/portal-individual-statement";
import type { PgLikePool } from "@/lib/import/commit";

const INDIVIDUAL_ID = "00000000-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  getPool: vi.fn(),
  resolvePortalAccess: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/auth/portal-access", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth/portal-access")>(),
  resolvePortalAccess: mocks.resolvePortalAccess,
}));

import { GET as downloadStatement } from "@/app/api/portal/individual-statements/route";

function parentAccess(
  grants: PortalCapability[],
  denials: PortalCapability[] = [],
): PortalAccessContext {
  return {
    userId: "portal-user",
    globalRoles: [{ role: "parent", grants: [], denials: [] }],
    agencyAccess: [],
    individualLinks: [{
      individualId: INDIVIDUAL_ID,
      relationship: "parent",
      grants,
      denials,
    }],
    employeeLinks: [],
  };
}

function statementPool() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM individuals")) {
      return { rows: [{ id: INDIVIDUAL_ID, name: "Individual One" }] };
    }
    if (sql.includes("sum(transaction.imported_amount)")) {
      return { rows: [
        { month: "2026-07", amount: "100" },
        { month: "2026-08", amount: "150" },
      ] };
    }
    if (sql.includes("FROM settlement_events")) {
      return { rows: [{ month: "2026-08", amount: "40" }] };
    }
    if (sql.includes("= 'excellent_staffing'")) {
      return { rows: [{ month: "2026-08", amount: "60" }] };
    }
    if (sql.includes("= 'employee'")) {
      return { rows: [{ month: "2026-08", amount: "90" }] };
    }
    throw new Error(`Unexpected statement query: ${sql}`);
  });
  return { pool: { query, connect: vi.fn() } as unknown as PgLikePool, query };
}

describe("individual portal statement privacy", () => {
  it("queries and returns only the categories granted on that direct relationship", async () => {
    const { pool, query } = statementPool();
    const statement = await getPortalIndividualStatement(
      pool,
      parentAccess([
        "financials.self.billed_totals.read",
        "financials.self.cuts_set_asides.read",
      ]),
      INDIVIDUAL_ID,
      "2026-08",
      3,
    );

    expect(statement?.visibility).toEqual({
      billed: true,
      setAside: true,
      direct: false,
      agencyPaid: false,
    });
    expect(statement?.months).toEqual([
      { month: "2026-06", billed: "0.0000", setAside: "0.0000", direct: null, agencyPaid: null },
      { month: "2026-07", billed: "100.0000", setAside: "0.0000", direct: null, agencyPaid: null },
      { month: "2026-08", billed: "150.0000", setAside: "40.0000", direct: null, agencyPaid: null },
    ]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("employee_payment_amount"))).toBe(false);
    expect(JSON.stringify(statement)).not.toMatch(/employeeName|checkNumber|tax|gross|net/i);
  });

  it("honors a category denial even when the relationship also grants it", async () => {
    const { pool, query } = statementPool();
    const statement = await getPortalIndividualStatement(
      pool,
      parentAccess([
        "financials.self.direct_checks.read",
        "financials.self.agency_paid.read",
      ], ["financials.self.direct_checks.read"]),
      INDIVIDUAL_ID,
      "2026-08",
      1,
    );

    expect(statement?.visibility).toMatchObject({ direct: false, agencyPaid: true });
    expect(statement?.months[0]).toMatchObject({ direct: null, agencyPaid: "60.0000" });
    const paymentQueries = query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes("employee_payment_amount"));
    expect(paymentQueries).toHaveLength(1);
    expect(paymentQueries[0]).toContain("= 'excellent_staffing'");
  });

  it("does not query anything for an unlinked individual", async () => {
    const query = vi.fn();
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;
    const access = parentAccess([]);
    access.individualLinks = [];
    await expect(getPortalIndividualStatement(
      pool,
      access,
      INDIVIDUAL_ID,
      "2026-08",
    )).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("falls back to the standard trend window for a non-finite month count", async () => {
    const { pool } = statementPool();
    const statement = await getPortalIndividualStatement(
      pool,
      parentAccess(["financials.self.billed_totals.read"]),
      INDIVIDUAL_ID,
      "2026-08",
      Number.NaN,
    );

    expect(statement?.months).toHaveLength(12);
    expect(statement?.months.at(0)?.month).toBe("2025-09");
    expect(statement?.months.at(-1)?.month).toBe("2026-08");
  });

  it("omits hidden categories from both the CSV and printable HTML", async () => {
    const { pool } = statementPool();
    const statement = await getPortalIndividualStatement(
      pool,
      parentAccess(["financials.self.billed_totals.read"]),
      INDIVIDUAL_ID,
      "2026-08",
      2,
    );
    expect(statement).not.toBeNull();

    const csv = portalIndividualStatementCsv(statement!, "trend");
    const html = portalIndividualStatementHtml(statement!, "month");
    const historyHtml = portalIndividualStatementHtml(statement!, "trend");
    expect(csv).toContain("Billed");
    expect(html).toContain("Billed");
    expect(historyHtml).toContain("2-month history");
    for (const hidden of ["Set aside", "Direct-paid", "Agency-paid", "Tax", "Check", "Employee"]) {
      expect(csv).not.toContain(hidden);
      expect(html).not.toContain(hidden);
    }
  });
});

describe("individual portal statement download route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const { pool } = statementPool();
    mocks.apiUser.mockResolvedValue({ id: "portal-user", role: "viewer" });
    mocks.getPool.mockReturnValue(pool);
    mocks.resolvePortalAccess.mockResolvedValue(parentAccess([
      "financials.self.billed_totals.read",
      "financials.self.cuts_set_asides.read",
    ]));
  });

  it("downloads a no-store aggregate CSV after authoritative portal access resolution", async () => {
    const response = await downloadStatement(new NextRequest(
      `http://localhost/api/portal/individual-statements?individualId=${INDIVIDUAL_ID}&month=2026-08&scope=trend&format=csv&months=3`,
    ));
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(mocks.resolvePortalAccess).toHaveBeenCalled();
    expect(csv).toContain("Billed");
    expect(csv).toContain("Set aside");
    expect(csv).not.toMatch(/Direct-paid|Agency-paid|Tax|Check|Employee/);
  });

  it("returns not found when the signed-in account is not linked to that individual", async () => {
    const unlinked = parentAccess([]);
    unlinked.individualLinks = [];
    mocks.resolvePortalAccess.mockResolvedValue(unlinked);
    const response = await downloadStatement(new NextRequest(
      `http://localhost/api/portal/individual-statements?individualId=${INDIVIDUAL_ID}&month=2026-08`,
    ));
    expect(response.status).toBe(404);
  });
});
