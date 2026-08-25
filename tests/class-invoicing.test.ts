import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLASS_UNIT_PRICE,
  generateClassDatesBetween,
  generateMonthlyClassDates,
  isSaturday,
  prepareClassInvoiceLines,
} from "@/lib/business/class-invoicing";
import { dec } from "@/lib/money";

const EXERCISE_ID = "00000000-0000-4000-8000-000000000001";

describe("class invoice rules", () => {
  it("builds a 22-day July starting point with no Saturdays", () => {
    const dates = generateMonthlyClassDates("2026-07");

    expect(dates).toHaveLength(22);
    expect(dates[0]).toBe("2026-07-01");
    expect(dates.at(-1)).toBe("2026-07-26");
    expect(dates.every((date) => !isSaturday(date))).toBe(true);
    expect(dates).toContain("2026-07-05"); // Sunday remains valid.
    expect(dates).toContain("2026-07-22"); // Staff may edit the generated slate.
  });

  it("still fills 22 dates when an allowance starts after the first of a long month", () => {
    const dates = generateClassDatesBetween("2026-07-02", "2026-07-31");

    expect(dates).toHaveLength(22);
    expect(dates[0]).toBe("2026-07-02");
    expect(dates.at(-1)).toBe("2026-07-27");
    expect(dates.every((date) => !isSaturday(date))).toBe(true);
  });

  it("prices 22 one-lesson lines at the configurable $150 default to $3,300", () => {
    const activities = new Map([[EXERCISE_ID, {
      id: EXERCISE_ID,
      name: "Exercise Class",
      defaultUnitPrice: DEFAULT_CLASS_UNIT_PRICE,
    }]]);
    const result = prepareClassInvoiceLines(
      generateMonthlyClassDates("2026-07").map((serviceDate) => ({
        activityId: EXERCISE_ID,
        serviceDate,
      })),
      activities,
      "2026-07-01",
      "2026-07-31",
    );

    expect(result).toMatchObject({
      ok: true,
      subtotal: "3300.0000",
      discountTotal: "0.0000",
      totalAmount: "3300.0000",
    });
  });

  it("rejects Saturdays even when entered manually", () => {
    const result = prepareClassInvoiceLines([{
      serviceDate: "2026-07-04",
      description: "Art Class",
      unitPrice: "150",
    }], new Map(), "2026-07-01", "2026-07-31");

    expect(result).toEqual({
      ok: false,
      message: "Line 1 is on a Saturday. Choose another date.",
    });
  });

  it("keeps discounts and custom activity prices exact", () => {
    const result = prepareClassInvoiceLines([{
      serviceDate: "2026-07-05",
      description: "Custom Class",
      quantity: "2",
      unitPrice: "99.995",
      discountAmount: "9.99",
    }], new Map(), "2026-07-01", "2026-07-31");

    expect(result).toMatchObject({
      ok: true,
      subtotal: "199.9900",
      discountTotal: "9.9900",
      totalAmount: "190.0000",
    });
  });

  it("reconciles totals after normalizing fractional quantities and rates", () => {
    const result = prepareClassInvoiceLines([
      { serviceDate: "2026-07-01", description: "Art", quantity: "0.33335", unitPrice: "17.12345", discountAmount: "0.00005" },
      { serviceDate: "2026-07-02", description: "Music", quantity: "0.66665", unitPrice: "21.98765", discountAmount: "0.12345" },
    ], new Map(), "2026-07-01", "2026-07-31");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lineTotal = result.lines.reduce((sum, line) => sum.plus(line.lineTotal), dec(0));
    const discounts = result.lines.reduce((sum, line) => sum.plus(line.discountAmount), dec(0));
    expect(lineTotal.toFixed(4)).toBe(result.totalAmount);
    expect(lineTotal.plus(discounts).toFixed(4)).toBe(result.subtotal);
  });
});
