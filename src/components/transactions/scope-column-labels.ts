import type { ColumnDef } from "@/components/data-grid/types";
import type { GridTransaction } from "@/lib/data/transactions-grid";

const RECORD_LABELS: Record<string, string> = {
  id: "Selected service",
  individualId: "Selected person",
  employeeId: "Selected employee",
  programId: "Selected program",
  checkIdentity: "Selected payroll check",
  sourcePaymentIdentity: "Selected source payment",
};

function recordLabel(key: string, row: GridTransaction): string {
  if (key === "individualId") return row.individual ?? "Person unavailable";
  if (key === "employeeId") return row.employee ?? "Employee unavailable";
  if (key === "programId") return row.program ?? "Program unavailable";
  if (key === "id") return `${row.program ?? "Service"} · ${row.serviceDate ?? "Date unavailable"}`;
  const party = key === "sourcePaymentIdentity" ? row.payTo : row.employee;
  return `${row.checkNumber ? `Check ${row.checkNumber}` : "Unnumbered check"} · ${row.checkDate ?? "Date unavailable"} · ${party ?? "Recipient unavailable"}`;
}

/** Label only records already permitted in this workspace. Never replace ID matching with names. */
export function withTransactionScopeLabels(columns: ColumnDef<GridTransaction>[], rows: GridTransaction[]): ColumnDef<GridTransaction>[] {
  return columns.map((column) => {
    const filterLabel = RECORD_LABELS[column.key];
    if (!filterLabel) return column;
    const labels = new Map(rows.map((row) => [column.accessor(row), recordLabel(column.key, row)]));
    return { ...column, filterLabel, filterValueLabel: (value: string) => labels.get(value) ?? "Record unavailable in this view" };
  });
}
