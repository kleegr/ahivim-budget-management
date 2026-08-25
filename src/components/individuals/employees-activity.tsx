"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { dec, formatHours, formatMoney } from "@/lib/money";
import { txLink } from "@/lib/nav/tx-link";
import type { PeriodEmployee } from "@/lib/data/queries";

/**
 * Employees working with this individual, THIS budget year only (the rows are
 * already windowed to the period). Each row is a dropdown; opening it reveals a
 * mini transactions view for that employee — filter by program with a click and
 * the totals underneath update live, just like the Transactions grid, without
 * leaving the page. "rows →" still opens the full grid pre-filtered.
 */
export default function EmployeesActivity({
  individualId,
  periodStart,
  periodEnd,
  employees,
  canSeeHours = true,
  canSeeBilledAmounts = true,
  canSeeEmployeeAmounts = true,
  canSeeTransactions,
}: {
  individualId: string;
  periodStart: string | null;
  periodEnd: string | null;
  employees: PeriodEmployee[];
  canSeeHours?: boolean;
  canSeeBilledAmounts?: boolean;
  canSeeEmployeeAmounts?: boolean;
  canSeeTransactions: boolean;
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
              {canSeeTransactions ? (
                <button
                  type="button"
                  onClick={() => toggle(k)}
                  aria-expanded={isOpen}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={isOpen ? "Hide transactions" : "Show this employee's transactions"}
                >
                  <span className={`shrink-0 text-[var(--color-ink-faint)] transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden>▶</span>
                  <span className="min-w-0 truncate font-medium text-[var(--color-ink)]" title={e.name}>{e.name}</span>
                  <span className="shrink-0 text-xs text-[var(--color-ink-faint)]">
                    {e.txCount} {e.txCount === 1 ? "transaction" : "transactions"}
                  </span>
                </button>
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 truncate font-medium text-[var(--color-ink)]" title={e.name}>{e.name}</span>
                </div>
              )}
              {canSeeHours ? <span className="tnum hidden w-24 text-right text-sm text-[var(--color-ink-soft)] sm:block">{formatHours(e.hours)} h</span> : null}
              {canSeeBilledAmounts ? <span className="tnum w-28 text-right text-sm font-medium">{formatMoney(e.agency)}</span> : null}
              {canSeeTransactions ? <Link
                className="w-16 text-right text-xs text-[var(--color-primary)] hover:underline"
                href={txLink({ individualId, employeeId: e.id ?? undefined, ...window })}
                title="Open in the Transactions grid, filtered to this person, employee and period"
              >
                rows →
              </Link> : null}
            </div>

            {canSeeTransactions && isOpen ? (
              <EmployeePanel
                employee={e}
                canSeeHours={canSeeHours}
                canSeeBilledAmounts={canSeeBilledAmounts}
                canSeeEmployeeAmounts={canSeeEmployeeAmounts}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The expandable per-employee snippet: a program filter + itemized rows + live totals. */
function EmployeePanel({
  employee,
  canSeeHours = true,
  canSeeBilledAmounts = true,
  canSeeEmployeeAmounts = true,
}: {
  employee: PeriodEmployee;
  canSeeHours?: boolean;
  canSeeBilledAmounts?: boolean;
  canSeeEmployeeAmounts?: boolean;
}) {
  const programs = useMemo(() => {
    const set = new Set<string>();
    for (const t of employee.transactions) set.add(t.programName);
    return [...set].sort();
  }, [employee.transactions]);

  const [active, setActive] = useState<Set<string> | null>(null); // null = all programs
  const isOn = (p: string) => active === null || active.has(p);
  const toggleProgram = (p: string) =>
    setActive((prev) => {
      const base = prev ?? new Set(programs);
      const next = new Set(base);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      // Back to "all" when everything is on again — keeps the chips visually clean.
      return next.size === programs.length ? null : next;
    });

  const rows = employee.transactions.filter((t) => isOn(t.programName));
  const totals = rows.reduce(
    (acc, t) => ({
      hours: acc.hours.plus(dec(t.hours)),
      agency: acc.agency.plus(dec(t.agency)),
      internal: acc.internal.plus(dec(t.internal)),
    }),
    { hours: dec(0), agency: dec(0), internal: dec(0) },
  );

  return (
    <div className="bg-[var(--color-surface-muted)] px-5 pb-3 pt-2">
      {programs.length > 1 ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[0.7rem] font-medium uppercase tracking-wide text-[var(--color-text-soft)]">Program</span>
          {programs.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => toggleProgram(p)}
              aria-pressed={isOn(p)}
              className={`rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${
                isOn(p)
                  ? "bg-[var(--color-primary)] text-white"
                  : "bg-[var(--color-surface-strong)] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
              }`}
            >
              {p}
            </button>
          ))}
          {active !== null ? (
            <button type="button" onClick={() => setActive(null)} className="ml-1 text-[0.7rem] text-[var(--color-ink-faint)] underline underline-offset-2">
              all
            </button>
          ) : null}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="py-2 text-xs text-[var(--color-ink-faint)]">No rows for the chosen program.</p>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-left text-[var(--color-text-soft)]">
              <th className="py-1.5 pr-3 font-medium">Pay period</th>
              <th className="px-2 py-1.5 font-medium">Program</th>
              {canSeeHours ? <th className="px-2 py-1.5 text-right font-medium">Hours</th> : null}
              {canSeeBilledAmounts ? <th className="px-2 py-1.5 text-right font-medium">Billed $</th> : null}
              {canSeeEmployeeAmounts ? <th className="py-1.5 pl-2 text-right font-medium">Employee base</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-t border-[var(--color-rule)]">
                <td className="tnum py-1.5 pr-3 text-[var(--color-ink-soft)]">{t.periodBegin}</td>
                <td className="px-2 py-1.5">{t.programName}</td>
                {canSeeHours ? <td className="tnum px-2 py-1.5 text-right">{formatHours(t.hours)}</td> : null}
                {canSeeBilledAmounts ? <td className="tnum px-2 py-1.5 text-right">{formatMoney(t.agency)}</td> : null}
                {canSeeEmployeeAmounts ? <td className="tnum py-1.5 pl-2 text-right text-[var(--color-ink-soft)]">{formatMoney(t.internal)}</td> : null}
              </tr>
            ))}
            <tr className="border-t-2 border-[var(--color-rule-strong)] font-semibold">
              <td className="py-1.5 pr-3">Total</td>
              <td className="px-2 py-1.5 text-[var(--color-ink-faint)]">{rows.length} {rows.length === 1 ? "row" : "rows"}</td>
              {canSeeHours ? <td className="tnum px-2 py-1.5 text-right">{formatHours(totals.hours.toString())}</td> : null}
              {canSeeBilledAmounts ? <td className="tnum px-2 py-1.5 text-right">{formatMoney(totals.agency.toString())}</td> : null}
              {canSeeEmployeeAmounts ? <td className="tnum py-1.5 pl-2 text-right">{formatMoney(totals.internal.toString())}</td> : null}
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
