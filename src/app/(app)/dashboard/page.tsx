import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getDashboardData } from "@/lib/data/app-queries";
import { scheduledTotals } from "@/lib/data/schedule-queries";
import { dashboardReportMetrics } from "@/lib/data/report-queries";
import { exceptionCounts } from "@/lib/data/queries";
import { getSetting } from "@/lib/manage/app-settings";
import { StatTile, ErrorPanel, PageHeader, ButtonLink } from "@/components/ui";
import { formatHours, formatMoney } from "@/lib/money";
import DefaultLanding from "@/components/dashboard/default-landing";
import FirstRunWelcome from "@/components/first-run-welcome";

export const dynamic = "force-dynamic";
export const metadata = { title: "Home — Ahivim Budget Management" };

/*
  Home (a.k.a. Dashboard) — redesigned to lead with "what needs me today".

  The user opens this screen every morning. What they need first is not a
  menu of doors — the nav already offers those. What they need is the
  answer to "did anything change I need to look at?" So this page now
  leads with a strip of four attention tiles (over budget, expiring,
  needs review, behind pace), each a one-tap link into the exact list.

  Money tiles come second, then a quiet row of workspace shortcuts.
*/

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

/** Big attention tile — a coloured left rail, a plain-English label and a link. */
function AttentionTile({
  href,
  label,
  count,
  hint,
  tone,
}: {
  href: string;
  label: string;
  count: number;
  hint: string;
  tone: "danger" | "warn" | "info" | "behind" | "good";
}) {
  const styles: Record<typeof tone, { edge: string; value: string }> = {
    danger: { edge: "border-l-[var(--color-danger)]", value: "text-[var(--color-danger)]" },
    warn: { edge: "border-l-[var(--color-warn)]", value: "text-[var(--color-warn)]" },
    info: { edge: "border-l-[var(--color-info)]", value: "text-[var(--color-info)]" },
    behind: { edge: "border-l-[var(--color-pace-behind)]", value: "text-[var(--color-pace-behind)]" },
    good: { edge: "border-l-[var(--color-success)]", value: "text-[var(--color-success)]" },
  } as Record<string, { edge: string; value: string }>;
  const s = styles[tone];
  return (
    <Link
      href={href}
      className={`card card-interactive block border-l-4 ${s.edge} px-4 py-3.5`}
    >
      <p className="eyebrow">{label}</p>
      <p className={`tnum mt-1 text-2xl font-semibold leading-tight ${s.value}`}>
        {count.toLocaleString()}
      </p>
      <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{hint}</p>
    </Link>
  );
}

