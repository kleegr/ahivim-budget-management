import Link from "next/link";
import type { ReactNode } from "react";
import {
  CalendarDays,
  CircleAlert,
  Clock3,
  KeyRound,
  UserRound,
  UsersRound,
} from "lucide-react";
import {
  EmptyState,
  Hours,
  Money,
  Plain,
  StatusBadge,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { PORTAL_ROLE_LABELS } from "@/lib/auth/portal-access";
import type { AgencyProfileReadModel } from "@/lib/data/agency-profile";
import type { PlanningCoverageRow } from "@/lib/data/planning-queries";
import { dec, toHours } from "@/lib/money";

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));
}

function responsibility(managesBudget: boolean | null, billsServices: boolean | null): string {
  if (managesBudget && billsServices) return "Budget + billing";
  if (managesBudget) return "Budget management";
  if (billsServices) return "Billing only";
  return "Roster only";
}

function intervalLabel(from: string, to: string | null): string {
  return `${from}${to ? ` to ${to}` : " onward"}`;
}

function intervalStatusLabel(status: "current" | "scheduled" | "ended" | "voided"): string {
  if (status === "current") return "Current";
  if (status === "scheduled") return "Scheduled";
  if (status === "ended") return "Ended";
  return "Voided";
}

function intervalTone(status: "current" | "scheduled" | "ended" | "voided"): "good" | "info" | "muted" {
  if (status === "current") return "good";
  if (status === "scheduled") return "info";
  return "muted";
}

function compactLink(href: string, label: string) {
  return <Link href={href} className="touch-target inline-flex items-center text-xs font-semibold text-[var(--color-primary)] hover:underline">{label}</Link>;
}

function anchorValue(href: string, value: ReactNode) {
  return <a href={href} className="underline decoration-[var(--color-rule-strong)] underline-offset-4 hover:text-[var(--color-primary)]">{value}</a>;
}

function coverageTotals(rows: readonly PlanningCoverageRow[] | null): {
  authorized: string;
  actual: string;
  scheduled: string;
  remainingAfterSchedule: string;
} | null {
  if (rows === null) return null;
  return {
    authorized: toHours(rows.reduce((sum, row) => sum.plus(row.authorizedHours), dec(0))),
    actual: toHours(rows.reduce((sum, row) => sum.plus(row.actualHours), dec(0))),
    scheduled: toHours(rows.reduce((sum, row) => sum.plus(row.scheduledHours), dec(0))),
    remainingAfterSchedule: toHours(rows.reduce((sum, row) => sum.plus(row.unplannedHours), dec(0))),
  };
}

