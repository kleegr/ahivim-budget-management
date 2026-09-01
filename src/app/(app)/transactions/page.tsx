import { requireUser } from "@/lib/auth/session";
import { isPlanningOnlyAccess, resolveAccessScope } from "@/lib/auth/access";
import { redirect } from "next/navigation";
import { withDb } from "@/lib/data/pool";
import { listTransactionsForGrid, type GridTransaction } from "@/lib/data/transactions-grid";
import { PageHeader, ErrorPanel, EmptyState, Card, ButtonLink } from "@/components/ui";
import BilledActivityWorkspace from "@/components/transactions/billed-activity-workspace";
import { transactionFieldVisibility } from "@/lib/auth/money-redaction";
import { buildInitialFilters } from "@/lib/transactions/initial-filters";
import { RefreshCw } from "lucide-react";
import { listSettlementSourceTransactions } from "@/lib/data/settlement-source-transactions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Transactions - Ahivim" };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;
const many = (v: string | string[] | undefined): string[] =>
  [...new Set((Array.isArray(v) ? v : v ? [v] : []).filter(Boolean))];

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser("viewer");
  const canManage = user.role !== "viewer";
  const sp = await searchParams;
  const requestedTransactionIdsFromUrl = many(sp.transactionId);
  const requestedSettlementSource = one(sp.settlementSource);
  const requestedTransactionId = !requestedSettlementSource && requestedTransactionIdsFromUrl.length === 1
    ? requestedTransactionIdsFromUrl[0]
    : undefined;

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
      };
    }
    const sourceSelection = requestedSettlementSource
      ? await listSettlementSourceTransactions(pool, scope, requestedSettlementSource)
      : null;
    const requestedTransactionIds = sourceSelection
      ? sourceSelection.transactionIds
      : requestedTransactionIdsFromUrl;
    return {
      denied: false as const,
      planningOnly: false,
      rows: sourceSelection
        ? sourceSelection.rows
        : await listTransactionsForGrid(pool, scope, {
            transactionIds: requestedTransactionIds,
          }),
      visibility,
      canSeeBudgets: scope.canSeeBudgets,
      requestedTransactionIds,
      sourceSelection,
    };
  });

  if (result.ok && result.data.planningOnly) redirect("/schedule");

  // A user whose access hides Transactions is refused server-side, not just in the nav.
  if (result.ok && result.data.denied) {
    return (
      <>
        <PageHeader eyebrow="Actual activity" title="Transactions" />
        <ErrorPanel title="No access to Transactions" action={<ButtonLink href="/home">Back to home</ButtonLink>}>
          Your account doesn&rsquo;t include permission to view transactions. Ask an administrator if you need it.
        </ErrorPanel>
      </>
    );
  }

  const allRows = result.ok ? result.data.rows : [];
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
    ? `${requestedTransactionIds.length.toLocaleString()} source transaction${requestedTransactionIds.length === 1 ? "" : "s"} from Money operations`
    : selectedTransaction
    ? `Selected transaction${selectedTransaction.checkNumber ? ` · check ${selectedTransaction.checkNumber}` : ""}`
    : requestedTransactionIds.length > 1
      ? `${requestedTransactionIds.length.toLocaleString()} selected transactions`
      : seeded.label;
  const hasFilterContext = Object.keys(seeded.filters).length > 0;
  const requestedView = one(sp.view);
  const initialView: "checks" | "rows" = contextLabel || hasFilterContext
    ? "rows"
    : requestedView === "checks" || requestedView === "rows"
      ? requestedView
      : user.role === "admin"
        ? "rows"
        : "checks";

  return (
    <>
      <PageHeader
        eyebrow="Actual activity"
        title="Transactions"
        description="Actual billing and payroll activity."
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
            title="No transactions yet"
            action={canManage ? (
              <ButtonLink href="/sync" variant="primary">
                <RefreshCw aria-hidden className="h-4 w-4" /> Open Google Sheet sync
              </ButtonLink>
            ) : undefined}
          >
            Once a payroll file is imported and committed, every row appears here.
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
        />
      )}
    </>
  );
}
