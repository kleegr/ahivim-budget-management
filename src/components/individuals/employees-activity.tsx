"use client";

import { useState } from "react";
import Link from "next/link";
import { formatHours, formatMoney } from "@/lib/money";
import { txLink } from "@/lib/nav/tx-link";
import type { PeriodEmployee } from "@/lib/data/queries";

/**
 * Employees working with this individual, this budget year. Each row is a
 * dropdown (collapsed by default); opening it reveals that employee's own
 * transactions for this person — the same rows you'd get from the ledger, inline
 * — so you never have to leave the page. The "rows →" link still opens the full
 * Transactions grid pre-filtered to this employee, this person, this period.
 */
export default function EmployeesActivity({
  individualId,
  periodStart,
  periodEnd,
  employees,
}: {
  individualId: string;
  periodStart: string | null;
  periodEnd: string | null;
  employees: PeriodEmployee[];
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const window = { pbFrom: periodStart ?? undefined, pbTo: periodEnd ?? undefined };

  return (
    <div className="divide-y divide-[var(--color-rule)]">
      {employees.map((e) => {
        const k = e.id ?? `raw:${e.name}`;
        const isOpen = open.has(k);
        return (
          <div key={k}>
            <div className="flex items-center gap-3 px-5 py-2.5">
              <button
                type="button"
                onClick={() => toggle(k)}
                aria-expanded={isOpen}
                className="flex flex-1 items-center gap-2 text-left"
                title={isOpen ? "Hide transactions" : "Show this employee's transactions"}
              >
                <span className={`text-[var(--color-ink-faint)] transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden>▶</span>
                <span className="font-medium text-[var(--color-ink)]">{e.name}</span>
                <span className="text-xs text-[var(--color-ink-faint)]">
                  {e.txCount} {e.txCount === 1 ? "transaction" : "transactions"}
                </span>
              </button>
              <span className="tnum hidden w-24 text-right text-sm text-[var(--color-ink-soft)] sm:block">{formatHours(e.hours)} h</span>
              <span className="tnum w-28 text-right text-sm font-medium">{formatMoney(e.agency)}</span>
              <Link
                className="w-16 text-right text-xs text-[var(--color-primary)] hover:underline"
                href={txLink({ individualId, employeeId: e.id ?? undefined, ...window })}
                title="Open in the Transactions grid, filtered to this person, employee and period"
              >
                rows →
              </Link>
            </div>

            {isOpen ? (
              <div className="bg-[var(--color-surface-muted)] px-5 pb-3 pt-1">
                {e.transactions.length === 0 ? (
                  <p className="py-2 text-xs text-[var(--color-ink-faint)]">No itemized rows in this period.</p>
                ) : (
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="text-left text-[var(--color-text-soft)]">
                        <th className="py-1.5 pr-3 font-medium">Pay period</th>
                        <th className="px-2 py-1.5 font-medium">Program</th>
                        <th className="px-2 py-1.5 text-right font-medium">Hours</th>
                        <th className="px-2 py-1.5 text-right font-medium">Billed $</th>
                        <th className="py-1.5 pl-2 text-right font-medium">Company $</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.transactions.map((t) => (
                        <tr key={t.id} className="border-t border-[var(--color-rule)]">
                          <td className="tnum py-1.5 pr-3 text-[var(--color-ink-soft)]">{t.periodBegin}</td>
                          <td className="px-2 py-1.5">{t.programName}</td>
                          <td className="tnum px-2 py-1.5 text-right">{formatHours(t.hours)}</td>
                          <td className="tnum px-2 py-1.5 text-right">{formatMoney(t.agency)}</td>
                          <td className="tnum py-1.5 pl-2 text-right text-[var(--color-ink-soft)]">{formatMoney(t.internal)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
