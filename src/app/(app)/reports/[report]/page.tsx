import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import {
  REPORTS,
  isReportKey,
  selectFilters,
  type ReportFilterSpec,
} from "@/lib/data/report-queries";
import { ErrorPanel, PageHeader, ButtonLink } from "@/components/ui";
import ReportGrid from "@/components/reports/report-grid";

export const dynamic = "force-dynamic";

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
          type={spec.type === "date" ? "date" : spec.type === "int" ? "number" : "text"}
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
  const user = await requireUser("viewer");
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
        <div className="space-y-6">
          {result.data.map((table) => (
            <ReportGrid
              key={table.key}
              table={table}
              reportKey={report}
              canManage={user.role !== "viewer"}
            />
          ))}
        </div>
      )}
    </>
  );
}