/** Quiet workspace shortcut — smaller than the old giant buttons. */
function Shortcut({ href, title, sub }: { href: string; title: string; sub: string }) {
  return (
    <Link
      href={href}
      className="card-interactive flex flex-col rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-2.5 hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-tint)]"
    >
      <span className="text-sm font-semibold">{title}</span>
      <span className="text-xs text-[var(--color-ink-faint)]">{sub}</span>
    </Link>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("manager");
  const canManage = user.role !== "viewer";
  const denied = (await searchParams).denied;

  const result = await withDb(async (pool) => ({
    dashboard: await getDashboardData(pool),
    scheduled: await scheduledTotals(pool),
    metrics: await dashboardReportMetrics(pool),
    review: await exceptionCounts(pool),
    strategies: Number(
      (await pool.query<{ c: string }>(`SELECT count(*)::text c FROM calculation_strategies WHERE status = 'active'`)).rows[0]?.c ?? 0,
    ),
    defaultLanding: (await getSetting<string>(pool, "default_landing")) ?? "dashboard",
  }));

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="Home" title="Home" />
        <ErrorPanel title="Could not load the home screen">{result.error}</ErrorPanel>
      </>
    );
  }

  const d = result.data.dashboard;
  const m = result.data.metrics;
  const scheduled = result.data.scheduled;
  const review = result.data.review;

  // Decisions a person must make (see layout.tsx for the rationale) — not the
  // monitoring metrics, which have their own tiles below.
  const reviewTotal =
    review.unmatchedNames +
    review.duplicateIndividuals +
    review.pendingAliases +
    review.unknownPrograms +
    review.reconciliationDifferences;

  // The four attention tiles that lead the page.
  const attention = [
    {
      key: "over",
      label: "Over budget",
      count: review.overAuthorization,
      hint: review.overAuthorization ? "People past their approved hours" : "No one is over their approved hours",
      tone: "danger" as const,
      href: "/reports/utilization-outliers",
    },
    {
      key: "expiring",
      label: "Renew < 60 days",
      count: m.counts.expiringAuthorizations,
      hint: m.counts.expiringAuthorizations ? "Authorizations expiring soon" : "None expiring in the next 60 days",
      tone: "warn" as const,
      href: "/reports/expiring-authorizations",
    },
    {
      key: "review",
      label: "Needs review",
      count: reviewTotal,
      hint: reviewTotal ? "Items waiting on a decision" : "Review inbox is clear",
      tone: "info" as const,
      href: "/review",
    },
    {
      key: "behind",
      label: "Behind pace",
      count: m.counts.underutilizing,
      hint: m.counts.underutilizing ? "Using budgets too slowly" : "Everyone is on pace",
      tone: "behind" as const,
      href: "/reports/budget-utilization",
    },
  ];
  const totalAttention = attention.reduce((sum, a) => sum + a.count, 0);

  const firstName = user.displayName.split(" ")[0];
  const now = new Date();
  const greeting = now.getHours() < 12 ? "Good morning" : now.getHours() < 18 ? "Good afternoon" : "Good evening";
  const dayLine = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <>
      <PageHeader
        eyebrow="Home"
        title={`${greeting}, ${firstName}`}
        description={`${dayLine} — everything below is one tap into the exact list.`}
        action={canManage ? <ButtonLink href="/imports" variant="primary">Import a workbook</ButtonLink> : undefined}
      />

      {denied ? (
        <div className="mb-4">
          <ErrorPanel title="You do not have permission to open that screen">
            Your role is {user.role}. Ask an administrator if you need wider access.
          </ErrorPanel>
        </div>
      ) : null}

      <FirstRunWelcome />

      {/* ---- Needs you: the answer to "did anything change?" ---- */}
      <section aria-labelledby="needs-you-heading" className="fade-in-up">
        <h2 id="needs-you-heading" className="eyebrow mb-2">Needs you</h2>
        {totalAttention === 0 ? (
          <div className="card flex items-center gap-3 border-l-4 border-l-[var(--color-success)] px-5 py-4">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--color-success-soft)] text-[var(--color-success)]">
              ✓
            </span>
            <div>
              <p className="text-sm font-semibold text-[var(--color-success)]">All clear</p>
              <p className="text-xs text-[var(--color-ink-soft)]">
                Nothing is waiting on you right now. Enjoy the calm.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {attention.map((a) => (
              <AttentionTile
                key={a.key}
                href={a.href}
                label={a.label}
                count={a.count}
                hint={a.hint}
                tone={a.count === 0 ? "good" : a.tone}
              />
            ))}
          </div>
        )}
      </section>

      {/* ---- The numbers: money at a glance ---- */}
      <section aria-labelledby="numbers-heading" className="mt-8 fade-in-up">
        <h2 id="numbers-heading" className="eyebrow mb-2">The numbers</h2>
        <p className="mb-2 text-xs text-[var(--color-ink-faint)]">
          Three parallel money figures live side by side — the agency total (what the funder pays),
          the employee/internal amount (what workers earned), and the agency difference retained between them.
          Each links into the ledger, where the totals match.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <TileLink href="/transactions">
            <StatTile label="Agency total (billed)" value={formatMoney(d.totals.agencyGross)} hint={`${d.counts.transactions.toLocaleString()} transactions`} />
          </TileLink>
          <TileLink href="/transactions">
            <StatTile label="Employee amount" value={formatMoney(d.totals.internalAmount)} hint="What the employees earned" />
          </TileLink>
          {m.agencyAdditional.available ? (
            <TileLink href="/reports/agency-earnings">
              <StatTile label="Agency difference" value={formatMoney(m.agencyAdditional.amount)} hint="Agency total less employee amount" />
            </TileLink>
          ) : (
            <TileLink href="/reports/agency-earnings"><StatTile label="Agency difference" unavailable="Not recorded on the imports on file." /></TileLink>
          )}
          {m.employeePayable.available ? (
            <TileLink href="/reports/employee-payable">
              <StatTile label="Employee payable" value={formatMoney(m.employeePayable.amount)} hint="Owed to employees" />
            </TileLink>
          ) : (
            <TileLink href="/reports/employee-payable"><StatTile label="Employee payable" unavailable="Not recorded on the imports on file." /></TileLink>
          )}
          <TileLink href="/schedule">
            <StatTile label="Planned (not yet billed)" value={formatMoney(scheduled.internal)} hint={`${scheduled.sessions.toLocaleString()} pending · ${formatHours(scheduled.hours)} h`} />
          </TileLink>
          <TileLink href="/calculations">
            <StatTile label="Financial plans" value={result.data.strategies.toLocaleString()} hint="Active accounts in the Financial workbook" />
          </TileLink>
        </div>
      </section>

      {/* ---- Workspaces: a quiet strip, since the nav does the same job ---- */}
      <section aria-labelledby="jump-heading" className="mt-8 fade-in-up">
        <h2 id="jump-heading" className="eyebrow mb-2">Jump to a workspace</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Shortcut href="/transactions" title="Transactions" sub="What was billed" />
          <Shortcut href="/individuals" title="Individuals" sub="Budgets & usage" />
          <Shortcut href="/employees" title="Employees" sub="Activity from the ledger" />
          <Shortcut href="/calculations" title="Financial" sub="Rates, cuts & net" />
        </div>
      </section>

      {canManage && (
        <div className="mt-8 rounded-xl border border-[var(--color-rule)] bg-[var(--color-surface)] px-5 py-3">
          <DefaultLanding current={result.data.defaultLanding} />
        </div>
      )}
    </>
  );
}
