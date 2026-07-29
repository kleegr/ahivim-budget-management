import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import {
  REPORTS,
  isReportKey,
  selectFilters,
  type ReportFieldType,
  type ReportCell,
  type ReportFilterSpec,
} from "@/lib/data/report-queries";
import {
  Card,
  Table,
  Th,
  Td,
  Tr,
  Money,
  Hours,
  Plain,
  EmptyState,
  ErrorPanel,
  PageHeader,
  ButtonLink,
} from "@/components/ui";
import { dec } from "@/lib/money";

export const dynamic = "force-dynamic";

function numericType(type: ReportFieldType): boolean {
  return type === "money" || type === "hours" || type === "percent" || type === "int";
}

function renderCell(type: ReportFieldType, value: ReportCell): ReactNode {
  if (value === null || value === undefined || value === "") {
    if (type === "money" || type === "hours") {
      return type === "money" ? <Money value={null} /> : <Hours value={null} />;
    }
    return <span className="text-[var(--color-ink-faint)]">—</span>;
  }
  switch (type) {
    case "money":
      return <Money value={String(value)} />;
    case "hours":
      return <Hours value={String(value)} />;
    case "percent":
      return <span className="tnum">{dec(value).toDecimalPlaces(1).toFixed(1)}%</span>;
    case "int":
      return <span className="tnum">{Number(value).toLocaleString()}</span>;
    default:
      return <Plain value={value} />;
  }
}

function FilterField({ spec, value }: { spec: ReportFilterSpec; value: string | undefined }) {
  const inputClass =
    "mt-1 rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm";
  const current = value ?? spec.defaultValue ?? "";
  return (
    <div>
      <label className="block text-sm font-medium" htmlFor={spec.key}>
        {spec.label}
      </label>
      {spec.type === "select" ? (
        <select id={spec.key} name={spec.key} defaultValue={current} className={inputClass}>
          {(spec.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={spec.key}
          name={spec.key}
          type={spec.type === "date" ? "date" : "number"}
          defaultValue={current}
          placeholder={spec.placeholder}
          className={inputClass}
        />
      )}
    </div>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  const def = isReportKey(report) ? REPORTS[report] : null;
  return { title: `${def ? def.title : "Report"} — Ahivim Budget Management` };
}

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ report: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("viewer");
  const { report } = await params;
  if (!isReportKey(report)) notFound();

  const def = REPORTS[report];
  const raw = await searchParams;
  const filters = selectFilters(report, raw);

  // Preserve the active filters on the export links.
  const exportQuery = new URLSearchParams();
  for (const spec of def.filters) {
    const v = filters[spec.key];
    if (v) exportQuery.set(spec.key, v);
  }
  const csvHref = `/api/reports/${report}/export?format=csv${exportQuery.toString() ? `&${exportQuery}` : ""}`;
  const xlsxHref = `/api/reports/${report}/export?format=xlsx${exportQuery.toString() ? `&${exportQuery}` : ""}`;

  const result = await withDb((pool) => def.run(pool, filters));

  return (
    <>
      <PageHeader
        eyebrow="Reports"
        title={def.title}
        description={def.description}
        action={
          <div className="flex gap-2">
            <ButtonLink href={csvHref}>Export CSV</ButtonLink>
            <ButtonLink href={xlsxHref}>Export Excel</ButtonLink>
          </div>
        }
      />

      <div className="mb-4">
        <Link className="text-sm underline underline-offset-2" href="/reports">
          ← All reports
        </Link>
      </div>

      {def.filters.length > 0 ? (
        <form className="mb-4 flex flex-wrap items-end gap-3" method="get" action={`/reports/${report}`}>
          {def.filters.map((spec) => (
            <FilterField key={spec.key} spec={spec} value={filters[spec.key]} />
          ))}
          <button
            type="submit"
            className="rounded bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white"
          >
            Apply
          </button>
          <Link className="text-sm underline underline-offset-2" href={`/reports/${report}`}>
            Clear
          </Link>
        </form>
      ) : null}

      {!result.ok ? (
        <ErrorPanel title="Could not run this report">{result.error}</ErrorPanel>
      ) : (
        <div className="space-y-4">
          {result.data.map((table) => (
            <Card key={table.key} title={table.title}>
              {table.rows.length === 0 ? (
                <EmptyState title="Nothing to report">
                  <p>{table.emptyMessage ?? "No rows match the current filters."}</p>
                </EmptyState>
              ) : (
                <Table
                  head={
                    <>
                      {table.columns.map((c) => (
                        <Th key={c.key} numeric={numericType(c.type)}>
                          {c.header}
                        </Th>
                      ))}
                    </>
                  }
                >
                  {table.rows.map((row, i) => (
                    <Tr key={i}>
                      {table.columns.map((c) => (
                        <Td key={c.key} numeric={numericType(c.type)}>
                          {renderCell(c.type, row[c.key] ?? null)}
                        </Td>
                      ))}
                    </Tr>
                  ))}
                </Table>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
