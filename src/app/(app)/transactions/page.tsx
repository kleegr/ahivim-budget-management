import { requireUser } from "@/lib/auth/session";
import { resolveAccessScope } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { listTransactionsForGrid, type GridTransaction } from "@/lib/data/transactions-grid";
import { PageHeader, ErrorPanel, EmptyState, Card } from "@/components/ui";
import TransactionsGrid from "@/components/transactions/transactions-grid";
import type { FilterState } from "@/components/data-grid/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Transactions — Ahivim Budget Management" };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * Turn URL search params into grid filters, so every "open the rows behind this
 * number" link across the app lands here already filtered — and the live totals
 * then equal the figure that was clicked. Ids are resolved to their display
 * value against the loaded ledger so the on-screen chip reads a name, not a UUID.
 */
function buildInitialFilters(rows: GridTransaction[], sp: SP): { filters: FilterState; label: string | null } {
  const filters: FilterState = {};
  const labels: string[] = [];

  const setByIdOrName = (
    key: string,
    idParam: string | undefined,
    nameParam: string | undefined,
    idOf: (r: GridTransaction) => string | null,
    nameOf: (r: GridTransaction) => string | null,
  ) => {
    if (idParam) {
      const match = rows.find((r) => idOf(r) === idParam);
      const name = match ? nameOf(match) : null;
      if (name) {
        filters[key] = { selected: [name] };
        labels.push(name);
        return;
      }
    }
    if (nameParam) {
      filters[key] = { selected: [nameParam] };
      labels.push(nameParam);
    }
  };

  setByIdOrName("individual", one(sp.individualId), one(sp.individual), (r) => r.individualId, (r) => r.individual);
  setByIdOrName("employee", one(sp.employeeId), one(sp.employee), (r) => r.employeeId, (r) => r.employee);

  // Program: accept a display name or a canonical code.
  const programName = one(sp.program);
  const programCode = one(sp.programCode);
  if (programName) {
    filters.program = { selected: [programName] };
    labels.push(programName);
  } else if (programCode) {
    const match = rows.find((r) => r.programCode === programCode);
    if (match?.program) {
      filters.program = { selected: [match.program] };
      labels.push(match.program);
    }
  }

  const payTo = one(sp.payTo);
  if (payTo) {
    filters.payTo = { selected: [payTo] };
    labels.push(`paid to ${payTo}`);
  }

  const checkNumber = one(sp.checkNumber);
  if (checkNumber) {
    filters.checkNumber = { selected: [checkNumber] };
    labels.push(`check ${checkNumber}`);
  }

  // Period-begin window (service period), used by budget drill-throughs so the
  // grid matches the period-scoped billed figure exactly (the workbook windows on
  // Period Begin, not on the check date the top period control uses).
  const pbFrom = one(sp.pbFrom);
  const pbTo = one(sp.pbTo);
  if (pbFrom || pbTo) {
    filters.periodBegin = { from: pbFrom ?? "", to: pbTo ?? "" };
    if (pbFrom && pbTo) labels.push(`service ${pbFrom} → ${pbTo}`);
  }

  const recipient = one(sp.recipient);
  if (recipient) filters.paymentRecipient = { selected: [recipient] };

  const group = one(sp.group);
  if (group === "1" || group === "true") filters.groupStatus = { selected: ["Group"] };
  else if (group === "0" || group === "false") filters.groupStatus = { selected: ["Individual"] };

  return { filters, label: labels.length ? labels.join(" · ") : null };
}

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser("viewer");
  const canManage = user.role !== "viewer";
  const sp = await searchParams;

  const result = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    if (!scope.canSeeTransactions) return { denied: true as const, rows: [] as GridTransaction[], canSeeMoney: scope.canSeeMoney };
    return { denied: false as const, rows: await listTransactionsForGrid(pool, scope), canSeeMoney: scope.canSeeMoney };
  });

  // A user whose access hides Transactions is refused server-side, not just in the nav.
  if (result.ok && result.data.denied) {
    return (
      <>
        <PageHeader eyebrow="Ledger" title="Transactions" />
        <ErrorPanel title="No access to Transactions">
          Your account doesn&rsquo;t include permission to view transactions. Ask an administrator if you need it.
        </ErrorPanel>
      </>
    );
  }

  const rows = result.ok ? result.data.rows : [];
  const canSeeMoney = result.ok ? result.data.canSeeMoney : true;
  const seeded = result.ok ? buildInitialFilters(rows, sp) : { filters: {}, label: null };

  return (
    <>
      <PageHeader
        eyebrow="Ledger · source of truth"
        title="Transactions"
        description="Every committed payroll row in one filterable grid — like the Ahivim workbook tab. Filter any column or pick a period, sort, and the totals at the top update to match exactly what you see. Every summary number elsewhere in the app links back into this grid, pre-filtered."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load transactions">{result.error}</ErrorPanel>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState title="No transactions yet">
            Once a payroll file is imported and committed, every row appears here.
          </EmptyState>
        </Card>
      ) : (
        <TransactionsGrid
          rows={rows}
          canManage={canManage}
          canSeeMoney={canSeeMoney}
          initialFilters={seeded.filters}
          contextLabel={seeded.label}
        />
      )}
    </>
  );
}
