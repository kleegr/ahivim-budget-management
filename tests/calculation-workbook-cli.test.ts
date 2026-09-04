import { describe, expect, it } from "vitest";
import {
  calculationWorkbookConnectionString,
  parseCalculationWorkbookCliArgs,
} from "@/lib/import/calculation-workbook-cli";

describe("Calculations workbook CLI safety", () => {
  it("defaults to dry-run and requires an explicit disposable confirmation for apply", () => {
    expect(parseCalculationWorkbookCliArgs(["--file", "calculations.xlsx"])).toMatchObject({
      apply: false,
      confirmDisposable: false,
    });
    expect(() => parseCalculationWorkbookCliArgs([
      "--file",
      "calculations.xlsx",
      "--apply",
    ])).toThrow("--apply requires --confirm-disposable");
  });

  it("rejects apply in production and never falls back from TEST_DATABASE_URL", () => {
    const apply = { apply: true };
    expect(() => calculationWorkbookConnectionString(apply, {
      VERCEL_ENV: "production",
      TEST_DATABASE_URL: "postgres://disposable",
    })).toThrow("disabled in a production runtime");
    expect(() => calculationWorkbookConnectionString(apply, {
      DATABASE_URL: "postgres://production",
    })).toThrow("accepts only TEST_DATABASE_URL");
    expect(calculationWorkbookConnectionString(apply, {
      TEST_DATABASE_URL: " postgres://disposable ",
      DATABASE_URL: "postgres://production",
    })).toBe("postgres://disposable");
  });

  it("validates the audit actor and business date before opening a connection", () => {
    expect(() => parseCalculationWorkbookCliArgs([
      "--file",
      "calculations.xlsx",
      "--as-of",
      "2026-02-30",
    ])).toThrow("real calendar date");
    expect(() => parseCalculationWorkbookCliArgs([
      "--file",
      "calculations.xlsx",
      "--actor-id",
      "not-a-uuid",
    ])).toThrow("must be a UUID");
  });

  it("accepts an explicit report path without changing dry-run safety", () => {
    expect(parseCalculationWorkbookCliArgs([
      "--file",
      "calculations.xlsx",
      "--out",
      "work/report.json",
    ])).toMatchObject({
      file: "calculations.xlsx",
      out: "work/report.json",
      apply: false,
    });
  });
});
