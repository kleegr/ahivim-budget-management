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
    checkNumber: p.checkNumber ?? null,
    individualId: p.individualId ?? null,
    individual: p.individual ?? null,
    employeeId: p.employeeId ?? null,
    employee: p.employee ?? null,
  };
}

describe("computeGridTotals — Excel-SUBTOTAL parity", () => {
  it("sums gross, internal, agency-additional and hours as plain column totals", () => {
    const t = computeGridTotals([
      row({ id: "a", gross: "336.75", internalAmount: "282.87", agencyAdditional: "53.88", hours: "13.47" }),
      row({ id: "b", gross: "252.25", internalAmount: "211.89", agencyAdditional: "40.36", hours: "10.09" }),
    ]);
    expect(t.gross).toBe("589.00");
    expect(t.internal).toBe("494.76");
    expect(t.agencyAdditional).toBe("94.24"); // 53.88 + 40.36
    expect(t.hours).toBe("23.56");
    expect(t.transactions).toBe(2);
  });

  it("counts Total Net Pay ONCE per check number (workbook column-S rule)", () => {
    // Two rows of the SAME check both carry the check's full net pay (10538.05).
    const t = computeGridTotals([
      row({ id: "a", checkNumber: "24665", totalNetPay: "10538.05", gross: "336.75" }),
      row({ id: "b", checkNumber: "24665", totalNetPay: "10538.05", gross: "252.25" }),
      row({ id: "c", checkNumber: "24666", totalNetPay: "5000.00", gross: "100.00" }),
    ]);
    // Net counted once per check: 10538.05 + 5000.00 — NOT 10538.05 twice.
    expect(t.netPerCheck).toBe("15538.05");
    expect(t.checks).toBe(2);
    expect(t.gross).toBe("689.00"); // gross is still summed per row
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

  it("re-computes on a filtered subset (SUBTOTAL semantics)", () => {
    const all = [
      row({ id: "a", gross: "100", checkNumber: "1", totalNetPay: "1000" }),
      row({ id: "b", gross: "200", checkNumber: "2", totalNetPay: "2000" }),
    ];
    const filtered = all.filter((r) => r.checkNumber === "1");
    const t = computeGridTotals(filtered);
    expect(t.gross).toBe("100.00");
    expect(t.netPerCheck).toBe("1000.00");
    expect(t.transactions).toBe(1);
  });
});
