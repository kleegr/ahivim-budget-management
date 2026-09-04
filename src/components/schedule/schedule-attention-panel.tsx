"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import type { CalendarSession } from "@/lib/data/schedule-queries";
import {
  buildScheduleAttention,
  type ScheduleRepairKind,
} from "@/lib/business/schedule-attention";
import { humanDate, prettyTime, type SessionFlags } from "./shared";

export default function ScheduleAttentionPanel({
  sessions,
  flags,
  canManage,
  showBudgetTracking,
  onRepair,
}: {
  sessions: CalendarSession[];
  flags: Map<string, SessionFlags>;
  canManage: boolean;
  showBudgetTracking: boolean;
  onRepair: (session: CalendarSession, repair: ScheduleRepairKind) => void;
}) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const items = buildScheduleAttention(sessions, flags, { showBudgetTracking });
  if (items.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-lg border border-[var(--color-warn)] bg-[var(--color-surface)]" aria-labelledby="schedule-attention-heading">
      <div className="flex items-start gap-2 bg-[var(--color-warn-soft)] px-3 py-2.5 text-[var(--color-warn)] sm:px-4">
        <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <h2 id="schedule-attention-heading" className="text-sm font-semibold">Schedule attention · {items.length}</h2>
          <p className="mt-0.5 text-xs">Each problem below has one direct next step. These are planned visits, not recorded service.</p>
        </div>
      </div>
      <ul className="max-h-72 divide-y divide-[var(--color-rule)] overflow-y-auto">
        {items.map((attention) => {
          const session = byId.get(attention.sessionId);
          if (!session) return null;
          const query = new URLSearchParams({
            individualId: session.individualIds[0] ?? "",
            programId: session.programId,
          });
          if (session.employeeId) query.set("employeeId", session.employeeId);
          const action = !canManage ? (
            <button type="button" className="btn btn-sm btn-secondary shrink-0" onClick={() => onRepair(session, "review")}>
              Open visit
            </button>
          ) : attention.repair === "assignment" ? (
            <Link className="btn btn-sm btn-secondary shrink-0" href={`/schedule?view=future&${query.toString()}`}>
              {attention.actionLabel}
            </Link>
          ) : attention.repair === "coverage" ? (
            <Link className="btn btn-sm btn-secondary shrink-0" href={`/schedule?view=coverage&${query.toString()}`}>
              {attention.actionLabel}
            </Link>
          ) : (
            <button type="button" className="btn btn-sm btn-secondary shrink-0" onClick={() => onRepair(session, attention.repair)}>
              {attention.actionLabel}
            </button>
          );
          return (
            <li key={attention.key} className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-sm font-semibold text-[var(--color-ink)]">{attention.title}</span>
                  <span className="tnum text-xs text-[var(--color-ink-faint)]">{humanDate(attention.sessionDate)}{attention.startTime ? ` · ${prettyTime(attention.startTime)}` : ""}</span>
                </div>
                <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">{attention.individualName} · {attention.programName} · {attention.employeeName ?? "Unassigned"}</p>
                <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{attention.detail}</p>
              </div>
              {action}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
