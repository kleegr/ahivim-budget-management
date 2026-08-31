import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  GraduationCap,
  HandCoins,
  Users,
  WalletCards,
} from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listIndividualBudgetBoard } from "@/lib/data/queries";
import { listProgramBudgets } from "@/lib/data/program-budgets";
import { listTransactionsForGrid } from "@/lib/data/transactions-grid";
import { listStrategies } from "@/lib/manage/calculation-strategies";
import {
  buildOwnerActivityFilterOptions,
  buildOwnerDashboardSummary,
  normalizeOwnerActivitySelection,
} from "@/lib/dashboard/owner-summary";
import { agencyDate } from "@/lib/business/agency-time";
import { dec, formatHours } from "@/lib/money";
import { ErrorPanel, PageHeader } from "@/components/ui";
import GoogleSheetSyncButton from "@/components/sync/google-sheet-sync-button";
import OwnerDashboard from "@/components/dashboard/owner-dashboard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Home - Ahivim" };

type HomeLink = {
  href: string;
  label: string;
  detail: string;
  icon: LucideIcon;
};

const PRIMARY_LINKS: HomeLink[] = [
  {
    href: "/individuals",
    label: "People & budgets",
    detail: "Find a person, see hours left, or update a budget.",
    icon: WalletCards,
  },
  {
    href: "/schedule",
    label: "Schedule",
    detail: "See the calendar and plan upcoming work.",
    icon: CalendarDays,
  },
  {
    href: "/masser",
    label: "Masser",
    detail: "Record payments, collections, and set-asides.",
    icon: HandCoins,
  },
  {
    href: "/employees",
    label: "Employees",
    detail: "Find an employee, assignment, or pay arrangement.",
    icon: Users,
  },
];

const SECONDARY_LINKS: HomeLink[] = [
  {
    href: "/classes",
    label: "Classes",
    detail: "Class budgets and invoices.",
    icon: GraduationCap,
  },
  {
    href: "/reports",
    label: "Reports",
    detail: "View or export a report.",
    icon: BarChart3,
  },
];

function HomeDestination({ href, label, detail, icon: Icon }: HomeLink) {
  return (
    <Link
      href={href}
      className="group flex min-h-24 items-center gap-4 border-t border-[var(--color-rule)] px-1 py-4 first:border-t-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">
          {label}
        </span>
        <span className="mt-0.5 block text-sm leading-5 text-[var(--color-ink-soft)]">{detail}</span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-[var(--color-ink-faint)] group-hover:text-[var(--color-primary)]" aria-hidden />
    </Link>
  );
}

