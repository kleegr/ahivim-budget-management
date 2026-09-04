import { requireUser } from "@/lib/auth/session";
import { isPlanningOnlyAccess, resolveAccessScope } from "@/lib/auth/access";
import { redirect } from "next/navigation";
import { withDb } from "@/lib/data/pool";
import { listTransactionsForGrid, type GridTransaction } from "@/lib/data/transactions-grid";
import { PageHeader, ErrorPanel, EmptyState, Card, ButtonLink } from "@/components/ui";
import BilledActivityWorkspace from "@/components/transactions/billed-activity-workspace";
import { transactionFieldVisibility } from "@/lib/auth/money-redaction";
import {
  buildInitialFilters,
  filterTransactionsByCheckIdentity,
} from "@/lib/transactions/initial-filters";
import { RefreshCw } from "lucide-react";
import { listSettlementSourceTransactions } from "@/lib/data/settlement-source-transactions";
import { getActivityReviewSummary } from "@/lib/data/activity-overview";

export const dynamic = "force-dynamic";
export const metadata = { title: "Activity - Ahivim" };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;
const many = (v: string | string[] | undefined): string[] =>
  [...new Set((Array.isArray(v) ? v : v ? [v] : []).filter(Boolean))];

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser("viewer");
  const canManage = user.role !== "viewer";
  const sp = await searchParams;
  const requestedCheckIdentity = one(sp.checkIdentity);
  const requestedTransactionIdsFromUrl = many(sp.transactionId);
  const requestedSettlementSource = one(sp.settlementSource);
  const requestedTransactionId = !requestedSettlementSource && requestedTransactionIdsFromUrl.length === 1
    ? requestedTransactionIdsFromUrl[0]
    : undefined;
  const loadActivityOverview = canManage
    && !requestedSettlementSource
    && requestedTransactionIdsFromUrl.length === 0;

  const result = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    const visibility = transactionFieldVisibility(scope);
    if (!scope.canSeeTransactions) {
      return {
        denied: true as const,
        planningOnly: isPlanningOnlyAccess(scope),
        rows: [] as GridTransaction[],
        visibility,
        canSeeBudgets: scope.canSeeBudgets,
        requestedTransactionIds: [] as string[],
        sourceSelection: null,
        reviewSummary: null,
      };
    }
    const reviewSummaryPromise = loadActivityOverview
      ? getActivityReviewSummary(pool, { includeBudgetMonitoring: false }).catch(() => null)
      : Promise.resolve(null);
    const sourceSelection = requestedSettlementSource
      ? await listSettlementSourceTransactions(pool, scope, requestedSettlementSource)
      : null;
    const requestedTransactionIds = sourceSelection
      ? sourceSelection.transactionIds
      : requestedTransactionIdsFromUrl;
    const [rows, reviewSummary] = await Promise.all([
      sourceSelection
        ? Promise.resolve(sourceSelection.rows)
        : listTransactionsForGrid(pool, scope, {
            transactionIds: requestedTransactionIds,
          }),
      reviewSummaryPromise,
    ]);
    return {
      denied: false as const,
      planningOnly: false,
      rows,
      visibility,
      canSeeBudgets: scope.canSeeBudgets,
      requestedTransactionIds,
      sourceSelection,
      reviewSummary,
    };
  });

  if (result.ok && result.data.planningOnly) redirect("/schedule");

  // A user whose access hides Transactions is refused server-side, not just in the nav.
  if (result.ok && result.data.denied) {
    return (
      <>
        <PageHeader eyebrow="Recorded work" title="Activity" />
        <ErrorPanel title="No access to Activity" action={<ButtonLink href="/home">Back to home</ButtonLink>}>
          Your account doesn&rsquo;t include permission to view recorded services or payroll. Ask an administrator if you need it.
        </ErrorPanel>
      </>
    );
  }

  const allRows = filterTransactionsByCheckIdentity(
    result.ok ? result.data.rows : [],
    requestedCheckIdentity,
  );
  const requestedTransactionIds = result.ok
    ? result.data.requestedTransactionIds
    : requestedTransactionIdsFromUrl;
  const sourceSelection = result.ok ? result.data.sourceSelection : null;
  const sourceUnavailable = Boolean(requestedSettlementSource)
    && (sourceSelection === null
      || sourceSelection.tooLarge
      || requestedTransactionIds.length === 0);
  const selectedTransaction = requestedTransactionId
    ? allRows.find((row) => row.id === requestedTransactionId) ?? null
    : null;
  const exactSelectionAvailable = requestedTransactionIds.length === 0
    || allRows.length === requestedTransactionIds.length;
  const rows = requestedTransactionIds.length > 0
    ? (exactSelectionAvailable ? allRows : [])
    : allRows;
  const seeded = result.ok ? buildInitialFilters(rows, sp) : { filters: {}, label: null };
  const contextLabel = requestedSettlementSource && !sourceUnavailable
    ? `${requestedTransactionIds.length.toLocaleString()} recorded service${requestedTransactionIds.length === 1 ? "" : "s"} behind Money operations`
    : selectedTransaction
    ? `Selected transaction${selectedTransaction.checkNumber ? ` · check ${selectedTransaction.checkNumber}` : ""}`
    : requestedTransactionIds.length > 1
      ? `${requestedTransactionIds.length.toLocaleString()} selected transactions`
      : seeded.label;
  const hasFilterContext = Object.keys(seeded.filters).length > 0;
  const requestedView = one(sp.view);
  const normalizedRequestedView: "checks" | "rows" | null = requestedView === "checks" || requestedView === "payroll"
    ? "checks"
    : requestedView === "rows" || requestedView === "services"
      ? "rows"
      : null;
  const initialView: "checks" | "rows" = contextLabel || hasFilterContext
    ? "rows"
    : normalizedRequestedView ?? "rows";

  return (
    <>
      <PageHeader
        eyebrow="Recorded work"
        title="Activity"
        description="See what service happened, how payroll was grouped, and what needs a decision."
      />

      {!result.ok ? (
        <ErrorPanel title="Billed activity is unavailable">{result.error}</ErrorPanel>
      ) : sourceUnavailable ? (
        <ErrorPanel
          title={sourceSelection?.tooLarge ? "This source is too large to open" : "Source rows are no longer available"}
          action={<ButtonLink href="/settlements?focus=check-issues">Back to Money operations</ButtonLink>}
        >
          {sourceSelection?.tooLarge
            ? "This source contains more than 10,000 rows. Return to Money operations and narrow the item before opening it."
            : "The item may have been resolved, removed, or may be outside your access. Refresh Money operations to see its current source rows."}
        </ErrorPanel>
      ) : requestedTransactionIds.length > 0 && !exactSelectionAvailable ? (
        <ErrorPanel
          title={requestedTransactionIds.length === 1 ? "This transaction is not available" : "These transactions are not available"}
          action={<ButtonLink href="/transactions">Open all transactions</ButtonLink>}
        >
          One or more rows may have been removed, or your account may not include access to them.
        </ErrorPanel>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No recorded activity yet"
            action={canManage ? (
              <ButtonLink href="/sync" variant="primary">
                <RefreshCw aria-hidden className="h-4 w-4" /> Update activity
              </ButtonLink>
            ) : undefined}
          >
            Recorded services and payroll checks will appear here after activity is updated.
          </EmptyState>
        </Card>
      ) : (
        <BilledActivityWorkspace
          key={`${contextLabel ?? "all"}:${initialView}`}
          rows={rows}
          canManage={canManage}
          visibility={result.data.visibility}
          canSeeBudgets={result.data.canSeeBudgets}
          initialFilters={seeded.filters}
          contextLabel={contextLabel}
          initialView={initialView}
          reviewSummary={result.data.reviewSummary}
        />
      )}
    </>
  );
}
