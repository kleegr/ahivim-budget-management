import { formatKnownMoneyTotal } from "@/lib/business/transaction-totals";
import SearchableSelect from "@/components/manage/searchable-select";
import { ReloadButton } from "@/components/ui-client";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CalendarPlus,
  Calculator,
  Filter,
  HandCoins,
  ReceiptText,
  RotateCcw,
  UserRoundCog,
  WalletCards,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import GoogleSheetSyncButton from "@/components/sync/google-sheet-sync-button";
import OwnerPeopleMultiSelect from "@/components/dashboard/owner-people-multi-select";
import OwnerSavedViews from "@/components/dashboard/owner-saved-views";
import { ButtonLink, PageHeader } from "@/components/ui";
import {
  buildOwnerActualMoney,
  type OwnerActivityFilterOptions,
  type OwnerActivitySelection,
  type OwnerDashboardSummary,
} from "@/lib/dashboard/owner-summary";
import { formatHours, formatMoney } from "@/lib/money";
import type { GridView } from "@/lib/manage/grid-views";
import { getAgencyFinancialReport } from "@/lib/data/agency-financial-report";
import { getSettlementDashboard } from "@/lib/data/settlements";
import { getOwnerScheduleAttention } from "@/lib/dashboard/owner-schedule-attention";
import { getOperationalReviewSummary } from "@/lib/data/operational-review";
import { withDb } from "@/lib/data/pool";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";

const LONG_DATE = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const SHORT_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const MONTH_DATE = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(value: string | null, formatter = SHORT_DATE): string {
  return value
    ? formatter.format(new Date(`${value}T00:00:00Z`))
    : "No check date";
}

async function readOnlySnapshot<T>(
  pool: PgLikePool,
  read: (client: PgLikeClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const value = await read(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function SectionHeading({
  id,
  eyebrow,
  title,
  description,
  href,
  action,
  icon: Icon,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  action: string;
  icon: LucideIcon;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
          <Icon aria-hidden className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="eyebrow text-[var(--color-ink-faint)]">{eyebrow}</p>
          <h2 id={id} className="display mt-1 text-xl font-semibold text-[var(--color-ink)]">{title}</h2>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{description}</p>
        </div>
      </div>
      <ButtonLink href={href}>
        {action}
        <ArrowRight aria-hidden className="h-4 w-4" />
      </ButtonLink>
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  href,
  hint,
}: {
  label: string;
  value: string;
  href: string;
  hint?: string;
}) {
  return (
    <Link
      href={href}
      className="group min-h-24 px-3 py-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
    >
      <span className="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--color-ink-soft)]">
        {label}
        <ArrowRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--color-ink-faint)] group-hover:text-[var(--color-primary)]" />
      </span>
      <span className="tnum mt-2 block text-xl font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">
        {value}
      </span>
      {hint ? <span className="mt-1 block text-xs leading-4 text-[var(--color-ink-faint)]">{hint}</span> : null}
    </Link>
  );
}

interface OwnerReviewGroup {
  key: string;
  title: string;
  detail: string;
  href: string;
  undecided?: { count: number; unit: string; href: string };
}

function OwnerReviewSection({
  groups,
  unavailableSources = [],
}: {
  groups: OwnerReviewGroup[];
  unavailableSources?: string[];
}) {
  return (
    <section aria-labelledby="owner-attention-heading">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
          <AlertTriangle aria-hidden className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="eyebrow text-[var(--color-ink-faint)]">Review</p>
          <h2 id="owner-attention-heading" className="display mt-1 text-xl font-semibold text-[var(--color-ink)]">Needs attention</h2>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">Resolve the matters affecting planning or money. Optional setup is listed separately.</p>
        </div>
      </div>

      <div className="mt-4 grid divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] md:grid-cols-2 md:divide-y-0">
        {groups.map((group, index) => (
          <div
            key={group.key}
            className={`min-w-0 border-[var(--color-rule)] py-3 md:py-4 ${index % 2 ? "md:border-l md:pl-5" : "md:pr-5"} ${index > 1 ? "md:border-t" : ""}`}
          >
            <Link
              href={group.href}
              className="group flex min-h-12 items-start justify-between gap-3 px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
            >
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{group.title}</span>
                <span className="mt-1 block text-xs leading-5 text-[var(--color-ink-soft)]">{group.detail}</span>
              </span>
              <ArrowRight aria-hidden className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--color-primary)]" />
            </Link>
          </div>
        ))}
      </div>
      {unavailableSources.length > 0 ? (
        <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-[var(--color-ink-soft)]">
            {unavailableSources.join(" and ")} could not be loaded. The review summary is incomplete.
          </p>
          <ButtonLink href="/dashboard">Try again</ButtonLink>
        </div>
      ) : null}
    </section>
  );
}