function HeadlineNumber({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-4 py-4 first:pl-0 last:pr-0 sm:px-5">
      <p className="tnum text-2xl font-semibold text-[var(--color-ink)]">{value}</p>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{label}</p>
    </div>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("manager");
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const denied = params.denied;
  const today = agencyDate();

  if (user.role === "admin") {
    const activitySelection = normalizeOwnerActivitySelection({
      checkDateFrom: one(params.from) ?? null,
      checkDateTo: one(params.to) ?? null,
      individualIds: Array.isArray(params.individualId)
        ? params.individualId
        : params.individualId
          ? [params.individualId]
          : [],
      employeeId: one(params.employeeId) ?? null,
      payrollPeriod: one(params.payrollPeriod) ?? null,
    });
    const ownerResult = await withDb(async (pool) => {
      const [transactions, programBudgets, budgetBoard, strategyResult] = await Promise.all([
        listTransactionsForGrid(pool),
        listProgramBudgets(pool, { status: "active", asOf: today }),
        listIndividualBudgetBoard(pool, new Date(`${today}T12:00:00Z`)),
        listStrategies(pool),
      ]);
      return {
        summary: buildOwnerDashboardSummary({
          transactions,
          programBudgets,
          budgetBoard,
          strategies: strategyResult.rows,
          activitySelection,
        }),
        activityOptions: buildOwnerActivityFilterOptions(transactions),
      };
    });

    if (!ownerResult.ok) {
      return (
        <>
          <PageHeader eyebrow="Ahivim" title="Owner overview" action={<GoogleSheetSyncButton />} />
          <ErrorPanel title="Owner overview could not load">
            Refresh the page and try again.
          </ErrorPanel>
        </>
      );
    }

    return (
      <OwnerDashboard
        summary={ownerResult.data.summary}
        denied={Boolean(denied)}
        activitySelection={activitySelection}
        activityOptions={ownerResult.data.activityOptions}
      />
    );
  }

  const result = await withDb(async (pool) => {
    const [budgets, openMoneyResult] = await Promise.all([
      listIndividualBudgetBoard(pool, new Date(`${today}T12:00:00Z`)),
      pool.query<{ open_count: string }>(
        `WITH applied AS (
           SELECT settlement_obligation_id, COALESCE(sum(amount), 0) AS amount
             FROM settlement_events
            GROUP BY settlement_obligation_id
         )
         SELECT count(*) FILTER (
                  WHERE o.status = 'active'
                    AND abs(o.original_amount - COALESCE(applied.amount, 0)) > 0.005
                )::text AS open_count
           FROM settlement_obligations o
           LEFT JOIN applied ON applied.settlement_obligation_id = o.id`,
      ),
    ]);
    return {
      budgets,
      openMoneyItems: Number(openMoneyResult.rows[0]?.open_count ?? 0),
    };
  });

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="Ahivim" title="Home" />
        <ErrorPanel title="Home could not load">
          Refresh the page and try again.
        </ErrorPanel>
      </>
    );
  }

  const activePeople = result.data.budgets.filter((row) => row.status === "active" && !row.archived);
  const activeBudgets = activePeople.filter((row) => row.budget);
  const hoursRemaining = activeBudgets.reduce(
    (total, row) => total.plus(Math.max(0, row.budget?.hoursLeft ?? 0)),
    dec(0),
  );

  return (
    <>
      <PageHeader
        eyebrow="Ahivim"
        title="Home"
        description="Choose what you want to do."
        action={<GoogleSheetSyncButton />}
      />

      {denied ? (
        <p role="status" className="mb-5 border-l-2 border-[var(--color-info)] bg-[var(--color-info-soft)] px-3 py-2 text-sm text-[var(--color-ink-soft)]">
          That page is not part of your access. You are back on Home.
        </p>
      ) : null}

      <section aria-labelledby="start-heading">
        <h2 id="start-heading" className="display text-lg font-semibold text-[var(--color-ink)]">What do you want to do?</h2>
        <div className="mt-3 grid gap-x-8 border-y border-[var(--color-rule-strong)] md:grid-cols-2">
          {PRIMARY_LINKS.map((item) => <HomeDestination key={item.href} {...item} />)}
        </div>
      </section>

      <section aria-labelledby="snapshot-heading" className="mt-9">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="snapshot-heading" className="display text-lg font-semibold text-[var(--color-ink)]">At a glance</h2>
          <span className="text-xs text-[var(--color-ink-faint)]">Today</span>
        </div>
        <div className="mt-3 grid grid-cols-2 divide-x divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] lg:grid-cols-4 lg:divide-y-0">
          <HeadlineNumber label="Active people" value={activePeople.length.toLocaleString()} />
          <HeadlineNumber label="Active budgets" value={activeBudgets.length.toLocaleString()} />
          <HeadlineNumber label="Hours remaining" value={formatHours(hoursRemaining)} />
          <HeadlineNumber label="Open money items" value={result.data.openMoneyItems.toLocaleString()} />
        </div>
      </section>

      <section aria-labelledby="other-heading" className="mt-9">
        <h2 id="other-heading" className="display text-lg font-semibold text-[var(--color-ink)]">More</h2>
        <div className="mt-3 grid gap-x-8 border-y border-[var(--color-rule-strong)] md:grid-cols-2">
          {SECONDARY_LINKS.map((item) => <HomeDestination key={item.href} {...item} />)}
        </div>
      </section>
    </>
  );
}