function SummaryBand({ profile }: { profile: AgencyProfileReadModel }) {
  const { agency } = profile;
  const totals = coverageTotals(profile.planning?.coverage ?? null);
  const items: Array<{ label: string; value: ReactNode } | null> = [
    {
      label: `Individuals (${monthLabel(agency.month)})`,
      value: anchorValue("#agency-individual-roster", <Plain value={agency.individualCount} />),
    },
    {
      label: `Employees (${monthLabel(agency.month)})`,
      value: anchorValue("#agency-employee-roster", <Plain value={agency.employeeCount} />),
    },
    agency.managedBudgetCount !== null
      ? { label: "Budgets managed", value: anchorValue("#agency-authorizations", <Plain value={agency.managedBudgetCount} />) }
      : null,
    totals
      ? { label: "Authorized hours", value: anchorValue("#agency-authorizations", <Hours value={totals.authorized} />) }
      : null,
    totals
      ? { label: "Actual hours", value: anchorValue("#agency-authorizations", <Hours value={totals.actual} />) }
      : null,
    totals
      ? { label: "Future scheduled", value: anchorValue("#agency-authorizations", <Hours value={totals.scheduled} />) }
      : null,
    totals
      ? { label: "Remaining after schedule", value: anchorValue("#agency-authorizations", <Hours value={totals.remainingAfterSchedule} />) }
      : null,
  ];
  const visibleItems = items.filter((item): item is { label: string; value: ReactNode } => item !== null);
  if (visibleItems.length === 0) return null;
  return (
    <dl className="grid border-y border-[var(--color-rule)] sm:grid-cols-2 lg:grid-cols-4">
      {visibleItems.map((item) => (
        <div key={item.label} className="border-b border-r border-[var(--color-rule)] px-4 py-3">
          <dt className="text-xs text-[var(--color-ink-faint)]">{item.label}</dt>
          <dd className="tnum mt-1 text-base font-semibold">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Attention({ profile }: { profile: AgencyProfileReadModel }) {
  if (!profile.planning) return null;
  const work = profile.planning.workQueue ?? [];
  const gaps = profile.planning.authorizationGaps ?? [];
  const visible = profile.planning.workQueue !== null || profile.planning.authorizationGaps !== null;
  if (!visible) return null;
  return (
    <section id="agency-exceptions" aria-labelledby="agency-exceptions-heading" className="scroll-mt-24 border-y border-[var(--color-rule)]">
      <div className="border-b border-[var(--color-rule)] px-4 py-3">
        <h2 id="agency-exceptions-heading" className="display flex items-center gap-2 text-base font-semibold">
          <CircleAlert aria-hidden className="h-4 w-4 text-[var(--color-primary)]" /> Current exceptions
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Only schedule and authorization issues inside this agency&rsquo;s dated roster are included.</p>
      </div>
      {work.length === 0 && gaps.length === 0 ? (
        <EmptyState compact title="No current agency planning exceptions" icon={<CircleAlert aria-hidden className="h-5 w-5" />} />
      ) : (
        <Table caption="Current agency planning exceptions" head={<><Th>Source</Th><Th>People</Th><Th>Program</Th><Th>Issue</Th><Th>Action</Th></>}>
          {work.map((item) => (
            <Tr key={`session-${item.id}`}>
              <Td><p className="font-medium">{item.sessionDate}</p><p className="text-xs text-[var(--color-ink-faint)]">Scheduled visit</p></Td>
              <Td><p>{item.individualNames.join(", ") || "Individual not set"}</p><p className="text-xs text-[var(--color-ink-faint)]">{item.employeeName ?? "Employee unassigned"}</p></Td>
              <Td>{item.programName}</Td>
              <Td>{item.reasonCodes.map((code) => code.replaceAll("_", " ")).join(" · ")}</Td>
              <Td>{compactLink(`/schedule?view=calendar&date=${item.sessionDate}&sessionId=${item.id}`, "Repair visit")}</Td>
            </Tr>
          ))}
          {gaps.map((item) => (
            <Tr key={`authorization-${item.authorizationId}`}>
              <Td><p className="font-medium">{item.periodLabel}</p><p className="text-xs text-[var(--color-ink-faint)]">Authorization</p></Td>
              <Td>{item.individualName}</Td>
              <Td>{item.programName}</Td>
              <Td>{item.gap.replaceAll("_", " ")}</Td>
              <Td>{profile.permissions.canReadSchedules
                ? compactLink(`/schedule?view=coverage&individualId=${item.individualId}&programId=${item.programId}`, "Review coverage")
                : <Plain value={null} />}</Td>
            </Tr>
          ))}
        </Table>
      )}
    </section>
  );
}

function AuthorizationPlanning({ profile }: { profile: AgencyProfileReadModel }) {
  const coverage = profile.planning?.coverage;
  if (coverage === null || coverage === undefined) return null;
  return (
    <section id="agency-authorizations" aria-labelledby="agency-authorizations-heading" className="scroll-mt-24 border-y border-[var(--color-rule)]">
      <div className="border-b border-[var(--color-rule)] px-4 py-3">
        <h2 id="agency-authorizations-heading" className="display flex items-center gap-2 text-base font-semibold"><Clock3 aria-hidden className="h-4 w-4 text-[var(--color-primary)]" /> Programs and authorizations</h2>
        <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Authorization-period actuals and future scheduled hours as of {profile.asOf}. These are separate from the selected financial reporting month.</p>
      </div>
      {coverage.length === 0 ? (
        <EmptyState compact title="No current hourly authorizations in this agency scope" icon={<Clock3 aria-hidden className="h-5 w-5" />} />
      ) : (
        <Table caption="Agency authorization and scheduling coverage" head={<>
          <Th>Individual</Th><Th>Program</Th><Th>Authorization period</Th><Th numeric>Authorized</Th><Th numeric>Actual</Th><Th numeric>Scheduled</Th><Th numeric>After schedule</Th><Th>Status</Th><Th>Open</Th>
        </>}>
          {coverage.map((row) => (
            <Tr key={row.authorizationId}>
              <Td>{row.individualName}</Td>
              <Td><p className="font-medium">{row.programName}</p><p className="text-xs text-[var(--color-ink-faint)]">{row.programCode}</p></Td>
              <Td><p>{row.periodLabel}</p><p className="text-xs text-[var(--color-ink-faint)]">{row.startDate} to {row.endDate}</p></Td>
              <Td numeric><Hours value={row.authorizedHours} /></Td>
              <Td numeric><Hours value={row.actualHours} /></Td>
              <Td numeric><Hours value={row.scheduledHours} /></Td>
              <Td numeric><Hours value={row.unplannedHours} /></Td>
              <Td><StatusBadge tone={row.status === "over_committed" ? "danger" : row.status === "plan_gap" || row.eligibleEmployeeCount === 0 ? "warn" : "good"} label={row.status.replaceAll("_", " ")} /></Td>
              <Td>{profile.permissions.canReadSchedules ? compactLink(`/schedule?view=coverage&individualId=${row.individualId}&programId=${row.programId}`, "Open") : <Plain value={null} />}</Td>
            </Tr>
          ))}
        </Table>
      )}
    </section>
  );
}

function DatedRosters({ profile }: { profile: AgencyProfileReadModel }) {
  if (profile.individualRoster === null && profile.employeeRoster === null) return null;
  const individuals = profile.individualRoster ?? [];
  const employees = profile.employeeRoster ?? [];
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <section id="agency-individual-roster" aria-labelledby="agency-individual-roster-heading" className="scroll-mt-24 border-y border-[var(--color-rule)]">
        <div className="border-b border-[var(--color-rule)] px-4 py-3">
          <h2 id="agency-individual-roster-heading" className="display flex items-center gap-2 text-base font-semibold"><UserRound aria-hidden className="h-4 w-4 text-[var(--color-primary)]" /> Dated Individual roster</h2>
          <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Budget, billing, both, and roster-only responsibility are preserved as dated history.</p>
        </div>
        {individuals.length === 0 ? (
          <EmptyState compact title="No Individual roster history" icon={<UserRound aria-hidden className="h-5 w-5" />} />
        ) : (
          <Table caption="Dated agency Individual roster" head={<><Th>Individual</Th><Th>Responsibility</Th><Th>Effective</Th><Th>Status</Th><Th>Open</Th></>}>
            {individuals.map((entry) => (
              <Tr key={entry.membershipId}>
                <Td>{profile.permissions.isOwner ? <Link href={`/individuals/${entry.individualId}`} className="font-semibold text-[var(--color-primary)] hover:underline">{entry.individualName}</Link> : entry.individualName}</Td>
                <Td><StatusBadge tone={entry.managesBudget ? "good" : entry.billsServices ? "warn" : "muted"} label={responsibility(entry.managesBudget, entry.billsServices)} /></Td>
                <Td><span className="text-xs">{intervalLabel(entry.effectiveFrom, entry.effectiveTo)}</span></Td>
                <Td><StatusBadge tone={intervalTone(entry.intervalStatus)} label={intervalStatusLabel(entry.intervalStatus)} /></Td>
                <Td>{profile.permissions.canReadSchedules && entry.currentlyEffective ? compactLink(`/schedule?view=calendar&individualId=${entry.individualId}`, "Schedule") : <Plain value={null} />}</Td>
              </Tr>
            ))}
          </Table>
        )}
      </section>

      <section id="agency-employee-roster" aria-labelledby="agency-employee-roster-heading" className="scroll-mt-24 border-y border-[var(--color-rule)]">
        <div className="border-b border-[var(--color-rule)] px-4 py-3">
          <h2 id="agency-employee-roster-heading" className="display flex items-center gap-2 text-base font-semibold"><UsersRound aria-hidden className="h-4 w-4 text-[var(--color-primary)]" /> Dated Employee roster</h2>
          <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Current, future, ended, and voided intervals remain distinct.</p>
        </div>
        {employees.length === 0 ? (
          <EmptyState compact title="No Employee roster history" icon={<UsersRound aria-hidden className="h-5 w-5" />} />
        ) : (
          <Table caption="Dated agency Employee roster" head={<><Th>Employee</Th><Th>Effective</Th><Th>Status</Th><Th>Open</Th></>}>
            {employees.map((entry) => (
              <Tr key={entry.membershipId}>
                <Td>{profile.permissions.isOwner ? <Link href={`/employees/${entry.employeeId}`} className="font-semibold text-[var(--color-primary)] hover:underline">{entry.employeeName}</Link> : entry.employeeName}</Td>
                <Td><span className="text-xs">{intervalLabel(entry.effectiveFrom, entry.effectiveTo)}</span></Td>
                <Td><StatusBadge tone={intervalTone(entry.intervalStatus)} label={intervalStatusLabel(entry.intervalStatus)} /></Td>
                <Td>{profile.permissions.canReadSchedules && entry.currentlyEffective ? compactLink(`/schedule?view=calendar&employeeId=${entry.employeeId}`, "Schedule") : <Plain value={null} />}</Td>
              </Tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}

function Assignments({ profile }: { profile: AgencyProfileReadModel }) {
  const assignments = profile.planning?.assignments;
  if (assignments === null || assignments === undefined) return null;
  return (
    <section id="agency-assignments" aria-labelledby="agency-assignments-heading" className="scroll-mt-24 border-y border-[var(--color-rule)]">
      <div className="border-b border-[var(--color-rule)] px-4 py-3">
        <h2 id="agency-assignments-heading" className="display text-base font-semibold">Assignments</h2>
        <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Active pairings whose full effective interval is covered by this agency roster.</p>
      </div>
      {assignments.length === 0 ? (
        <EmptyState compact title="No active assignments in this agency scope" icon={<UsersRound aria-hidden className="h-5 w-5" />} />
      ) : (
        <Table caption="Agency-scoped assignments" head={<><Th>Individual</Th><Th>Employee</Th><Th>Program</Th><Th>Effective</Th><Th numeric>Allowed hours</Th><Th>Status</Th><Th>Open</Th></>}>
          {assignments.map((row) => (
            <Tr key={row.id}>
              <Td>{row.individualName}</Td><Td>{row.employeeName}</Td><Td><Plain value={row.programName} /></Td>
              <Td>{row.startDate ?? "Any start"}{row.endDate ? ` to ${row.endDate}` : " onward"}</Td>
              <Td numeric>{row.allowedHours === null ? <Plain value={null} /> : <Hours value={row.allowedHours} />}</Td>
              <Td><StatusBadge tone={row.timing === "ending_soon" ? "warn" : row.timing === "future" ? "info" : "good"} label={row.timing.replaceAll("_", " ")} /></Td>
              <Td>{compactLink(`/schedule?view=coverage&individualId=${row.individualId}&employeeId=${row.employeeId}`, "Open")}</Td>
            </Tr>
          ))}
        </Table>
      )}
    </section>
  );
}

function FinancialActivity({ profile }: { profile: AgencyProfileReadModel }) {
  const { agency } = profile;
  const selectedMonth = monthLabel(agency.month);
  const financialItems = [
    { label: "Funder billed", value: agency.billedThisMonth },
    { label: "Individual set-aside", value: agency.setAsideThisMonth },
    { label: "Agency-paid employee base", value: agency.agencyPaidThisMonth },
    { label: "Verified direct-check gross", value: agency.payrollGrossThisMonth },
    { label: "Verified direct-check net", value: agency.payrollNetThisMonth },
    { label: "Current give-back remaining", value: agency.giveBackRemaining },
  ].filter((item): item is { label: string; value: string } => item.value !== null);
  if (financialItems.length === 0) return null;
  const individuals = agency.individuals ?? [];
  const employees = agency.employees ?? [];
  const checks = employees.flatMap((employee) => (employee.checks ?? []).map((check) => ({ employee, check })));
  return (
    <section id="agency-financial-sources" aria-labelledby="agency-financial-heading" className="scroll-mt-24 border-y border-[var(--color-rule)]">
      <div className="border-b border-[var(--color-rule)] px-4 py-3">
        <h2 id="agency-financial-heading" className="display text-base font-semibold">Actual financial activity</h2>
        <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Recorded values for {selectedMonth}, except the current outstanding give-back balance. The rows below come from the same agency-scoped model as these totals; broader person ledgers are not used.</p>
      </div>
      <dl className="grid sm:grid-cols-2 lg:grid-cols-3">
        {financialItems.map((item) => (
          <div key={item.label} className="border-b border-r border-[var(--color-rule)] px-4 py-3">
            <dt className="text-xs text-[var(--color-ink-faint)]">{item.label}</dt>
            <dd className="tnum mt-1 text-base font-semibold"><Money value={item.value} /></dd>
          </div>
        ))}
      </dl>
      {individuals.length > 0 ? (
        <div className="border-t border-[var(--color-rule)]">
          <p className="border-b border-[var(--color-rule)] px-4 py-2.5 text-xs font-semibold text-[var(--color-ink-soft)]">Exact Individual and program rollups</p>
          <Table caption="Agency-scoped Individual financial sources" head={<><Th>Individual</Th><Th>Responsibility</Th><Th>Programs</Th><Th numeric>Billed</Th><Th numeric>Set aside</Th><Th numeric>Direct checks</Th><Th numeric>Agency-paid</Th></>}>
            {individuals.map((individual) => (
              <Tr key={individual.id}>
                <Td>{individual.name}</Td>
                <Td><StatusBadge tone={individual.managesBudget ? "good" : individual.billsServices ? "warn" : "muted"} label={responsibility(individual.managesBudget, individual.billsServices)} /></Td>
                <Td>{individual.programs === null ? <Plain value={null} /> : individual.programs.length === 0 ? "No program source" : <ul className="space-y-1">{individual.programs.map((program) => <li key={program.id ?? `${program.code}:${program.name}`}><span className="font-medium">{program.name}</span>{program.code ? <span className="text-xs text-[var(--color-ink-faint)]"> · {program.code}</span> : null}</li>)}</ul>}</Td>
                <Td numeric><Money value={individual.billedThisMonth} /></Td>
                <Td numeric><Money value={individual.setAsideThisMonth} /></Td>
                <Td numeric><Money value={individual.directChecksThisMonth} /></Td>
                <Td numeric><Money value={individual.agencyPaidThisMonth} /></Td>
              </Tr>
            ))}
          </Table>
        </div>
      ) : null}
      {employees.length > 0 ? (
        <div className="border-t border-[var(--color-rule)]">
          <p className="border-b border-[var(--color-rule)] px-4 py-2.5 text-xs font-semibold text-[var(--color-ink-soft)]">Exact Employee rollups</p>
          <Table caption="Agency-scoped Employee financial sources" head={<><Th>Employee</Th><Th numeric>Verified gross</Th><Th numeric>Verified net</Th><Th numeric>Give-back due</Th><Th numeric>Collected</Th><Th numeric>Remaining</Th></>}>
            {employees.map((employee) => (
              <Tr key={employee.id}>
                <Td>{employee.name}</Td><Td numeric><Money value={employee.payrollGrossThisMonth} /></Td><Td numeric><Money value={employee.payrollNetThisMonth} /></Td>
                <Td numeric><Money value={employee.giveBack?.dueThisMonth ?? null} /></Td><Td numeric><Money value={employee.giveBack?.collectedThisMonth ?? null} /></Td><Td numeric><Money value={employee.giveBack?.remaining ?? null} /></Td>
              </Tr>
            ))}
          </Table>
        </div>
      ) : null}
      {checks.length > 0 ? (
        <div className="border-t border-[var(--color-rule)]">
          <p className="border-b border-[var(--color-rule)] px-4 py-2.5 text-xs font-semibold text-[var(--color-ink-soft)]">Uniquely attributed verified checks</p>
          <Table caption="Agency-scoped verified check sources" head={<><Th>Employee</Th><Th>Check</Th><Th>Service date</Th><Th numeric>Gross</Th><Th numeric>Net</Th></>}>
            {checks.map(({ employee, check }) => (
              <Tr key={check.id}><Td>{employee.name}</Td><Td><Plain value={check.checkNumber} /></Td><Td><Plain value={check.serviceDate} /></Td><Td numeric><Money value={check.actualGross ?? null} /></Td><Td numeric><Money value={check.actualNet ?? null} /></Td></Tr>
            ))}
          </Table>
        </div>
      ) : null}
    </section>
  );
}

function AgencyUsers({ profile }: { profile: AgencyProfileReadModel }) {
  if (profile.linkedUsers === null) return null;
  return (
    <section id="agency-users" aria-labelledby="agency-users-heading" className="scroll-mt-24 border-y border-[var(--color-rule)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-rule)] px-4 py-3">
        <div>
          <h2 id="agency-users-heading" className="display flex items-center gap-2 text-base font-semibold"><KeyRound aria-hidden className="h-4 w-4 text-[var(--color-primary)]" /> Agency users</h2>
          <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Owner-only account and portal-role context.</p>
        </div>
        {compactLink("/settings/agencies", "Manage access")}
      </div>
      {profile.linkedUsers.length === 0 ? (
        <EmptyState compact title="No user account is linked to this agency" icon={<KeyRound aria-hidden className="h-5 w-5" />} />
      ) : (
        <Table caption="Agency user access" head={<><Th>Account</Th><Th>Portal role</Th><Th>Status</Th><Th>Overrides</Th></>}>
          {profile.linkedUsers.map((entry) => (
            <Tr key={`${entry.userId}-${entry.role}`}>
              <Td><p className="font-medium">{entry.displayName}</p><p className="text-xs text-[var(--color-ink-faint)]">{entry.email}</p></Td>
              <Td>{PORTAL_ROLE_LABELS[entry.role]}</Td>
              <Td><StatusBadge tone={entry.isActive ? "good" : "muted"} label={entry.isActive ? "Active" : "Inactive"} /></Td>
              <Td>{entry.capabilityGrants.length} grants · {entry.capabilityDenials.length} denials</Td>
            </Tr>
          ))}
        </Table>
      )}
    </section>
  );
}

export default function AgencyProfile({ profile }: { profile: AgencyProfileReadModel }) {
  return (
    <div className="space-y-7">
      <form action={`/agencies/${profile.agency.id}`} method="get" className="flex flex-wrap items-end justify-between gap-3 border-y border-[var(--color-rule)] py-3">
        <label>
          <span className="inline-flex items-center gap-1.5 text-sm font-medium"><CalendarDays aria-hidden className="h-4 w-4 text-[var(--color-primary)]" /> Financial reporting month</span>
          <input type="month" name="month" defaultValue={profile.agency.month} className="mt-1 block rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm" />
        </label>
        <button type="submit" className="btn btn-secondary btn-sm">View month</button>
      </form>

      <SummaryBand profile={profile} />
      <Attention profile={profile} />
      <AuthorizationPlanning profile={profile} />
      <DatedRosters profile={profile} />
      <Assignments profile={profile} />
      <FinancialActivity profile={profile} />
      <AgencyUsers profile={profile} />
    </div>
  );
}
