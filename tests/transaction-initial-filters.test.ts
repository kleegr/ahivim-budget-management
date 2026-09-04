import { describe, expect, it } from "vitest";
import { applyFilters } from "@/components/data-grid/engine";
import type { ColumnDef } from "@/components/data-grid/types";
import { completeCheckIdentity, computeGridTotals } from "@/lib/business/transaction-totals";
import {
  buildInitialFilters,
  filterTransactionsByCheckIdentity,
  hasInitialTransactionDateContext,
} from "@/lib/transactions/initial-filters";
import type { GridTransaction } from "@/lib/data/transactions-grid";

describe("transaction URL filters", () => {
  it("filters an actuals report by the same canonical service date used in its totals", () => {
    const rows = [
      {
        id: "period-row",
        serviceDate: "2026-08-01",
        periodBegin: "2026-08-01",
        checkDate: "2026-08-15",
      },
      {
        id: "check-date-fallback",
        serviceDate: "2026-08-20",
        periodBegin: null,
        checkDate: "2026-08-20",
      },
    ] as GridTransaction[];

    const seeded = buildInitialFilters(rows, {
      serviceFrom: "2026-08-01",
      serviceTo: "2026-08-31",
    });
    expect(seeded).toEqual({
      filters: { serviceDate: { from: "2026-08-01", to: "2026-08-31" } },
      label: "service dates 2026-08-01 to 2026-08-31",
    });
    expect(hasInitialTransactionDateContext(seeded.filters)).toBe(true);
  });

  it("opens an owner cohort as one multi-person transaction filter", () => {
    const firstId = "10000000-0000-4000-8000-000000000001";
    const secondId = "10000000-0000-4000-8000-000000000002";
    const rows = [
      { individualId: firstId, individual: "Alex One" },
      { individualId: secondId, individual: "Blair Two" },
      { individualId: secondId, individual: "Blair Two" },
    ] as GridTransaction[];

    expect(buildInitialFilters(rows, { individualId: [firstId, secondId] })).toEqual({
      filters: { individual: { selected: ["Alex One", "Blair Two"] } },
      label: "2 people",
    });
  });

  it("keeps an owner check-date deep link constrained and totals only those rows", () => {
    const rows = [
      {
        id: "latest-a",
        checkDate: "2026-08-21",
        checkNumber: "900",
        gross: "100.00",
        internalAmount: "80.00",
        agencyAdditional: "20.00",
        hours: "4.00",
      },
      {
        id: "latest-b",
        checkDate: "2026-08-21",
        checkNumber: "901",
        gross: "250.00",
        internalAmount: "200.00",
        agencyAdditional: "50.00",
        hours: "10.00",
      },
      {
        id: "older",
        checkDate: "2026-08-07",
        checkNumber: "850",
        gross: "1000.00",
        internalAmount: "700.00",
        agencyAdditional: "300.00",
        hours: "40.00",
      },
    ] as GridTransaction[];
    const seeded = buildInitialFilters(rows, {
      view: "rows",
      checkDateFrom: "2026-08-21",
      checkDateTo: "2026-08-21",
    });
    const columns: ColumnDef<GridTransaction>[] = [{
      key: "checkDate",
      label: "Check date",
      kind: "date",
      accessor: (row) => row.checkDate,
    }];

    expect(hasInitialTransactionDateContext(seeded.filters)).toBe(true);
    const filtered = applyFilters(rows, columns, seeded.filters, "", []);
    expect(filtered.map((row) => row.id)).toEqual(["latest-a", "latest-b"]);
    expect(computeGridTotals(filtered)).toMatchObject({
      transactions: 2,
      gross: "350.00",
      internal: "280.00",
      agencyAdditional: "70.00",
      hours: "14.00",
    });
  });

  it("labels one-sided check-date links so the fixed context can be cleared", () => {
    expect(buildInitialFilters([], { checkDateFrom: "2026-08-21" })).toEqual({
      filters: { checkDate: { from: "2026-08-21", to: "" } },
      label: "check dates from 2026-08-21",
    });
    expect(buildInitialFilters([], { checkDateTo: "2026-08-21" })).toEqual({
      filters: { checkDate: { from: "", to: "2026-08-21" } },
      label: "check dates through 2026-08-21",
    });
  });

  it("labels one-sided service-date and service-period links", () => {
    expect(buildInitialFilters([], { serviceFrom: "2026-08-01" })).toEqual({
      filters: { serviceDate: { from: "2026-08-01", to: "" } },
      label: "service dates from 2026-08-01",
    });
    expect(buildInitialFilters([], { pbTo: "2026-08-31" })).toEqual({
      filters: { periodBegin: { from: "", to: "2026-08-31" } },
      label: "service periods through 2026-08-31",
    });
  });

  it("uses both exact period bounds for a check drill-through without changing range links", () => {
    const rows = [
      { id: "wanted", periodBegin: "2026-08-01", periodEnd: "2026-08-15" },
      { id: "other-end", periodBegin: "2026-08-01", periodEnd: "2026-08-16" },
      { id: "other-begin", periodBegin: "2026-08-02", periodEnd: "2026-08-15" },
    ] as GridTransaction[];
    const columns: ColumnDef<GridTransaction>[] = [
      { key: "periodBegin", label: "Period begin", kind: "date", accessor: (row) => row.periodBegin },
      { key: "periodEnd", label: "Period end", kind: "date", accessor: (row) => row.periodEnd },
    ];
    const exact = buildInitialFilters(rows, {
      periodBeginExact: "2026-08-01",
      periodEndExact: "2026-08-15",
    });

    expect(exact.filters).toEqual({
      periodBegin: { selected: ["2026-08-01"] },
      periodEnd: { selected: ["2026-08-15"] },
    });
    expect(hasInitialTransactionDateContext(exact.filters)).toBe(true);
    expect(applyFilters(rows, columns, exact.filters, "", []).map((row) => row.id)).toEqual(["wanted"]);
    expect(buildInitialFilters(rows, { pbFrom: "2026-08-01", pbTo: "2026-08-31" }).filters).toEqual({
      periodBegin: { from: "2026-08-01", to: "2026-08-31" },
    });
  });

  it("can constrain missing identity components instead of dropping their filters", () => {
    expect(buildInitialFilters([], {
      employeeExact: "",
      checkNumberExact: "",
      checkDateExact: "",
      periodBeginExact: "",
      periodEndExact: "",
    }).filters).toEqual({
      employee: { selected: [""] },
      checkNumber: { selected: [""] },
      checkDate: { selected: [""] },
      periodBegin: { selected: [""] },
      periodEnd: { selected: [""] },
    });
  });

  it("keeps the exact Check-mode identity despite raw check-number whitespace and payee differences", () => {
    const base = {
      employeeId: "10000000-0000-4000-8000-000000000001",
      employee: "Alex Worker",
      checkNumber: " CHK-100 ",
      checkDate: "2026-08-21",
      periodBegin: "2026-08-01",
      periodEnd: "2026-08-15",
    };
    const rows = [
      { ...base, id: "first", payTo: "Alex Worker" },
      { ...base, id: "same-check", employee: " Alex  Worker ", checkNumber: "CHK-100", payTo: "Excellent Staffing" },
      { ...base, id: "other-period", periodEnd: "2026-08-16" },
    ] as GridTransaction[];
    const identity = completeCheckIdentity(rows[0]!)!;
    const exactRows = filterTransactionsByCheckIdentity(rows, identity);

    expect(exactRows.map((row) => row.id)).toEqual(["first", "same-check"]);
    expect(buildInitialFilters(exactRows, {
      employeeId: base.employeeId,
      checkNumber: "CHK-100",
    }).filters).toEqual({
      employee: { selected: ["Alex Worker", " Alex  Worker "] },
      checkNumber: { selected: [" CHK-100 ", "CHK-100"] },
    });
  });
});
