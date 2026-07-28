import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getIndividualReport } from "@/lib/data/queries";
import { isUuid } from "@/lib/data/app-queries";
import {
  Card, Table, Th, Td, Tr, Money, Hours, EmptyState, ErrorPanel, PageHeader, StatTile, PaceBar, ButtonLink, Badge,
} from "@/components/ui";
import { STATUS_LABELS } from "@/lib/business/utilization";
import { formatPercent, formatHours } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Individual — Ahivim Budget Management" };

const STATUS_COLOR: Record<string, string> = {
  not_started: "var(--color-pace-idle)",
  behind_pace: "var(--color-pace-behind)",
  on_pace: "var(--color-pace-on)",
  ahead_of_pace: "var(--color-pace-ahead)",
  near_exhaustion: "var(--color-pace-near)",
  fully_used: "var(--color-pace-near)",
  over_authorization: "var(--color-pace-over)",
};

export default async function IndividualDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser("viewer");
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const result = await withDb((pool) => getIndividualReport(pool, id));
  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="Individual" title="Individual" />
        <ErrorPanel title="Could not load this individual">{result.error}</ErrorPanel>
      </>
    );
  }
  if (!result.data) notFound();
  const r = result.data;

  return (
    <>
      <PageHeader
        eyebrow="Individual"
        title={r.individual.displayName}
        description={
          r.budgetPeriod
            ? `${r.budgetPeriod.label}: ${r.budgetPeriod.startDate} to ${r.budgetPeriod.endDate}`
            : "No budget period has been recorded for this individual, so pace and forecast cannot be computed."
        }
        action={<ButtonLink href="/individuals">All individuals</ButtonLink>}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Agency gross" value={`$${Number(r.totals.agencyGross).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
        <StatTile label="Internal amount" value={`$${Number(r.totals.internalAmount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
        <StatTile label="Hours used" value={`${formatHours(r.totals.usedHours)} h`} hint="From service allocations" />
        <StatTile
          label="Group sessions"
          value={r.groupSessions.toLocaleString()}
          hint={`${r.rateExceptions} rate exceptions · ${r.importWarnings} warnings`}
          tone={r.rateExceptions ? "warn" : "neutral"}
        />
      </div>

      {r.unresolvedRowCount > 0 ? (
        <div className="mt-4">
          <ErrorPanel title={`${r.unresolvedRowCount} imported rows are still awaiting a mapping decision`}>
            <p>
              Those rows are excluded from every figure on this page, so the totals above may
              understate this individual&rsquo;s activity until they are resolved.
            </p>
          </ErrorPanel>
        </div>
      ) : null}

      <div className="mt-6">
        <Card title="Authorization and pace" description="Fill is hours used; the notch is where the calendar has reached">
          {r.programs.length === 0 ? (
            <EmptyState title="No authorized programs">
              <p>
                No budget authorization rows exist for this individual, so utilization and remaining
                authorization cannot be calculated. They are not shown as zero because zero would be
                a different, and wrong, statement.
              </p>
            </EmptyState>
          ) : (
            <div className="divide-y divide-[var(--color-rule)]">
              {r.programs.map((program) => {
                const u = program.utilization;
                return (
                  <div key={program.programCode} className="px-5 py-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">{program.programName}</p>
                        <p className="tnum text-xs text-[var(--color-ink-faint)]">
                          {formatHours(u.usedHours)} of {formatHours(u.authorizedHours)} h ·{" "}
                          {formatHours(u.remainingHours)} h remaining · internal rate{" "}
                          {Number(u.internalRate).toFixed(2)}
                        </p>
                      </div>
                      <span className="text-sm" style={{ color: STATUS_COLOR[u.status] }}>
                        {STATUS_LABELS[u.status]} · {formatPercent(u.usagePercent)}
                      </span>
                    </div>
                    <div className="mt-2">
                      <PaceBar
                        usagePercent={u.usagePercent}
                        timeElapsedPercent={r.elapsed?.timeElapsedPercent ?? "0"}
                        color={STATUS_COLOR[u.status]}
                      />
                    </div>
                    <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
                      {program.forecast === null
                        ? "No forecast: this program has no budget period to project across."
                        : program.forecast.available
                          ? `Projected exhaustion ${program.forecast.estimatedExhaustionDate ?? "beyond the period end"} at ${formatHours(program.forecast.averageWeeklyUsage)} h/week (${program.forecast.observationCount} observations).`
                          : `Forecast unavailable: ${program.forecast.message}`}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Usage by program" description="What was actually delivered">
          {r.usageByProgram.length === 0 ? (
            <EmptyState title="No transactions recorded" />
          ) : (
            <Table head={<><Th>Program</Th><Th numeric>Hours</Th><Th numeric>Agency</Th><Th numeric>Internal</Th></>}>
              {r.usageByProgram.map((row) => (
                <Tr key={row.programCode}>
                  <Td>{row.programName}<p className="text-xs text-[var(--color-ink-faint)]">{row.transactionCount} transactions</p></Td>
                  <Td numeric><Hours value={row.usedHours} /></Td>
                  <Td numeric><Money value={row.agencyGross} /></Td>
                  <Td numeric><Money value={row.internalAmount} /></Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Employees serving this individual">
          {r.employeesServing.length === 0 ? (
            <EmptyState title="No employees recorded" />
          ) : (
            <Table head={<><Th>Employee</Th><Th numeric>Hours</Th></>}>
              {r.employeesServing.map((e) => (
                <Tr key={e.id}>
                  <Td>{e.displayName}</Td>
                  <Td numeric><Hours value={e.hours} /></Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <p className="mt-4 text-xs text-[var(--color-ink-faint)]">
        <Badge value="valid" label="Note" /> Hours shown are allocation hours. On a group session
        every participant is credited the full session hours; the money is what divides.
      </p>
    </>
  );
}
