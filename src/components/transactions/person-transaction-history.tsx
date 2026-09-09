"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import type { TransactionFieldVisibility } from "@/lib/auth/money-redaction";
import { formatHours, formatMoney } from "@/lib/money";
import { historyServiceDate, selectPersonHistoryPage } from "@/lib/transactions/person-history";

export default function PersonTransactionHistory({ individualId, rows, visibility }: {
  individualId: string; rows: GridTransaction[]; visibility: TransactionFieldVisibility;
}) {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const { total, pages, current, visible } = useMemo(() => selectPersonHistoryPage(rows, query, page), [rows, query, page]);
  return <section aria-label="Complete transaction history" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="display text-lg font-semibold">Complete transaction history</h2><p className="text-sm text-[var(--color-ink-soft)]">All recorded periods, newest service date first. Undated records remain available.</p></div>
      <Link href={`/transactions?individualId=${encodeURIComponent(individualId)}`} className="btn btn-secondary">Open all transactions</Link>
    </div>
    <input aria-label="Search transaction history" type="search" className="input w-full sm:max-w-sm" placeholder="Find a program, employee, or date" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
    <p role="status" className="text-sm text-[var(--color-ink-soft)]">{total.toLocaleString()} transactions · page {current} of {pages}</p>
    {visible.length ? <div className="overflow-x-auto border-y border-[var(--color-rule)]"><table className="w-full min-w-[600px] text-sm">
      <thead className="bg-[var(--color-surface-muted)] text-left"><tr><th className="px-3 py-3">Service date</th><th className="px-3 py-3">Program</th><th className="px-3 py-3">Employee</th>{visibility.canSeeHours ? <th className="px-3 py-3 text-right">Hours</th> : null}{visibility.canSeeBilledAmounts ? <th className="px-3 py-3 text-right">Funder billed</th> : null}{visibility.canSeeEmployeeAmounts ? <th className="px-3 py-3 text-right">Employee base</th> : null}</tr></thead>
      <tbody className="divide-y divide-[var(--color-rule)]">{visible.map((row) => <tr key={row.id}><td className="whitespace-nowrap px-3 py-3"><Link className="text-[var(--color-primary)] hover:underline" href={`/transactions?individualId=${individualId}&transactionId=${row.id}`}>{historyServiceDate(row) ?? "Undated"}</Link></td><td className="px-3 py-3">{row.program ?? "Not recorded"}</td><td className="px-3 py-3">{row.employee ?? "Not recorded"}</td>{visibility.canSeeHours ? <td className="tnum px-3 py-3 text-right">{row.hours === null ? "Unavailable" : formatHours(row.hours)}</td> : null}{visibility.canSeeBilledAmounts ? <td className="tnum px-3 py-3 text-right">{row.gross === null ? "Unavailable" : formatMoney(row.gross)}</td> : null}{visibility.canSeeEmployeeAmounts ? <td className="tnum px-3 py-3 text-right">{row.internalAmount === null ? "Unavailable" : formatMoney(row.internalAmount)}</td> : null}</tr>)}</tbody>
    </table></div> : <p className="py-5 text-sm">No transactions match this selection.</p>}
    <nav aria-label="Transaction history pages" className="flex justify-between gap-3"><button type="button" className="btn btn-secondary" disabled={current === 1} onClick={() => setPage(current - 1)}>Previous</button><button type="button" className="btn btn-secondary" disabled={current === pages} onClick={() => setPage(current + 1)}>Next</button></nav>
  </section>;
}
