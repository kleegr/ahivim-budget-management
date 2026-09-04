import { requireUser } from "@/lib/auth/session";
import { canAccessPlanning, resolveAccessScope } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { listUsersWithAccess } from "@/lib/auth/users";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import { listEmployeesManaged } from "@/lib/manage/employees";
import { listAgencies } from "@/lib/manage/agencies";
import { listPrograms, listAudit } from "@/lib/data/app-queries";
import { listProgramRules } from "@/lib/manage/program-rules";
import {
  Card, Table, Th, Td, Tr, Money, EmptyState, ErrorPanel, PageHeader, Badge, Plain,
} from "@/components/ui";
import { CreateButton, ActionButton, Field, TextAreaField } from "@/components/manage/client";
import PasswordForm from "@/components/password-form";
import ApplyMigrations from "@/components/manage/apply-migrations";
import AttributePayments from "@/components/settings/attribute-payments";
import UserAccessAdmin from "@/components/settings/user-access-admin";
import ProgramRules, { GuidedProgramButton } from "@/components/settings/program-rules";
import Link from "next/link";
import { hasPortalCapability, resolvePortalAccess } from "@/lib/auth/portal-access";
import { resolveAccountProfile } from "@/lib/auth/account-label";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings — Ahivim Budget Management" };

