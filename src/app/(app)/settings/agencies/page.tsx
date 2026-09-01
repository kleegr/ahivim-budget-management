import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, ContactRound, Plus, ShieldCheck, UserRound, UsersRound } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import {
  hasPortalCapability,
  PORTAL_ROLE_LABELS,
  resolvePortalAccess,
  type AgencyPortalRole,
  type PortalCapability,
} from "@/lib/auth/portal-access";
import { listUsers } from "@/lib/auth/users";
import { withDb } from "@/lib/data/pool";
import { agencyDate } from "@/lib/business/agency-time";
import {
  listAgencies,
  listAgencyEmployeeMemberships,
  listAgencyIndividualMemberships,
  listAgencyUserAccess,
} from "@/lib/manage/agencies";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import { listEmployeesManaged } from "@/lib/manage/employees";
import {
  listEmployeePortalAssignments,
  listGlobalPortalRoleAssignments,
  listIndividualPortalAssignments,
} from "@/lib/manage/portal-identities";
import { ActionButton, CreateButton, Field, SelectField, TextAreaField } from "@/components/manage/client";
import { Card, EmptyState, ErrorPanel, Metric, PageHeader, StatusBadge, Table, Td, Th, Tr } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agencies and portal access - Ahivim Budget Management" };

const VISIBILITY_OPTIONS = [
  { value: "default", label: "Role default" },
  { value: "show", label: "Show" },
  { value: "hide", label: "Hide" },
];

function policyValue(
  capability: PortalCapability,
  grants: readonly PortalCapability[],
  denials: readonly PortalCapability[],
): "default" | "show" | "hide" {
  if (denials.includes(capability)) return "hide";
  return grants.includes(capability) ? "show" : "default";
}

function VisibilityFields({
  mode,
  role,
  grants = [],
  denials = [],
}: {
  mode: "individual" | "employee" | "agency";
  role?: AgencyPortalRole;
  grants?: readonly PortalCapability[];
  denials?: readonly PortalCapability[];
}) {
  const agencyAdministrator = mode !== "agency" || role === undefined || role === "agency";
  const agencyFinancial = mode !== "agency" || role === undefined || role === "agency" || role === "collector";
  const capability = (self: PortalCapability, agency: PortalCapability) => mode === "agency" ? agency : self;
  return (
    <fieldset className="space-y-3 border-t border-[var(--color-rule)] pt-3">
      <legend className="text-sm font-semibold">Financial visibility</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {mode !== "employee" && agencyAdministrator ? <SelectField label="Dollar budgets" name="dollarBudgets" defaultValue={policyValue(capability("dollar_budgets.self.read", "dollar_budgets.agency.read"), grants, denials)} options={VISIBILITY_OPTIONS} /> : null}
        {mode !== "employee" && agencyFinancial ? <SelectField label="Billed totals" name="billedTotals" defaultValue={policyValue(capability("financials.self.billed_totals.read", "financials.agency.billed_totals.read"), grants, denials)} options={VISIBILITY_OPTIONS} /> : null}
        {mode !== "employee" && agencyFinancial ? <SelectField label="Cuts and set-asides" name="cutsSetAsides" defaultValue={policyValue(capability("financials.self.cuts_set_asides.read", "financials.agency.cuts_set_asides.read"), grants, denials)} options={VISIBILITY_OPTIONS} /> : null}
        {mode !== "employee" && agencyFinancial ? <SelectField label="Direct checks" name="directChecks" defaultValue={policyValue(capability("financials.self.direct_checks.read", "financials.agency.direct_checks.read"), grants, denials)} options={VISIBILITY_OPTIONS} /> : null}
        {mode !== "employee" && agencyFinancial ? <SelectField label="Agency-paid amounts" name="agencyPaidAmounts" defaultValue={policyValue(capability("financials.self.agency_paid.read", "financials.agency.agency_paid.read"), grants, denials)} options={VISIBILITY_OPTIONS} /> : null}
        {mode === "employee" ? <SelectField label="Check gross" name="checkGross" defaultValue={policyValue("employee_checks.self.gross.read", grants, denials)} options={VISIBILITY_OPTIONS} /> : null}
        {mode === "employee" ? <SelectField label="Check net" name="checkNet" defaultValue={policyValue("employee_checks.self.net.read", grants, denials)} options={VISIBILITY_OPTIONS} /> : null}
        {mode === "employee" ? <SelectField label="Tax withheld" name="checkTax" defaultValue={policyValue("employee_checks.self.tax.read", grants, denials)} options={VISIBILITY_OPTIONS} /> : null}
        {mode === "employee" ? <SelectField label="Give-back" name="giveBack" defaultValue={policyValue("employee_giveback.self.read", grants, denials)} options={VISIBILITY_OPTIONS} /> : null}
      </div>
    </fieldset>
  );
}

