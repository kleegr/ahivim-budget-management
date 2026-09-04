import type { CalendarSession, SessionWarningFlags } from "@/lib/data/schedule-queries";

export type ScheduleRepairKind = "staffing" | "reschedule" | "assignment" | "coverage" | "review";

export interface ScheduleAttentionItem {
  key: string;
  sessionId: string;
  sessionDate: string;
  startTime: string | null;
  programName: string;
  individualName: string;
  employeeName: string | null;
  title: string;
  detail: string;
  actionLabel: string;
  repair: ScheduleRepairKind;
  priority: number;
}

type AttentionFlag = Omit<Pick<
  SessionWarningFlags,
  | "hasScheduleConflict"
  | "hasAvailabilityConflict"
  | "hasBudgetRisk"
  | "hasAssignmentGap"
  | "hasOtherWarning"
  | "warningCount"
>, "warningCount"> & { warningCount?: number };

function item(
  session: CalendarSession,
  issue: string,
  fields: Pick<ScheduleAttentionItem, "title" | "detail" | "actionLabel" | "repair" | "priority">,
): ScheduleAttentionItem {
  return {
    key: `${session.id}:${issue}`,
    sessionId: session.id,
    sessionDate: session.sessionDate,
    startTime: session.startTime,
    programName: session.programName,
    individualName: session.individualNames.join(", ") || "Individual",
    employeeName: session.employeeName,
    ...fields,
  };
}

/**
 * Convert live calendar signals into an operator-facing queue. The queue only
 * contains planned-service context and hours-safe repair routes; it never
 * serializes rates, payments, checks, or transaction data.
 */
export function buildScheduleAttention(
  sessions: CalendarSession[],
  warningFlags: Map<string, AttentionFlag>,
  options: { showBudgetTracking: boolean },
): ScheduleAttentionItem[] {
  const result: ScheduleAttentionItem[] = [];

  for (const session of sessions) {
    // The repair queue is planning work only. Completed, cancelled, and
    // no-show visits are historical facts and must not be presented as edits.
    if (session.status !== "pending") continue;
    const flags = warningFlags.get(session.id);

    if (!session.employeeId) {
      result.push(item(session, "unassigned", {
        title: "Employee needed",
        detail: "This visit has no employee assigned.",
        actionLabel: "Find employee",
        repair: "staffing",
        priority: 1,
      }));
    }
    if (flags?.hasAvailabilityConflict) {
      result.push(item(session, "availability", {
        title: "Employee unavailable",
        detail: "The employee is unavailable, outside working hours, or inactive for this visit.",
        actionLabel: "Change employee",
        repair: "staffing",
        priority: 2,
      }));
    }
    if (flags?.hasScheduleConflict) {
      result.push(item(session, "collision", {
        title: "Schedule conflict",
        detail: "This visit overlaps another visit for the employee or individual.",
        actionLabel: "Reschedule visit",
        repair: "reschedule",
        priority: 3,
      }));
    }
    if (flags?.hasAssignmentGap) {
      result.push(item(session, "assignment", {
        title: "Assignment missing",
        detail: "The selected employee is not assigned to every person in this program on this date.",
        actionLabel: "Fix assignment",
        repair: "assignment",
        priority: 4,
      }));
    }
    if (options.showBudgetTracking && flags?.hasBudgetRisk) {
      result.push(item(session, "coverage", {
        title: "Budget coverage needs review",
        detail: "The visit is outside clear authorization coverage or would over-commit planned hours.",
        actionLabel: "Review coverage",
        repair: "coverage",
        priority: 5,
      }));
    }
    if (flags?.hasOtherWarning) {
      result.push(item(session, "review", {
        title: "Visit setup needs review",
        detail: "A program or participant setting changed after this visit was planned.",
        actionLabel: "Open visit",
        repair: "review",
        priority: 6,
      }));
    } else if (
      (flags?.warningCount ?? session.warningCount) > 0
      && !flags?.hasAvailabilityConflict
      && !flags?.hasScheduleConflict
      && !flags?.hasAssignmentGap
      && !flags?.hasBudgetRisk
    ) {
      result.push(item(session, "review", {
        title: "Visit needs review",
        detail: "Open the planned visit to review its current warning.",
        actionLabel: "Open visit",
        repair: "review",
        priority: 6,
      }));
    }
  }

  return result.sort((left, right) =>
    left.priority - right.priority
    || left.sessionDate.localeCompare(right.sessionDate)
    || (left.startTime ?? "").localeCompare(right.startTime ?? "")
    || left.sessionId.localeCompare(right.sessionId));
}