function OwnerAttentionLoading() {
  return (
    <section aria-labelledby="owner-attention-heading">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
          <AlertTriangle aria-hidden className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="eyebrow text-[var(--color-ink-faint)]">Review</p>
          <h2 id="owner-attention-heading" className="display mt-1 text-xl font-semibold text-[var(--color-ink)]">Needs attention</h2>
        </div>
      </div>
      <div role="status" aria-live="polite" className="mt-4 min-h-16 border-y border-[var(--color-rule-strong)] px-1 py-4 text-sm text-[var(--color-ink-soft)]">
        Loading review summary...
      </div>
    </section>
  );
}

function OwnerMoneyShell({ month, children }: { month: string; children: ReactNode }) {
  return (
    <section aria-labelledby="owner-money-heading">
      <SectionHeading
        id="owner-money-heading"
        eyebrow="Actual money"
        title="Money"
        description={`${MONTH_DATE.format(new Date(`${month}-01T00:00:00Z`))} actual income, counted expenses, and agency result from exact source records.`}
        href={`/reports/agency-financials?month=${month}`}
        action="Open agency financials"
        icon={HandCoins}
      />
      {children}
      <p className="mt-2 text-xs text-[var(--color-ink-soft)]">Approved set-asides are included in expense detail. Issued invoices are separate from cash received.</p>
    </section>
  );
}

function OwnerMoneyLoading({ month }: { month: string }) {
  return (
    <OwnerMoneyShell month={month}>
      <div
        role="status"
        aria-live="polite"
        className="mt-4 min-h-24 border-y border-[var(--color-rule-strong)] px-3 py-4 text-sm text-[var(--color-ink-soft)]"
      >
        Loading actual money...
      </div>
    </OwnerMoneyShell>
  );
}

export async function OwnerReviewData({ today }: { today: string }) {
  const [settlementResult, scheduleResult, reviewResult] = await Promise.all([
    withDb((pool) => readOnlySnapshot(pool, (client) => getSettlementDashboard(client))),
    withDb((pool) => getOwnerScheduleAttention(pool, today)),
    withDb((pool) => getOperationalReviewSummary(pool, today)),
  ]);
  const unavailableSources = [
    reviewResult.ok ? null : "People and employee review status",
    settlementResult.ok ? null : "Current money and check status",
    scheduleResult.ok ? null : "Upcoming schedule status",
  ].filter((value): value is string => value !== null);
  const review = reviewResult.ok ? reviewResult.data : null;
  const money = settlementResult.ok ? settlementResult.data : null;
  const schedule = scheduleResult.ok ? scheduleResult.data : null;
  const groups: OwnerReviewGroup[] = [
    {
      key: "individuals",
      title: "Review program authorizations",
      detail: review
        ? `${review.individuals.toLocaleString()} ${review.individuals === 1 ? "individual" : "individuals"} with detected issues`
        : "Review status unavailable",
      href: "/individuals?review=needs_review",
      undecided: review ? {
        count: review.undecidedIndividuals,
        unit: review.undecidedIndividuals === 1 ? "individual" : "individuals",
        href: "/individuals?management=undecided",
      } : undefined,
    },
    {
      key: "employees",
      title: "Review employee arrangements",
      detail: review
        ? `${review.employees.toLocaleString()} ${review.employees === 1 ? "employee" : "employees"} with detected issues`
        : "Review status unavailable",
      href: "/employees?review=needs_review",
      undecided: review ? {
        count: review.undecidedEmployees,
        unit: review.undecidedEmployees === 1 ? "employee" : "employees",
        href: "/employees?management=undecided",
      } : undefined,
    },
    {
      key: "schedule",
      title: "Schedule",
      detail: !schedule
        ? "Upcoming schedule status unavailable"
        : schedule.conflictCount > 0 && schedule.unassignedCount > 0
          ? "Upcoming visits have conflicts or need staffing."
          : schedule.conflictCount > 0
            ? "Upcoming visits have scheduling conflicts."
            : schedule.unassignedCount > 0
              ? "Upcoming visits need staffing."
              : "Open upcoming visits and staffing coverage.",
      href: schedule?.nextConflict?.href ?? schedule?.nextUnassigned?.href ?? "/schedule?view=calendar",
    },
    {
      key: "money",
      title: "Money & checks",
      detail: !money
        ? "Current money and check status unavailable"
        : money.freshness.dirty
          ? "Current balances are unavailable until refreshed. Review check sources and recorded history."
          : money.rows.some((row) => row.reviewRequired) || (money.freshness.sourceReviewCount ?? 0) > 0
            ? "Some balances are held for review. Open source details before taking action."
            : money.checkIssues.length > 0
              ? "Check source information needs review before money actions."
              : "Open verified balances, check sources, and recorded money actions.",
      href: money?.freshness.dirty ? "/masser" : "/settlements?focus=check-issues",
    },
  ];

  return (
    <OwnerReviewSection
      groups={groups.filter((group) => group.key === "individuals" ? !review || review.individuals > 0 : group.key === "employees" ? !review || review.employees > 0 : group.key === "schedule" ? !schedule || schedule.conflictCount > 0 || schedule.unassignedCount > 0 : !money || money.freshness.dirty || money.checkIssues.length > 0 || money.rows.some((row) => row.reviewRequired))}
      unavailableSources={unavailableSources}
    />
  );
}

