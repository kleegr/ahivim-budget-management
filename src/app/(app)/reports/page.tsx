import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listIndividuals } from "@/lib/data/queries";
import { getReconciliation, listPrograms, getPortfolioForecast } from "@/lib/data/app-queries";
import { REPORTS } from "@/lib/data/report-queries";
import {
  Card, Table, Th, Td, Tr, Money, EmptyState, ErrorPanel, PageHeader, Badge, Plain,
} from "@/components/ui";
import { formatHours, formatPercent } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports — Ahivim Budget Management" };

// The hub groups the reports by the decision they support, not alphabetically.
const REPORT_GROUPS: { heading: string; description: string; keys: string[] }[] = [
  {
    heading: "Budgets & utilization",
    description: "Where authorized hours stand, what is about to lapse, and who is off pace.",
    keys: ["budget-utilization", "expiring-authorizations", "utilization-outliers"],
  },
  {
    heading: "Money & payments",
    description: "Agency, internal and employee money — every figure kept in its own column.",
    keys: ["agency-earnings", "employee-payable", "program-totals", "cuts-monthly"],
  },
  {
    heading: "Data quality / attention",
    description: "Configuration gaps and decisions that quietly distort the figures downstream.",
    keys: ["missing-config", "alias-decisions", "audit-history"],
  },
  {
    heading: "Reconciliation",
    description: "Planned against actual: what was billed but not scheduled, and the reverse.",
    keys: ["unbilled-schedules", "unscheduled-billing", "actual-vs-scheduled", "group-activity"],
  },
];

