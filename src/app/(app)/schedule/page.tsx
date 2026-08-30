import { requirePlanningUser } from "@/lib/auth/planning-access";
import { withDb } from "@/lib/data/pool";
import {
  filterPlanningWorkspaceForAgency,
  getPlanningReferenceData,
  getPlanningWorkspace,
} from "@/lib/data/planning-queries";
import { PageHeader, ErrorPanel } from "@/components/ui";
import PlanningWorkspace from "@/components/schedule/planning-workspace";
import type { View } from "@/components/schedule/shared";
import { agencyDate } from "@/lib/business/agency-time";

export const dynamic = "force-dynamic";
export const metadata = { title: "Schedule - Ahivim" };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLANNING_VIEWS = new Set(["calendar", "schedules", "future"]);
const CALENDAR_VIEWS = new Set<View>(["month", "week", "day"]);

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const planningAccess = await requirePlanningUser();
  const canManage = planningAccess.canManageSchedules;
  const today = agencyDate();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const requestedView = one(sp.view);
  const initialView = requestedView && PLANNING_VIEWS.has(requestedView) ? requestedView : "calendar";
  const requestedDate = one(sp.date);
  const initialCalendarDate = requestedDate && ISO_DATE.test(requestedDate) ? requestedDate : today;
  const requestedCalendarView = one(sp.calendarView);
  const initialCalendarView = requestedCalendarView && CALENDAR_VIEWS.has(requestedCalendarView as View)
    ? requestedCalendarView as View
    : requestedDate
      ? "day"
      : "week";
  const initialFilters = {
    employeeId: one(sp.employeeId),
    individualId: one(sp.individualId),
    programId: one(sp.programId),
    status: one(sp.status),
    unassigned: sp.unassigned === "true",
  };

  const result = await withDb(async (pool) => {
    const [reference, planning] = await Promise.all([
      getPlanningReferenceData(pool, planningAccess.access),
      getPlanningWorkspace(pool, today, planningAccess.access, planningAccess.agencyIds),
    ]);
    return {
      reference,
      planning: filterPlanningWorkspaceForAgency(planning, planningAccess.agencyRosters),
    };
  });

  return (
    <>
      <PageHeader
        eyebrow="Schedule"
        title="Calendar"
        description="See scheduled work and add sessions."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load scheduling data">{result.error}</ErrorPanel>
      ) : (
        <>
          <PlanningWorkspace
            data={result.data.planning}
            canManage={canManage}
            canManageAssignments={planningAccess.canManageAssignments}
            today={today}
            initialView={initialView}
            initialCalendarDate={initialCalendarDate}
            initialCalendarView={initialCalendarView}
            initialFilters={initialFilters}
            individuals={result.data.reference.individuals}
            employees={result.data.reference.employees}
            programs={result.data.reference.programs.map((p) => ({
              id: p.id,
              code: p.code,
              name: p.name,
              isGroupCapable: p.isGroupCapable,
            }))}
          />
        </>
      )}
    </>
  );
}
