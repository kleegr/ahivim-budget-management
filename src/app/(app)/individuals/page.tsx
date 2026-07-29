import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listIndividualsManaged, INDIVIDUAL_STATUSES } from "@/lib/manage/individuals";
import { Card, Table, Th, Td, Tr, Badge, EmptyState, ErrorPanel, PageHeader } from "@/components/ui";
import { CreateButton, ActionButton, Field, TextAreaField } from "@/components/manage/client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Individuals — Ahivim Budget Management" };

/** The create/edit form shares one field set. */
function individualFields() {
  return (
    <>
      <Field label="Display name" name="displayName" required help="How this person is shown everywhere." />
      <Field label="Legal name" name="legalName" help="Defaults to the display name if left blank." />
      <Field label="Preferred name" name="preferredName" />
      <Field label="External reference" name="externalRef" help="An agency or case number, if there is one." />
      <TextAreaField label="Notes" name="notes" />
    </>
  );
}

export default async function IndividualsPage({
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
    listIndividualsManaged(pool, {
      search: q || undefined,
      status: statusFilter || undefined,
      includeArchived: archived,
    }),
  );

  return (
    <>
      <PageHeader
        eyebrow="Register"
        title="Individuals"
        description="Everyone with authorized services. Search, filter by status, and open a record to manage budgets, authorizations and assignments."
        action={
          canEdit ? (
            <CreateButton
              label="New individual"
              title="New individual"
              endpoint="/api/individuals"
              fields={individualFields()}
            />
          ) : undefined
        }
      />

      <form
        method="get"
        className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3"
      >
        <label className="block">
          <span className="text-xs font-medium text-[var(--color-ink-faint)]">Search</span>
          <input
            name="q"
            defaultValue={q}
            placeholder="Name or reference"
            className="mt-1 block w-56 rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-[var(--color-ink-faint)]">Status</span>
          <select
            name="status"
            defaultValue={statusFilter}
            className="mt-1 block rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm"
          >
            <option value="">All</option>
            {INDIVIDUAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <input type="checkbox" name="archived" value="1" defaultChecked={archived} />
          Include archived
        </label>
        <button
          type="submit"
          className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white"
        >
          Apply
        </button>
        <Link
          href="/individuals"
          className="rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm font-medium"
        >
          Clear
        </Link>
      </form>

      {!result.ok ? (
        <ErrorPanel title="Could not load individuals">{result.error}</ErrorPanel>
      ) : (
        <Card>
          {result.data.length === 0 ? (
            <EmptyState title="No individuals match">
              <p>
                No one matches these filters.{" "}
                {q || statusFilter || archived ? "Clear the filters" : "Individuals also appear here once a workbook is committed"}
                {canEdit ? ", or add one with “New individual”." : "."}
              </p>
            </EmptyState>
          ) : (
            <Table
              caption="Individuals with their lifecycle status"
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
                    <Link className="underline underline-offset-2" href={`/individuals/${row.id}`}>
                      {row.displayName}
                    </Link>
                    {row.preferredName ? (
                      <span className="text-[var(--color-ink-faint)]"> ({row.preferredName})</span>
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
                          endpoint={`/api/individuals/${row.id}`}
                          body={{ action: "restore" }}
                          withReason
                        />
                      ) : (
                        <ActionButton
                          label="Archive"
                          endpoint={`/api/individuals/${row.id}`}
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
