import { requireUser } from "@/lib/auth/session";
import { resolveAccessScope } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { listUsersWithAccess } from "@/lib/auth/users";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import { listEmployeesManaged } from "@/lib/manage/employees";
import { listPrograms, listAudit } from "@/lib/data/app-queries";
import { listProgramRules } from "@/lib/manage/program-rules";
import {
  Card, Table, Th, Td, Tr, Money, EmptyState, ErrorPanel, PageHeader, Badge, Plain,
} from "@/components/ui";
import { CreateButton, ActionButton, Field, SelectField, TextAreaField } from "@/components/manage/client";
import PasswordForm from "@/components/password-form";
import ApplyMigrations from "@/components/manage/apply-migrations";
import AttributePayments from "@/components/settings/attribute-payments";
import UserAccessAdmin from "@/components/settings/user-access-admin";
import ProgramRules from "@/components/settings/program-rules";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings — Ahivim Budget Management" };

export default async function SettingsPage() {
  const user = await requireUser("viewer");
  const isAdmin = user.role === "admin";

  const result = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    const programs = await listPrograms(pool);
    return {
      users: isAdmin ? await listUsersWithAccess(pool) : [],
      individuals: isAdmin ? (await listIndividualsManaged(pool, {})).map((i) => ({ id: i.id, name: i.displayName })) : [],
      employees: isAdmin ? (await listEmployeesManaged(pool, {})).map((e) => ({ id: e.id, name: e.displayName })) : [],
      programs: programs.map((program) => ({
        ...program,
        agencyRate: scope.canSeeBilledAmounts ? program.agencyRate : null,
        internalRate: scope.canSeeEmployeeAmounts ? program.internalRate : null,
      })),
      programRules: isAdmin ? await listProgramRules(pool) : [],
      audit: isAdmin ? await listAudit(pool, 40) : [],
    };
  });

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Settings and access"
        description="Accounts, visibility, program rates, audit history, and system maintenance."
      />

      <div className="space-y-4">
        <nav aria-label="Settings sections" className="scroll-thin sticky top-[var(--shell-header-height,0px)] z-20 -mx-1 flex gap-1 overflow-x-auto border-b border-[var(--color-rule)] bg-[var(--color-paper)] px-1 py-2">
          <Link href="#account" className="btn btn-sm btn-ghost shrink-0">Account</Link>
          {isAdmin ? <Link href="#access" className="btn btn-sm btn-ghost shrink-0">User access</Link> : null}
          <Link href="#programs" className="btn btn-sm btn-ghost shrink-0">Programs</Link>
          {isAdmin ? <Link href="#activity" className="btn btn-sm btn-ghost shrink-0">Activity</Link> : null}
          {isAdmin ? <Link href="#system" className="btn btn-sm btn-ghost shrink-0">System</Link> : null}
        </nav>

        <section id="account" className="scroll-mt-24"><Card title="Your account">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-b border-[var(--color-rule)] px-5 py-4 text-sm sm:grid-cols-4">
            <dt className="text-[var(--color-ink-faint)]">Name</dt>
            <dd>{user.displayName}</dd>
            <dt className="text-[var(--color-ink-faint)]">Email</dt>
            <dd>{user.email}</dd>
            <dt className="text-[var(--color-ink-faint)]">Role</dt>
            <dd><Badge value={user.role === "admin" ? "committed" : "pending"} label={user.role} /></dd>
            <dt className="text-[var(--color-ink-faint)]">Permissions</dt>
            <dd className="text-[var(--color-ink-soft)]">
              {user.role === "admin"
                ? "Full access, including user management and migrations."
                : user.role === "manager"
                  ? "Read everything; upload, commit and discard imports."
                  : "Read-only."}
            </dd>
          </dl>
          <PasswordForm />
        </Card></section>

        {!result.ok ? (
          <ErrorPanel title="Could not load settings data">{result.error}</ErrorPanel>
        ) : (
          <>
            {isAdmin ? (
              <section id="access" className="scroll-mt-24"><UserAccessAdmin
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
                  individualCount: u.individualCount,
                  employeeCount: u.employeeCount,
                }))}
                individuals={result.data.individuals}
                employees={result.data.employees}
              /></section>
            ) : (
              <Card title="User access">
                <EmptyState title="Administrators manage accounts">
                  <p>Your role is {user.role}, so this section is not available to you.</p>
                </EmptyState>
              </Card>
            )}

            <section id="programs" className="scroll-mt-24 space-y-4"><Card
              title="Programs and rates"
              description={
                isAdmin
                  ? "The effective-dated schedule used by every calculation. Add a program, add a rate, or archive one — history is never overwritten."
                  : "Read-only view of the effective-dated schedule used by every calculation"
              }
              action={
                isAdmin ? (
                  <CreateButton
                    label="New program"
                    title="New program"
                    endpoint="/api/programs"
                    size="sm"
                    fields={
                      <>
                        <Field label="Code" name="code" required help="A short code, e.g. RESPITE. Letters, numbers and underscores." />
                        <Field label="Name" name="name" required />
                        <SelectField
                          label="Group capable"
                          name="isGroupCapable"
                          defaultValue="false"
                          options={[
                            { value: "false", label: "No" },
                            { value: "true", label: "Yes" },
                          ]}
                        />
                        <TextAreaField label="Notes" name="notes" />
                      </>
                    }
                  />
                ) : undefined
              }
            >
              {result.data.programs.length === 0 ? (
                <EmptyState title="No programs are configured" />
              ) : (
                <Table head={<><Th>Code</Th><Th>Program</Th><Th numeric>Funder rate</Th><Th numeric>Employee base rate</Th><Th>Effective from</Th><Th>Group</Th><Th>Active</Th>{isAdmin ? <Th>Actions</Th> : null}</>}>
                  {result.data.programs.map((p) => (
                    <Tr key={p.id}>
                      <Td><code className="text-xs">{p.code}</code></Td>
                      <Td>{p.name}</Td>
                      <Td numeric><Money value={p.agencyRate} /></Td>
                      <Td numeric><Money value={p.internalRate} /></Td>
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

            {isAdmin ? <ProgramRules programs={result.data.programRules} /> : null}</section>

            {isAdmin ? (
              <>
                <section id="activity" className="scroll-mt-24"><Card title="Audit trail" description="The 40 most recent recorded actions">
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
                </Card></section>
                <section id="system" className="scroll-mt-24"><Card title="System maintenance" description="Administrative data operations">
                  <ApplyMigrations />
                  <AttributePayments />
                </Card></section>
              </>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
