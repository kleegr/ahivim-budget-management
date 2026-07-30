import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listTransactionsForGrid } from "@/lib/data/transactions-grid";
import { PageHeader, ErrorPanel, EmptyState, Card } from "@/components/ui";
import TransactionsGrid from "@/components/transactions/transactions-grid";

export const dynamic = "force-dynamic";
export const metadata = { title: "Transactions — Ahivim Budget Management" };

export default async function TransactionsPage() {
  const user = await requireUser("viewer");
  const canManage = user.role !== "viewer";

  const result = await withDb((pool) => listTransactionsForGrid(pool));

  return (
    <>
      <PageHeader
        eyebrow="Ledger"
        title="Transactions"
        description="Every committed payroll row, in one filterable grid — like the Ahivim workbook tab. Filter any column, sort, and the totals below update to match exactly what you see."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load transactions">{result.error}</ErrorPanel>
      ) : result.data.length === 0 ? (
        <Card>
          <EmptyState title="No transactions yet">
            Once a payroll file is imported and committed, every row appears here.
          </EmptyState>
        </Card>
      ) : (
        <TransactionsGrid rows={result.data} canManage={canManage} />
      )}
    </>
  );
}
