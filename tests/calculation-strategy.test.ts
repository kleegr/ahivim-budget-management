import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeStrategy, derivePeriodFromRenewal } from "@/lib/business/calculation-strategy";
import { closeEnough } from "@/lib/money";

interface FixtureRow {
  label: string;
  cut1Pct: string;
  cut2Pct: string;
  clock: string;
  adjustment: string;
  hours: Record<string, string>;
  workbookYearly: string;
  workbookMonthly: string;
  impliedMonthDivisor: string;
  workbookGrossNet: string;
  workbookNet: string;
  afterAll: string;
}
interface Fixture {
  calculations: {
    rates: Record<string, string>;
    rows: FixtureRow[];
    multiStrategyIndividuals: Record<string, string[]>;
  };
}

const fixturePath = fileURLToPath(new URL("./fixtures/workbook-parity.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

function linesFor(row: FixtureRow, rates: Record<string, string>) {
  return Object.entries(row.hours).map(([program, hours]) => ({
    programLabel: program,
    hours,
    internalRate: rates[program] ?? "0",
  }));
}

describe("computeStrategy — workbook Calculation-tab parity", () => {
  const { rates, rows } = fixture.calculations;

  it("reproduces yearly and monthly gross for EVERY workbook row (pure structural parity)", () => {
    const failures: string[] = [];
    for (const row of rows) {
      const result = computeStrategy({
        lines: linesFor(row, rates),
        monthDivisor: row.impliedMonthDivisor,
        cut1Percent: row.cut1Pct,
        cut2Percent: row.cut2Pct,
      });
      if (!closeEnough(result.yearlyGross, row.workbookYearly, "0.01")) failures.push(`${row.label}: yearly ${result.yearlyGross} vs ${row.workbookYearly}`);
      if (!closeEnough(result.monthlyGross, row.workbookMonthly, "0.01")) failures.push(`${row.label}: monthly ${result.monthlyGross} vs ${row.workbookMonthly}`);
    }
    expect(failures).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(23); // every Calculation line represented
  });

  it("reproduces the full cut→net chain for standard rows and FLAGS the one documented irregular row", () => {
    // The workbook applies a standard sequential-cut chain to every row except
    // Faigy Weiss, whose stored gross-net/net do not follow it (a manual value).
    // The engine must reproduce the standard rows exactly and SURFACE the
    // difference on the anomaly rather than silently matching or hiding it.
    const mismatched: string[] = [];
    for (const row of rows) {
      const result = computeStrategy({
        lines: linesFor(row, rates),
        monthDivisor: row.impliedMonthDivisor,
        cut1Percent: row.cut1Pct,
        cut2Percent: row.cut2Pct,
        clockAdjustment: row.clock,
        otherAdjustment: row.adjustment,
      });
      const ok =
        closeEnough(result.grossNet, row.workbookGrossNet, "0.05") &&
        closeEnough(result.net, row.workbookNet, "0.05");
      if (!ok) mismatched.push(row.label);
    }
    // Only the known, documented anomaly diverges — everything else reconciles.
    expect(mismatched).toEqual(["Faigy Weiss"]);
  });

  it("matches a hand-checked row exactly (Joel Duestch)", () => {
    const joel = rows.find((r) => r.label === "Joel Duestch")!;
    const result = computeStrategy({
      lines: linesFor(joel, rates),
      monthDivisor: joel.impliedMonthDivisor,
      cut1Percent: joel.cut1Pct,
      cut2Percent: joel.cut2Pct,
      clockAdjustment: joel.clock,
      otherAdjustment: joel.adjustment,
      afterAll: joel.afterAll,
    });
    expect(Number(result.yearlyGross)).toBe(74645); // 780×21 + 860×38 + 1075×17 + 430×17
    expect(closeEnough(result.monthlyGross, "6220.416667", "0.01")).toBe(true);
    expect(closeEnough(result.grossNet, "3448.599", "0.01")).toBe(true);
    expect(closeEnough(result.net, "3148.599", "0.01")).toBe(true); // grossNet − 300 clock
    expect(result.steps).toHaveLength(8); // every formula step is shown
  });

  it("honours a documented non-12 month divisor (Faigy Weiss ÷7) instead of normalising it", () => {
    const faigy = rows.find((r) => r.label === "Faigy Weiss")!;
    expect(faigy.impliedMonthDivisor).toBe("7.000");
    const result = computeStrategy({
      lines: linesFor(faigy, rates),
      monthDivisor: faigy.impliedMonthDivisor,
      cut1Percent: faigy.cut1Pct,
      cut2Percent: faigy.cut2Pct,
    });
    expect(closeEnough(result.monthlyGross, faigy.workbookMonthly, "0.01")).toBe(true);
  });

  it("treats '1'/'2' rows as strategies of ONE canonical individual, not duplicates", () => {
    const multi = fixture.calculations.multiStrategyIndividuals;
    expect(multi["Fradel Ostreicher"]).toEqual(["Fradel Ostreicher 1", "Fradel Ostreicher 2"]);
    expect(multi["Mendel Stern"]).toEqual(["Mendel Stern 1", "Mendel Stern 2"]);
  });

  it("rejects cuts outside the 0% to 100% range", () => {
    const lines = [{ programLabel: "Com Hab", hours: "10", internalRate: "21" }];
    expect(() => computeStrategy({ lines, cut1Percent: "-1" })).toThrow(/between 0% and 100%/);
    expect(() => computeStrategy({ lines, cut2Percent: "101" })).toThrow(/between 0% and 100%/);
  });
});

describe("derivePeriodFromRenewal — renewal-date-only", () => {
  it("derives start = renewal − 12 months, end = renewal", () => {
    expect(derivePeriodFromRenewal("2023-01-01")).toEqual({ start: "2022-01-01", end: "2023-01-01" });
    expect(derivePeriodFromRenewal("2026-03-01")).toEqual({ start: "2025-03-01", end: "2026-03-01" });
  });
  it("returns nulls when there is no renewal date", () => {
    expect(derivePeriodFromRenewal(null)).toEqual({ start: null, end: null });
  });
});
