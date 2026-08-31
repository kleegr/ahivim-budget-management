import type { ReactNode } from "react";
import { CalendarClock, Clock3 } from "lucide-react";
import ScheduleCalendar, { type ScheduleCalendarProps } from "@/components/schedule/calendar";
import AssignmentManager from "@/components/schedule/assignment-manager";
import EmployeeAvailabilityManager from "@/components/schedule/employee-availability-manager";
import ServiceSchedules from "@/components/schedule/service-schedules";
import BudgetCoveragePanel from "@/components/schedule/budget-coverage-panel";
import DirectPayTargetsPanel from "@/components/schedule/direct-pay-targets-panel";
import { TabPanels } from "@/components/ui-client";
import type { PlanningWorkspaceData } from "@/lib/data/planning-queries";
import type { PlannerDirectPayTargetRow } from "@/lib/data/direct-pay-operations";
import type { View } from "./shared";

interface PlanningWorkspaceProps {
  data: PlanningWorkspaceData;
  canManage: boolean;
  canManageAssignments?: boolean;
  today: string;
  initialView?: string;
  initialCalendarDate?: string;
  initialCalendarView?: View;
  initialFilters?: ScheduleCalendarProps["initialFilters"];
  employees: ScheduleCalendarProps["employees"];
  individuals: ScheduleCalendarProps["individuals"];
  programs: ScheduleCalendarProps["programs"];
  directPayTargets?: PlannerDirectPayTargetRow[];
  showDirectPayTargets?: boolean;
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
  today,
  initialView,
  initialCalendarDate,
  initialCalendarView,
  initialFilters,
  employees,
  individuals,
  programs,
  directPayTargets = [],
  showDirectPayTargets = false,
}: PlanningWorkspaceProps) {
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
    <div>
      <TabPanels
        paramKey="view"
        initialId={initialView}
        panels={[
          { id: "calendar", label: "Calendar", content: calendar },
          {
            id: "coverage",
            label: "Budget tracking",
            content: <BudgetCoveragePanel rows={data.coverage} />,
          },
          {
            id: "schedules",
            label: "Recurring schedules",
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
          {
            id: "future",
            label: "Assignments",
            content: (
              <FuturePlans
                data={data}
                employees={employees}
                individuals={individuals}
                programs={programs}
                canManageAssignments={canManageAssignments}
              />
            ),
          },
          {
            id: "availability",
            label: "Employee hours",
            content: (
              <section>
                <SectionHeading
                  title="Employee hours and time off"
                  description="Keep the calendar aligned with when each employee can work."
                  icon={<CalendarClock aria-hidden className="h-4 w-4" />}
                />
                <EmployeeAvailabilityManager
                  employees={employees}
                  initialEmployeeId={initialFilters?.employeeId}
                  today={today}
                  canManage={canManageAssignments}
                />
              </section>
            ),
          },
          ...(showDirectPayTargets ? [{
            id: "targets",
            label: "Employee targets",
            content: <DirectPayTargetsPanel rows={directPayTargets} />,
          }] : []),
        ]}
      />
    </div>
  );
}

function FuturePlans({
  data,
  employees,
  individuals,
  programs,
  canManageAssignments,
}: {
  data: PlanningWorkspaceData;
  employees: ScheduleCalendarProps["employees"];
  individuals: ScheduleCalendarProps["individuals"];
  programs: ScheduleCalendarProps["programs"];
  canManageAssignments: boolean;
}) {
  return (
    <section>
      <SectionHeading
        title="Assignments"
        description="Choose which employees can work with each person and program."
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
  );
}
