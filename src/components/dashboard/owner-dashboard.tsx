import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CalendarPlus,
  Calculator,
  CheckCircle2,
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
  buildOwnerAttentionItems,
  type OwnerActivityFilterOptions,
  type OwnerActivitySelection,
  type OwnerAttentionItem,
  type OwnerDashboardSummary,
} from "@/lib/dashboard/owner-summary";
import { formatHours, formatMoney } from "@/lib/money";
import type { GridView } from "@/lib/manage/grid-views";
import { getAgencyFinancialReport, type AgencyFinancialReport } from "@/lib/data/agency-financial-report";
import { getSettlementDashboard } from "@/lib/data/settlements";
import { getOwnerScheduleAttention } from "@/lib/dashboard/owner-schedule-attention";
import { withDb } from "@/lib/data/pool";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";

export interface OwnerActualMoney {
  month: string;
  totals: AgencyFinancialReport["totals"];
}

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

function OwnerAttentionSection({
  items,
  unavailableSources = [],
}: {
  items: OwnerAttentionItem[];
  unavailableSources?: string[];
}) {
  return (
    <section aria-labelledby="owner-attention-heading">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[var(--color-warn-soft)] text-[var(--color-warn)]">
          <AlertTriangle aria-hidden className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="eyebrow text-[var(--color-ink-faint)]">Owner follow-up</p>
          <h2 id="owner-attention-heading" className="display mt-1 text-xl font-semibold text-[var(--color-ink)]">Needs attention</h2>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">Start with work that can affect a person, a schedule, a check, or current cash.</p>
        </div>
      </div>

      {items.length > 0 ? (
        <div className="mt-4 divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)]">
          {items.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className="group grid min-h-16 gap-1 px-1 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] sm:grid-cols-[5.5rem_minmax(0,1fr)_auto] sm:items-center sm:gap-4"
            >
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">{item.category}</span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{item.title}</span>
                <span className="mt-0.5 block text-xs leading-5 text-[var(--color-ink-soft)]">{item.detail}</span>
              </span>
              <span className="mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-primary)] sm:mt-0 sm:justify-self-end">
                {item.action}
                <ArrowRight aria-hidden className="h-3.5 w-3.5" />
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="mt-4 flex min-h-16 items-center gap-3 border-y border-[var(--color-rule-strong)] px-1 py-3 text-sm text-[var(--color-ink-soft)]">
          <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0 text-[var(--color-success)]" />
          <p>
            No follow-up appears in the budget, schedule, check, money, or financial setup data loaded on Home.
          </p>
        </div>
      )}
      {unavailableSources.length > 0 ? (
        <p role="status" className="mt-2 text-xs text-[var(--color-ink-faint)]">
          {unavailableSources.join(" and ")} {unavailableSources.length === 1 ? "is" : "are"} temporarily unavailable; the follow-up shown above is still current.
        </p>
      ) : null}
    </section>
  );
}

function OwnerAttentionLoading() {
  return (
    <section aria-labelledby="owner-attention-heading">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[var(--color-warn-soft)] text-[var(--color-warn)]">
          <AlertTriangle aria-hidden className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="eyebrow text-[var(--color-ink-faint)]">Owner follow-up</p>
          <h2 id="owner-attention-heading" className="display mt-1 text-xl font-semibold text-[var(--color-ink)]">Needs attention</h2>
        </div>
      </div>
      <div role="status" aria-live="polite" className="mt-4 min-h-16 border-y border-[var(--color-rule-strong)] px-1 py-4 text-sm text-[var(--color-ink-soft)]">
        Loading current follow-up...
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

async function OwnerAttentionData({
  today,
  summary,
}: {
  today: string;
  summary: OwnerDashboardSummary;
}) {
  const [settlementResult, scheduleResult] = await Promise.all([
    withDb((pool) => readOnlySnapshot(pool, (client) => getSettlementDashboard(client))),
    withDb((pool) => getOwnerScheduleAttention(pool, today)),
  ]);
  const unavailableSources = [
    settlementResult.ok ? null : "Current money and check status",
    scheduleResult.ok ? null : "Upcoming schedule status",
  ].filter((value): value is string => value !== null);

  return (
    <OwnerAttentionSection
      items={buildOwnerAttentionItems(
        summary,
        settlementResult.ok ? settlementResult.data.summary : undefined,
        settlementResult.ok ? settlementResult.data.checkIssues.length : 0,
        scheduleResult.ok ? scheduleResult.data : undefined,
      )}
      unavailableSources={unavailableSources}
    />
  );
}

async function OwnerActualMoneySection({ month }: { month: string }) {
  const result = await withDb((pool) => readOnlySnapshot(
    pool,
    async (client) => {
      const report = await getAgencyFinancialReport(client, month);
      return { month: report.month, totals: report.totals } satisfies OwnerActualMoney;
    },
  ));

  if (!result.ok) {
    return (
      <OwnerMoneyShell month={month}>
        <div role="alert" className="mt-4 flex min-h-24 flex-wrap items-center justify-between gap-3 border-y border-[var(--color-rule-strong)] px-3 py-4 text-sm">
          <p className="text-[var(--color-ink-soft)]">Actual income, expenses, and result are temporarily unavailable. The rest of Home is still current.</p>
          <ButtonLink href="/dashboard">Try again</ButtonLink>
        </div>
      </OwnerMoneyShell>
    );
  }

  const actualMoney = result.data;
  return (
    <OwnerMoneyShell month={actualMoney.month}>
      <div className="mt-4 grid grid-cols-1 divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <SummaryMetric
          label="Actual income"
          value={formatMoney(actualMoney.totals.income.total)}
          href={`/reports/agency-financials?month=${actualMoney.month}`}
          hint="Transactions and recorded receipts"
        />
        <SummaryMetric
          label="Actual expenses"
          value={formatMoney(actualMoney.totals.expenses.total)}
          href={`/reports/agency-financials?month=${actualMoney.month}`}
          hint="Set-asides, taxes, and shares"
        />
        <SummaryMetric
          label="Agency result"
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
      href: "/individuals?view=attention",
      label: "Review budget follow-up",
      detail: "Open the people who need a budget or renewal decision.",
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
          <select className={fieldClass} name="employeeId" defaultValue={selection.employeeId ?? ""}>
            <option value="">All employees</option>
            {options.employees.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
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
                  <span className="tnum mt-1 block text-sm font-semibold text-[var(--color-ink)]">{formatMoney(check.funderBilled)}</span>
                </span>
                <span>
                  <span className="block text-[0.68rem] font-semibold uppercase text-[var(--color-ink-faint)]">Employee base</span>
                  <span className="tnum mt-1 block text-sm font-semibold text-[var(--color-ink)]">{formatMoney(check.employeeBase)}</span>
                </span>
                <span>
                  <span className="block text-[0.68rem] font-semibold uppercase text-[var(--color-ink-faint)]">Agency spread</span>
                  <span className="tnum mt-1 block text-sm font-semibold text-[var(--color-ink)]">{formatMoney(check.agencySpread)}</span>
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

export default function OwnerDashboard({
  summary,
  activitySelection,
  activityOptions,
  savedViews,
  financialMonth,
  today,
}: {
  summary: OwnerDashboardSummary;
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

  return (
    <>
      <PageHeader
        eyebrow="Ahivim"
        title="Home"
        description="See what needs attention, take the next action, and keep budgets, checks, and money moving."
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

      <div className="space-y-12">
        <Suspense fallback={<OwnerAttentionLoading />}>
          <OwnerAttentionData today={today} summary={summary} />
        </Suspense>
        <OwnerQuickActions />
        <Suspense fallback={<OwnerMoneyLoading month={financialMonth} />}>
          <OwnerActualMoneySection month={financialMonth} />
        </Suspense>

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
          <div className="mt-4 grid grid-cols-2 divide-x divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] md:grid-cols-3 xl:grid-cols-5 xl:divide-y-0">
            <SummaryMetric label="Funder billed" value={formatMoney(transactions.contextTotals.gross)} href={transactions.contextHref} />
            <SummaryMetric label="Employee base" value={formatMoney(transactions.contextTotals.internal)} href={transactions.contextHref} />
            <SummaryMetric label="Agency spread" value={formatMoney(transactions.contextTotals.agencyAdditional)} href={transactions.contextHref} />
            <SummaryMetric label="Net payroll" value={formatMoney(transactions.contextTotals.netPerCheck)} href={transactions.contextHref} hint="Counted once per payment" />
            <SummaryMetric label="Hours" value={formatHours(transactions.contextTotals.hours)} href={transactions.contextHref} />
          </div>
          <RecentChecks checks={transactions.recentChecks} selected={selected} />
        </section>

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
          <div className="mt-4 grid grid-cols-2 divide-x divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] md:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
            <SummaryMetric label="People" value={budgets.people.toLocaleString()} href="/individuals?budget=with" hint="With active authorizations" />
            <SummaryMetric label="Authorizations" value={budgets.authorizations.toLocaleString()} href="/individuals?budget=with" />
            <SummaryMetric label="Hours authorized" value={formatHours(budgets.authorizedHours)} href="/individuals" />
            <SummaryMetric label="Hours used" value={formatHours(budgets.usedHours)} href="/individuals" />
            <SummaryMetric label="Hours remaining" value={formatHours(budgets.remainingHours)} href="/individuals" />
            <SummaryMetric
              label="Billing without budget"
              value={budgets.billingWithoutBudget.toLocaleString()}
              href="/individuals?view=billing_without_budget"
            />
          </div>
        </section>

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

      </div>
    </>
  );
}
