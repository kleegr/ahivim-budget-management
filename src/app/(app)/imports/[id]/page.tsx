import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { loadFile, restage } from "@/lib/import/service";
import { getImport, listImportRows, listImportWarnings, ALLOWED_ROW_STATUSES } from "@/lib/data/app-queries";
import {
  Card, Table, Th, Td, Tr, Badge, EmptyState, ErrorPanel, PageHeader, StatTile, Money, ButtonLink, Pagination,
} from "@/components/ui";
import CommitPanel from "@/components/commit-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import review — Ahivim Budget Management" };

const PAGE_SIZE = 50;

export default async function ImportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("viewer");
  const { id } = await params;
  const sp = await searchParams;
  const first = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const statusFilter = ALLOWED_ROW_STATUSES.has(first("status") ?? "") ? first("status")! : undefined;
  const offset = Math.max(0, Number(first("offset") ?? 0) || 0);

  const result = await withDb(async (pool) => {
    const file = await loadFile(pool, id);
    if (!file) return null;
    const summary = await getImport(pool, id);
    const staging = file.payload ? await restage(pool, file.payload) : null;
    const committedRows = file.committedBatchId
      ? await listImportRows(pool, file.committedBatchId, { status: statusFilter, limit: PAGE_SIZE, offset })
      : { rows: [], total: 0 };
    const warnings = file.committedBatchId
      ? await listImportWarnings(pool, file.committedBatchId, 100)
      : [];
    return { file, summary, staging, committedRows, warnings };
  });

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="Import" title="Import review" />
        <ErrorPanel title="Could not load this import">{result.error}</ErrorPanel>
      </>
    );
  }
  if (!result.data) notFound();

  const { file, summary, staging, committedRows, warnings } = result.data;
  const committed = Boolean(file.committedBatchId);
  const counts = staging?.counts;

  return (
    <>
      <PageHeader
        eyebrow={committed ? "Committed import" : "Staged import — review"}
        title={file.filename}
        description={`SHA-256 ${file.checksum} · ${(file.byteSize / 1024).toFixed(0)} KB · uploaded ${new Date(file.uploadedAt).toLocaleString()}`}
        action={<ButtonLink href="/imports">All imports</ButtonLink>}
      />

      {staging ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Source rows" value={staging.totalSourceRows.toLocaleString()} hint="Every row is preserved" />
            <StatTile label="Valid" value={counts!.valid.toLocaleString()} tone="good" hint="Eligible to become transactions" />
            <StatTile label="Needs review" value={counts!.needsReview.toLocaleString()} tone={counts!.needsReview ? "warn" : "good"} hint="Held out of the ledger" />
            <StatTile label="Invalid / duplicate" value={`${counts!.invalid.toLocaleString()} / ${counts!.duplicates.toLocaleString()}`} tone={counts!.invalid || counts!.duplicates ? "warn" : "good"} hint="Kept, not imported" />
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Groups detected" value={counts!.groupsDetected.toLocaleString()} hint={`${counts!.groupsNeedingReview} need review`} />
            <StatTile label="Rate exceptions" value={counts!.rateExceptions.toLocaleString()} tone={counts!.rateExceptions ? "warn" : "good"} hint="Imported rate off the schedule" />
            <StatTile label="Unknown programs" value={counts!.unknownPrograms.toLocaleString()} tone={counts!.unknownPrograms ? "warn" : "good"} />
            <StatTile label="Unmatched names" value={(counts!.unmatchedIndividuals + counts!.unmatchedEmployees).toLocaleString()} tone={counts!.unmatchedIndividuals + counts!.unmatchedEmployees ? "warn" : "good"} hint={`${counts!.ambiguousNames} ambiguous`} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card title="Reconciliation" description="The workbook's own control totals against these rows">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-5 py-4 text-sm">
                <dt className="text-[var(--color-ink-faint)]">Agency total (workbook)</dt>
                <dd className="text-right"><Money value={staging.reconciliation.workbookAgencyGross} /></dd>
                <dt className="text-[var(--color-ink-faint)]">Agency total (these rows)</dt>
                <dd className="text-right"><Money value={staging.reconciliation.importedAgencyGross} /></dd>
                <dt className="text-[var(--color-ink-faint)]">Employee amount (workbook)</dt>
                <dd className="text-right"><Money value={staging.reconciliation.workbookInternalAmount} /></dd>
                <dt className="text-[var(--color-ink-faint)]">Employee amount (these rows)</dt>
                <dd className="text-right"><Money value={staging.reconciliation.importedInternalAmount} /></dd>
              </dl>
              <p className="border-t border-[var(--color-rule)] px-5 py-3 text-sm text-[var(--color-ink-soft)]">
                {staging.reconciliation.note}
              </p>
            </Card>

            <Card title="Unresolved references" description="Everything staging could not match">
              <div className="space-y-3 px-5 py-4 text-sm">
                <UnresolvedList label="Unknown programs" values={staging.unknownProgramLabels} />
                <UnresolvedList label="Unmatched individuals" values={staging.unmatchedIndividualNames} />
                <UnresolvedList label="Unmatched employees" values={staging.unmatchedEmployeeNames} />
              </div>
            </Card>
          </div>

          {!committed && user.role !== "viewer" ? (
            <div className="mt-4">
              <CommitPanel
                fileId={file.id}
                validRows={counts!.valid}
                heldRows={counts!.needsReview + counts!.invalid + counts!.duplicates}
              />
            </div>
          ) : null}

          {staging.warnings.length > 0 ? (
            <div className="mt-4">
              <Card title="Staging warnings" description={`${staging.warnings.length} recorded; the first 100 are shown`}>
                <Table head={<><Th>Row</Th><Th>Severity</Th><Th>Category</Th><Th>Message</Th></>}>
                  {staging.warnings.slice(0, 100).map((w, index) => (
                    <Tr key={`${w.category}-${w.sourceRowNumber}-${index}`}>
                      <Td className="tnum">{w.sourceRowNumber ?? "—"}</Td>
                      <Td><Badge value={w.severity === "error" ? "invalid" : w.severity === "warning" ? "needs_review" : "pending"} label={w.severity} /></Td>
                      <Td>{w.category.replace(/_/g, " ")}</Td>
                      <Td>{w.message}</Td>
                    </Tr>
                  ))}
                </Table>
              </Card>
            </div>
          ) : null}
        </>
      ) : null}

      {committed ? (
        <div className="mt-4 space-y-4">
          <Card
            title="Committed source rows"
            description={`${summary?.importedRows.toLocaleString() ?? 0} of ${summary?.totalRows.toLocaleString() ?? 0} source rows became transactions. Every source row is stored regardless of status.`}
            action={
              <div className="flex flex-wrap gap-2">
                <ButtonLink href={`/imports/${file.id}`}>All</ButtonLink>
                {["imported", "needs_review", "invalid", "duplicate"].map((s) => (
                  <ButtonLink key={s} href={`/imports/${file.id}?status=${s}`}>
                    {s.replace(/_/g, " ")}
                  </ButtonLink>
                ))}
              </div>
            }
          >
            {committedRows.rows.length === 0 ? (
              <EmptyState title="No rows match this filter" />
            ) : (
              <>
                <Table head={<><Th numeric>Source row</Th><Th>Status</Th><Th>Individual</Th><Th>Employee</Th><Th>Program</Th><Th>Fingerprint</Th></>}>
                  {committedRows.rows.map((row) => (
                    <Tr key={row.id}>
                      <Td numeric className="tnum">{row.sourceRowNumber}</Td>
                      <Td><Badge value={row.status} /></Td>
                      <Td>{row.individual ?? <span className="text-[var(--color-ink-faint)]">{row.raw?.individual ?? "—"}</span>}</Td>
                      <Td>{row.employee ?? <span className="text-[var(--color-ink-faint)]">{row.raw?.employee ?? "—"}</span>}</Td>
                      <Td>{row.program ?? <span className="text-[var(--color-ink-faint)]">{row.raw?.program ?? "—"}</span>}</Td>
                      <Td><code className="text-xs">{row.fingerprint ? `${row.fingerprint.slice(0, 16)}…` : "—"}</code></Td>
                    </Tr>
                  ))}
                </Table>
                <Pagination
                  basePath={`/imports/${file.id}`}
                  total={committedRows.total}
                  limit={PAGE_SIZE}
                  offset={offset}
                  params={{ status: statusFilter }}
                />
              </>
            )}
          </Card>

          {warnings.length > 0 ? (
            <Card title="Recorded warnings" description="Stored with the batch so they survive the review session">
              <Table head={<><Th>Row</Th><Th>Severity</Th><Th>Category</Th><Th>Message</Th></>}>
                {warnings.map((w) => (
                  <Tr key={w.id}>
                    <Td className="tnum">{w.sourceRowNumber ?? "—"}</Td>
                    <Td><Badge value={w.severity === "error" ? "invalid" : "needs_review"} label={w.severity} /></Td>
                    <Td>{w.category.replace(/_/g, " ")}</Td>
                    <Td>{w.message}</Td>
                  </Tr>
                ))}
              </Table>
            </Card>
          ) : null}
        </div>
      ) : null}

      {!staging && !committed ? (
        <ErrorPanel title="This upload has no readable staged payload">
          <p>
            The pending payload is missing or unreadable, so it cannot be reviewed or committed.
            Upload the workbook again. <Link href="/imports">Back to imports</Link>.
          </p>
        </ErrorPanel>
      ) : null}
    </>
  );
}

function UnresolvedList({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      {values.length === 0 ? (
        <p className="text-[var(--color-ink-soft)]">None — everything resolved.</p>
      ) : (
        <ul className="mt-1 list-inside list-disc text-[var(--color-ink-soft)]">
          {values.slice(0, 25).map((value) => (
            <li key={value}>{value}</li>
          ))}
          {values.length > 25 ? <li>…and {values.length - 25} more</li> : null}
        </ul>
      )}
    </div>
  );
}
