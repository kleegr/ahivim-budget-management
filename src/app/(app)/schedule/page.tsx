import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import { listEmployeesManaged } from "@/lib/manage/employees";
import { listPrograms } from "@/lib/data/app-queries";
import { PageHeader, ErrorPanel } from "@/components/ui";
import ScheduleCalendar from "@/components/schedule/calendar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Schedule — Ahivim Budget Management" };

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("manager");
  const canManage = user.role !== "viewer";
  const today = new Date().toISOString().slice(0, 10);
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const initialFilters = {
    employeeId: one(sp.employeeId),
    individualId: one(sp.individualId),
    programId: one(sp.programId),
    status: one(sp.status),
    unassigned: sp.unassigned === "true",
  };

  const result = await withDb(async (pool) => ({
    individuals: await listIndividualsManaged(pool, { status: "active" }),
    employees: await listEmployeesManaged(pool, { status: "active" }),
    programs: await listPrograms(pool),
  }));

  return (
    <>
      <PageHeader
        eyebrow="Planning"
        title="Schedule"
        description="Plan one-off and recurring sessions. Conflicts are flagged but never block — save with a reason. Every session shows its forecast against each individual's approved hours."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load scheduling data">{result.error}</ErrorPanel>
      ) : (
        <ScheduleCalendar
          canManage={canManage}
          today={today}
          initialFilters={initialFilters}
          individuals={result.data.individuals.map((i) => ({ id: i.id, label: i.displayName }))}
          employees={result.data.employees.map((e) => ({ id: e.id, label: e.displayName }))}
          programs={result.data.programs
            .filter((p) => p.isActive)
            .map((p) => ({ id: p.id, code: p.code, name: p.name, isGroupCapable: p.isGroupCapable }))}
        />
      )}
    </>
  );
}
