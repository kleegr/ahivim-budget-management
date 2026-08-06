import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getDashboardData } from "@/lib/data/app-queries";
import { scheduledTotals } from "@/lib/data/schedule-queries";
import { dashboardReportMetrics } from "@/lib/data/report-queries";
import { getSetting } from "@/lib/manage/app-settings";
import { StatTile, ErrorPanel, PageHeader, ButtonLink } from "@/components/ui";
import { formatHours, formatMoney } from "@/lib/money";
import DefaultLanding from "@/components/dashboard/default-landing";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard — Ahivim Budget Management" };

function TileLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="block rounded-lg outline-offset-2 transition hover:ring-2 hover:ring-[var(--color-primary-soft)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
    >
      {children}
    </Link>
  );
}

/** A large, obvious button to a whole workspace. */
function BigButton({ href, title, sub }: { href: string; title: string; sub: string }) {
  return (
    <Link
      href={href}
      className="flex flex-col rounded-xl border border-[var(--color-rule-strong)] bg-[var(--color-surface)] px-5 py-4 transition hover:border-[var(--color-primary)] hover:shadow-sm"
    >
      <span className="text-lg font-semibold">{title}</span>
      <span className="mt-0.5 text-sm text-[var(--color-text-soft)]">{sub}</span>
    </Link>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("viewer");
  const canManage = user.role !== "viewer";
  const denied = (await searchParams).denied;

  const result = await withDb(async (pool) => ({
    dashboard: await getDashboardData(pool),
    scheduled: await scheduledTotals(pool),
    metrics: await dashboardReportMetrics(pool),
    strategies: Number(
      (await pool.query<{ c: string }>(`SELECT count(*)::text c FROM calculation_strategies WHERE status = 'active'`)).rows[0]?.c ?? 0,
    ),
    defaultLanding: (await getSetting<string>(pool, "default_landing")) ?? "dashboard",
  }));

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="Overview" title="Dashboard" />
        <ErrorPanel title="Could not load the dashboard">{result.error}</ErrorPanel>
      </>
    );
  }

  const d = result.data.dashboard;
  const m = result.data.metrics;
  const scheduled = result.data.scheduled;

  // Needs-attention: only surface what actually needs a person, in plain English.
  const attention = [
    { n: d.counts.reviewRows, href: "/imports", label: "import rows waiting for review", none: "No imports are waiting for review" },
    { n: d.counts.openRateExceptions, href: "/exceptions", label: "rates that differ from the schedule", none: "Every rate matches its schedule" },
    { n: m.counts.unbilledSchedules, href: "/reconciliation", label: "planned sessions not yet billed", none: "Every planned session is billed" },
    { n: m.counts.unscheduledBilling, href: "/reconciliation", label: "billed transactions with no plan", none: "Every transaction was planned" },
    { n: m.counts.missingRates + m.counts.missingAssignments, href: "/reports/missing-config", label: "missing rates or assignments", none: "Rates and assignments are complete" },
    { n: d.counts.pendingAliases, href: "/aliases", label: "name matches awaiting approval", none: "No name matches are pending" },
  ];
  const open = attention.filter((a) => a.n > 0);

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title={`Welcome, ${user.displayName.split(" ")[0]}`}
        description="Start in a workspace, or scan what needs attention below. Every number is clickable."
        action={canManage ? <ButtonLink href="/imports" variant="primary">Import a workbook</ButtonLink> : undefined}
      />

      {denied ? (
        <div className="mb-4">
          <ErrorPanel title="You do not have permission to open that screen">
            Your role is {user.role}. Ask an administrator if you need wider access.
          </ErrorPanel>
        </div>
      ) : null}

      {/* Big workspace buttons */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <BigButton href="/transactions" title="Transactions" sub="Billed payroll, like the Ahivim tab" />
        <BigButton href="/calculations" title="Projections" sub="Budgets, pacing & utilization" />
        <BigButton href="/schedule" title="Schedule" sub="Planned sessions" />
        <BigButton href="/imports" title="Imports" sub="Upload & commit workbooks" />
        <BigButton href="/reports" title="Reports" sub="Export & analyze" />
      </div>

      {/* 6 headline totals — all clickable */}
      <h2 className="eyebrow mb-2 mt-6">The numbers</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TileLink href="/transactions">
          <StatTile label="Total billed" value={formatMoney(d.totals.agencyGross)} hint={`${d.counts.transactions.toLocaleString()} transactions`} />
        </TileLink>
        <TileLink href="/transactions">
          <StatTile label="Internal / employee amount" value={formatMoney(d.totals.internalAmount)} hint="What the employees earned" />
        </TileLink>
        {m.agencyAdditional.available ? (
          <TileLink href="/reports/agency-earnings">
            <StatTile label="Agency additional" value={formatMoney(m.agencyAdditional.amount)} hint="Billed less internal" />
          </TileLink>
        ) : (
          <TileLink href="/reports/agency-earnings"><StatTile label="Agency additional" unavailable="Not recorded on the imports on file." /></TileLink>
        )}
        {m.employeePayable.available ? (
          <TileLink href="/reports/employee-payable">
            <StatTile label="Employee payable" value={formatMoney(m.employeePayable.amount)} hint="Owed to employees" />
          </TileLink>
        ) : (
          <TileLink href="/reports/employee-payable"><StatTile label="Employee payable" unavailable="Not recorded on the imports on file." /></TileLink>
        )}
        <TileLink href="/schedule">
          <StatTile label="Scheduled (expected)" value={formatMoney(scheduled.internal)} hint={`${scheduled.sessions.toLocaleString()} pending · ${formatHours(scheduled.hours)} h`} />
        </TileLink>
        <TileLink href="/calculations">
          <StatTile label="Budget projections" value={result.data.strategies.toLocaleString()} hint="Active projection lines" />
        </TileLink>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {/* Needs attention */}
        <div className="rounded-xl border border-[var(--color-rule-strong)] bg-[var(--color-surface)] p-5">
          <h2 className="text-lg font-semibold">Needs attention</h2>
          {open.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--color-text-soft)]">All clear — nothing is waiting on you right now.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {open.map((a) => (
                <li key={a.label}>
                  <Link href={a.href} className="flex items-baseline justify-between gap-3 rounded-lg px-3 py-2 hover:bg-black/[0.03]">
                    <span className="text-sm">{a.label}</span>
                    <span className="rounded-full bg-[var(--color-primary)] px-2 py-0.5 text-xs font-semibold text-white">{a.n.toLocaleString()}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Budget status */}
        <div className="rounded-xl border border-[var(--color-rule-strong)] bg-[var(--color-surface)] p-5">
          <h2 className="text-lg font-semibold">Budget status</h2>
          <div className="mt-3 grid grid-cols-2 gap-3">
            {d.authorization.available ? (
              <>
                <TileLink href="/reports/budget-utilization">
                  <StatTile label="Budget used" value={`${d.authorization.utilizationPercent}%`} hint={`${formatHours(d.authorization.remainingHours)} h left`} tone={Number(d.authorization.utilizationPercent) > 100 ? "alert" : "neutral"} />
                </TileLink>
                <TileLink href="/reports/budget-utilization">
                  <StatTile label="Near exhaustion" value={m.counts.nearExhaustion.toLocaleString()} hint={m.counts.nearExhaustion ? "At/above 90% used" : "None above 90%"} tone={m.counts.nearExhaustion ? "warn" : "good"} />
                </TileLink>
              </>
            ) : (
              <TileLink href="/calculations">
                <StatTile label="Budget used" unavailable="Set renewal dates and hours in Projections to track this." />
              </TileLink>
            )}
            <TileLink href="/reports/expiring-authorizations">
              <StatTile label="Expiring soon" value={m.counts.expiringAuthorizations.toLocaleString()} hint={m.counts.expiringAuthorizations ? "Renew within 60 days" : "None within 60 days"} tone={m.counts.expiringAuthorizations ? "warn" : "good"} />
            </TileLink>
            <TileLink href="/reports/budget-utilization">
              <StatTile label="Underutilizing" value={m.counts.underutilizing.toLocaleString()} hint={m.counts.underutilizing ? "Behind pace" : "On pace"} tone={m.counts.underutilizing ? "warn" : "good"} />
            </TileLink>
          </div>
        </div>
      </div>

      {canManage && (
        <div className="mt-6 rounded-xl border border-[var(--color-rule)] bg-[var(--color-surface)] px-5 py-3">
          <DefaultLanding current={result.data.defaultLanding} />
        </div>
      )}
    </>
  );
}
