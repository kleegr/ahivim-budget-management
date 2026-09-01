import { notFound } from "next/navigation";
import { UpcomingSchedule } from "@/components/portal/portal-home";
import { ButtonLink, ErrorPanel, PageHeader } from "@/components/ui";
import {
  hasPortalEmployeeCapability,
  hasPortalIndividualCapability,
  resolvePortalAccess,
} from "@/lib/auth/portal-access";
import { requireUser } from "@/lib/auth/session";
import {
  employeePortalUpcomingSchedule,
  individualPortalUpcomingSchedule,
} from "@/lib/data/portal-schedule";
import { withDb } from "@/lib/data/pool";

export const dynamic = "force-dynamic";
export const metadata = { title: "My schedule - Ahivim Budget Management" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function PortalSchedulePage({
  searchParams,
}: {
  searchParams: Promise<{
    individualId?: string | string[];
    employeeId?: string | string[];
  }>;
}) {
  const user = await requireUser("viewer");
  const params = await searchParams;
  const individualId = typeof params.individualId === "string" ? params.individualId : null;
  const employeeId = typeof params.employeeId === "string" ? params.employeeId : null;
  const hasIndividual = individualId !== null && UUID.test(individualId);
  const hasEmployee = employeeId !== null && UUID.test(employeeId);
  if (hasIndividual === hasEmployee) notFound();

  const result = await withDb(async (pool) => {
    const access = await resolvePortalAccess(pool, user);
    if (hasIndividual) {
      if (!hasPortalIndividualCapability(access, individualId, "schedules.self.read")) return null;
      const person = await pool.query<{ name: string }>(
        `SELECT display_name AS name
           FROM individuals
          WHERE id = $1 AND status <> 'archived'`,
        [individualId],
      );
      if (!person.rows[0]) return null;
      return {
        name: person.rows[0].name,
        schedule: await individualPortalUpcomingSchedule(pool, individualId),
      };
    }

    if (!hasPortalEmployeeCapability(access, employeeId!, "schedules.self.read")) return null;
    const person = await pool.query<{ name: string }>(
      `SELECT display_name AS name
         FROM employees
        WHERE id = $1 AND status <> 'archived'`,
      [employeeId],
    );
    if (!person.rows[0]) return null;
    return {
      name: person.rows[0].name,
      schedule: await employeePortalUpcomingSchedule(pool, employeeId!),
    };
  });

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="My portal" title="Schedule unavailable" />
        <ErrorPanel title="Could not load the schedule">{result.error}</ErrorPanel>
      </>
    );
  }
  if (result.data === null) notFound();

  return (
    <>
      <PageHeader
        eyebrow="My portal"
        title={`${result.data.name}'s schedule`}
        description="Upcoming visits for the next 60 days."
        action={<ButtonLink href="/portal">Back to portal</ButtonLink>}
      />
      <div className="overflow-hidden border-y border-[var(--color-rule)] bg-[var(--color-surface)]">
        <UpcomingSchedule schedule={result.data.schedule} summaryLimit={null} />
      </div>
    </>
  );
}