async function OwnerActualMoneySection({ month }: { month: string }) {
  const result = await withDb((pool) => readOnlySnapshot(
    pool,
    async (client) => {
      const report = await getAgencyFinancialReport(client, month);
      return buildOwnerActualMoney(report);
    },
  ));

  if (!result.ok) {
    return (
      <OwnerMoneyShell month={month}>
        <div role="alert" className="mt-4 flex min-h-24 flex-wrap items-center justify-between gap-3 border-y border-[var(--color-rule-strong)] px-3 py-4 text-sm">
          <p className="text-[var(--color-ink-soft)]">Actual income, expenses, and result are temporarily unavailable.</p>
          <ButtonLink href="/dashboard">Try again</ButtonLink>
        </div>
      </OwnerMoneyShell>
    );
  }

  const actualMoney = result.data;
  return (
    <OwnerMoneyShell month={actualMoney.month}>
      {actualMoney.incomplete ? (
        <p role="status" className="mt-4 text-sm text-[var(--color-warn)]">
          Some amounts are missing or need review. This result is incomplete.{" "}
          <Link className="font-semibold underline" href={`/reports/agency-financials?month=${actualMoney.month}`}>
            Review source details
          </Link>
        </p>
      ) : null}
      <div className="mt-4 grid grid-cols-1 divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <SummaryMetric
          label="Actual income"
          value={formatMoney(actualMoney.totals.income.total)}
          href={`/reports/agency-financials?month=${actualMoney.month}`}
          hint="Transactions and recorded receipts"
        />
        <SummaryMetric
          label="Counted expenses"
          value={formatMoney(actualMoney.totals.expenses.total)}
          href={`/reports/agency-financials?month=${actualMoney.month}`}
          hint="Set-asides, taxes, and shares"
        />
        <SummaryMetric
          label={actualMoney.incomplete ? "Agency result (incomplete)" : "Agency result"}
          value={formatMoney(actualMoney.totals.agencyResult)}
          href={`/reports/agency-financials?month=${actualMoney.month}`}
          hint="Income minus listed expenses"
        />
      </div>
    </OwnerMoneyShell>
  );
}

