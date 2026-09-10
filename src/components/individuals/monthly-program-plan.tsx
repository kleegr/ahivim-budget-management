"use client";
import { useState } from "react";
import Link from "next/link";
import { buildMonthlyAuthorizationPlan, type MonthlyPlanInput } from "@/lib/business/monthly-authorization-plan";
import { formatHours } from "@/lib/money";

export default function MonthlyProgramPlan({ input, individualId, programId, canOpenTransactions }: {
  input: MonthlyPlanInput; individualId: string; programId: string; canOpenTransactions: boolean;
}) {
  const [allMonths, setAllMonths] = useState(false);
  const plan = buildMonthlyAuthorizationPlan(input);
  const firstRemaining = plan.months.findIndex((row) => row.phase !== "past");
  const current = firstRemaining < 0 ? Math.max(0, plan.months.length - 1) : firstRemaining;
  const months = allMonths ? plan.months : plan.months.slice(Math.max(0, current - 1), current + 7);
  return <section className="border-t border-[var(--color-rule)] p-4 sm:p-5" aria-label="Monthly actuals and remaining plan">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Monthly actuals & remaining plan</h3>
      <button type="button" className="btn btn-sm btn-secondary" onClick={() => setAllMonths(!allMonths)}>{allMonths ? "Around this month" : "All months in this authorization"}</button></div>
    {plan.unavailableReason ? <p role="status" className="mb-3 text-sm text-[var(--color-warn)]">{plan.unavailableReason} <a href="#service-authorizations" className="underline">Review authorization setup</a></p> : null}
    <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-[var(--color-rule)] text-left text-xs"><th className="py-2">Month</th><th className="p-2 text-right">Actual credited</th><th className="p-2 text-right">Suggested hours</th><th className="p-2 text-right">Future scheduled</th><th className="p-2 text-right">Hours still to plan</th></tr></thead>
      <tbody>{months.map((row) => <tr key={row.month} className={`border-b border-[var(--color-rule)] ${row.phase === "current" ? "bg-[var(--color-primary-tint)]" : ""}`}>
        <th className="py-3 text-left font-medium">{row.month}<span className="block text-xs font-normal text-[var(--color-ink-soft)]">{row.phase === "current" ? "Actual to date · remaining month target" : row.phase === "past" ? "Historical actuals" : "Future plan"}</span></th>
        <td className="p-2 text-right tnum">{formatHours(row.actualHours)}{canOpenTransactions ? <Link className="block text-xs text-[var(--color-primary)] underline" href={`/transactions?individualId=${individualId}&programId=${programId}&serviceFrom=${row.from}&serviceTo=${row.to}`}>Credited budget hours{row.payrollHours !== null ? `: ${formatHours(row.payrollHours)} h` : ""}</Link> : null}{row.adjustmentHours !== null && Number(row.adjustmentHours) !== 0 ? <span className="block text-xs text-[var(--color-ink-soft)]">Ledger adjustments: {formatHours(row.adjustmentHours)} h · see history below</span> : null}</td>
        <td className="p-2 text-right tnum">{row.targetHours === null ? "—" : formatHours(row.targetHours)}{row.targetHours !== null ? <span className="block text-xs text-[var(--color-ink-soft)]">{row.remainingDays} remaining days</span> : null}</td>
        <td className="p-2 text-right tnum">{row.phase === "past" ? "—" : formatHours(row.scheduledHours)}</td>
        <td className="p-2 text-right tnum">{row.gapHours === null ? "—" : formatHours(row.gapHours)}</td>
      </tr>)}</tbody></table></div>
    <details className="mt-3 text-xs text-[var(--color-ink-soft)]"><summary className="cursor-pointer">How credited hours and targets are calculated</summary><p className="mt-2">{plan.method}. Actuals use credited budget hours, including full individual credit for confirmed group services. Imported hours may differ and are shown separately in Transactions. Employee physical working time is a separate measure. Targets distribute remaining positive authorization through the earlier of the authorization end and day before renewal. Pending unmatched future visits count toward the target.</p></details>
  </section>;
}
