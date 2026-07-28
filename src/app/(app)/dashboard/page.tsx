import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getDashboardData } from "@/lib/data/app-queries";
import {
  Card,
  StatTile,
  Money,
  EmptyState,
  ErrorPanel,
  Badge,
  Table,
  Th,
  Td,
  Tr,
  PageHeader,
  ButtonLink,
  Plain,
} from "@/components/ui";
import { formatHours, formatPercent } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard — Ahivim Budget Management" };

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("viewer");
  const denied = (await searchParams).denied;
  const result = await withDb(getDashboardData);

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="Overview" title="Dashboard" />
        <ErrorPanel title="Could not load the dashboard">
          <p>{result.error}</p>
          <p className="mt-2">
            Check <Link href="/api/health/db">/api/health/db</Link> for live connectivity.
          </p>
        </ErrorPanel>
      </>
    );
  }

  const d = result.data;
  const nothingImported = d.counts.transactions === 0;

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        description={`Signed in as ${user.displayName}. Every figure below is read from the operational database.`}
        action={
          user.role !== "viewer" ? (
            <ButtonLink href="/imports" variant="primary">
              Import a workbook
            </ButtonLink>
          ) : undefined
        }
      />

      {denied ? (
        <div className="mb-6">
          <ErrorPanel title="You do not have permission to open that screen">
            <p>Your role is {user.role}. Ask an administrator if you need wider access.</p>
          </ErrorPanel>
        </div>
      ) : null}

      {nothingImported ? (
        <div className="mb-6 rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-5 py-4">
          <p className="display text-sm font-medium">No payroll data has been committed yet</p>
          <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-soft)]">
            The database is connected and migrated, and the programs and rate schedules are seeded,
            but no workbook has been imported. Financial totals below are therefore zero rather than
            unknown &mdash; they are real sums over an empty transaction table.
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Agency gross"
          value={`$${Number(d.totals.agencyGross).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          hint={`${d.counts.transactions.toLocaleString()} transactions`}
        />
        <StatTile
          label="Internal amount"
          value={`$${Number(d.totals.internalAmount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          hint="After the agency-rate conversion"
        />
        <StatTile
          label="Agency retention"
          value={`$${Number(d.totals.agencyRetention).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          hint="Agency gross less internal amount"
        />
        {d.employeeCash.available ? (
          <StatTile
            label="Employee cash"
            value={`$${Number(d.employeeCash.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            hint={`Across ${d.employeeCash.accounts} account periods, after the third cut`}
          />
        ) : (
          <StatTile
            label="Employee cash"
            unavailable="No account periods have been configured, so the sequential cuts have nothing to run against."
          />
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {d.authorization.available ? (
          <>
            <StatTile
              label="Budget utilization"
              value={`${d.authorization.utilizationPercent}%`}
              hint={`${formatHours(d.authorization.usedHours)} of ${formatHours(d.authorization.authorizedHours)} authorized hours`}
              tone={Number(d.authorization.utilizationPercent) > 100 ? "alert" : "neutral"}
            />
            <StatTile
              label="Remaining authorization"
              value={`${formatHours(d.authorization.remainingHours)} h`}
              hint="Authorized hours not yet consumed"
              tone={Number(d.authorization.remainingHours) < 0 ? "alert" : "good"}
            />
          </>
        ) : (
          <>
            <StatTile
              label="Budget utilization"
              unavailable="No authorized hours are recorded. Import the Calculations sheet to establish authorizations."
            />
            <StatTile
              label="Remaining authorization"
              unavailable="Remaining authorization cannot be computed without authorized hours."
            />
          </>
        )}
        <StatTile
          label="Rows needing review"
          value={d.counts.reviewRows.toLocaleString()}
          hint={d.counts.reviewRows ? "Held out of the ledger until resolved" : "Nothing outstanding"}
          tone={d.counts.reviewRows ? "warn" : "good"}
        />
        <StatTile
          label="Open rate exceptions"
          value={d.counts.openRateExceptions.toLocaleString()}
          hint={
            d.counts.openRateExceptions
              ? "Imported rates that differ from the schedule"
              : "Every rate matched its schedule"
          }
          tone={d.counts.openRateExceptions ? "warn" : "good"}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card
          title="Recent imports"
          description="Most recent workbook uploads and their commit state"
          action={<ButtonLink href="/imports">All imports</ButtonLink>}
        >
          {d.recentImports.length === 0 ? (
            <EmptyState title="No workbooks have been uploaded">
              <p>
                Uploading an .xlsx file stages it for review. Nothing reaches the ledger until a
                manager commits it.
              </p>
            </EmptyState>
          ) : (
            <Table head={<><Th>File</Th><Th>Status</Th><Th numeric>Rows</Th><Th numeric>Committed</Th></>}>
              {d.recentImports.map((row) => (
                <Tr key={row.fileId}>
                  <Td>
                    <Link className="underline underline-offset-2" href={`/imports/${row.fileId}`}>
                      {row.filename}
                    </Link>
                    <p className="text-xs text-[var(--color-ink-faint)]">
                      {new Date(row.uploadedAt).toLocaleString()}
                    </p>
                  </Td>
                  <Td><Badge value={row.status} /></Td>
                  <Td numeric className="tnum">{row.totalRows.toLocaleString()}</Td>
                  <Td numeric className="tnum">{row.importedRows.toLocaleString()}</Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>

        <Card
          title="Reconciliation"
          description="Workbook control totals against what was committed"
        >
          {d.reconciliation.length === 0 ? (
            <EmptyState title="Nothing to reconcile yet">
              <p>
                Once a workbook is committed, its own control totals are compared with the sum of
                the rows this application stored.
              </p>
            </EmptyState>
          ) : (
            <Table head={<><Th>Batch</Th><Th numeric>Agency diff.</Th><Th numeric>Internal diff.</Th><Th>State</Th></>}>
              {d.reconciliation.map((row) => (
                <Tr key={row.batchId}>
                  <Td>
                    {row.filename}
                    <p className="text-xs text-[var(--color-ink-faint)]">
                      {row.committedAt ? new Date(row.committedAt).toLocaleString() : "Not committed"}
                    </p>
                  </Td>
                  <Td numeric><Money value={row.agencyDifference} /></Td>
                  <Td numeric><Money value={row.internalDifference} /></Td>
                  <Td>
                    {row.balanced === null ? (
                      <span className="text-xs text-[var(--color-ink-faint)]">
                        No control totals in the source
                      </span>
                    ) : (
                      <Badge value={row.balanced ? "valid" : "invalid"} label={row.balanced ? "Balanced" : "Differs"} />
                    )}
                  </Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Forecast" description="Projected exhaustion of authorized hours">
          <div className="px-5 py-4 text-sm">
            {!d.forecast.available ? (
              <>
                <p className="font-medium">Not available</p>
                <p className="mt-1 text-[var(--color-ink-soft)]">{d.forecast.reason}</p>
              </>
            ) : d.forecast.result.available === false ? (
              <>
                <p className="font-medium">Not available</p>
                <p className="mt-1 text-[var(--color-ink-soft)]">{d.forecast.result.message}</p>
                <p className="tnum mt-2 text-xs text-[var(--color-ink-faint)]">
                  {formatPercent(d.forecast.result.timeElapsedPercent)} of the period elapsed;{" "}
                  {formatPercent(d.forecast.result.usagePercent)} of hours used;{" "}
                  {d.forecast.result.observationCount} observations.
                </p>
              </>
            ) : (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                <dt className="text-[var(--color-ink-faint)]">Estimated exhaustion</dt>
                <dd className="tnum text-right font-medium">
                  <Plain value={d.forecast.result.estimatedExhaustionDate} />
                </dd>
                <dt className="text-[var(--color-ink-faint)]">Average weekly usage</dt>
                <dd className="tnum text-right">{formatHours(d.forecast.result.averageWeeklyUsage)} h</dd>
                <dt className="text-[var(--color-ink-faint)]">Required weekly usage</dt>
                <dd className="tnum text-right">{formatHours(d.forecast.result.requiredWeeklyUsage)} h</dd>
                <dt className="text-[var(--color-ink-faint)]">Projected remaining</dt>
                <dd className="tnum text-right">{formatHours(d.forecast.result.projectedRemainingHours)} h</dd>
              </dl>
            )}
          </div>
        </Card>

        <Card title="Register" description="What the database currently holds">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-5 py-4 text-sm">
            <dt className="text-[var(--color-ink-faint)]">Individuals</dt>
            <dd className="tnum text-right">{d.counts.individuals.toLocaleString()}</dd>
            <dt className="text-[var(--color-ink-faint)]">Employees</dt>
            <dd className="tnum text-right">{d.counts.employees.toLocaleString()}</dd>
            <dt className="text-[var(--color-ink-faint)]">Service sessions</dt>
            <dd className="tnum text-right">{d.counts.serviceSessions.toLocaleString()}</dd>
            <dt className="text-[var(--color-ink-faint)]">Group sessions</dt>
            <dd className="tnum text-right">{d.counts.groupSessions.toLocaleString()}</dd>
            <dt className="text-[var(--color-ink-faint)]">Imports</dt>
            <dd className="tnum text-right">{d.counts.imports.toLocaleString()}</dd>
            <dt className="text-[var(--color-ink-faint)]">Pending alias approvals</dt>
            <dd className="tnum text-right">{d.counts.pendingAliases.toLocaleString()}</dd>
          </dl>
        </Card>
      </div>
    </>
  );
}