function OwnerQuickActions() {
  const actions = [
    {
      href: "/individuals?review=needs_review",
      label: "Review people & budgets",
      detail: "Open the people with detected setup or budget issues.",
      icon: WalletCards,
    },
    {
      href: "/schedule?view=calendar",
      label: "Plan a visit",
      detail: "Open the working calendar to add or change service.",
      icon: CalendarPlus,
    },
    {
      href: "/masser",
      label: "Open Masser",
      detail: "Collect, pay, or put away money.",
      icon: HandCoins,
    },
    {
      href: "/settings#access",
      label: "Users and role preview",
      detail: "Create an account or verify what a user will see.",
      icon: UserRoundCog,
    },
  ] as const;

  return (
    <section aria-labelledby="owner-quick-actions-heading">
      <h2 id="owner-quick-actions-heading" className="display text-lg font-semibold text-[var(--color-ink)]">Quick actions</h2>
      <nav aria-label="Owner quick actions" className="mt-3 grid gap-x-6 border-y border-[var(--color-rule-strong)] md:grid-cols-2 xl:grid-cols-4">
        {actions.map(({ href, label, detail, icon: Icon }, index) => (
          <Link
            key={href}
            href={href}
            className={`group flex min-h-20 items-center gap-3 px-1 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] ${
              index > 0 ? "border-t border-[var(--color-rule)] md:[&:nth-child(2)]:border-t-0 md:[&:nth-child(even)]:pl-4 xl:border-l xl:border-t-0" : ""
            }`}
          >
            <Icon aria-hidden className="h-5 w-5 shrink-0 text-[var(--color-primary)]" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{label}</span>
              <span className="mt-0.5 block text-xs leading-5 text-[var(--color-ink-soft)]">{detail}</span>
            </span>
            <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-[var(--color-ink-faint)] group-hover:text-[var(--color-primary)]" />
          </Link>
        ))}
      </nav>
    </section>
  );
}

