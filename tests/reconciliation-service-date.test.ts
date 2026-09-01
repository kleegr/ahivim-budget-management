import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { canonicalServiceDate } from "@/lib/business/service-date";
import { REPORT_PRESENTATION } from "@/components/reports/report-library";
import type { PgLikePool } from "@/lib/import/commit";
import {
  candidatesForSession,
  listBilledNotScheduled,
  reconciliationDetail,
  reconciliationSummary,
} from "@/lib/manage/reconciliation";

const FROM = "2026-08-01";
const TO = "2026-08-31";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const CANONICAL_WINDOW =
  "canonical_service_date(t.period_begin, t.check_date, t.period_end) BETWEEN $1 AND $2";

describe("reconciliation canonical service dates", () => {
  it("falls back from a null period begin to check date, then period end", () => {
    expect(canonicalServiceDate({
      periodBegin: null,
      checkDate: "2026-08-15",
      periodEnd: "2026-08-31",
    })).toBe("2026-08-15");
    expect(canonicalServiceDate({
      periodBegin: null,
      checkDate: null,
      periodEnd: "2026-08-31",
    })).toBe("2026-08-31");
  });

  it("uses the canonical date for billed summaries and unmatched rows", async () => {
    const summarySql: string[] = [];
    const summaryPool = {
      query: vi.fn(async (query: string) => {
        summarySql.push(query);
        if (query.includes("GROUP BY bucket")) return { rows: [] };
        return { rows: [{ c: "2", hours: "3", amount: "60" }] };
      }),
    } as unknown as PgLikePool;

    const summary = await reconciliationSummary(summaryPool, { from: FROM, to: TO });

    expect(summary.billedNotScheduled).toEqual({ count: 2, hours: "3.0000", amount: "60.0000" });
    expect(summarySql[1]).toContain(CANONICAL_WINDOW);
    expect(summarySql[1]).not.toContain("WHERE t.period_begin BETWEEN");

    const listSql: string[] = [];
    const listPool = {
      query: vi.fn(async (query: string) => {
        listSql.push(query);
        if (!query.includes(CANONICAL_WINDOW)) return { rows: [] };
        return {
          rows: [
            {
              id: "check-date-fallback",
              service_date: "2026-08-15",
              period_begin: null,
              check_date: "2026-08-15",
              period_end: "2026-08-10",
              program_code: "COMHAB",
              individual_name: "Check Date",
              imported_hours: "1",
              imported_amount: "20",
            },
            {
              id: "period-end-fallback",
              service_date: "2026-08-31",
              period_begin: null,
              check_date: null,
              period_end: "2026-08-31",
              program_code: "COMHAB",
              individual_name: "Period End",
              imported_hours: "2",
              imported_amount: "40",
            },
          ],
        };
      }),
    } as unknown as PgLikePool;

    const rows = await listBilledNotScheduled(listPool, { from: FROM, to: TO });

    expect(rows.map((row) => row.id)).toEqual(["check-date-fallback", "period-end-fallback"]);
    expect(rows.map((row) => row.serviceDate)).toEqual(["2026-08-15", "2026-08-31"]);
    expect(listSql[0]).toContain(CANONICAL_WINDOW);
    expect(listSql[0]).toContain(
      "ORDER BY canonical_service_date(t.period_begin, t.check_date, t.period_end) NULLS LAST",
    );
    expect(listSql[0]).not.toContain("WHERE t.period_begin BETWEEN");
  });

  it("displays the canonical date when only one period boundary exists", () => {
    const client = readFileSync("src/components/reconciliation/reconcile-client.tsx", "utf8");
    expect(client).toContain("b.periodBegin && b.periodEnd");
    expect(client).toContain("b.serviceDate ?? periodLabel(b.periodBegin, b.periodEnd)");
  });

  it("scopes both duplicate scans by canonical date", async () => {
    const sql: string[] = [];
    const pool = {
      query: vi.fn(async (query: string) => {
        sql.push(query);
        if (query.includes("GROUP BY t.transaction_fingerprint")) {
          return {
            rows: [{
              c: 2,
              ids: ["check-date-1", "check-date-2"],
              period_begin: null,
              check_date: "2026-08-15",
              period_end: "2026-08-31",
              individual_name: "Check Date",
              program_code: "COMHAB",
              amount: "20",
            }],
          };
        }
        if (query.includes("GROUP BY t.individual_id")) {
          return {
            rows: [{
              c: 2,
              ids: ["period-end-1", "period-end-2"],
              period_begin: null,
              check_date: null,
              period_end: "2026-08-31",
              individual_name: "Period End",
              program_code: "COMHAB",
              amount: "40",
            }],
          };
        }
        return { rows: [] };
      }),
    } as unknown as PgLikePool;

    const detail = await reconciliationDetail(pool, { from: FROM, to: TO });
    const duplicateSql = sql.filter((query) => query.includes("HAVING count(*) > 1"));

    expect(detail.duplicates.map((group) => group.reason)).toEqual(["fingerprint", "composite"]);
    expect(duplicateSql).toHaveLength(2);
    for (const query of duplicateSql) {
      expect(query).toContain(CANONICAL_WINDOW);
      expect(query).not.toContain("WHERE t.period_begin BETWEEN");
    }
    expect(duplicateSql[1]).toContain(
      "canonical_service_date(t.period_begin, t.check_date, t.period_end)",
    );
  });

  it("keeps session candidate matching based on period overlap", async () => {
    const sql: string[] = [];
    const pool = {
      query: vi.fn(async (query: string) => {
        sql.push(query);
        return { rows: [] };
      }),
    } as unknown as PgLikePool;

    await candidatesForSession(pool, SESSION_ID);

    expect(sql[0]).toContain("s.session_date BETWEEN t.period_begin AND t.period_end");
  });

  it("labels canonical-date reports with their actual time basis", () => {
    for (const key of ["agency-earnings", "employee-payable", "unscheduled-billing"]) {
      expect(REPORT_PRESENTATION[key].timeBasis).toBe("Canonical service date");
    }
  });
});
