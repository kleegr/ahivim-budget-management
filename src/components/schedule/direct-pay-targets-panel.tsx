import { CheckCircle2, Clock3, Target } from "lucide-react";
import type { PlannerDirectPayTargetRow } from "@/lib/data/direct-pay-operations";
import { formatHours } from "@/lib/money";
import { Card, EmptyState } from "@/components/ui";

const STATUS = {
  met: { label: "Target met", className: "bg-[var(--color-success-soft)] text-[var(--color-success)]", icon: CheckCircle2 },
  covered: { label: "Scheduled to target", className: "bg-[var(--color-info-soft)] text-[var(--color-info)]", icon: Clock3 },
  needs_hours: { label: "Needs hours", className: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]", icon: Target },
} as const;

export default function DirectPayTargetsPanel({ rows }: { rows: PlannerDirectPayTargetRow[] }) {
  return (
    <Card
      title="Direct-pay hour targets"
      description="Current service-hour coverage for employees with a direct-pay target."
      className="mb-5"
    >
      {rows.length === 0 ? (
        <EmptyState compact title="No active hour targets" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] text-left text-xs font-semibold text-[var(--color-ink-soft)]">
              <tr>
                <th className="px-4 py-2.5">Employee</th>
                <th className="px-3 py-2.5">Interval</th>
                <th className="px-3 py-2.5 text-right">Target hours</th>
                <th className="px-3 py-2.5 text-right">Recorded</th>
                <th className="px-3 py-2.5 text-right">Scheduled</th>
                <th className="px-3 py-2.5 text-right">Still needed</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-rule)]">
              {rows.map((row) => {
                const status = STATUS[row.status];
                const Icon = status.icon;
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-3 font-medium text-[var(--color-ink)]">{row.employeeName}</td>
                    <td className="px-3 py-3 text-[var(--color-ink-soft)]">
                      {row.windowStart} to {row.windowEnd}
                    </td>
                    <td className="tnum px-3 py-3 text-right font-semibold">{formatHours(row.targetHours)}</td>
                    <td className="tnum px-3 py-3 text-right">{formatHours(row.recordedHours)}</td>
                    <td className="tnum px-3 py-3 text-right">{formatHours(row.scheduledHours)}</td>
                    <td className="tnum px-3 py-3 text-right font-semibold">{formatHours(row.remainingHours)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold ${status.className}`}>
                        <Icon size={13} aria-hidden />{status.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