function ActivityFilters({
  selection,
  options,
  savedViews,
}: {
  selection: OwnerActivitySelection;
  options: OwnerActivityFilterOptions;
  savedViews: GridView[];
}) {
  const active = Boolean(
    selection.checkDateFrom
      || selection.checkDateTo
      || selection.individualIds.length > 0
      || selection.employeeId
      || selection.payrollPeriod,
  );
  const fieldClass = "input mt-1 min-h-10 w-full text-sm";

  return (
    <div className="mt-5 border-y border-[var(--color-rule-strong)] py-4">
      <form action="/dashboard" method="get" aria-label="Filter actual activity">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="min-w-0 text-xs font-semibold text-[var(--color-ink-soft)]">
          Check date from
          <input className={fieldClass} type="date" name="from" defaultValue={selection.checkDateFrom ?? ""} />
        </label>
        <label className="min-w-0 text-xs font-semibold text-[var(--color-ink-soft)]">
          Check date to
          <input className={fieldClass} type="date" name="to" defaultValue={selection.checkDateTo ?? ""} />
        </label>
        <OwnerPeopleMultiSelect options={options.individuals} selected={selection.individualIds} />
        <label className="min-w-0 text-xs font-semibold text-[var(--color-ink-soft)]">
          Employee
          <SearchableSelect label="employees" className={fieldClass} name="employeeId" defaultValue={selection.employeeId ?? ""} options={options.employees} placeholder="All employees" />
        </label>
        <label className="min-w-0 text-xs font-semibold text-[var(--color-ink-soft)]">
          Payroll period
          <select className={fieldClass} name="payrollPeriod" defaultValue={selection.payrollPeriod ?? ""}>
            <option value="">All periods</option>
            {options.payrollPeriods.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-primary">
          <Filter aria-hidden className="h-4 w-4" /> Apply
        </button>
        {active ? (
          <Link href="/dashboard" className="btn btn-secondary">
            <RotateCcw aria-hidden className="h-4 w-4" /> Clear
          </Link>
        ) : null}
      </div>
      </form>
      <OwnerSavedViews selection={selection} views={savedViews} />
    </div>
  );
}

function RecentChecks({
  checks,
  selected,
}: {
  checks: OwnerDashboardSummary["transactions"]["recentChecks"];
  selected: boolean;
}) {
  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-[var(--color-ink)]">
        {selected ? "Payroll activity in this selection" : "Recent payroll activity"}
      </h3>
      {checks.length === 0 ? (
        <p className="mt-3 border-y border-[var(--color-rule)] py-5 text-sm text-[var(--color-ink-soft)]">
          No check-dated transactions yet.
        </p>
      ) : (
        <div className="mt-3 border-y border-[var(--color-rule-strong)]">
          {checks.map((check) => {
            const recipient = check.payTo ?? check.employee ?? "Unknown recipient";
            const employee = check.employee && check.employee !== recipient ? check.employee : null;
            const details = [
              employee,
              check.netPay ? `Net pay ${formatMoney(check.netPay)}` : null,
              `${formatHours(check.hours)} hours`,
              `${check.individuals.toLocaleString()} ${check.individuals === 1 ? "person" : "people"}`,
              `${check.programs.toLocaleString()} ${check.programs === 1 ? "program" : "programs"}`,
            ].filter(Boolean).join(" · ");
            return (
              <Link
                key={check.key}
                href={check.href}
                className="group grid min-h-20 grid-cols-2 gap-x-4 gap-y-3 border-t border-[var(--color-rule)] px-1 py-3 first:border-t-0 md:grid-cols-[minmax(13rem,1.45fr)_repeat(3,minmax(7rem,0.75fr))_1.25rem] md:items-center"
              >
                <span className="col-span-2 min-w-0 md:col-span-1">
                  <span className="block text-sm font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">
                    {check.checkNumber ? `Check ${check.checkNumber}` : "No check number"}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--color-ink-soft)]">
                    {formatDate(check.checkDate)} · Paid to {recipient}
                  </span>
                  <span className="mt-0.5 block text-xs text-[var(--color-ink-faint)]">
                    {details}
                  </span>
                </span>
                <span>
                  <span className="block text-[0.68rem] font-semibold uppercase text-[var(--color-ink-faint)]">Funder billed</span>
                  <span className="tnum mt-1 block text-sm font-semibold text-[var(--color-ink)]">{check.funderBilled === null ? "Unavailable" : `${formatMoney(check.funderBilled)}${check.completeness.funderBilled.missing > 0 ? " · incomplete subtotal" : ""}`}</span>
                </span>
                <span>
                  <span className="block text-[0.68rem] font-semibold uppercase text-[var(--color-ink-faint)]">Employee base</span>
                  <span className="tnum mt-1 block text-sm font-semibold text-[var(--color-ink)]">{check.employeeBase === null ? "Unavailable" : `${formatMoney(check.employeeBase)}${check.completeness.employeeBase.missing > 0 ? " · incomplete subtotal" : ""}`}</span>
                </span>
                <span>
                  <span className="block text-[0.68rem] font-semibold uppercase text-[var(--color-ink-faint)]">Agency spread</span>
                  <span className="tnum mt-1 block text-sm font-semibold text-[var(--color-ink)]">{check.agencySpread === null ? "Unavailable" : `${formatMoney(check.agencySpread)}${check.completeness.agencySpread.missing > 0 ? " · incomplete subtotal" : ""}`}</span>
                </span>
                <ArrowRight aria-hidden className="hidden h-4 w-4 text-[var(--color-ink-faint)] group-hover:text-[var(--color-primary)] md:block" />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

async function OwnerSourceContext({ month, today }: { month: string; today: string }) {
  const result = await withDb(async (pool) => (await pool.query<{ last_import: string | null; latest_service: string | null; latest_check: string | null }>(`SELECT
    (SELECT max(finished_at)::text FROM sheet_sync_runs WHERE status IN ('success', 'no_changes')) AS last_import,
    (SELECT max(canonical_service_date(period_begin, check_date, period_end))::text FROM payroll_transactions) AS latest_service,
    (SELECT max(check_date)::text FROM payroll_transactions) AS latest_check`)).rows[0]);
  const source = result.ok ? result.data : null;
  return <section aria-label="Home period and source dates" className="mb-6 flex flex-wrap items-end justify-between gap-3 rounded-lg bg-[var(--color-surface-muted)] p-4">
    <form className="flex items-end gap-2" action="/dashboard"><label className="text-sm">Financial period<input className="input mt-1 block" type="month" name="month" defaultValue={month} required /></label><button className="btn btn-secondary" type="submit">Apply</button></form>
    <div className="text-xs text-[var(--color-ink-soft)]"><p>{formatDate(today, LONG_DATE)}</p><p className="mt-1">Import: {source ? source.last_import ? new Date(source.last_import).toLocaleString("en-US", { timeZone: "America/New_York" }) + " Eastern" : "No successful import yet" : "Unavailable"} · Latest check: {source?.latest_check ?? "Unavailable"} · Latest service: {source?.latest_service ?? "Unavailable"}</p><Link className="underline" href="/sync">Import details</Link></div>
  </section>;
}

export default function OwnerDashboard({
  summary,
  unavailableSections = [],
  activitySelection,
  activityOptions,
  savedViews,
  financialMonth,
  today,
}: {
  summary: OwnerDashboardSummary;
  unavailableSections?: string[];
  activitySelection: OwnerActivitySelection;
  activityOptions: OwnerActivityFilterOptions;
  savedViews: GridView[];
  financialMonth: string;
  today: string;
}) {
  const transactions = summary.transactions;
  const budgets = summary.budgets;
  const financial = summary.financial;
  const selected = transactions.mode === "selection";
  const activityContext = selected
    ? transactions.contextTotals.transactions > 0
      ? `${transactions.contextTotals.transactions.toLocaleString()} ${transactions.contextTotals.transactions === 1 ? "row" : "rows"} · ${transactions.contextCheckCount.toLocaleString()} ${transactions.contextCheckCount === 1 ? "check" : "checks"}`
      : null
    : transactions.latestCheckDate
      ? `${formatDate(transactions.latestCheckDate, LONG_DATE)} · ${transactions.contextTotals.transactions.toLocaleString()} ${transactions.contextTotals.transactions === 1 ? "row" : "rows"} · ${transactions.contextCheckCount.toLocaleString()} ${transactions.contextCheckCount === 1 ? "check" : "checks"}`
      : null;
  const reconciliationHint = transactions.contextTotals.moneyExcludedRows > 0
    ? `${transactions.contextTotals.moneyExcludedRows.toLocaleString()} incomplete money ${transactions.contextTotals.moneyExcludedRows === 1 ? "row is" : "rows are"} included where known; incomplete subtotals are labeled.`
    : undefined;

  return (
    <>
      <PageHeader
        eyebrow="Ahivim"
        title="Home"
        description="See actual activity, open a workspace, and review the records that need a correction."
        action={(
          <>
            <ButtonLink href="/reports">
              <BarChart3 aria-hidden className="h-4 w-4" />
              Reports
            </ButtonLink>
            <GoogleSheetSyncButton />
          </>
        )}
      />

      <OwnerSourceContext month={financialMonth} today={today} />
      <div className="space-y-8">
        <Suspense fallback={<OwnerMoneyLoading month={financialMonth} />}>
          <OwnerActualMoneySection month={financialMonth} />
        </Suspense>
        <Suspense fallback={<OwnerAttentionLoading />}>
          <OwnerReviewData today={today} />
        </Suspense>
        <OwnerQuickActions />
        <details className="rounded-lg border border-[var(--color-rule)] p-4" open={selected || undefined}>
          <summary className="cursor-pointer font-semibold">Activity, budgets, and setup detail</summary>
          <div className="mt-6 space-y-8">
        {unavailableSections.includes("Transactions") ? (
          <section aria-label="Transactions unavailable" className="border-y border-[var(--color-rule)] py-5">
            <h2 className="display text-lg font-semibold">Transactions</h2>
            <p role="status" className="my-3 text-sm text-[var(--color-ink-soft)]">Transactions is unavailable. Other Home sections remain usable.</p>
            <ReloadButton label="Retry transactions" />
          </section>
        ) : (
        <section aria-labelledby="owner-transactions-heading">
          <SectionHeading
            id="owner-transactions-heading"
            eyebrow="Actual activity"
            title="Transactions"
            description={activityContext
              ? selected ? `Selected activity: ${activityContext}` : `Latest check date: ${activityContext}`
              : selected ? "No transactions match this selection." : "No check-dated transactions yet."}
            href={transactions.contextHref}
            action={selected ? "Open selected rows" : "Open transactions"}
            icon={ReceiptText}
          />
          <ActivityFilters selection={activitySelection} options={activityOptions} savedViews={savedViews} />
          {unavailableSections.includes("Saved views") ? <p role="status" className="mt-2 text-sm">Saved views are unavailable. <ReloadButton label="Retry saved views" /></p> : null}
          <div className="mt-4 grid grid-cols-2 divide-x divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] md:grid-cols-3 xl:grid-cols-5 xl:divide-y-0">
            <SummaryMetric label="Funder billed" value={formatKnownMoneyTotal(transactions.contextTotals.amounts.gross)} href={transactions.contextHref} hint={reconciliationHint} />
            <SummaryMetric label="Employee base" value={formatKnownMoneyTotal(transactions.contextTotals.amounts.internal)} href={transactions.contextHref} hint={reconciliationHint} />
            <SummaryMetric label="Agency spread" value={formatKnownMoneyTotal(transactions.contextTotals.amounts.agencyAdditional)} href={transactions.contextHref} hint={reconciliationHint} />
            <SummaryMetric label="Net payroll" value={formatKnownMoneyTotal(transactions.contextTotals.amounts.netPerCheck)} href={transactions.contextHref} hint="Counted once per payment" />
            <SummaryMetric label="Hours" value={formatHours(transactions.contextTotals.hours)} href={transactions.contextHref} />
          </div>
          <RecentChecks checks={transactions.recentChecks} selected={selected} />
        </section>
        )}

        {unavailableSections.includes("Budgets") ? (
          <section aria-label="Budgets unavailable" className="border-y border-[var(--color-rule)] py-5">
            <h2 className="display text-lg font-semibold">Budgets</h2>
            <p role="status" className="my-3 text-sm text-[var(--color-ink-soft)]">Budgets is unavailable. Other Home sections remain usable.</p>
            <ReloadButton label="Retry budgets" />
          </section>
        ) : (
        <section aria-labelledby="owner-budgets-heading">
          <SectionHeading
            id="owner-budgets-heading"
            eyebrow="Budget position"
            title="Budgets"
            description="Authorized, used, and remaining hours across active authorizations."
            href="/individuals"
            action="Open people & budgets"
            icon={WalletCards}
          />
          <div className="mt-4 grid grid-cols-2 divide-x divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] md:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
            <SummaryMetric label="People" value={budgets.people.toLocaleString()} href="/individuals?budget=with" hint="With active authorizations" />
            <SummaryMetric label="Authorizations" value={budgets.authorizations.toLocaleString()} href="/individuals?budget=with" />
            <SummaryMetric label="Hours authorized" value={formatHours(budgets.authorizedHours)} href="/individuals" />
            <SummaryMetric label="Hours used" value={formatHours(budgets.usedHours)} href="/individuals" />
            <SummaryMetric label="Hours remaining" value={formatHours(budgets.remainingHours)} href="/individuals" />
          </div>
        </section>
        )}

        {unavailableSections.includes("Financial setup") ? (
          <section aria-label="Financial setup unavailable" className="border-y border-[var(--color-rule)] py-5">
            <h2 className="display text-lg font-semibold">Financial setup</h2>
            <p role="status" className="my-3 text-sm text-[var(--color-ink-soft)]">Financial setup is unavailable. Other Home sections remain usable.</p>
            <ReloadButton label="Retry financial setup" />
          </section>
        ) : (
        <section aria-labelledby="owner-financial-heading">
          <SectionHeading
            id="owner-financial-heading"
            eyebrow="Financial setup"
            title="Financial setup"
            description="Expected monthly amounts and their sequential-cut calculations."
            href="/calculations"
            action="Open financial setup"
            icon={Calculator}
          />
          <div className="mt-4 grid grid-cols-2 divide-x divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] md:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
            <SummaryMetric label="Current plans" value={financial.strategies.toLocaleString()} href="/calculations" />
            <SummaryMetric label="Yearly gross" value={formatMoney(financial.yearlyGross)} href="/calculations" />
            <SummaryMetric label="Monthly gross" value={formatMoney(financial.monthlyGross)} href="/calculations" />
            <SummaryMetric label="Calculated net" value={formatMoney(financial.calculatedNet)} href="/calculations" />
            <SummaryMetric
              label="Approved final"
              value={formatMoney(financial.approvedFinal)}
              href="/calculations"
              hint={`${financial.approvedStrategies.toLocaleString()} of ${financial.strategies.toLocaleString()} plans set`}
            />
          </div>
        </section>
        )}

          </div>
        </details>
      </div>
    </>
  );
}