export default async function AgencySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ roster?: string }>;
}) {
  const rosterFilter = (await searchParams).roster === "billing-only" ? "billing-only" : "all";
  const today = agencyDate();
  const user = await requireUser("viewer");
  const result = await withDb(async (pool) => {
    const portal = await resolvePortalAccess(pool, user);
    if (!hasPortalCapability(portal, "agencies.manage")) return null;
    const [agencies, users, individuals, employees, globalRoles, individualAccess, employeeAccess] = await Promise.all([
      listAgencies(pool),
      listUsers(pool),
      listIndividualsManaged(pool, {}),
      listEmployeesManaged(pool, {}),
      listGlobalPortalRoleAssignments(pool),
      listIndividualPortalAssignments(pool),
      listEmployeePortalAssignments(pool),
    ]);
    const [access, individualRosters, employeeRosters] = await Promise.all([
      Promise.all(agencies.map((agency) => listAgencyUserAccess(pool, agency.id))),
      Promise.all(agencies.map((agency) => listAgencyIndividualMemberships(pool, agency.id))),
      Promise.all(agencies.map((agency) => listAgencyEmployeeMemberships(pool, agency.id))),
    ]);
    return {
      agencies: agencies.map((agency, index) => ({
        ...agency,
        access: access[index] ?? [],
        individualRoster: individualRosters[index] ?? [],
        employeeRoster: employeeRosters[index] ?? [],
      })),
      users: users.filter((candidate) => candidate.isActive),
      individuals: individuals.map((individual) => ({ id: individual.id, name: individual.displayName })),
      employees: employees.map((employee) => ({ id: employee.id, name: employee.displayName })),
      globalRoles,
      individualAccess,
      employeeAccess,
    };
  });

  if (result.ok && result.data === null) redirect("/home?denied=1");
  const activeUsers = result.ok && result.data ? result.data.users : [];
  const globalRoles = result.ok && result.data ? result.data.globalRoles : [];
  const individualOptions = result.ok && result.data ? result.data.individuals : [];
  const employeeOptions = result.ok && result.data ? result.data.employees : [];
  const agencyRows = result.ok && result.data
    ? result.data.agencies.map((agency) => ({
        ...agency,
        visibleIndividualRoster: rosterFilter === "billing-only"
          ? agency.individualRoster.filter((entry) => entry.currentlyEffective && entry.billsServices && !entry.managesBudget)
          : agency.individualRoster,
      }))
    : [];

  return (
    <>
      <PageHeader
        eyebrow="Portal administration"
        title="Agencies and access"
        description="Organizations, roster membership, and agency-scoped portal roles."
        action={result.ok && result.data ? (
          <CreateButton
            label="New agency"
            title="New agency"
            endpoint="/api/agencies"
            fields={(
              <>
                <Field label="Code" name="code" required />
                <Field label="Agency name" name="name" required />
                <Field label="Contact name" name="contactName" />
                <Field label="Contact email" name="contactEmail" type="email" />
                <Field label="Contact phone" name="contactPhone" />
                <TextAreaField label="Notes" name="notes" />
              </>
            )}
          />
        ) : undefined}
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load agency administration">{result.error}</ErrorPanel>
      ) : result.data === null ? null : (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Agencies" value={result.data.agencies.length} icon={<Building2 aria-hidden className="h-4 w-4" />} />
            <Metric
              label="Portal accounts"
              value={new Set([
                ...result.data.agencies.flatMap((agency) => agency.access.filter((entry) => entry.isActive).map((entry) => entry.userId)),
                ...result.data.globalRoles.filter((entry) => entry.isActive).map((entry) => entry.userId),
                ...result.data.individualAccess.filter((entry) => entry.isActive).map((entry) => entry.userId),
                ...result.data.employeeAccess.filter((entry) => entry.isActive).map((entry) => entry.userId),
              ]).size}
              icon={<UsersRound aria-hidden className="h-4 w-4" />}
            />
            <Metric
              label="Active role grants"
              value={
                result.data.agencies.reduce((sum, agency) => sum + agency.access.filter((entry) => entry.isActive).length, 0)
                + result.data.globalRoles.filter((entry) => entry.isActive).length
              }
              icon={<ShieldCheck aria-hidden className="h-4 w-4" />}
            />
          </div>

          {result.data.agencies.length === 0 ? (
            <Card>
              <EmptyState
                title="No agencies are configured"
                icon={<Building2 aria-hidden className="h-5 w-5" />}
                action={(
                  <CreateButton
                    label="Create agency"
                    title="New agency"
                    endpoint="/api/agencies"
                    fields={<><Field label="Code" name="code" required /><Field label="Agency name" name="name" required /></>}
                  />
                )}
              />
            </Card>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-y border-[var(--color-rule)] py-3">
            <div>
              <p className="text-sm font-semibold">Operational staff access</p>
              <p className="text-xs text-[var(--color-ink-faint)]">
                Schedulers and staffing managers can work in hours-only Planning for their agency roster. Agency and collector roles remain scoped portal summaries; broader internal access is managed separately.
              </p>
            </div>
            <Link href="/settings#access" className="btn btn-secondary btn-sm">Manage staff access</Link>
          </div>

          <Card
            title="Portal account roles"
            description="Installation roles are separate from admin rank. Agency roles are assigned inside the relevant agency below."
            action={(
              <CreateButton
                label="Assign role"
                title="Assign portal account role"
                endpoint="/api/portal/roles"
                size="sm"
                fields={(
                  <>
                    <SelectField
                      label="Account"
                      name="userId"
                      options={activeUsers.map((candidate) => ({ value: candidate.id, label: `${candidate.displayName} (${candidate.email})` }))}
                    />
                    <SelectField
                      label="Portal role"
                      name="role"
                      options={[
                        { value: "owner", label: "Owner" },
                        { value: "individual", label: "Individual" },
                        { value: "parent", label: "Parent or guardian" },
                        { value: "employee", label: "Employee" },
                      ]}
                    />
                  </>
                )}
              />
            )}
          >
            {result.data.globalRoles.length === 0 ? (
              <EmptyState compact title="No portal account roles" icon={<ShieldCheck aria-hidden className="h-5 w-5" />} />
            ) : (
              <Table head={<><Th>Account</Th><Th>Role</Th><Th>Status</Th><Th>Action</Th></>}>
                {result.data.globalRoles.map((entry) => (
                  <Tr key={`${entry.userId}-${entry.role}`}>
                    <Td><p className="font-medium">{entry.displayName}</p><p className="text-xs text-[var(--color-ink-faint)]">{entry.email}</p></Td>
                    <Td>{entry.role === "parent" ? "Parent or guardian" : entry.role}</Td>
                    <Td><StatusBadge tone={entry.isActive ? "good" : "muted"} label={entry.isActive ? "Active" : "Inactive"} /></Td>
                    <Td>
                      <ActionButton
                        label={entry.isActive ? "Remove" : "Restore"}
                        endpoint="/api/portal/roles"
                        method="POST"
                        body={{ userId: entry.userId, role: entry.role, isActive: !entry.isActive }}
                        confirm={entry.isActive ? `Remove the ${entry.role} role from this account?` : undefined}
                      />
                    </Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>

          <Card
            title="Individual and guardian portals"
            description="Direct profile relationships. These never expand through employee assignments or transactions."
            action={(
              <CreateButton
                label="Add individual access"
                title="Individual or guardian portal access"
                endpoint="/api/portal/assignments/individuals"
                size="sm"
                fields={(
                  <>
                    <SelectField
                      label="Account"
                      name="userId"
                      options={result.data.users.map((candidate) => ({ value: candidate.id, label: `${candidate.displayName} (${candidate.email})` }))}
                    />
                    <SelectField
                      label="Individual"
                      name="individualId"
                      options={result.data.individuals.map((individual) => ({ value: individual.id, label: individual.name }))}
                    />
                    <SelectField
                      label="Relationship"
                      name="relationship"
                      defaultValue="self"
                      options={[
                        { value: "self", label: "Self" },
                        { value: "parent", label: "Parent" },
                        { value: "guardian", label: "Guardian" },
                        { value: "representative", label: "Representative" },
                      ]}
                    />
                    <VisibilityFields mode="individual" />
                  </>
                )}
              />
            )}
          >
            {result.data.individualAccess.length === 0 ? (
              <EmptyState compact title="No individual portal relationships" icon={<UserRound aria-hidden className="h-5 w-5" />} />
            ) : (
              <Table head={<><Th>Account</Th><Th>Individual</Th><Th>Relationship</Th><Th>Link</Th><Th>Account role</Th><Th>Policy</Th><Th>Action</Th></>}>
                {result.data.individualAccess.map((entry) => (
                  <Tr key={`${entry.userId}-${entry.individualId}-${entry.relationship}`}>
                    <Td><p className="font-medium">{entry.displayName}</p><p className="text-xs text-[var(--color-ink-faint)]">{entry.email}</p></Td>
                    <Td>{entry.individualName}</Td>
                    <Td>{entry.relationship}</Td>
                    <Td><StatusBadge tone={entry.isActive ? "good" : "muted"} label={entry.isActive ? "Active" : "Inactive"} /></Td>
                    <Td>
                      {globalRoles.some((role) => (
                        role.userId === entry.userId
                        && role.isActive
                        && role.role === (entry.relationship === "self" ? "individual" : "parent")
                      ))
                        ? <StatusBadge tone="good" label={entry.relationship === "self" ? "Individual" : "Parent"} />
                        : <StatusBadge tone="warn" label="Missing" />}
                    </Td>
                    <Td><span className="text-xs text-[var(--color-ink-soft)]">{entry.capabilityGrants.length} grants · {entry.capabilityDenials.length} denials</span></Td>
                    <Td>
                      <div className="flex flex-wrap gap-2">
                        <CreateButton
                          label="Edit"
                          title={`Edit visibility for ${entry.individualName}`}
                          endpoint="/api/portal/assignments/individuals"
                          size="sm"
                          variant="secondary"
                          hidden={{
                            userId: entry.userId,
                            individualId: entry.individualId,
                            relationship: entry.relationship,
                            isActive: String(entry.isActive),
                          }}
                          fields={<VisibilityFields mode="individual" grants={entry.capabilityGrants} denials={entry.capabilityDenials} />}
                        />
                        <ActionButton
                          label={entry.isActive ? "Disable" : "Restore"}
                          endpoint="/api/portal/assignments/individuals"
                          method="POST"
                          body={{
                            userId: entry.userId,
                            individualId: entry.individualId,
                            relationship: entry.relationship,
                            isActive: !entry.isActive,
                            capabilityGrants: entry.capabilityGrants,
                            capabilityDenials: entry.capabilityDenials,
                          }}
                          confirm={entry.isActive ? "Disable this direct portal relationship?" : undefined}
                        />
                      </div>
                    </Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>

          <Card
            title="Employee portals"
            description="Employee accounts are linked only to their own employee record."
            action={(
              <CreateButton
                label="Add employee access"
                title="Employee portal access"
                endpoint="/api/portal/assignments/employees"
                size="sm"
                fields={(
                  <>
                    <SelectField
                      label="Account"
                      name="userId"
                      options={result.data.users.map((candidate) => ({ value: candidate.id, label: `${candidate.displayName} (${candidate.email})` }))}
                    />
                    <SelectField
                      label="Employee"
                      name="employeeId"
                      options={result.data.employees.map((employee) => ({ value: employee.id, label: employee.name }))}
                    />
                    <VisibilityFields mode="employee" />
                  </>
                )}
              />
            )}
          >
            {result.data.employeeAccess.length === 0 ? (
              <EmptyState compact title="No employee portal relationships" icon={<ContactRound aria-hidden className="h-5 w-5" />} />
            ) : (
              <Table head={<><Th>Account</Th><Th>Employee</Th><Th>Link</Th><Th>Account role</Th><Th>Policy</Th><Th>Action</Th></>}>
                {result.data.employeeAccess.map((entry) => (
                  <Tr key={`${entry.userId}-${entry.employeeId}`}>
                    <Td><p className="font-medium">{entry.displayName}</p><p className="text-xs text-[var(--color-ink-faint)]">{entry.email}</p></Td>
                    <Td>{entry.employeeName}</Td>
                    <Td><StatusBadge tone={entry.isActive ? "good" : "muted"} label={entry.isActive ? "Active" : "Inactive"} /></Td>
                    <Td>
                      {globalRoles.some((role) => role.userId === entry.userId && role.role === "employee" && role.isActive)
                        ? <StatusBadge tone="good" label="Employee" />
                        : <StatusBadge tone="warn" label="Missing" />}
                    </Td>
                    <Td><span className="text-xs text-[var(--color-ink-soft)]">{entry.capabilityGrants.length} grants · {entry.capabilityDenials.length} denials</span></Td>
                    <Td>
                      <div className="flex flex-wrap gap-2">
                        <CreateButton
                          label="Edit"
                          title={`Edit visibility for ${entry.employeeName}`}
                          endpoint="/api/portal/assignments/employees"
                          size="sm"
                          variant="secondary"
                          hidden={{ userId: entry.userId, employeeId: entry.employeeId, isActive: String(entry.isActive) }}
                          fields={<VisibilityFields mode="employee" grants={entry.capabilityGrants} denials={entry.capabilityDenials} />}
                        />
                        <ActionButton
                          label={entry.isActive ? "Disable" : "Restore"}
                          endpoint="/api/portal/assignments/employees"
                          method="POST"
                          body={{
                            userId: entry.userId,
                            employeeId: entry.employeeId,
                            isActive: !entry.isActive,
                            capabilityGrants: entry.capabilityGrants,
                            capabilityDenials: entry.capabilityDenials,
                          }}
                          confirm={entry.isActive ? "Disable this employee portal relationship?" : undefined}
                        />
                      </div>
                    </Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-2 border-y border-[var(--color-rule)] py-3">
            <span className="text-sm font-semibold">Individual roster</span>
            <div className="inline-flex rounded border border-[var(--color-rule-strong)] bg-white p-0.5" aria-label="Individual roster filter">
              <Link
                href="/settings/agencies"
                className={`rounded px-2.5 py-1 text-xs font-medium ${rosterFilter === "all" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-ink-soft)]"}`}
              >
                All
              </Link>
              <Link
                href="/settings/agencies?roster=billing-only"
                className={`rounded px-2.5 py-1 text-xs font-medium ${rosterFilter === "billing-only" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-ink-soft)]"}`}
              >
                Billing without budget
              </Link>
            </div>
          </div>

          {agencyRows.map((agency) => (
            <Card
              key={agency.id}
              title={agency.name}
              description={`${agency.code} · ${agency.individualCount} individuals · ${agency.employeeCount} employees`}
              action={(
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge
                    tone={agency.status === "active" ? "good" : agency.status === "inactive" ? "warn" : "muted"}
                    label={agency.isHomeAgency ? `Home · ${agency.status}` : agency.status}
                  />
                  <CreateButton
                    label="Add access"
                    title={`Agency access - ${agency.name}`}
                    endpoint={`/api/agencies/${agency.id}/access`}
                    size="sm"
                    fields={(
                      <>
                        <SelectField
                          label="Account"
                          name="userId"
                          options={activeUsers.map((candidate) => ({ value: candidate.id, label: `${candidate.displayName} (${candidate.email})` }))}
                        />
                        <SelectField
                          label="Portal role"
                          name="role"
                          options={[
                            { value: "agency", label: PORTAL_ROLE_LABELS.agency },
                            { value: "staffing_manager", label: PORTAL_ROLE_LABELS.staffing_manager },
                            { value: "scheduler", label: PORTAL_ROLE_LABELS.scheduler },
                            { value: "collector", label: PORTAL_ROLE_LABELS.collector },
                          ]}
                        />
                      </>
                    )}
                  />
                </div>
              )}
            >
              <div className="space-y-6">
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Portal accounts</h3>
                  {agency.access.length === 0 ? (
                    <EmptyState compact title="No portal accounts" icon={<Plus aria-hidden className="h-5 w-5" />} />
                  ) : (
                    <Table head={<><Th>Account</Th><Th>Portal role</Th><Th>Status</Th><Th>Policy</Th><Th>Action</Th></>}>
                      {agency.access.map((entry) => (
                        <Tr key={`${entry.userId}-${entry.role}`}>
                          <Td>
                            <p className="font-medium">{entry.displayName}</p>
                            <p className="text-xs text-[var(--color-ink-faint)]">{entry.email}</p>
                          </Td>
                          <Td>{PORTAL_ROLE_LABELS[entry.role]}</Td>
                          <Td><StatusBadge tone={entry.isActive ? "good" : "muted"} label={entry.isActive ? "Active" : "Inactive"} /></Td>
                          <Td>
                            <span className="text-xs text-[var(--color-ink-soft)]">
                              {entry.capabilityGrants.length} grants · {entry.capabilityDenials.length} denials
                            </span>
                          </Td>
                          <Td>
                            <div className="flex flex-wrap gap-2">
                              {entry.role === "agency" || entry.role === "collector" ? (
                                <CreateButton
                                  label="Edit"
                                  title={`Edit ${entry.role.replaceAll("_", " ")} visibility`}
                                  endpoint={`/api/agencies/${agency.id}/access`}
                                  size="sm"
                                  variant="secondary"
                                  hidden={{ userId: entry.userId, role: entry.role, isActive: String(entry.isActive) }}
                                  fields={(
                                    <VisibilityFields
                                      mode="agency"
                                      role={entry.role}
                                      grants={entry.capabilityGrants}
                                      denials={entry.capabilityDenials}
                                    />
                                  )}
                                />
                              ) : null}
                              <ActionButton
                                label={entry.isActive ? "Disable" : "Restore"}
                                endpoint={`/api/agencies/${agency.id}/access`}
                                method="POST"
                                body={{
                                  userId: entry.userId,
                                  role: entry.role,
                                  isActive: !entry.isActive,
                                  capabilityGrants: entry.capabilityGrants,
                                  capabilityDenials: entry.capabilityDenials,
                                }}
                                confirm={entry.isActive ? "Disable this agency role?" : undefined}
                              />
                            </div>
                          </Td>
                        </Tr>
                      ))}
                    </Table>
                  )}
                </section>

                <section className="border-t border-[var(--color-rule)] pt-5">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold">Individuals</h3>
                      <p className="text-xs text-[var(--color-ink-faint)]">Budget and billing responsibilities are retained as dated history.</p>
                    </div>
                    <CreateButton
                      label="Add individual"
                      title={`Add individual to ${agency.name}`}
                      endpoint={`/api/agencies/${agency.id}/individuals`}
                      size="sm"
                      fields={(
                        <>
                          <SelectField
                            label="Individual"
                            name="individualId"
                            options={individualOptions.map((individual) => ({ value: individual.id, label: individual.name }))}
                          />
                          <div className="grid gap-3 sm:grid-cols-2">
                            <SelectField label="Manages budget" name="managesBudget" defaultValue="true" options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
                            <SelectField label="Bills services" name="billsServices" defaultValue="true" options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
                          </div>
                          <Field label="Effective from" name="effectiveFrom" type="date" defaultValue={today} required />
                          <Field label="Effective through" name="effectiveTo" type="date" />
                        </>
                      )}
                    />
                  </div>
                  {agency.visibleIndividualRoster.length === 0 ? (
                    <EmptyState
                      compact
                      title={rosterFilter === "billing-only" ? "No billing-only individuals" : "No individuals in this agency roster"}
                      icon={<UserRound aria-hidden className="h-5 w-5" />}
                    />
                  ) : (
                    <Table head={<><Th>Individual</Th><Th>Relationship</Th><Th>Effective</Th><Th>Status</Th><Th>Action</Th></>}>
                      {agency.visibleIndividualRoster.map((entry) => (
                        <Tr key={entry.membershipId}>
                          <Td><p className="font-medium">{entry.individualName}</p></Td>
                          <Td>
                            <StatusBadge
                              tone={entry.billsServices && !entry.managesBudget ? "warn" : "muted"}
                              label={entry.managesBudget && entry.billsServices
                                ? "Budget + billing"
                                : entry.managesBudget
                                  ? "Budget management"
                                  : "Billing only"}
                            />
                          </Td>
                          <Td><span className="text-xs">{entry.effectiveFrom}{entry.effectiveTo ? ` to ${entry.effectiveTo}` : " onward"}</span></Td>
                          <Td>
                            <StatusBadge
                              tone={entry.currentlyEffective && entry.effectiveTo !== today ? "good" : "muted"}
                              label={entry.intervalStatus === "current" && entry.effectiveTo === today
                                ? "Ends today"
                                : entry.intervalStatus === "current"
                                  ? "Current"
                                  : entry.intervalStatus === "scheduled"
                                    ? "Scheduled"
                                    : entry.intervalStatus === "ended"
                                      ? "Ended"
                                      : "Voided"}
                            />
                          </Td>
                          <Td>
                            <div className="flex flex-wrap gap-2">
                              {entry.currentlyEffective && entry.effectiveTo !== today ? (
                                <>
                                  <CreateButton
                                    label="Change"
                                    title={`Start new terms for ${entry.individualName}`}
                                    endpoint={`/api/agencies/${agency.id}/individuals`}
                                    size="sm"
                                    variant="secondary"
                                    hidden={{ individualId: entry.individualId, isActive: "true" }}
                                    fields={(
                                      <>
                                        <div className="grid gap-3 sm:grid-cols-2">
                                          <SelectField label="Manages budget" name="managesBudget" defaultValue={String(entry.managesBudget)} options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
                                          <SelectField label="Bills services" name="billsServices" defaultValue={String(entry.billsServices)} options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
                                        </div>
                                        <Field label="New terms start" name="effectiveFrom" type="date" defaultValue={today} required />
                                        <Field label="Effective through" name="effectiveTo" type="date" />
                                      </>
                                    )}
                                  />
                                  <ActionButton
                                    label="End"
                                    endpoint={`/api/agencies/${agency.id}/individuals`}
                                    method="POST"
                                    body={{
                                      membershipId: entry.membershipId,
                                      individualId: entry.individualId,
                                      managesBudget: entry.managesBudget,
                                      billsServices: entry.billsServices,
                                      isActive: false,
                                    }}
                                    confirm="End this membership after today? Its history will remain available."
                                  />
                                </>
                              ) : entry.intervalStatus === "scheduled" ? (
                                <ActionButton
                                  label="Cancel"
                                  endpoint={`/api/agencies/${agency.id}/individuals`}
                                  method="POST"
                                  body={{
                                    membershipId: entry.membershipId,
                                    individualId: entry.individualId,
                                    managesBudget: entry.managesBudget,
                                    billsServices: entry.billsServices,
                                    isActive: false,
                                  }}
                                  confirm="Cancel this future interval? The earlier interval will still end on its recorded date."
                                />
                              ) : entry.intervalStatus === "ended" && entry.isLatest ? (
                                <CreateButton
                                  label="Restart"
                                  title={`Restart ${entry.individualName}`}
                                  endpoint={`/api/agencies/${agency.id}/individuals`}
                                  size="sm"
                                  variant="secondary"
                                  hidden={{ individualId: entry.individualId, isActive: "true" }}
                                  fields={(
                                    <>
                                      <div className="grid gap-3 sm:grid-cols-2">
                                        <SelectField label="Manages budget" name="managesBudget" defaultValue={String(entry.managesBudget)} options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
                                        <SelectField label="Bills services" name="billsServices" defaultValue={String(entry.billsServices)} options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
                                      </div>
                                      <Field label="Restart date" name="effectiveFrom" type="date" defaultValue={today} required />
                                      <Field label="Effective through" name="effectiveTo" type="date" />
                                    </>
                                  )}
                                />
                              ) : <span className="text-xs text-[var(--color-ink-faint)]">History</span>}
                            </div>
                          </Td>
                        </Tr>
                      ))}
                    </Table>
                  )}
                </section>

                <section className="border-t border-[var(--color-rule)] pt-5">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">Employees</h3>
                    <CreateButton
                      label="Add employee"
                      title={`Add employee to ${agency.name}`}
                      endpoint={`/api/agencies/${agency.id}/employees`}
                      size="sm"
                      fields={(
                        <>
                          <SelectField
                            label="Employee"
                            name="employeeId"
                            options={employeeOptions.map((employee) => ({ value: employee.id, label: employee.name }))}
                          />
                          <Field label="Effective from" name="effectiveFrom" type="date" defaultValue={today} required />
                          <Field label="Effective through" name="effectiveTo" type="date" />
                        </>
                      )}
                    />
                  </div>
                  {agency.employeeRoster.length === 0 ? (
                    <EmptyState compact title="No employees in this agency roster" icon={<ContactRound aria-hidden className="h-5 w-5" />} />
                  ) : (
                    <Table head={<><Th>Employee</Th><Th>Effective</Th><Th>Status</Th><Th>Action</Th></>}>
                      {agency.employeeRoster.map((entry) => (
                        <Tr key={entry.membershipId}>
                          <Td><p className="font-medium">{entry.employeeName}</p></Td>
                          <Td><span className="text-xs">{entry.effectiveFrom}{entry.effectiveTo ? ` to ${entry.effectiveTo}` : " onward"}</span></Td>
                          <Td>
                            <StatusBadge
                              tone={entry.currentlyEffective && entry.effectiveTo !== today ? "good" : "muted"}
                              label={entry.intervalStatus === "current" && entry.effectiveTo === today
                                ? "Ends today"
                                : entry.intervalStatus === "current"
                                  ? "Current"
                                  : entry.intervalStatus === "scheduled"
                                    ? "Scheduled"
                                    : entry.intervalStatus === "ended"
                                      ? "Ended"
                                      : "Voided"}
                            />
                          </Td>
                          <Td>
                            <div className="flex flex-wrap gap-2">
                              {entry.currentlyEffective && entry.effectiveTo !== today ? (
                                <>
                                  <CreateButton
                                    label="Change"
                                    title={`Start a new interval for ${entry.employeeName}`}
                                    endpoint={`/api/agencies/${agency.id}/employees`}
                                    size="sm"
                                    variant="secondary"
                                    hidden={{ employeeId: entry.employeeId, isActive: "true" }}
                                    fields={(
                                      <>
                                        <Field label="New interval starts" name="effectiveFrom" type="date" defaultValue={today} required />
                                        <Field label="Effective through" name="effectiveTo" type="date" />
                                      </>
                                    )}
                                  />
                                  <ActionButton
                                    label="End"
                                    endpoint={`/api/agencies/${agency.id}/employees`}
                                    method="POST"
                                    body={{ membershipId: entry.membershipId, employeeId: entry.employeeId, isActive: false }}
                                    confirm="End this membership after today? Its history will remain available."
                                  />
                                </>
                              ) : entry.intervalStatus === "scheduled" ? (
                                <ActionButton
                                  label="Cancel"
                                  endpoint={`/api/agencies/${agency.id}/employees`}
                                  method="POST"
                                  body={{ membershipId: entry.membershipId, employeeId: entry.employeeId, isActive: false }}
                                  confirm="Cancel this future interval? The earlier interval will still end on its recorded date."
                                />
                              ) : entry.intervalStatus === "ended" && entry.isLatest ? (
                                <CreateButton
                                  label="Restart"
                                  title={`Restart ${entry.employeeName}`}
                                  endpoint={`/api/agencies/${agency.id}/employees`}
                                  size="sm"
                                  variant="secondary"
                                  hidden={{ employeeId: entry.employeeId, isActive: "true" }}
                                  fields={(
                                    <>
                                      <Field label="Restart date" name="effectiveFrom" type="date" defaultValue={today} required />
                                      <Field label="Effective through" name="effectiveTo" type="date" />
                                    </>
                                  )}
                                />
                              ) : <span className="text-xs text-[var(--color-ink-faint)]">History</span>}
                            </div>
                          </Td>
                        </Tr>
                      ))}
                    </Table>
                  )}
                </section>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