export default async function ReportsPage() {
  await requireUser("viewer");

  const result = await withDb(async (pool) => ({
    individuals: await listIndividuals(pool),
    reconciliation: await getReconciliation(pool, 25),
    programs: await listPrograms(pool),
    forecast: await getPortfolioForecast(pool),
  }));

  return (
    <>
      <PageHeader
        eyebrow="Analysis"
        title="Reports"
        description="Pick a report to filter it on screen and export the exact figures to CSV or Excel. Every money column stays separate — agency total, employee amount, agency difference and employee payment are never merged."
      />

      <div className="space-y-8">
        {REPORT_GROUPS.map((group) => (
          <section key={group.heading}>
            <div className="mb-3">
              <h2 className="display text-lg font-medium">{group.heading}</h2>
              <p className="mt-0.5 max-w-prose text-sm text-[var(--color-ink-soft)]">{group.description}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.keys.map((key) => {
                const def = REPORTS[key];
                if (!def) return null;
                return (
                  <div
                    key={key}
                    className="flex flex-col justify-between rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] p-4"
                  >
                    <div>
                      <Link href={`/reports/${key}`} className="display text-base font-medium hover:underline">
                        {def.title}
                      </Link>
                      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{def.description}</p>
                    </div>
                    <div className="mt-3 flex items-center gap-3 text-sm">
                      <Link href={`/reports/${key}`} className="font-medium text-[var(--color-primary)] hover:underline">
                        Open report
                      </Link>
                      <span className="text-[var(--color-ink-faint)]">·</span>
                      <Link href={`/api/reports/${key}/export?format=csv`} className="underline underline-offset-2">
                        CSV
                      </Link>
                      <Link href={`/api/reports/${key}/export?format=xlsx`} className="underline underline-offset-2">
                        Excel
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-10 mb-4">
        <h2 className="display text-lg font-medium">Quick reference</h2>
        <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-soft)]">
          A few portfolio-wide figures inline, so you don&rsquo;t have to open a report for the
          everyday questions. Each full report — with its own chart and filters — is one card above.
        </p>
      </div>

      {!result.ok ? (
        <ErrorPanel title="Could not load analysis">{result.error}</ErrorPanel>
      ) : (
        <div className="space-y-4">
          <Card title="Portfolio forecast" description="Projected exhaustion across every authorization">
            <div className="px-5 py-4 text-sm">
              {!result.data.forecast.available ? (
                <>
                  <p className="font-medium">Not available</p>
                  <p className="mt-1 text-[var(--color-ink-soft)]">{result.data.forecast.reason}</p>
                </>
              ) : result.data.forecast.result.available === false ? (
                <>
                  <p className="font-medium">Not available</p>
                  <p className="mt-1 text-[var(--color-ink-soft)]">{result.data.forecast.result.message}</p>
                </>
              ) : (
                <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  <div className="flex justify-between"><dt className="text-[var(--color-ink-faint)]">Estimated exhaustion</dt><dd className="tnum font-medium"><Plain value={result.data.forecast.result.estimatedExhaustionDate} /></dd></div>
                  <div className="flex justify-between"><dt className="text-[var(--color-ink-faint)]">Time elapsed</dt><dd className="tnum">{formatPercent(result.data.forecast.result.timeElapsedPercent)}</dd></div>
                  <div className="flex justify-between"><dt className="text-[var(--color-ink-faint)]">Hours used</dt><dd className="tnum">{formatPercent(result.data.forecast.result.usagePercent)}</dd></div>
                  <div className="flex justify-between"><dt className="text-[var(--color-ink-faint)]">Average weekly usage</dt><dd className="tnum">{formatHours(result.data.forecast.result.averageWeeklyUsage)} h</dd></div>
                </dl>
              )}
            </div>
          </Card>

          <Card title="Individual utilization" description="Open an individual for authorization, pace and forecast">
            {result.data.individuals.length === 0 ? (
              <EmptyState title="No individuals to report on">
                <p>Commit an import and every person it names becomes reportable here.</p>
              </EmptyState>
            ) : (
              <Table head={<><Th>Individual</Th><Th numeric>Transactions</Th><Th numeric>Agency total</Th><Th>Report</Th></>}>
                {result.data.individuals.map((row) => (
                  <Tr key={row.id}>
                    <Td>{row.displayName}</Td>
                    <Td numeric className="tnum">{row.transactionCount.toLocaleString()}</Td>
                    <Td numeric><Money value={row.agencyGross} /></Td>
                    <Td>
                      <Link className="underline underline-offset-2" href={`/individuals/${row.id}`}>
                        Open
                      </Link>
                    </Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>

          <Card title="Reconciliation history" description="Each committed batch against the control totals in its own workbook">
            {result.data.reconciliation.length === 0 ? (
              <EmptyState title="Nothing has been committed yet" />
            ) : (
              <Table head={<><Th>Batch</Th><Th numeric>Workbook agency</Th><Th numeric>Imported agency</Th><Th numeric>Difference</Th><Th>State</Th></>}>
                {result.data.reconciliation.map((row) => (
                  <Tr key={row.batchId}>
                    <Td>{row.filename}<p className="text-xs text-[var(--color-ink-faint)]">{row.committedAt ? new Date(row.committedAt).toLocaleString() : "Not committed"}</p></Td>
                    <Td numeric><Money value={row.sourceAgencyGross} /></Td>
                    <Td numeric><Money value={row.importedAgencyGross} /></Td>
                    <Td numeric><Money value={row.agencyDifference} /></Td>
                    <Td>
                      {row.balanced === null
                        ? <span className="text-xs text-[var(--color-ink-faint)]">No control totals</span>
                        : <Badge value={row.balanced ? "valid" : "invalid"} label={row.balanced ? "Balanced" : "Differs"} />}
                    </Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>

          <Card title="Rate schedule" description="Effective-dated rates. The latest effective_from on or before today wins.">
            {result.data.programs.length === 0 ? (
              <EmptyState title="No programs are configured" />
            ) : (
              <Table head={<><Th>Code</Th><Th>Program</Th><Th numeric>Agency rate</Th><Th numeric>Internal rate</Th><Th>Effective</Th><Th numeric>Aliases</Th><Th>Group</Th></>}>
                {result.data.programs.map((p) => (
                  <Tr key={p.id}>
                    <Td><code className="text-xs">{p.code}</code></Td>
                    <Td>{p.name}</Td>
                    <Td numeric><Money value={p.agencyRate} /></Td>
                    <Td numeric><Money value={p.internalRate} /></Td>
                    <Td><Plain value={p.effectiveFrom} /></Td>
                    <Td numeric className="tnum">{p.aliasCount}</Td>
                    <Td>{p.isGroupCapable ? <Badge value="valid" label="group capable" /> : <span className="text-[var(--color-ink-faint)]">—</span>}</Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