function readableList(items: string[]): string {
  if (items.length < 2) return items[0] ?? "assigned portal information";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function permissionSummary(input: {
  role: string;
  canPlan: boolean;
  canManagePortalSchedules: boolean;
  canManagePortalAssignments: boolean;
  canManageSettlements: boolean;
  canManageClassInvoices: boolean;
  canEditDocuments: boolean;
  canSeeTransactions: boolean;
  canSeeBudgets: boolean;
  canSeeSettlements: boolean;
  canSeeClassFinancials: boolean;
}): string {
  if (input.role === "admin") return "Full access, including user management and migrations.";
  if (input.role === "manager") return "Read everything; upload, commit and discard imports.";

  const manage: string[] = [];
  if (input.canPlan) {
    manage.push(input.canSeeBudgets
      ? "schedules, assignments, and authorized hours"
      : "schedules and assignments");
  } else {
    if (input.canManagePortalSchedules) manage.push("agency schedules");
    if (input.canManagePortalAssignments) manage.push("agency assignments");
  }
  if (input.canManageSettlements) manage.push("collections, payroll checks, and monthly set-asides");
  if (input.canManageClassInvoices) manage.push("class billing and invoices");
  if (input.canEditDocuments) manage.push("documents");
  if (manage.length > 0) return `Can manage ${readableList(manage)}.`;

  const view: string[] = [];
  if (input.canSeeTransactions) view.push("transactions");
  if (input.canSeeBudgets) view.push("budgets");
  if (input.canSeeSettlements) view.push("collections");
  if (input.canSeeClassFinancials) view.push("class billing");
  return `Can view ${readableList(view)} for the people assigned to this account.`;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const previewError = typeof params.previewError === "string" ? params.previewError : null;
  const user = await requireUser("viewer");
  const isAdmin = user.role === "admin";

  const result = await withDb(async (pool) => {
    const [scope, portal] = await Promise.all([
      resolveAccessScope(pool, user),
      resolvePortalAccess(pool, user),
    ]);
    const canSeeBilledAmounts = scope.canSeeBilledAmounts;
    const canSeeEmployeeAmounts = scope.canSeeEmployeeAmounts;
    const canViewProgramRates = canSeeBilledAmounts || canSeeEmployeeAmounts;
    const [users, managedIndividuals, managedEmployees, agencies, programs, programRules, audit] = await Promise.all([
      isAdmin ? listUsersWithAccess(pool) : Promise.resolve([]),
      isAdmin ? listIndividualsManaged(pool, {}) : Promise.resolve([]),
      isAdmin ? listEmployeesManaged(pool, {}) : Promise.resolve([]),
      isAdmin ? listAgencies(pool) : Promise.resolve([]),
      canViewProgramRates ? listPrograms(pool) : Promise.resolve([]),
      isAdmin ? listProgramRules(pool) : Promise.resolve([]),
      isAdmin ? listAudit(pool, 40) : Promise.resolve([]),
    ]);
    return {
      users,
      individuals: managedIndividuals.map((i) => ({ id: i.id, name: i.displayName })),
      employees: managedEmployees.map((e) => ({ id: e.id, name: e.displayName })),
      agencies: agencies
        .filter((agency) => agency.status === "active")
        .map((agency) => ({ id: agency.id, name: agency.name })),
      programs: programs.map((program) => ({
        ...program,
        agencyRate: canSeeBilledAmounts ? program.agencyRate : null,
        internalRate: canSeeEmployeeAmounts ? program.internalRate : null,
      })),
      programRules,
      audit,
      canSeeBilledAmounts,
      canSeeEmployeeAmounts,
      canViewProgramRates,
      canPlan: canAccessPlanning(scope),
      canManagePortalSchedules: portal.agencyAccess.some((assignment) => (
        hasPortalCapability(portal, "schedules.agency.manage", assignment.agencyId)
      )),
      canManagePortalAssignments: portal.agencyAccess.some((assignment) => (
        hasPortalCapability(portal, "assignments.agency.manage", assignment.agencyId)
      )),
      canManageSettlements: scope.canManageSettlements,
      canManageClassInvoices: scope.canManageClassInvoices,
      canEditDocuments: scope.canEditDocuments,
      canSeeTransactions: scope.canSeeTransactions,
      canSeeBudgets: scope.canSeeBudgets,
      canSeeSettlements: scope.canSeeSettlements,
      canSeeClassFinancials: scope.canSeeClassFinancials,
      accountLabel: resolveAccountProfile(user.role, scope, portal, user.accountPreset).label,
    };
  });

  const accountOnly = result.ok && !isAdmin && !result.data.canViewProgramRates;

  return (
    <>
      <PageHeader
        eyebrow={accountOnly ? "Account" : "Administration"}
        title={accountOnly ? "Account settings" : isAdmin ? "Users & settings" : "Programs & account"}
        description={accountOnly
          ? "Review your account and update your password."
          : isAdmin
            ? "Create users and manage the basic system setup."
            : "Review program rates and update your account."}
      />

      <div className="flex flex-col gap-4">
        {isAdmin && previewError ? (
          <div role="alert">
            <ErrorPanel title="Could not open that user portal">{previewError}</ErrorPanel>
          </div>
        ) : null}
        <nav aria-label="Settings sections" className="scroll-thin sticky top-[var(--shell-header-height,0px)] z-20 -mx-1 flex gap-1 overflow-x-auto border-b border-[var(--color-rule)] bg-[var(--color-paper)] px-1 py-2">
          {isAdmin ? <Link href="#access" className="btn btn-sm btn-ghost shrink-0">Users</Link> : null}
          {isAdmin ? <Link href="/settings/role-preview" className="btn btn-sm btn-ghost shrink-0">Role preview</Link> : null}
          {result.ok && result.data.canViewProgramRates ? <Link href="#programs" className="btn btn-sm btn-ghost shrink-0">Programs</Link> : null}
          <Link href="#account" className="btn btn-sm btn-ghost shrink-0">My account</Link>
          {isAdmin ? <Link href="#advanced" className="btn btn-sm btn-ghost shrink-0">Advanced</Link> : null}
        </nav>

        <section id="account" className={`${isAdmin ? "order-3" : "order-1"} scroll-mt-24`}><Card title="Your account">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-b border-[var(--color-rule)] px-5 py-4 text-sm sm:grid-cols-4">
            <dt className="text-[var(--color-ink-faint)]">Name</dt>
            <dd>{user.displayName}</dd>
            <dt className="text-[var(--color-ink-faint)]">Email</dt>
            <dd>{user.email}</dd>
            <dt className="text-[var(--color-ink-faint)]">Role</dt>
            <dd><Badge value={user.role === "admin" ? "committed" : "pending"} label={result.ok ? result.data.accountLabel : resolveAccountProfile(user.role, null, null, user.accountPreset).label} /></dd>
            <dt className="text-[var(--color-ink-faint)]">Permissions</dt>
            <dd className="text-[var(--color-ink-soft)]">
              {result.ok
                ? permissionSummary({ role: user.role, ...result.data })
                : user.role === "admin"
                  ? "Full access, including user management and migrations."
                  : "Access follows the role and people assigned to this account."}
            </dd>
          </dl>
          <PasswordForm />
        </Card></section>

        {!result.ok ? (
          <ErrorPanel title="Could not load settings data">{result.error}</ErrorPanel>
        ) : (
          <>
            {isAdmin ? (
              <section id="access" className="order-1 scroll-mt-24"><UserAccessAdmin
                currentUserId={user.id}
                initialUsers={result.data.users.map((u) => ({
                  id: u.id,
                  email: u.email,
                  displayName: u.displayName,
                  role: u.role,
                  isActive: u.isActive,
                  lastLoginAt: u.lastLoginAt,
                  accessScope: u.accessScope,
                  seeAllIndividuals: u.seeAllIndividuals,
                  seeAllEmployees: u.seeAllEmployees,
                  canSeeTransactions: u.canSeeTransactions,
                  canSeeMoney: u.canSeeMoney,
                  canSeeHours: u.canSeeHours,
                  canSeeBilledAmounts: u.canSeeBilledAmounts,
                  canSeeEmployeeAmounts: u.canSeeEmployeeAmounts,
                  canSeeAgencySpread: u.canSeeAgencySpread,
                  canSeeCheckNet: u.canSeeCheckNet,
                  canSeeTaxes: u.canSeeTaxes,
                  canSeeBudgets: u.canSeeBudgets,
                  canSeeEmployeeDeals: u.canSeeEmployeeDeals,
                  canSeeSettlements: u.canSeeSettlements,
                  canManageSettlements: u.canManageSettlements,
                  canSeeClassFinancials: u.canSeeClassFinancials,
                  canManageClassInvoices: u.canManageClassInvoices,
                  canPlan: u.canPlan,
                  canEditDocuments: u.canEditDocuments,
                  accountPreset: u.accountPreset,
                  portalManaged: u.portalManaged,
                  individualCount: u.individualCount,
                  employeeCount: u.employeeCount,
                }))}
                individuals={result.data.individuals}
                employees={result.data.employees}
                agencies={result.data.agencies}
              /></section>
            ) : null}

            {result.data.canViewProgramRates ? <section id="programs" className="order-2 scroll-mt-24"><details className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3">
              <summary className="cursor-pointer text-sm font-semibold text-[var(--color-ink)]">Programs &amp; rates</summary>
              <div className="mt-4 space-y-4"><Card
              title="Programs and rates"
              description={
                isAdmin
                  ? "The effective-dated schedule used by every calculation. Add a program, add a rate, or archive one — history is never overwritten."
                  : "Read-only view of the effective-dated schedule used by every calculation"
              }
              action={
                isAdmin ? <GuidedProgramButton /> : undefined
              }
            >
              {result.data.programs.length === 0 ? (
                <EmptyState title="No programs are configured" />
              ) : (
                <Table head={<><Th>Code</Th><Th>Program</Th>{result.data.canSeeBilledAmounts ? <Th numeric>Funder rate</Th> : null}{result.data.canSeeEmployeeAmounts ? <Th numeric>Employee base rate</Th> : null}<Th>Effective from</Th><Th>Group</Th><Th>Active</Th>{isAdmin ? <Th>Actions</Th> : null}</>}>
                  {result.data.programs.map((p) => (
                    <Tr key={p.id}>
                      <Td><code className="text-xs">{p.code}</code></Td>
                      <Td>{p.name}</Td>
                      {result.data.canSeeBilledAmounts ? <Td numeric><Money value={p.agencyRate} /></Td> : null}
                      {result.data.canSeeEmployeeAmounts ? <Td numeric><Money value={p.internalRate} /></Td> : null}
                      <Td><Plain value={p.effectiveFrom} /></Td>
                      <Td>{p.isGroupCapable ? "Yes" : "No"}</Td>
                      <Td>{p.isActive ? "Yes" : "No"}</Td>
                      {isAdmin ? (
                        <Td>
                          <div className="flex flex-wrap gap-2">
                            <CreateButton
                              label="Add rate"
                              title={`Add rate — ${p.code}`}
                              endpoint={`/api/programs/${p.id}/rates`}
                              variant="secondary"
                              size="sm"
                              fields={
                                <>
                                  <Field label="Effective from" name="effectiveFrom" type="date" required />
                                  <Field label="Internal rate" name="internalRate" type="number" required />
                                  <Field label="Agency rate" name="agencyRate" type="number" help="Optional." />
                                  <TextAreaField label="Notes" name="notes" />
                                </>
                              }
                            />
                            {p.isActive ? (
                              <ActionButton
                                label="Archive"
                                endpoint={`/api/programs/${p.id}`}
                                body={{ isActive: false }}
                                withReason
                              />
                            ) : (
                              <ActionButton
                                label="Restore"
                                endpoint={`/api/programs/${p.id}`}
                                body={{ isActive: true }}
                                withReason
                                variant="primary"
                              />
                            )}
                          </div>
                        </Td>
                      ) : null}
                    </Tr>
                  ))}
                </Table>
              )}
            </Card>

            {isAdmin ? <ProgramRules programs={result.data.programRules} /> : null}</div></details></section> : null}

            {isAdmin ? (
              <section id="advanced" className="order-4 scroll-mt-24">
                <details className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3">
                  <summary className="cursor-pointer text-sm font-semibold text-[var(--color-ink)]">Advanced system tools</summary>
                  <div className="mt-4 space-y-4">
                    <Card title="Audit trail" description="The 40 most recent recorded actions">
                      {result.data.audit.length === 0 ? (
                        <EmptyState title="No audit entries yet" />
                      ) : (
                        <Table head={<><Th>When</Th><Th>Action</Th><Th>Entity</Th><Th>Actor</Th></>}>
                          {result.data.audit.map((a) => (
                            <Tr key={a.id}>
                              <Td><span className="text-xs">{new Date(a.createdAt).toLocaleString()}</span></Td>
                              <Td>{a.action.replace(/_/g, " ")}</Td>
                              <Td><Plain value={a.entityType} /></Td>
                              <Td><Plain value={a.actor} /></Td>
                            </Tr>
                          ))}
                        </Table>
                      )}
                    </Card>
                    <Card title="System maintenance" description="Administrative data operations">
                      <ApplyMigrations />
                      <AttributePayments />
                    </Card>
                  </div>
                </details>
              </section>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
