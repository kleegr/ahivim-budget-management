import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CalendarDays,
  Clock3,
  Download,
  FileSpreadsheet,
  Filter,
  Info,
  ReceiptText,
  RotateCcw,
} from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import {
  REPORTS,
  isReportKey,
  selectFilters,
  type ReportFilterSpec,
  type ReportTable,
} from "@/lib/data/report-queries";
import type { PgLikePool } from "@/lib/import/commit";
import { ErrorPanel, PageHeader, ButtonLink, Button } from "@/components/ui";
import ReportGrid from "@/components/reports/report-grid";
import { REPORT_LIBRARY, REPORT_PRESENTATION } from "@/components/reports/report-library";
import { ReportInlineChart } from "@/components/charts";

export const dynamic = "force-dynamic";

function readableDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function FilterField({ spec, value }: { spec: ReportFilterSpec; value: string | undefined }) {
  const current = value ?? spec.defaultValue ?? "";
  const inputClass = "input mt-1 w-full min-w-44";
  return (
    <div className="min-w-44 flex-1 sm:flex-initial">
      <label className="block text-xs font-semibold text-[var(--color-ink-soft)]" htmlFor={spec.key}>
        {spec.label}
      </label>
      {spec.type === "select" ? (
        <select id={spec.key} name={spec.key} defaultValue={current} className={inputClass}>
          {(spec.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={spec.key}
          name={spec.key}
          type={spec.type === "date" ? "date" : spec.type === "int" ? "number" : "text"}
          min={spec.type === "int" ? 1 : undefined}
          defaultValue={current}
          placeholder={spec.placeholder}
          className={inputClass}
        />
      )}
    </div>
  );
}

function describeScope(
  specs: ReportFilterSpec[],
  filters: Record<string, string | undefined>,
): string {
  if (specs.length === 0) return "Full report";

  const parts: string[] = [];
  const fromSpec = specs.find((spec) => spec.key === "from");
  const toSpec = specs.find((spec) => spec.key === "to");
  if (fromSpec || toSpec) {
    const from = filters.from;
    const to = filters.to;
    if (from && to) parts.push(`${readableDate(from)} to ${readableDate(to)}`);
    else if (from) parts.push(`From ${readableDate(from)}`);
    else if (to) parts.push(`Through ${readableDate(to)}`);
    else parts.push("All recorded dates");
  }

  for (const spec of specs) {
    if (spec.key === "from" || spec.key === "to") continue;
    const value = filters[spec.key] ?? spec.defaultValue ?? "";
    if (spec.type === "select") {
      const option = spec.options?.find((candidate) => candidate.value === value);
      parts.push(`${spec.label}: ${option?.label ?? (value || "All")}`);
    } else if (value) {
      parts.push(`${spec.label}: ${value}`);
    } else {
      parts.push(`${spec.label}: All`);
    }
  }
  return parts.join(" | ");
}

function ContextItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 gap-3 px-4 py-3 sm:px-5">
      <Icon size={16} className="mt-0.5 shrink-0 text-[var(--color-primary)]" aria-hidden />
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase text-[var(--color-ink-faint)]">{label}</p>
        <p className="mt-0.5 text-sm leading-5 text-[var(--color-ink)]">{value}</p>
      </div>
    </div>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  const def = isReportKey(report) ? REPORTS[report] : null;
  const title = (isReportKey(report) ? REPORT_PRESENTATION[report]?.title : null) ?? def?.title ?? "Report";
  return { title: `${title} - Ahivim Budget Management` };
}

/** Attach canonical entity ids so name cells can link to the matching record. */
async function attachEntityIds(pool: PgLikePool, tables: ReportTable[]): Promise<void> {
  const needsInd = tables.some((table) => table.columns.some((column) => /individual/i.test(column.key)));
  const needsEmp = tables.some((table) => table.columns.some((column) => /employee/i.test(column.key)));
  if (!needsInd && !needsEmp) return;

  const indMap = new Map<string, string>();
  const empMap = new Map<string, string>();
  if (needsInd) {
    const { rows } = await pool.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM individuals WHERE status <> 'archived' AND display_name IS NOT NULL`,
    );
    for (const row of rows) indMap.set(row.display_name, row.id);
  }
  if (needsEmp) {
    const { rows } = await pool.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM employees WHERE display_name IS NOT NULL`,
    );
    for (const row of rows) empMap.set(row.display_name, row.id);
  }

  for (const table of tables) {
    const indCols = table.columns.filter((column) => /individual/i.test(column.key));
    const empCols = table.columns.filter((column) => /employee/i.test(column.key));
    if (indCols.length === 0 && empCols.length === 0) continue;
    for (const row of table.rows) {
      if (row.individualId == null) {
        for (const column of indCols) {
          const value = row[column.key];
          if (typeof value === "string" && indMap.has(value)) {
            row.individualId = indMap.get(value)!;
            break;
          }
        }
      }
      if (row.employeeId == null) {
        for (const column of empCols) {
          const value = row[column.key];
          if (typeof value === "string" && empMap.has(value)) {
            row.employeeId = empMap.get(value)!;
            break;
          }
        }
      }
    }
  }
}

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ report: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("manager");
  const { report } = await params;
  if (!isReportKey(report)) notFound();

  const def = REPORTS[report];
  const presentation = REPORT_PRESENTATION[report];
  const group = REPORT_LIBRARY.find((item) => item.reports.some((candidate) => candidate.key === report));
  const raw = await searchParams;
  const filters = selectFilters(report, raw);
  const asOf = new Date().toISOString().slice(0, 10);

  const exportQuery = new URLSearchParams();
  for (const spec of def.filters) {
    const value = filters[spec.key];
    if (value) exportQuery.set(spec.key, value);
  }
  const querySuffix = exportQuery.toString() ? `&${exportQuery}` : "";
  const csvHref = `/api/reports/${report}/export?format=csv${querySuffix}`;
  const xlsxHref = `/api/reports/${report}/export?format=xlsx${querySuffix}`;

  const result = await withDb(async (pool) => {
    const tables = await def.run(pool, filters);
    await attachEntityIds(pool, tables);
    return tables.map((table) => ({
      ...table,
      columns: table.columns.map((column) => ({
        ...column,
        header: presentation?.columnLabels?.[column.key] ?? column.header,
      })),
    }));
  });

  const resultCount = result.ok
    ? {
        rows: result.data.reduce((sum, table) => sum + table.rows.length, 0),
        sections: result.data.length,
      }
    : null;
  const resultLabel = resultCount == null
    ? "Unavailable"
    : `${resultCount.rows.toLocaleString()} ${resultCount.rows === 1 ? "row" : "rows"}${resultCount.sections > 1 ? ` in ${resultCount.sections} sections` : ""}`;

  return (
    <>
      <Link
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-ink-soft)] hover:text-[var(--color-primary)]"
        href="/reports"
      >
        <ArrowLeft size={15} aria-hidden /> All reports
      </Link>

      <PageHeader
        eyebrow={group ? `Reports / ${group.heading}` : "Reports"}
        title={presentation?.title ?? def.title}
        description={presentation?.question ?? def.description}
        action={
          <>
            <ButtonLink href={csvHref}><Download size={15} aria-hidden /> CSV</ButtonLink>
            <ButtonLink href={xlsxHref} variant="primary"><FileSpreadsheet size={15} aria-hidden /> Excel</ButtonLink>
          </>
        }
      />

      {def.filters.length > 0 ? (
        <section aria-labelledby="report-scope-heading" className="mb-5 border-y border-[var(--color-rule-strong)] py-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 id="report-scope-heading" className="display text-base font-semibold text-[var(--color-ink)]">Report scope</h2>
              <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">The table, chart, and both exports use these same filters.</p>
            </div>
          </div>
          <form className="flex flex-wrap items-end gap-3" method="get" action={`/reports/${report}`}>
            {def.filters.map((spec) => (
              <FilterField key={spec.key} spec={spec} value={filters[spec.key]} />
            ))}
            <Button type="submit" variant="primary" size="sm">
              <Filter size={15} aria-hidden /> Apply
            </Button>
            <ButtonLink href={`/reports/${report}`} variant="ghost">
              <RotateCcw size={15} aria-hidden /> Reset
            </ButtonLink>
          </form>
        </section>
      ) : null}

      <section aria-label="Report context" className="mb-5 grid divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] lg:grid-cols-4 lg:divide-x lg:divide-y-0">
        <ContextItem icon={Clock3} label="Time basis" value={presentation?.timeBasis ?? "Current report scope"} />
        <ContextItem icon={Filter} label="Active scope" value={describeScope(def.filters, filters)} />
        <ContextItem icon={ReceiptText} label="Results" value={resultLabel} />
        <ContextItem icon={CalendarDays} label="Generated" value={`As of ${readableDate(asOf)}`} />
      </section>

      <div className="mb-6 flex items-start gap-2 border-l-2 border-[var(--color-primary)] pl-3 text-xs leading-5 text-[var(--color-ink-soft)]">
        <Info size={15} className="mt-0.5 shrink-0 text-[var(--color-primary)]" aria-hidden />
        <div>
          <p>{presentation?.description ?? def.description}</p>
          {presentation?.note ? <p className="mt-1 font-medium text-[var(--color-ink)]">{presentation.note}</p> : null}
        </div>
      </div>

      {!result.ok ? (
        <ErrorPanel title="Could not run this report">{result.error}</ErrorPanel>
      ) : (
        <div className="space-y-7">
          {result.data.map((table) => (
            <section key={table.key} className="space-y-4" aria-label={table.title ?? presentation?.title ?? def.title}>
              <ReportInlineChart table={table} />
              <ReportGrid table={table} reportKey={report} canManage={user.role !== "viewer"} />
            </section>
          ))}
        </div>
      )}
    </>
  );
}
