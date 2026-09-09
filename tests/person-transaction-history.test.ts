import { describe, expect, it } from "vitest";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import { historyServiceDate, selectPersonHistoryPage } from "@/lib/transactions/person-history";

const row = (id: string, values: Partial<GridTransaction> = {}) => ({ id, serviceDate: null, periodBegin: null, checkDate: null, periodEnd: null, employee: null, program: null, ...values }) as GridTransaction;

describe("complete person transaction history", () => {
  it("keeps every old period and fully undated record reachable across pages", () => {
    const rows = Array.from({ length: 60 }, (_, index) => row(String(index).padStart(3, "0"), { periodBegin: `2026-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String(index % 28 + 1).padStart(2, "0")}` }));
    rows.push(row("undated"));
    const pages = [1, 2, 3].map((page) => selectPersonHistoryPage(rows, "", page));
    expect(pages.map((page) => page.visible.length)).toEqual([25, 25, 11]);
    expect(new Set(pages.flatMap((page) => page.visible.map((entry) => entry.id))).size).toBe(61);
    expect(pages[2]!.visible.at(-1)!.id).toBe("undated");
    expect(selectPersonHistoryPage(rows, "Undated", 1).visible.map((entry) => entry.id)).toEqual(["undated"]);
  });

  it("uses canonical date fallbacks with stable equal-date ordering and searches all pages", () => {
    const rows = [row("c", { periodEnd: "2026-09-03" }), row("b", { checkDate: "2026-09-04", employee: "Older worker" }), row("a", { periodBegin: "2026-09-04" }), row("d", { serviceDate: "2026-09-05", periodBegin: "2020-01-01" })];
    expect(selectPersonHistoryPage(rows, "", 1).visible.map((entry) => entry.id)).toEqual(["d", "a", "b", "c"]);
    expect(selectPersonHistoryPage(rows, "older", 12)).toMatchObject({ current: 1, total: 1, pages: 1 });
    expect(selectPersonHistoryPage(rows, "2026-09-03", 1).visible[0]!.id).toBe("c");
    expect(selectPersonHistoryPage(rows, "does not exist", 1)).toMatchObject({ total: 0, current: 1, pages: 1, visible: [] });
    expect(historyServiceDate(row("unknown"))).toBeNull();
  });
});
