import type { GridTransaction } from "@/lib/data/transactions-grid";

const PAGE_SIZE = 25;
export const historyServiceDate = (row: GridTransaction): string | null =>
  row.serviceDate ?? row.periodBegin ?? row.checkDate ?? row.periodEnd ?? null;

export function selectPersonHistoryPage(rows: GridTransaction[], query: string, page: number) {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = rows.filter((row) => !needle || [row.employee, row.program, historyServiceDate(row), historyServiceDate(row) ? null : "Undated"]
    .some((value) => value?.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => (historyServiceDate(b) ?? "").localeCompare(historyServiceDate(a) ?? "") || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.max(1, Math.min(page, pages));
  return { total: filtered.length, pages, current, visible: filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE) };
}
