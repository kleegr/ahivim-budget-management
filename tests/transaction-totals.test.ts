import { describe, it, expect } from "vitest";
import { computeGridTotals, type TotalsInput } from "@/lib/business/transaction-totals";

function row(p: Partial<TotalsInput>): TotalsInput {
  return {
    id: p.id ?? Math.random().toString(36),
    gross: p.gross ?? null,
    internalAmount: p.internalAmount ?? null,
    agencyAdditional: p.agencyAdditional ?? null,
    hours: p.hours ?? null,
    totalNetPay: p.totalNetPay ?? null,
    payTo: p.payTo ?? null,
    checkNumber: p.checkNumber ?? null,
    checkDate: p.checkDate ?? null,
    periodBegin: p.periodBegin ?? null,
    periodEnd: p.periodEnd ?? null,
    individualId: p.individualId ?? null,
    individual: p.individual ?? null,
    employeeId: p.employeeId ?? null,
    employee: p.employee ?? null,
    verifiedCheckGross: p.verifiedCheckGross ?? null,
    verifiedCheckNet: p.verifiedCheckNet ?? null,
    withholding: p.withholding ?? null,
    verificationStatus: p.verificationStatus ?? null,
  };
}

describe("computeGridTotals — Excel-SUBTOTAL parity", () => {
  it("reconciles gross, internal, derived agency spread, and hours", () => {
    const t = computeGridTotals([
      row({ id: "a", gross: "336.75", internalAmount: "282.87", agencyAdditional: "53.88", hours: "13.47" }),
      row({ id: "b", gross: "252.25", internalAmount: "211.89", agencyAdditional: "40.36", hours: "10.09" }),
    ]);
    expect(t.gross).toBe("589.00");
    expect(t.internal).toBe("494.76");
    expect(t.agencyAdditional).toBe("94.24"); // 53.88 + 40.36
    expect(t.hours).toBe("23.56");
    expect(t.transactions).toBe(2);
    expect(t.moneyExcludedRows).toBe(0);
  });

  it("counts Total Net Pay once per payment identity", () => {
    // Two rows of the SAME check both carry the check's full net pay (10538.05).
    const t = computeGridTotals([
      row({ id: "a", checkNumber: "24665", totalNetPay: "10538.05", gross: "336.75", internalAmount: "0" }),
      row({ id: "b", checkNumber: "24665", totalNetPay: "10538.05", gross: "252.25", internalAmount: "0" }),
      row({ id: "c", checkNumber: "24666", totalNetPay: "5000.00", gross: "100.00", internalAmount: "0" }),
    ]);
    // Net counted once per check: 10538.05 + 5000.00 — NOT 10538.05 twice.
    expect(t.netPerCheck).toBe("15538.05");
    expect(t.checks).toBe(2);
    expect(t.sourcePayments).toBe(2);
    expect(t.gross).toBe("689.00"); // gross is still summed per row
  });

  it("keeps a reused check number separate across dates and employees", () => {
    const t = computeGridTotals([
      row({ id: "a", employeeId: "e1", checkNumber: " 700 ", checkDate: "2026-08-01", totalNetPay: "100" }),
      row({ id: "b", employeeId: "e1", checkNumber: "700", checkDate: "2026-08-01", totalNetPay: "100" }),
      row({ id: "c", employeeId: "e1", checkNumber: "700", checkDate: "2026-08-15", totalNetPay: "200" }),
      row({ id: "d", employeeId: "e2", checkNumber: "700", checkDate: "2026-08-15", totalNetPay: "300" }),
    ]);

    expect(t.netPerCheck).toBe("600.00");
    expect(t.checks).toBe(3);
  });

  it("counts one agency source payment once while retaining both employee checks and their verified facts", () => {
    const t = computeGridTotals([
      row({
        id: "a",
        payTo: "Excellent Staffing",
        employeeId: "e1",
        checkNumber: " 900 ",
        checkDate: "2026-08-15",
        periodBegin: "2026-08-01",
        periodEnd: "2026-08-15",
        totalNetPay: "800",
        verificationStatus: "verified",
        verifiedCheckGross: "1000",
        verifiedCheckNet: "800",
        withholding: "200",
      }),
      row({
        id: "b",
        payTo: " excellent staffing, LLC ",
        employeeId: "e2",
        checkNumber: "900",
        checkDate: "2026-08-15",
        periodBegin: "2026-08-01",
        periodEnd: "2026-08-15",
        totalNetPay: "800",
        verificationStatus: "verified",
        verifiedCheckGross: "1000",
        verifiedCheckNet: "800",
        withholding: "200",
      }),
    ]);

    expect(t).toMatchObject({
      netPerCheck: "800.00",
      checks: 2,
      sourcePayments: 1,
      verifiedCheckGross: "2000.00",
      verifiedCheckNet: "1600.00",
      withholding: "400.00",
    });
  });

  it("keeps direct source payments to different employee payees separate", () => {
    const t = computeGridTotals([
      row({ id: "a", payTo: "First Employee", employeeId: "e1", checkNumber: "900", checkDate: "2026-08-15", totalNetPay: "100" }),
      row({ id: "b", payTo: "Second Employee", employeeId: "e2", checkNumber: "900", checkDate: "2026-08-15", totalNetPay: "200" }),
    ]);

    expect(t.netPerCheck).toBe("300.00");
    expect(t.checks).toBe(2);
  });

  it("keeps dated source payments separate when their period bounds differ", () => {
    const t = computeGridTotals([
      row({
        id: "a",
        payTo: "Excellent Staffing",
        employeeId: "e1",
        checkNumber: "901",
        checkDate: "2026-08-20",
        periodBegin: "2026-08-01",
        periodEnd: "2026-08-15",
        totalNetPay: "825",
      }),
      row({
        id: "b",
        payTo: "Excellent Staffing",
        employeeId: "e1",
        checkNumber: "901",
        checkDate: "2026-08-20",
        periodBegin: "2026-08-02",
        periodEnd: "2026-08-16",
        totalNetPay: "825",
      }),
    ]);

    expect(t.netPerCheck).toBe("1650.00");
    expect(t.checks).toBe(2);
  });

  it("uses both pay-period bounds and excludes fully unidentified rows from check totals", () => {
    const t = computeGridTotals([
      row({ id: "a", employee: "First Payee", checkNumber: "88", periodBegin: "2026-07-01", periodEnd: "2026-07-15", totalNetPay: "125" }),
      row({ id: "b", employee: "First Payee", checkNumber: "88", periodBegin: "2026-07-01", periodEnd: "2026-07-15", totalNetPay: "125" }),
      row({ id: "c", employee: "First Payee", checkNumber: "88", periodBegin: "2026-07-16", periodEnd: "2026-07-31", totalNetPay: "150" }),
      row({ id: "d", employee: "Second Payee", checkNumber: "88", periodBegin: "2026-07-16", periodEnd: "2026-07-31", totalNetPay: "175" }),
      row({ id: "e", employee: "First Payee", totalNetPay: "25" }),
      row({ id: "f", employee: "First Payee", totalNetPay: "30" }),
    ]);

    expect(t.netPerCheck).toBe("450.00");
    expect(t.checks).toBe(3);
  });

  it("counts verified check facts once per complete identity only", () => {
    const shared = {
      employeeId: "e1",
      checkNumber: " V-100 ",
      checkDate: "2026-08-15",
      periodBegin: "2026-08-01",
      periodEnd: "2026-08-15",
      verificationStatus: "verified",
      verifiedCheckGross: "1000",
      verifiedCheckNet: "800",
      withholding: "200",
    };
    const t = computeGridTotals([
      row({ id: "a", ...shared }),
      row({ id: "b", ...shared, checkNumber: "V-100" }),
      row({
        id: "c",
        ...shared,
        periodBegin: "2026-08-16",
        periodEnd: "2026-08-31",
        verifiedCheckGross: "500",
        verifiedCheckNet: "400",
        withholding: "100",
      }),
      row({
        id: "unverified",
        ...shared,
        employeeId: "e2",
        verificationStatus: "unverified",
        verifiedCheckGross: "900",
        verifiedCheckNet: "700",
        withholding: "200",
      }),
      row({
        id: "unidentified",
        employeeId: "e3",
        verificationStatus: "verified",
        verifiedCheckGross: "999",
        verifiedCheckNet: "999",
        withholding: "999",
      }),
    ]);

    expect(t).toMatchObject({
      checks: 3,
      verifiedCheckGross: "1500.00",
      verifiedCheckNet: "1200.00",
      withholding: "300.00",
    });
  });

  it("separates the same employee, number and check date when either period bound differs", () => {
    const t = computeGridTotals([
      row({ id: "a", employeeId: "e1", checkNumber: "10", checkDate: "2026-08-20", periodBegin: "2026-08-01", periodEnd: "2026-08-15", totalNetPay: "100" }),
      row({ id: "b", employeeId: "e1", checkNumber: "10", checkDate: "2026-08-20", periodBegin: "2026-08-02", periodEnd: "2026-08-15", totalNetPay: "200" }),
      row({ id: "c", employeeId: "e1", checkNumber: "10", checkDate: "2026-08-20", periodBegin: "2026-08-01", periodEnd: "2026-08-16", totalNetPay: "300" }),
    ]);

    expect(t.checks).toBe(3);
    expect(t.netPerCheck).toBe("600.00");
  });

  it("counts distinct individuals and employees (by id, falling back to name)", () => {
    const t = computeGridTotals([
      row({ id: "a", individualId: "i1", employeeId: "e1" }),
      row({ id: "b", individualId: "i1", employeeId: "e2" }),
      row({ id: "c", individual: "Raw Name", employee: "Raw Emp" }), // no ids → name fallback
    ]);
    expect(t.individuals).toBe(2); // i1, "Raw Name"
    expect(t.employees).toBe(3); // e1, e2, "Raw Emp"
  });

  it("agency additional total equals gross − internal across the set (workbook R = Q − P)", () => {
    // Per-row agency additional is gross − internal, allowed to be negative.
    const rows = [
      row({ id: "a", gross: "100", internalAmount: "120", agencyAdditional: "-20" }),
      row({ id: "b", gross: "200", internalAmount: "150", agencyAdditional: "50" }),
    ];
    const t = computeGridTotals(rows);
    expect(t.agencyAdditional).toBe("30.00"); // -20 + 50
    // reconciles to sum(gross) − sum(internal) = 300 − 270 = 30
    expect(Number(t.gross) - Number(t.internal)).toBeCloseTo(Number(t.agencyAdditional), 2);
  });

  it("excludes incomplete money rows and never trusts a stale or floored spread", () => {
    const t = computeGridTotals([
      row({ id: "negative", gross: "100", internalAmount: "120", agencyAdditional: "0" }),
      row({ id: "missing-base", gross: "50", internalAmount: null, agencyAdditional: "50" }),
      row({ id: "missing-gross", gross: null, internalAmount: "10", agencyAdditional: "-10" }),
    ]);

    expect(t).toMatchObject({
      gross: "100.00",
      internal: "120.00",
      agencyAdditional: "-20.00",
      moneyExcludedRows: 2,
    });
  });

  it("re-computes on a filtered subset (SUBTOTAL semantics)", () => {
    const all = [
      row({ id: "a", gross: "100", internalAmount: "0", checkNumber: "1", totalNetPay: "1000" }),
      row({ id: "b", gross: "200", internalAmount: "0", checkNumber: "2", totalNetPay: "2000" }),
    ];
    const filtered = all.filter((r) => r.checkNumber === "1");
    const t = computeGridTotals(filtered);
    expect(t.gross).toBe("100.00");
    expect(t.netPerCheck).toBe("1000.00");
    expect(t.transactions).toBe(1);
  });
});
