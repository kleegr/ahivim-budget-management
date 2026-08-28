import { requirePlanningUser } from "@/lib/auth/planning-access";
import { withDb } from "@/lib/data/pool";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import { listEmployeesManaged } from "@/lib/manage/employees";
import { listPrograms } from "@/lib/data/app-queries";
import { getPlanningWorkspace } from "@/lib/data/planning-queries";
import { listPlannerDirectPayTargets } from "@/lib/data/direct-pay-operations";
import { PageHeader, ErrorPanel } from "@/components/ui";
import PlanningWorkspace from "@/components/schedule/planning-workspace";
import DirectPayTargetsPanel from "@/components/schedule/direct-pay-targets-panel";
import type { View } from "@/components/schedule/shared";
import { agencyDate } from "@/lib/business/agency-time";

export const dynamic = "force-dynamic";
export const metadata = { title: "Planning — Ahivim Budget Management" };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLANNING_VIEWS = new Set(["schedules", "calendar", "coverage", "queue", "future"]);
const CALENDAR_VIEWS = new Set<View>(["month", "week", "day"]);

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePlanningUser();
  const canManage = true;
  const today = agencyDate();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const requestedView = one(sp.view);
  const initialView = requestedView && PLANNING_VIEWS.has(requestedView) ? requestedView : "schedules";
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
    const [individuals, employees, programs, planning, directPayTargets] = await Promise.all([
      listIndividualsManaged(pool, { status: "active" }),
      listEmployeesManaged(pool, { status: "active" }),
      listPrograms(pool),
      getPlanningWorkspace(pool, today),
      listPlannerDirectPayTargets(pool, today),
    ]);
    return { individuals, employees, programs, planning, directPayTargets };
  });

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Planning"
        description="Plan employee and individual service hours, protect authorizations, and resolve schedule conflicts."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load scheduling data">{result.error}</ErrorPanel>
      ) : (
        <>
          <DirectPayTargetsPanel rows={result.data.directPayTargets} />
          <PlanningWorkspace
            data={result.data.planning}
            canManage={canManage}
            today={today}
            initialView={initialView}
            initialCalendarDate={initialCalendarDate}
            initialCalendarView={initialCalendarView}
            initialFilters={initialFilters}
            individuals={result.data.individuals.map((i) => ({ id: i.id, label: i.displayName }))}
            employees={result.data.employees.map((e) => ({ id: e.id, label: e.displayName }))}
            programs={result.data.programs
              .filter((p) => p.isActive
                && p.requiredAuthType !== "dollars"
                && (p.consumptionSource === "payroll" || p.consumptionSource === "mixed"))
              .map((p) => ({ id: p.id, code: p.code, name: p.name, isGroupCapable: p.isGroupCapable }))}
          />
        </>
      )}
    </>
  );
}
