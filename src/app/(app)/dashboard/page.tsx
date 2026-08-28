import Link from "next/link";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  CalendarClock,
  CircleDollarSign,
  Database,
  HandCoins,
  Landmark,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getFinancialDashboard } from "@/lib/data/financial-dashboard";
import { getSettlementDashboard } from "@/lib/data/settlements";
import { getReconciliation, listImports } from "@/lib/data/app-queries";
import { exceptionCounts, listIndividualBudgetBoard } from "@/lib/data/queries";
import { dec, formatMoney } from "@/lib/money";
import { ErrorPanel, PageHeader, ButtonLink } from "@/components/ui";
import FirstRunWelcome from "@/components/first-run-welcome";
import { agencyDate } from "@/lib/business/agency-time";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview - Ahivim Budget Management" };

type Tone = "danger" | "warn" | "info" | "good";

const TONE_STYLES: Record<Tone, { icon: string; value: string; bar: string }> = {
  danger: {
    icon: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
    value: "text-[var(--color-danger)]",
    bar: "bg-[var(--color-danger)]",
  },
  warn: {
    icon: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
    value: "text-[var(--color-warn)]",
    bar: "bg-[var(--color-warn)]",
  },
  info: {
    icon: "bg-[var(--color-info-soft)] text-[var(--color-info)]",
    value: "text-[var(--color-info)]",
    bar: "bg-[var(--color-info)]",
  },
  good: {
    icon: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
    value: "text-[var(--color-success)]",
    bar: "bg-[var(--color-success)]",
  },
};

