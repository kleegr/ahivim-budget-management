import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listEmployeesManaged, EMPLOYEE_STATUSES } from "@/lib/manage/employees";
import { Card, Table, Th, Td, Tr, Badge, EmptyState, ErrorPanel, PageHeader } from "@/components/ui";
import { CreateButton, ActionButton, Field, TextAreaField } from "@/components/manage/client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Employees — Ahivim Budget Management" };

/** The create/edit form shares one field set. */
function employeeFields() {
  return (
    <>
      <Field label="Display name" name="displayName" required help="How this employee is shown everywhere." />
      <Field label="External reference" name="externalRef" help="A payroll or staff number, if there is one." />
      <TextAreaField label="Notes" name="notes" />
    </>
  );
}

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("viewer");
  const canEdit = user.role !== "viewer";

  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const statusFilter = typeof sp.status === "string" ? sp.status : "";
  const archived = sp.archived === "1";

  const result = await withDb((pool) =>
    listEmployeesManaged(pool, {
      search: q || undefined,
      status: statusFilter || undefined,
      includeArchived: archived,
    }),
  );

  const count = result.ok ? result.data.length : 0;
  const buildHref = (p: { q?: string; status?: string; archived?: boolean }) => {
    const qs = new URLSearchParams();
    if (p.q) qs.set("q", p.q);
    if (p.status) qs.set("status", p.status);
    if (p.archived) qs.set("archived", "1");
    const s = qs.toString();
    return s ? `/employees?${s}` : "/employees";
  };
  const activeFilters: { label: string; href: string }[] = [];
  if (q) activeFilters.push({ label: `Search: "${q}"`, href: buildHref({ status: statusFilter, archived }) });
  if (statusFilter) activeFilters.push({ label: `Status: ${statusFilter}`, href: buildHref({ q, archived }) });
  if (archived) activeFilters.push({ label: "Including archived", href: buildHref({ q, status: statusFilter }) });

  return (
    <>
      <PageHeader
        eyebrow="Register"
        title="Employees"
        description="Everyone who delivers services. Search, filter by status, and open a record to see hours, the individuals they may serve, and recent transactions."
        action={
          canEdit ? (
            <CreateButton
              label="New employee"
              title="New employee"
              endpoint="/api/employees"
              fields={employeeFields()}
            />
          ) : undefined
        }
      />

      <form
        method="get"
        className="mb-3 flex flex-wrap items-end gap-3 rounded-xl border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3"
      >
        <label className="block">
          <span className="eyebrow">Search</span>
          <input name="q" defaultValue={q} placeholder="Name or reference" className="input mt-1 block w-56" />
        </label>
        <label className="block">
          <span className="eyebrow">Status</span>
          <select name="status" defaultValue={statusFilter} className="select mt-1 block">
            <option value="">All statuses</option>
            {EMPLOYEE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" name="archived" value="1" defaultChecked={archived} />
          Include archived
        </label>
        <button type="submit" className="btn btn-sm btn-primary">
          Apply filters
        </button>
        <Link href="/employees" className="btn btn-sm btn-secondary">
          Reset
        </Link>
        <span className="ml-auto self-center text-sm text-[var(--color-ink-faint)]">
          <span className="tnum font-semibold text-[var(--color-ink)]">{count}</span> {count === 1 ? "employee" : "employees"}
        </span>
      </form>

      {activeFilters.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="eyebrow">Active filters</span>
          {activeFilters.map((f) => (
            <Link
              key={f.label}
              href={f.href}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-primary-tint)] px-2.5 py-1 text-xs font-medium text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary-soft)]"
            >
              {f.label}
              <span aria-hidden>✕</span>
            </Link>
          ))}
          <Link href="/employees" className="text-xs text-[var(--color-ink-faint)] underline underline-offset-2">
            Clear all
          </Link>
        </div>
      ) : null}

      {!result.ok ? (
        <ErrorPanel title="Could not load employees">{result.error}</ErrorPanel>
      ) : (
        <Card>
          {result.data.length === 0 ? (
            <EmptyState title="No employees match">
              <p>
                No one matches these filters.{" "}
                {q || statusFilter || archived
                  ? "Clear the filters"
                  : "Employees also appear here once a workbook is committed"}
                {canEdit ? ", or add one with “New employee”." : "."}
              </p>
            </EmptyState>
          ) : (
            <Table
              caption="Employees with their lifecycle status"
              head={
                <>
                  <Th>Name</Th>
                  <Th>Status</Th>
                  {canEdit ? <Th>Actions</Th> : null}
                </>
              }
            >
              {result.data.map((row) => (
                <Tr key={row.id}>
                  <Td>
                    <Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={`/employees/${row.id}`}>
                      {row.displayName}
                    </Link>
                    {row.externalRef ? (
                      <span className="text-[var(--color-ink-faint)]"> ({row.externalRef})</span>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge value={row.status} />
                  </Td>
                  {canEdit ? (
                    <Td>
                      {row.status === "archived" ? (
                        <ActionButton
                          label="Restore"
                          endpoint={`/api/employees/${row.id}`}
                          body={{ action: "restore" }}
                          withReason
                        />
                      ) : (
                        <ActionButton
                          label="Archive"
                          endpoint={`/api/employees/${row.id}`}
                          body={{ action: "archive" }}
                          withReason
                        />
                      )}
                    </Td>
                  ) : null}
                </Tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
