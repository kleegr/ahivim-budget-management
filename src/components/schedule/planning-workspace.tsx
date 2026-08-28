import Link from "next/link";
import type { ReactNode } from "react";
import {
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Gauge,
  UserRoundX,
  UsersRound,
} from "lucide-react";
import ScheduleCalendar, { type ScheduleCalendarProps } from "@/components/schedule/calendar";
import AssignmentManager from "@/components/schedule/assignment-manager";
import ServiceSchedules from "@/components/schedule/service-schedules";
import { TabPanels } from "@/components/ui-client";
import { EmptyState, Hours, PaceBar, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";
import type {
  PlanningAuthorizationGap,
  PlanningCoverageRow,
  PlanningReasonCode,
  PlanningWorkspaceData,
} from "@/lib/data/planning-queries";
import { formatHours, formatPercent } from "@/lib/money";
import type { View } from "./shared";

interface PlanningWorkspaceProps {
  data: PlanningWorkspaceData;
  canManage: boolean;
  canManageAssignments?: boolean;
  canOpenPersonRecords?: boolean;
  today: string;
  initialView?: string;
  initialCalendarDate?: string;
  initialCalendarView?: View;
  initialFilters?: ScheduleCalendarProps["initialFilters"];
  employees: ScheduleCalendarProps["employees"];
  individuals: ScheduleCalendarProps["individuals"];
  programs: ScheduleCalendarProps["programs"];
}
const WORK_REASON: Record<PlanningReasonCode, { label: string; tone: "danger" | "warn" | "info" | "muted" }> = {
  unassigned: { label: "Unassigned", tone: "danger" },
  conflict: { label: "Conflict", tone: "danger" },
  over_budget: { label: "Over budget", tone: "danger" },
  assignment_gap: { label: "Assignment gap", tone: "warn" },
  authorization_gap: { label: "Authorization gap", tone: "warn" },
  past_due: { label: "Past planned date", tone: "warn" },
  other_warning: { label: "Setup warning", tone: "info" },
};

const COVERAGE_STATUS: Record<PlanningCoverageRow["status"], { label: string; tone: "danger" | "warn" | "info" | "good" }> = {
  over_committed: { label: "Over committed", tone: "danger" },
  plan_gap: { label: "Plan gap", tone: "warn" },
  covered: { label: "Covered by schedule", tone: "info" },
  on_pace: { label: "On pace", tone: "good" },
};
const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function dateLabel(value: string): string {
  return DATE_FORMATTER.format(new Date(`${value}T00:00:00Z`));
}
function timeLabel(value: string | null): string {
  if (!value) return "Time not set";
  const [hourText, minute = "00"] = value.split(":");
  const hour = Number(hourText);
  if (!Number.isFinite(hour)) return value;
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}

function SummaryMetric({
  label,
  value,
  detail,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  detail: string;
  icon: ReactNode;
  tone?: "neutral" | "warn" | "danger";
}) {
  const color = tone === "danger"
    ? "var(--color-danger)"
    : tone === "warn"
      ? "var(--color-warn)"
      : "var(--color-ink)";
  return (
    <div className="min-w-0 px-4 py-3 first:pl-0 last:pr-0">
      <div className="flex items-center gap-2 text-[var(--color-ink-faint)]">
        {icon}
        <p className="eyebrow">{label}</p>
      </div>
      <p className="tnum mt-1 text-xl font-semibold" style={{ color }}>{value}</p>
      <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{detail}</p>
    </div>
  );
}

function SectionHeading({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[var(--color-primary)]">{icon}</span>
          <h2 className="display text-base font-semibold">{title}</h2>
        </div>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{description}</p>
      </div>
      {action}
    </div>
  );
}

export default function PlanningWorkspace({
  data,
  canManage,
  canManageAssignments = canManage,
  canOpenPersonRecords = true,
  today,
  initialView,
  initialCalendarDate,
  initialCalendarView,
  initialFilters,
  employees,
  individuals,
  programs,
}: PlanningWorkspaceProps) {
  const unassignedSchedules = data.series.filter((row) => !row.employeeId).length;
  const calendar = (
    <ScheduleCalendar
      canManage={canManage}
      today={today}
      initialDate={initialCalendarDate}
      initialView={initialCalendarView}
      initialFilters={initialFilters}
      employees={employees}
      individuals={individuals}
      programs={programs}
    />
  );

  return (
    <div className="space-y-6">
      <div className="grid divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)] sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
        <SummaryMetric
          label="Active schedules"
          value={data.summary.activeSchedules}
          detail="recurring employee and individual plans"
          icon={<CalendarDays aria-hidden className="h-4 w-4" />}
        />
        <SummaryMetric
          label="Next 7 days"
          value={`${formatHours(data.summary.scheduledNextSevenDaysHours)} h`}
          detail="individual budget hours scheduled"
          icon={<Clock3 aria-hidden className="h-4 w-4" />}
        />
        <SummaryMetric
          label="Employee needed"
          value={unassignedSchedules}
          detail="recurring schedules not staffed"
          icon={<UserRoundX aria-hidden className="h-4 w-4" />}
          tone={unassignedSchedules > 0 ? "danger" : "neutral"}
        />
        <SummaryMetric
          label="Budget attention"
          value={data.summary.coverageGaps}
          detail="hour budgets behind, uncovered, or over"
          icon={<Gauge aria-hidden className="h-4 w-4" />}
          tone={data.summary.coverageGaps > 0 ? "warn" : "neutral"}
        />
      </div>

      <TabPanels
        paramKey="view"
        initialId={initialView}
        panels={[
          {
            id: "schedules",
            label: "Service schedules",
            badge: data.summary.activeSchedules || undefined,
            content: (
              <ServiceSchedules
                rows={data.series}
                today={today}
                canManage={canManage}
                employees={employees}
                individuals={individuals}
                programs={programs}
                initialFilters={initialFilters}
              />
            ),
          },
          { id: "calendar", label: "Calendar", content: calendar },
          { id: "coverage", label: "Budgets & pace", badge: data.summary.coverageGaps || undefined, content: <CoverageTable rows={data.coverage} canOpenPersonRecords={canOpenPersonRecords} /> },
          { id: "queue", label: "Attention", badge: data.workQueueTotal || undefined, content: <WorkQueue data={data} canOpenPersonRecords={canOpenPersonRecords} /> },
          {
            id: "future",
            label: "Assignments",
            badge: data.authorizationGaps.length || undefined,
            content: (
              <FuturePlans
                data={data}
                employees={employees}
                individuals={individuals}
                programs={programs}
                canOpenPersonRecords={canOpenPersonRecords}
                canManageAssignments={canManageAssignments}
              />
            ),
          },
        ]}
      />
    </div>
  );
}

function WorkQueue({ data, canOpenPersonRecords }: { data: PlanningWorkspaceData; canOpenPersonRecords: boolean }) {
  const hiddenCount = Math.max(0, data.workQueueTotal - data.workQueue.length);
  return (
    <section>
      <SectionHeading
        title="Sessions needing attention"
        description={`${data.summary.conflictedSessions} conflicted and ${data.summary.overBudgetSessions} over budget as of ${dateLabel(data.asOf)}.`}
        icon={<CircleAlert aria-hidden className="h-4 w-4" />}
        action={hiddenCount > 0 ? <span className="text-xs text-[var(--color-ink-faint)]">First {data.workQueue.length} of {data.workQueueTotal}</span> : null}
      />
      {data.workQueue.length === 0 ? (
        <EmptyState compact title="The planning queue is clear" icon={<CheckCircle2 aria-hidden className="h-5 w-5" />}>
          No pending session has a conflict, budget risk, missing assignment, or past planned date.
        </EmptyState>
      ) : (
        <div className="border-y border-[var(--color-rule)]">
          <Table
            caption="Planned sessions requiring attention"
            head={
              <>
                <Th>Date</Th>
                <Th>Service</Th>
                <Th>People</Th>
                <Th>Employee</Th>
                <Th>Attention</Th>
                <Th numeric>Hours</Th>
              </>
            }
          >
            {data.workQueue.map((item) => {
              const calendarParams = new URLSearchParams({
                view: "calendar",
                date: item.sessionDate,
                calendarView: "day",
              });
              if (item.employeeId) calendarParams.set("employeeId", item.employeeId);
              else calendarParams.set("unassigned", "true");
              return (
                <Tr key={item.id}>
                  <Td>
                    <Link href={`/schedule?${calendarParams.toString()}`} className="font-semibold text-[var(--color-primary)] hover:underline">
                      {dateLabel(item.sessionDate)}
                    </Link>
                    <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{timeLabel(item.startTime)}</p>
                  </Td>
                  <Td>
                    <p className="font-medium">{item.programName}</p>
                  </Td>
                  <Td>
                    <p className="max-w-56 text-[var(--color-ink-soft)]">{item.individualNames.join(", ") || "No individual"}</p>
                  </Td>
                  <Td>
                    {item.employeeId && canOpenPersonRecords ? (
                      <Link href={`/employees/${item.employeeId}`} className="hover:text-[var(--color-primary)] hover:underline">
                        {item.employeeName ?? "Employee"}
                      </Link>
                    ) : item.employeeId ? (
                      <span>{item.employeeName ?? "Employee"}</span>
                    ) : (
                      <span className="font-medium text-[var(--color-danger)]">Unassigned</span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex max-w-80 flex-wrap gap-1.5">
                      {item.reasonCodes.map((code) => (
                        <StatusBadge key={code} label={WORK_REASON[code].label} tone={WORK_REASON[code].tone} />
                      ))}
                    </div>
                    {item.warningMessages[0] ? (
                      <p className="mt-1.5 max-w-80 text-xs leading-relaxed text-[var(--color-ink-faint)]">{item.warningMessages[0]}</p>
                    ) : null}
                  </Td>
                  <Td numeric><Hours value={item.durationHours} /></Td>
                </Tr>
              );
            })}
          </Table>
        </div>
      )}
    </section>
  );
}
function CoverageTable({ rows, canOpenPersonRecords }: { rows: PlanningCoverageRow[]; canOpenPersonRecords: boolean }) {
  return (
    <section>
      <SectionHeading
        title="Current authorization coverage"
        description="Actual and pending hours are contained within each authorization period."
        icon={<Gauge aria-hidden className="h-4 w-4" />}
      />
      {rows.length === 0 ? (
        <EmptyState compact title="No current authorizations" icon={<Gauge aria-hidden className="h-5 w-5" />}>
          There are no active authorization periods containing today.
        </EmptyState>
      ) : (
        <div className="border-y border-[var(--color-rule)]">
          <Table
            caption="Current authorization hours, schedule coverage, and required weekly pace"
            head={
              <>
                <Th>Individual & program</Th>
                <Th>Authorization period</Th>
                <Th numeric>Authorized</Th>
                <Th numeric>Actual</Th>
                <Th numeric>Scheduled</Th>
                <Th numeric>Unplanned</Th>
                <Th numeric>Required / wk</Th>
                <Th>Pace & coverage</Th>
              </>
            }
          >
            {rows.map((row) => {
              const status = COVERAGE_STATUS[row.status];
              const color = row.status === "over_committed"
                ? "var(--color-danger)"
                : row.status === "plan_gap"
                  ? "var(--color-warn)"
                  : row.status === "covered"
                    ? "var(--color-info)"
                    : "var(--color-success)";
              return (
                <Tr key={row.authorizationId}>
                  <Td>
                    {canOpenPersonRecords ? (
                      <Link href={`/individuals/${row.individualId}`} className="font-semibold hover:text-[var(--color-primary)] hover:underline">{row.individualName}</Link>
                    ) : <span className="font-semibold">{row.individualName}</span>}
                    <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">{row.programCode} / {row.programName}</p>
                    {row.eligibleEmployeeCount === 0 ? (
                      <div className="mt-1.5"><StatusBadge label="No effective assignment" tone="warn" /></div>
                    ) : null}
                  </Td>
                  <Td>
                    <p className="font-medium">{row.periodLabel}</p>
                    <p className="mt-0.5 whitespace-nowrap text-xs text-[var(--color-ink-faint)]">{dateLabel(row.startDate)} to {dateLabel(row.endDate)}</p>
                    {row.nextScheduledDate ? <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Next: {dateLabel(row.nextScheduledDate)}</p> : null}
                  </Td>
                  <Td numeric><Hours value={row.authorizedHours} /></Td>
                  <Td numeric><Hours value={row.actualHours} /></Td>
                  <Td numeric><Hours value={row.scheduledHours} /></Td>
                  <Td numeric>
                    <span className={Number(row.unplannedHours) < 0 ? "font-semibold text-[var(--color-danger)]" : ""}>
                      <Hours value={row.unplannedHours} />
                    </span>
                  </Td>
                  <Td numeric>
                    {row.requiredWeeklyHours === null ? <span className="text-[var(--color-ink-faint)]">-</span> : <Hours value={row.requiredWeeklyHours} />}
                  </Td>
                  <Td className="min-w-52">
                    <StatusBadge label={status.label} tone={status.tone} />
                    <div className="mt-2"><PaceBar usagePercent={row.usagePercent} timeElapsedPercent={row.timeElapsedPercent} color={color} /></div>
                    <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
                      {formatPercent(row.usagePercent)} actual / {formatPercent(row.committedPercent)} committed
                    </p>
                  </Td>
                </Tr>
              );
            })}
          </Table>
        </div>
      )}
    </section>
  );
}

function FuturePlans({
  data,
  employees,
  individuals,
  programs,
  canOpenPersonRecords,
  canManageAssignments,
}: {
  data: PlanningWorkspaceData;
  employees: ScheduleCalendarProps["employees"];
  individuals: ScheduleCalendarProps["individuals"];
  programs: ScheduleCalendarProps["programs"];
  canOpenPersonRecords: boolean;
  canManageAssignments: boolean;
}) {
  return (
    <div className="space-y-8">
      <AuthorizationGaps rows={data.authorizationGaps} canOpenPersonRecords={canOpenPersonRecords} />
      <section>
        <SectionHeading
          title="Assignment timeline"
          description="Employee-to-individual assignments that are effective now or in the future."
          icon={<Clock3 aria-hidden className="h-4 w-4" />}
        />
        <AssignmentManager
          rows={data.assignments}
          employees={employees}
          individuals={individuals}
          programs={programs}
          canManage={canManageAssignments}
        />
      </section>
    </div>
  );
}

const AUTH_GAP_LABEL: Record<PlanningAuthorizationGap["gap"], string> = {
  no_assignment: "No assignment",
  starts_uncovered: "Start not covered",
  ends_uncovered: "End not covered",
  boundary_gaps: "Start and end not covered",
  coverage_gap: "Gap inside period",
};

function AuthorizationGaps({ rows, canOpenPersonRecords }: { rows: PlanningAuthorizationGap[]; canOpenPersonRecords: boolean }) {
  return (
    <section>
      <SectionHeading
        title="Authorization assignment gaps"
        description="Current and upcoming authorization dates without continuous employee assignment coverage."
        icon={<UsersRound aria-hidden className="h-4 w-4" />}
      />
      {rows.length === 0 ? (
        <EmptyState compact title="Authorization dates are covered" icon={<CheckCircle2 aria-hidden className="h-5 w-5" />} />
      ) : (
        <div className="border-y border-[var(--color-rule)]">
          <Table
            caption="Current and future authorization assignment gaps"
            head={<><Th>Individual & program</Th><Th>Period</Th><Th>Assigned employees</Th><Th>Gap</Th></>}
          >
            {rows.map((row) => (
              <Tr key={row.authorizationId}>
                <Td>
                  {canOpenPersonRecords ? (
                    <Link href={`/individuals/${row.individualId}`} className="font-semibold hover:text-[var(--color-primary)] hover:underline">{row.individualName}</Link>
                  ) : <span className="font-semibold">{row.individualName}</span>}
                  <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">{row.programName}</p>
                </Td>
                <Td>
                  <p>{row.periodLabel}</p>
                  <p className="mt-0.5 whitespace-nowrap text-xs text-[var(--color-ink-faint)]">{dateLabel(row.startDate)} to {dateLabel(row.endDate)}</p>
                </Td>
                <Td>{row.employeeNames.join(", ") || <span className="text-[var(--color-ink-faint)]">None</span>}</Td>
                <Td><StatusBadge label={AUTH_GAP_LABEL[row.gap]} tone="warn" /></Td>
              </Tr>
            ))}
          </Table>
        </div>
      )}
    </section>
  );
}