function readableDate(value: string | null, fallback = "Not yet") {
  if (!value) return fallback;
  const date = new Date(value.includes("T") ? value : `${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function readableTimestamp(value: string | null) {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function SectionHeading({ id, title, context }: { id: string; title: string; context: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
      <h2 id={id} className="display text-lg font-semibold text-[var(--color-ink)]">{title}</h2>
      <p className="text-xs text-[var(--color-ink-faint)]">{context}</p>
    </div>
  );
}

function ActionRow({
  href,
  icon: Icon,
  count,
  title,
  detail,
  tone,
}: {
  href: string;
  icon: LucideIcon;
  count: number;
  title: string;
  detail: string;
  tone: Tone;
}) {
  const style = TONE_STYLES[tone];
  return (
    <Link
      href={href}
      className="group grid grid-cols-[auto_1fr_auto] items-center gap-3 border-t border-[var(--color-rule)] px-1 py-3 first:border-t-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
    >
      <span className={`grid h-9 w-9 place-items-center rounded-md ${style.icon}`}>
        <Icon size={18} strokeWidth={1.8} aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">
          {title}
        </span>
        <span className="block text-xs leading-5 text-[var(--color-ink-soft)]">{detail}</span>
      </span>
      <span className="flex items-center gap-3">
        <span className={`tnum text-xl font-semibold ${style.value}`}>{count.toLocaleString()}</span>
        <ArrowRight size={16} className="text-[var(--color-ink-faint)] group-hover:text-[var(--color-primary)]" aria-hidden />
      </span>
    </Link>
  );
}

function MoneyMetric({
  label,
  value,
  detail,
  icon: Icon,
  children,
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0 px-4 py-4 sm:px-5">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase text-[var(--color-ink-faint)]">
        <Icon size={15} aria-hidden />
        <span>{label}</span>
      </div>
      <p className="tnum mt-2 text-2xl font-semibold leading-none text-[var(--color-ink)]">{value}</p>
      <p className="mt-2 text-xs leading-5 text-[var(--color-ink-soft)]">{detail}</p>
      {children}
    </div>
  );
}

function HealthMetric({ label, count, tone }: { label: string; count: number; tone: Tone }) {
  return (
    <div className="border-l-2 border-[var(--color-rule-strong)] pl-3">
      <p className={`tnum text-xl font-semibold ${TONE_STYLES[tone].value}`}>{count.toLocaleString()}</p>
      <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">{label}</p>
    </div>
  );
}

function HealthBar({
  total,
  segments,
}: {
  total: number;
  segments: { label: string; count: number; tone: Tone }[];
}) {
  if (total === 0) {
    return <div className="h-2 rounded-full bg-[var(--color-surface-strong)]" />;
  }
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-[var(--color-surface-strong)]" role="img" aria-label={`${total} active budgets by health`}>
      {segments.map((segment) =>
        segment.count > 0 ? (
          <span
            key={segment.label}
            className={TONE_STYLES[segment.tone].bar}
            style={{ width: `${(segment.count / total) * 100}%` }}
            title={`${segment.label}: ${segment.count}`}
          />
        ) : null,
      )}
    </div>
  );
}

function DataHealthRow({
  icon: Icon,
  label,
  value,
  detail,
  tone,
  href,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  tone: Tone;
  href: string;
}) {
  return (
    <Link href={href} className="group flex gap-3 px-4 py-4 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] sm:px-5">
      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md ${TONE_STYLES[tone].icon}`}>
        <Icon size={16} aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold uppercase text-[var(--color-ink-faint)]">{label}</span>
        <span className="mt-0.5 block break-words text-sm font-semibold text-[var(--color-ink)]">{value}</span>
        <span className="mt-0.5 block text-xs leading-5 text-[var(--color-ink-soft)]">{detail}</span>
      </span>
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
  const asOf = agencyDate();
  const now = new Date(`${asOf}T12:00:00Z`);

  const result = await withDb(async (pool) => {
    const [financial, settlements, budgets, review, imports, reconciliation] = await Promise.all([
      getFinancialDashboard(pool),
      getSettlementDashboard(pool),
      listIndividualBudgetBoard(pool, now),
      exceptionCounts(pool),
      listImports(pool, 1),
      getReconciliation(pool, 1),
    ]);
    return { financial, settlements, budgets, review, imports, reconciliation };
  });

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="Operations" title="Overview" />
        <ErrorPanel title="Could not load the overview">{result.error}</ErrorPanel>
      </>
    );
  }

  const { financial, settlements, budgets, review, imports, reconciliation } = result.data;
  const activeBudgets = budgets.filter((row) => row.status === "active" && !row.archived && row.budget);
  const budgetCount = activeBudgets.length;
  const budgetStatusCount = (statuses: string[]) =>
    activeBudgets.filter((row) => row.budget && statuses.includes(row.budget.status)).length;
  const stableBudgets = budgetStatusCount(["on_pace", "ahead_of_pace"]);
  const behindBudgets = budgetStatusCount(["behind_pace"]);
  const atLimitBudgets = budgetStatusCount(["near_exhaustion", "fully_used", "over_authorization"]);
  const noActivityBudgets = budgetStatusCount(["not_started"]);
  const renewalSoon = activeBudgets.filter((row) => {
    const days = row.budget?.daysToRenewal;
    return days != null && days >= 0 && days <= 60;
  }).length;
  const billingWithoutBudget = financial.candidates.filter((row) => row.txCount > 0).length;
  const transactionCount = financial.rows.reduce((sum, row) => sum + row.txCountPeriod, 0);
  const reviewTotal =
    review.unknownPrograms +
    review.unmatchedNames +
    review.duplicateIndividuals +
    review.pendingAliases +
    review.rateExceptions +
    review.duplicateCandidates +
    review.groupReviewIssues +
    review.reconciliationDifferences;

  const currentMasser = settlements.rows.filter(
    (row) =>
      row.state !== "void" &&
      row.kind.startsWith("individual_masser") &&
      row.periodBegin != null &&
      row.periodEnd != null &&
      row.periodBegin <= asOf &&
      row.periodEnd >= asOf,
  );
  const masserLedgerTarget = currentMasser.reduce((sum, row) => sum.plus(row.originalAmount), dec(0));
  const masserApplied = currentMasser.reduce((sum, row) => sum.plus(row.appliedAmount), dec(0));
  const masserRemaining = currentMasser.reduce(
    (sum, row) => (dec(row.balance).greaterThan(0) ? sum.plus(row.balance) : sum),
    dec(0),
  );

  const actions = [
    ...(settlements.freshness.dirty
      ? [{ href: "/settlements", icon: RefreshCw, count: 1, title: "Refresh payment balances", detail: settlements.freshness.lastRefreshError ?? "Budgets or transactions changed after the last payment refresh.", tone: "danger" as const }]
      : []),
    ...(settlements.summary.partialCount > 0
      ? [{ href: "/settlements", icon: HandCoins, count: settlements.summary.partialCount, title: "Continue partial payments", detail: "A payment or collection was started but still has a balance.", tone: "warn" as const }]
      : []),
    ...(settlements.summary.creditCount > 0
      ? [{ href: "/settlements", icon: CircleDollarSign, count: settlements.summary.creditCount, title: "Apply available credits", detail: `${formatMoney(settlements.summary.credits)} is available to offset future obligations.`, tone: "info" as const }]
      : []),
    ...(settlements.missingDeals.length > 0
      ? [{ href: "/settlements", icon: TriangleAlert, count: settlements.missingDeals.length, title: "Set employee deal rules", detail: "A direct-check give-back cannot be calculated until its deal rule is set.", tone: "danger" as const }]
      : []),
    ...(settlements.checkIssues.length > 0
      ? [{ href: "/settlements", icon: ReceiptText, count: settlements.checkIssues.length, title: "Resolve check data", detail: "Check identity, recipient, Direct-check net, or Employee base is incomplete or conflicting.", tone: "danger" as const }]
      : []),
    ...(atLimitBudgets > 0
      ? [{ href: "/individuals", icon: TriangleAlert, count: atLimitBudgets, title: "Review budgets at their limit", detail: "These current budget periods are at least 90% used, fully used, or over hours.", tone: "danger" as const }]
      : []),
    ...(behindBudgets > 0
      ? [{ href: "/individuals", icon: CalendarClock, count: behindBudgets, title: "Review budgets behind pace", detail: "Used hours trail elapsed time by more than the current pace tolerance.", tone: "warn" as const }]
      : []),
    ...(renewalSoon > 0
      ? [{ href: "/reports/expiring-authorizations", icon: CalendarClock, count: renewalSoon, title: "Prepare upcoming renewals", detail: "Current budget periods end within the next 60 days.", tone: "warn" as const }]
      : []),
    ...(billingWithoutBudget > 0
      ? [{ href: "/calculations", icon: Landmark, count: billingWithoutBudget, title: "Set up budgets for billed individuals", detail: "Transactions exist, but no active budget setup is on file.", tone: "danger" as const }]
      : []),
    ...(reviewTotal > 0
      ? [{ href: "/review", icon: Database, count: reviewTotal, title: "Clear the data review queue", detail: "Names, programs, rates, groups, duplicates, or reconciliations need a decision.", tone: "info" as const }]
      : []),
  ];

  const latestImport = imports[0] ?? null;
  const latestReconciliation = reconciliation[0] ?? null;
  const reconciliationTone: Tone = latestReconciliation?.balanced === false ? "danger" : latestReconciliation?.balanced === true ? "good" : "info";
  const reconciliationValue = latestReconciliation?.balanced === false
    ? "Differences found"
    : latestReconciliation?.balanced === true
      ? "Balanced"
      : "No control totals";
  const reconciliationDetail = latestReconciliation
    ? latestReconciliation.balanced === false
      ? `Funder billed difference ${formatMoney(latestReconciliation.agencyDifference ?? 0)} | Employee base difference ${formatMoney(latestReconciliation.internalDifference ?? 0)}`
      : `${latestReconciliation.filename} | ${readableDate(latestReconciliation.committedAt)}`
    : "No committed import is available to reconcile.";

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Overview"
        description="The current operating position from active budgets, period-matched transactions, and the payment ledger."
        meta={
          <>
            <span>As of {readableDate(asOf)}</span>
            <span aria-hidden>|</span>
            <span>Budget and billing totals use each individual&apos;s current budget period</span>
          </>
        }
        action={canManage ? <ButtonLink href="/imports" variant="primary"><Database size={15} aria-hidden /> Import workbook</ButtonLink> : undefined}
      />

      {denied ? (
        <div className="mb-5">
          <ErrorPanel title="You do not have permission to open that screen">
            Your role is {user.role}. Ask an administrator if you need wider access.
          </ErrorPanel>
        </div>
      ) : null}

      <FirstRunWelcome />

      <section aria-labelledby="action-queue-heading" className="border-y border-[var(--color-rule-strong)] py-5">
        <SectionHeading id="action-queue-heading" title="Action queue" context="Only items that need a decision or follow-up appear here" />
        {actions.length === 0 ? (
          <div className="flex items-center gap-3 py-3">
            <span className="grid h-10 w-10 place-items-center rounded-md bg-[var(--color-success-soft)] text-[var(--color-success)]">
              <ShieldCheck size={20} aria-hidden />
            </span>
            <div>
              <p className="text-sm font-semibold text-[var(--color-success)]">No open actions</p>
              <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">Budget, payment, and data checks are clear as of today.</p>
            </div>
          </div>
        ) : (
          <div className="grid gap-x-8 lg:grid-cols-2">
            {actions.map((action) => <ActionRow key={action.title} {...action} />)}
          </div>
        )}
      </section>

      <section aria-labelledby="money-position-heading" className="py-8">
        <SectionHeading id="money-position-heading" title="Money position" context={`${transactionCount.toLocaleString()} transactions inside current budget periods`} />
        <div className="grid divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <MoneyMetric icon={ReceiptText} label="Funder billed" value={formatMoney(financial.totals.period.billedGross)} detail="Funder billed recorded on committed transactions." />
          <MoneyMetric icon={HandCoins} label="Employee base" value={formatMoney(financial.totals.period.employeesMade)} detail="Employee base for the work, before payment activity." />
          <MoneyMetric icon={Landmark} label="Agency spread" value={formatMoney(financial.totals.period.agencyMade)} detail="Funder billed less Employee base. This is not an employee give-back." />
        </div>
        <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
          Funder billed = Employee base + Agency spread. People with billing but no active budget are excluded here and listed in the action queue.
        </p>

        <div className="mt-6 grid divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] sm:grid-cols-4 sm:divide-x sm:divide-y-0">
          <MoneyMetric icon={HandCoins} label="Agency to pay" value={formatMoney(settlements.summary.agencyOwes)} detail="Open employee payout balances." />
          <MoneyMetric icon={Landmark} label="Agency to collect" value={formatMoney(settlements.summary.employeesOwe)} detail="Open employee give-back balances, calculated from Direct-check net where required." />
          <MoneyMetric icon={CircleDollarSign} label="Annual set-aside" value={formatMoney(settlements.summary.reservesToSetAside)} detail="Open Annual set-aside balances, including the Masser obligation." />
          <MoneyMetric icon={RefreshCw} label="Available credits" value={formatMoney(settlements.summary.credits)} detail="Overpayments or over-collections available to apply." />
        </div>
        <p className="mt-2 text-xs text-[var(--color-ink-faint)]">Payment figures are remaining balances across all active obligations as of today.</p>
      </section>

      <div className="grid gap-10 border-t border-[var(--color-rule-strong)] py-8 lg:grid-cols-2">
        <section aria-labelledby="budget-health-heading">
          <SectionHeading id="budget-health-heading" title="Budget health" context={`${budgetCount.toLocaleString()} people with active budgets`} />
          <HealthBar
            total={budgetCount}
            segments={[
              { label: "Stable", count: stableBudgets, tone: "good" },
              { label: "Behind pace", count: behindBudgets, tone: "warn" },
              { label: "At limit", count: atLimitBudgets, tone: "danger" },
              { label: "No activity", count: noActivityBudgets, tone: "info" },
            ]}
          />
          <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-5 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
            <HealthMetric label="Stable" count={stableBudgets} tone="good" />
            <HealthMetric label="Behind pace" count={behindBudgets} tone="warn" />
            <HealthMetric label="At limit" count={atLimitBudgets} tone="danger" />
            <HealthMetric label="No activity" count={noActivityBudgets} tone="info" />
          </div>
          <Link href="/individuals" className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--color-primary)] hover:underline">
            Open individual budgets <ArrowRight size={15} aria-hidden />
          </Link>
        </section>

        <section aria-labelledby="annual-reserve-heading" className="border-t border-[var(--color-rule)] pt-8 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
          <SectionHeading id="annual-reserve-heading" title="Annual set-aside" context="Masser for current budget periods" />
          <div className="grid grid-cols-2 gap-x-6 gap-y-5">
            <div>
              <p className="text-xs font-semibold uppercase text-[var(--color-ink-faint)]">Configured target</p>
              <p className="tnum mt-1 text-2xl font-semibold text-[var(--color-ink)]">{formatMoney(financial.totals.masser)}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase text-[var(--color-ink-faint)]">Ledger obligation</p>
              <p className="tnum mt-1 text-2xl font-semibold text-[var(--color-ink)]">{formatMoney(masserLedgerTarget)}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase text-[var(--color-ink-faint)]">Recorded</p>
              <p className="tnum mt-1 text-xl font-semibold text-[var(--color-success)]">{formatMoney(masserApplied)}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase text-[var(--color-ink-faint)]">Remaining</p>
              <p className="tnum mt-1 text-xl font-semibold text-[var(--color-warn)]">{formatMoney(masserRemaining)}</p>
            </div>
          </div>
          <p className="mt-5 text-xs leading-5 text-[var(--color-ink-soft)]">
            Masser is the named Annual set-aside. One obligation is generated for each yearly budget period; the configured target and ledger obligation should agree.
          </p>
          {settlements.freshness.dirty ? (
            <p className="mt-3 flex items-start gap-2 text-xs font-medium text-[var(--color-danger)]">
              <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
              Payment balances are out of date. Refresh them before acting on the remaining amount.
            </p>
          ) : null}
          <Link href="/settlements" className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--color-primary)] hover:underline">
            Open payments <ArrowRight size={15} aria-hidden />
          </Link>
        </section>
      </div>

      <section aria-labelledby="data-health-heading" className="border-t border-[var(--color-rule-strong)] pt-8">
        <SectionHeading id="data-health-heading" title="Data health" context="Freshness, imports, controls, and unresolved decisions" />
        <div className="grid divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] lg:grid-cols-4 lg:divide-x lg:divide-y-0">
          <DataHealthRow
            icon={settlements.freshness.dirty ? RefreshCw : ShieldCheck}
            label="Payment ledger"
            value={settlements.freshness.dirty ? "Refresh required" : "Current"}
            detail={settlements.freshness.lastRefreshError ?? `Last refreshed ${readableTimestamp(settlements.freshness.lastRefreshedAt)}`}
            tone={settlements.freshness.dirty ? "danger" : "good"}
            href="/settlements"
          />
          <DataHealthRow
            icon={Database}
            label="Latest import"
            value={latestImport?.filename ?? "No imports yet"}
            detail={latestImport ? `${latestImport.status.replaceAll("_", " ")} | ${latestImport.importedRows.toLocaleString()} rows | ${readableDate(latestImport.committedAt ?? latestImport.uploadedAt)}` : "Import a source workbook to begin."}
            tone={latestImport && latestImport.errorRows > 0 ? "danger" : latestImport ? "good" : "info"}
            href={latestImport ? `/imports/${latestImport.fileId}` : "/imports"}
          />
          <DataHealthRow
            icon={reconciliationTone === "good" ? ShieldCheck : TriangleAlert}
            label="Latest reconciliation"
            value={reconciliationValue}
            detail={reconciliationDetail}
            tone={reconciliationTone}
            href="/reconciliation"
          />
          <DataHealthRow
            icon={reviewTotal > 0 ? TriangleAlert : ShieldCheck}
            label="Review queue"
            value={reviewTotal > 0 ? `${reviewTotal.toLocaleString()} open` : "Clear"}
            detail={reviewTotal > 0 ? "Identity, configuration, group, or source differences need review." : "No unresolved data decisions."}
            tone={reviewTotal > 0 ? "warn" : "good"}
            href="/review"
          />
        </div>
      </section>
    </>
  );
}
