import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listUsers } from "@/lib/auth/users";
import { listPrograms, listAudit } from "@/lib/data/app-queries";
import {
  Card, Table, Th, Td, Tr, Money, EmptyState, ErrorPanel, PageHeader, Badge, Plain,
} from "@/components/ui";
import PasswordForm from "@/components/password-form";
import UserAdmin from "@/components/user-admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings — Ahivim Budget Management" };

export default async function SettingsPage() {
  const user = await requireUser("viewer");
  const isAdmin = user.role === "admin";

  const result = await withDb(async (pool) => ({
    users: isAdmin ? await listUsers(pool) : [],
    programs: await listPrograms(pool),
    audit: isAdmin ? await listAudit(pool, 40) : [],
  }));

  return (
    <>
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        description="Your account, and — for administrators — user access, the rate schedule and the audit trail."
      />

      <div className="space-y-4">
        <Card title="Your account">
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
        </Card>

        {!result.ok ? (
          <ErrorPanel title="Could not load settings data">{result.error}</ErrorPanel>
        ) : (
          <>
            {isAdmin ? (
              <UserAdmin
                currentUserId={user.id}
                initialUsers={result.data.users.map((u) => ({
                  id: u.id,
                  email: u.email,
                  displayName: u.displayName,
                  role: u.role,
                  isActive: u.isActive,
                  lastLoginAt: u.lastLoginAt,
                }))}
              />
            ) : (
              <Card title="User access">
                <EmptyState title="Administrators manage accounts">
                  <p>Your role is {user.role}, so this section is not available to you.</p>
                </EmptyState>
              </Card>
            )}

            <Card title="Programs and rates" description="Read-only view of the effective-dated schedule used by every calculation">
              {result.data.programs.length === 0 ? (
                <EmptyState title="No programs are configured" />
              ) : (
                <Table head={<><Th>Code</Th><Th>Program</Th><Th numeric>Agency</Th><Th numeric>Internal</Th><Th>Effective from</Th><Th>Group</Th><Th>Active</Th></>}>
                  {result.data.programs.map((p) => (
                    <Tr key={p.id}>
                      <Td><code className="text-xs">{p.code}</code></Td>
                      <Td>{p.name}</Td>
                      <Td numeric><Money value={p.agencyRate} /></Td>
                      <Td numeric><Money value={p.internalRate} /></Td>
                      <Td><Plain value={p.effectiveFrom} /></Td>
                      <Td>{p.isGroupCapable ? "Yes" : "No"}</Td>
                      <Td>{p.isActive ? "Yes" : "No"}</Td>
                    </Tr>
                  ))}
                </Table>
              )}
            </Card>

            {isAdmin ? (
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
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
