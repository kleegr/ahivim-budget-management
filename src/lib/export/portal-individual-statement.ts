import { dec, formatMoney, toMoney } from "@/lib/money";
import { safeSpreadsheetText } from "@/lib/export/tabular";
import type {
  PortalIndividualStatement,
  PortalIndividualTrendMonth,
} from "@/lib/data/portal-individual-statement";

export type PortalStatementScope = "month" | "trend";

interface StatementColumn {
  key: Exclude<keyof PortalIndividualTrendMonth, "month">;
  label: string;
}

function columns(statement: PortalIndividualStatement): StatementColumn[] {
  return [
    statement.visibility.billed ? { key: "billed" as const, label: "Billed" } : null,
    statement.visibility.setAside ? { key: "setAside" as const, label: "Set aside" } : null,
    statement.visibility.direct ? { key: "direct" as const, label: "Direct-paid" } : null,
    statement.visibility.agencyPaid ? { key: "agencyPaid" as const, label: "Agency-paid" } : null,
  ].filter((column): column is StatementColumn => column !== null);
}

function rows(statement: PortalIndividualStatement, scope: PortalStatementScope) {
  return scope === "month"
    ? statement.months.filter((row) => row.month === statement.throughMonth)
    : statement.months;
}

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-01T00:00:00Z`));
}

function csvCell(value: string): string {
  const safe = safeSpreadsheetText(value);
  return `"${safe.replaceAll('"', '""')}"`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function totals(statementRows: PortalIndividualTrendMonth[], statementColumns: StatementColumn[]) {
  return new Map(statementColumns.map((column) => [
    column.key,
    toMoney(statementRows.reduce((sum, row) => sum.plus(row[column.key] ?? 0), dec(0))),
  ]));
}

export function portalIndividualStatementCsv(
  statement: PortalIndividualStatement,
  scope: PortalStatementScope,
): string {
  const statementRows = rows(statement, scope);
  const statementColumns = columns(statement);
  const summed = totals(statementRows, statementColumns);
  const lines = [
    ["Individual", statement.individualName],
    [scope === "month" ? "Reporting month" : "Through month", monthLabel(statement.throughMonth)],
    [],
    ["Month", ...statementColumns.map((column) => column.label)],
    ...statementRows.map((row) => [
      monthLabel(row.month),
      ...statementColumns.map((column) => row[column.key] ?? ""),
    ]),
    ["Total", ...statementColumns.map((column) => summed.get(column.key) ?? "")],
  ];
  return `\uFEFF${lines.map((line) => line.map((cell) => csvCell(String(cell))).join(",")).join("\r\n")}\r\n`;
}

export function portalIndividualStatementHtml(
  statement: PortalIndividualStatement,
  scope: PortalStatementScope,
): string {
  const statementRows = rows(statement, scope);
  const statementColumns = columns(statement);
  const summed = totals(statementRows, statementColumns);
  const historyLabel = `${statementRows.length}-month history`;
  const title = `${statement.individualName} - ${scope === "month" ? monthLabel(statement.throughMonth) : historyLabel}`;
  const headingCells = statementColumns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("");
  const bodyRows = statementRows.map((row) => `<tr><td>${escapeHtml(monthLabel(row.month))}</td>${statementColumns
    .map((column) => `<td class="number">${escapeHtml(formatMoney(row[column.key]))}</td>`)
    .join("")}</tr>`).join("");
  const totalCells = statementColumns
    .map((column) => `<td class="number">${escapeHtml(formatMoney(summed.get(column.key)))}</td>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Arial, sans-serif; color: #14201f; }
    body { margin: 0; padding: 32px; background: #fff; }
    main { max-width: 900px; margin: 0 auto; }
    header { display: flex; align-items: start; justify-content: space-between; gap: 20px; border-bottom: 2px solid #0b6b60; padding-bottom: 16px; }
    h1 { margin: 0; font-size: 24px; }
    p { margin: 6px 0 0; color: #52605e; }
    button { border: 1px solid #9aabaa; background: white; border-radius: 5px; padding: 8px 12px; font-weight: 600; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; margin-top: 24px; font-size: 14px; }
    th, td { border-bottom: 1px solid #d8dfde; padding: 10px 8px; text-align: left; }
    th { background: #f2f6f5; font-size: 12px; }
    .number { text-align: right; font-variant-numeric: tabular-nums; }
    tfoot td { border-top: 2px solid #9aabaa; border-bottom: 0; font-weight: 700; }
    @media print { body { padding: 0; } button { display: none; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div><h1>${escapeHtml(statement.individualName)}</h1><p>${escapeHtml(scope === "month" ? monthLabel(statement.throughMonth) : `${historyLabel} through ${monthLabel(statement.throughMonth)}`)}</p></div>
      <button type="button" onclick="window.print()">Print</button>
    </header>
    <table>
      <thead><tr><th>Month</th>${headingCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
      <tfoot><tr><td>Total</td>${totalCells}</tr></tfoot>
    </table>
  </main>
</body>
</html>`;
}

export function portalStatementFilename(statement: PortalIndividualStatement, scope: PortalStatementScope, extension: "csv" | "html"): string {
  const person = statement.individualName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "individual";
  return `${person}-${statement.throughMonth}-${scope === "month" ? "statement" : "history"}.${extension}`;
}
