import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listAliases, type AliasKind } from "@/lib/manage/aliases";
import { listIndividualsManaged, type IndividualRecord } from "@/lib/manage/individuals";
import { listEmployeesManaged, type EmployeeRecord } from "@/lib/manage/employees";
import {
  Card, Table, Th, Td, Tr, Badge, Plain, EmptyState, ErrorPanel, PageHeader,
} from "@/components/ui";
import { CreateButton, ActionButton, Field, SelectField } from "@/components/manage/client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Aliases — Ahivim Budget Management" };

const STATUSES = ["pending", "approved", "rejected", "archived"] as const;

/** A date cell that never throws on a null or unparseable value. */
function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export default async function AliasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("manager");
  const canManage = user.role !== "viewer";

  const sp = await searchParams;
  const pick = (k: string): string => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };
  const kindParam = pick("kind");
  const kind: AliasKind | "" =
    kindParam === "individual" || kindParam === "employee" ? kindParam : "";
  const statusParam = pick("status");
  const status = (STATUSES as readonly string[]).includes(statusParam) ? statusParam : "";
  const q = pick("q");

  const result = await withDb(async (pool) => {
    const aliases = await listAliases(pool, {
      kind: kind || undefined,
      status: status || undefined,
      search: q || undefined,
    });
    if (!canManage) {
      return { aliases, individuals: [] as IndividualRecord[], employees: [] as EmployeeRecord[] };
    }
    const [individuals, employees] = await Promise.all([
      listIndividualsManaged(pool, { status: "active" }),
      listEmployeesManaged(pool, { status: "active" }),
    ]);
    return { aliases, individuals, employees };
  });

  const individualOptions = result.ok
    ? result.data.individuals.map((i) => ({ value: i.id, label: i.displayName }))
    : [];
  const employeeOptions = result.ok
    ? result.data.employees.map((e) => ({ value: e.id, label: e.displayName }))
    : [];
  // The create form's canonical dropdown spans both kinds, so each option is
  // labelled with its kind to help the person pick one matching the chosen type.
  const canonicalOptions = [
    ...individualOptions.map((o) => ({ value: o.value, label: `${o.label} — individual` })),
    ...employeeOptions.map((o) => ({ value: o.value, label: `${o.label} — employee` })),
  ];

  const newAliasAction =
    result.ok && canManage && canonicalOptions.length > 0 ? (
      <CreateButton
        label="New alias"
        title="New alias"
        endpoint="/api/aliases"
        fields={
          <>
            <SelectField
              label="Type"
              name="kind"
              required
              placeholder="Choose a type"
              options={[
                { value: "individual", label: "Individual" },
                { value: "employee", label: "Employee" },
              ]}
            />
            <Field
              label="Imported name"
              name="importedName"
              required
              help="The spelling exactly as it appears in the source file."
            />
            <SelectField
              label="Canonical record"
              name="canonicalId"
              required
              placeholder="Choose the person"
              options={canonicalOptions}
            />
          </>
        }
      />
    ) : undefined;

  return (
    <>
      <PageHeader
        eyebrow="Name matching"
        title="Alias management"
        description="Aliases map imported spellings to a canonical person. Only approved aliases resolve future imports; nothing is ever merged automatically."
        action={newAliasAction}
      />

      <form
        method="get"
        className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3"
      >
        <label className="block">
          <span className="text-xs font-medium text-[var(--color-ink-faint)]">Type</span>
          <select
            name="kind"
            defaultValue={kind}
            className="mt-1 block rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm"
          >
            <option value="">All</option>
            <option value="individual">individual</option>
            <option value="employee">employee</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-[var(--color-ink-faint)]">Status</span>
          <select
            name="status"
            defaultValue={status}
            className="mt-1 block rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm"
          >
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-[var(--color-ink-faint)]">Search</span>
          <input
            name="q"
            defaultValue={q}
            placeholder="Imported name or person"
            className="mt-1 block w-56 rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm"
          />
        </label>
        <button
          type="submit"
          className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white"
        >
          Apply
        </button>
        <Link
          href="/aliases"
          className="rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm font-medium"
        >
          Clear
        </Link>
      </form>

      {!result.ok ? (
        <ErrorPanel title="Could not load aliases">{result.error}</ErrorPanel>
      ) : (
        <Card>
          {result.data.aliases.length === 0 ? (
            <EmptyState title="No aliases match this filter." />
          ) : (
            <Table
              caption="Imported spellings mapped to canonical people"
              head={
                <>
                  <Th>Imported name</Th>
                  <Th>Canonical record</Th>
                  <Th>Type</Th>
                  <Th>Status</Th>
                  <Th>Created by</Th>
                  <Th>Approved by</Th>
                  <Th>First seen</Th>
                  <Th>Last used</Th>
                  <Th numeric>Rows affected</Th>
                  {canManage ? <Th>Actions</Th> : null}
                </>
              }
            >
              {result.data.aliases.map((row) => {
                const href = `/${row.kind === "individual" ? "individuals" : "employees"}/${row.canonicalId}`;
                const rematchOptions =
                  row.kind === "individual" ? individualOptions : employeeOptions;
                return (
                  <Tr key={`${row.kind}-${row.id}`}>
                    <Td>{row.importedName}</Td>
                    <Td>
                      <Link className="underline underline-offset-2" href={href}>
                        {row.canonicalName}
                      </Link>
                    </Td>
                    <Td>
                      <Badge value={row.kind} />
                    </Td>
                    <Td>
                      <Badge value={row.status} />
                    </Td>
                    <Td>
                      <Plain value={row.createdBy} />
                    </Td>
                    <Td>
                      <Plain value={row.approvedBy} />
                    </Td>
                    <Td>
                      <span className="tnum">{formatDate(row.firstSeen)}</span>
                    </Td>
                    <Td>
                      <span className="tnum">{formatDate(row.lastUsed)}</span>
                    </Td>
                    <Td numeric className="tnum">
                      {row.rowsAffected}
                    </Td>
                    {canManage ? (
                      <Td>
                        <div className="flex flex-wrap gap-2">
                          {row.status === "pending" ? (
                            <ActionButton
                              label="Approve"
                              endpoint={`/api/aliases/${row.id}`}
                              body={{ kind: row.kind, action: "approve" }}
                              withReason
                              variant="primary"
                            />
                          ) : null}
                          <ActionButton
                            label="Reject"
                            endpoint={`/api/aliases/${row.id}`}
                            body={{ kind: row.kind, action: "reject" }}
                            withReason
                            variant="danger"
                          />
                          <ActionButton
                            label="Archive"
                            endpoint={`/api/aliases/${row.id}`}
                            body={{ kind: row.kind, action: "archive" }}
                            withReason
                          />
                          <CreateButton
                            label="Rematch"
                            title={`Rematch “${row.importedName}”`}
                            endpoint={`/api/aliases/${row.id}`}
                            method="PATCH"
                            variant="secondary"
                            size="sm"
                            hidden={{ kind: row.kind, action: "rematch" }}
                            fields={
                              <SelectField
                                label="Canonical record"
                                name="canonicalId"
                                required
                                placeholder="Choose the person"
                                options={rematchOptions}
                              />
                            }
                          />
                        </div>
                      </Td>
                    ) : null}
                  </Tr>
                );
              })}
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
