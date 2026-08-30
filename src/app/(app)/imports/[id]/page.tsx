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
import { importCorrectionsHref, importIssueCopy } from "@/lib/nav/review-actions";

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
  const user = await requireUser("manager");
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const first = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const statusFilter = ALLOWED_ROW_STATUSES.has(first("status") ?? "") ? first("status")! : undefined;
  const offset = Math.max(0, Number(first("offset") ?? 0) || 0);

  const result = await withDb(async (pool) => {
    const [file, summary] = await Promise.all([
      loadFile(pool, id),
      getImport(pool, id),
    ]);
    if (!file) return null;
    const [staging, committedRows, warnings] = await Promise.all([
      file.payload ? restage(pool, file.payload) : Promise.resolve(null),
      file.committedBatchId
        ? listImportRows(pool, file.committedBatchId, { status: statusFilter, limit: PAGE_SIZE, offset })
        : Promise.resolve({ rows: [], total: 0 }),
      file.committedBatchId
        ? listImportWarnings(pool, file.committedBatchId, 100)
        : Promise.resolve([]),
    ]);
    return { file, summary, staging, committedRows, warnings };
  });

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="Import" title="Import review" />
        <ErrorPanel title="Import review is unavailable">{result.error}</ErrorPanel>
      </>
    );
  }
  if (!result.data) notFound();

  const { file, summary, staging, committedRows, warnings } = result.data;
  const committed = Boolean(file.committedBatchId);
  const counts = staging?.counts;
  const correctionsHref = importCorrectionsHref(file.id);
  const actionableRows = committed
    ? summary?.actionableRows ?? 0
    : counts
      ? counts.needsReview + counts.invalid
      : 0;
  const displayedReconciliation = committed && summary
    ? {
        workbookAgencyGross: summary.sourceAgencyGross,
        importedAgencyGross: summary.importedAgencyGross,
        workbookInternalAmount: summary.sourceInternalAmount,
        importedInternalAmount: summary.importedInternalAmount,
        note: summary.reconciliationNotes ?? "No reconciliation note was recorded for this import.",
      }
    : staging?.reconciliation ?? null;

  return (
    <>
      <PageHeader
        eyebrow={committed ? "Committed import" : "Staged import — review"}
        title={file.filename}
        description={`SHA-256 ${file.checksum} · ${(file.byteSize / 1024).toFixed(0)} KB · uploaded ${new Date(file.uploadedAt).toLocaleString()}`}
        action={<ButtonLink href="/imports">All imports</ButtonLink>}
      />

      {committed && !staging ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Source rows" value={(summary?.totalRows ?? 0).toLocaleString()} hint="Every row is preserved" />
          <StatTile label="Imported" value={(summary?.importedRows ?? 0).toLocaleString()} tone="good" hint="Ledger transactions" />
          <StatTile
            label="Rows needing action"
            value={actionableRows.toLocaleString()}
            tone={actionableRows ? "warn" : "good"}
            hint="Matches the correction queue"
            href={actionableRows ? correctionsHref : undefined}
          />
          <StatTile label="Recorded warnings" value={(summary?.warningRows ?? 0).toLocaleString()} hint="Includes resolved history" />
        </div>
      ) : null}

      {staging ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Source rows" value={staging.totalSourceRows.toLocaleString()} hint="Every row is preserved" />
            <StatTile label="Valid" value={counts!.valid.toLocaleString()} tone="good" hint="Eligible to become transactions" />
            <StatTile label={committed ? "Rows needing action" : "Needs review"} value={actionableRows.toLocaleString()} tone={actionableRows ? "warn" : "good"} hint="Held out of the ledger" href={committed && actionableRows ? correctionsHref : undefined} />
            <StatTile label="Invalid / already recorded" value={`${counts!.invalid.toLocaleString()} / ${counts!.confirmedDuplicates.toLocaleString()}`} tone={counts!.invalid ? "warn" : "good"} hint="Problems versus safely skipped repeats" href={committed && actionableRows ? correctionsHref : undefined} />
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Groups detected" value={counts!.groupsDetected.toLocaleString()} hint={`${counts!.groupsNeedingReview} need review`} />
            <StatTile label="Rate exceptions" value={counts!.rateExceptions.toLocaleString()} tone={counts!.rateExceptions ? "warn" : "good"} hint="Imported rate off the schedule" />
            <StatTile label="Unknown programs" value={counts!.unknownPrograms.toLocaleString()} tone={counts!.unknownPrograms ? "warn" : "good"} />
            <StatTile label="Unmatched names" value={(counts!.unmatchedIndividuals + counts!.unmatchedEmployees).toLocaleString()} tone={counts!.unmatchedIndividuals + counts!.unmatchedEmployees ? "warn" : "good"} hint={`${counts!.ambiguousNames} ambiguous`} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {displayedReconciliation ? (
              <Card
                className="scroll-mt-24"
                title="Source reconciliation"
                description={committed ? "Recorded control totals compared with the current imported ledger" : "Control totals compared with staged activity"}
                action={committed && actionableRows > 0
                  ? <ButtonLink href={correctionsHref}>Correct held rows</ButtonLink>
                  : undefined}
              >
                <span id="reconciliation" className="block scroll-mt-24" aria-hidden />
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-5 py-4 text-sm">
                  <dt className="text-[var(--color-ink-faint)]">Funder billed (source)</dt>
                  <dd className="text-right"><Money value={displayedReconciliation.workbookAgencyGross} /></dd>
                  <dt className="text-[var(--color-ink-faint)]">Funder billed ({committed ? "ledger" : "staged"})</dt>
                  <dd className="text-right"><Money value={displayedReconciliation.importedAgencyGross} /></dd>
                  <dt className="text-[var(--color-ink-faint)]">Employee base (source)</dt>
                  <dd className="text-right"><Money value={displayedReconciliation.workbookInternalAmount} /></dd>
                  <dt className="text-[var(--color-ink-faint)]">Employee base ({committed ? "ledger" : "staged"})</dt>
                  <dd className="text-right"><Money value={displayedReconciliation.importedInternalAmount} /></dd>
                </dl>
                <p className="border-t border-[var(--color-rule)] px-5 py-3 text-sm text-[var(--color-ink-soft)]">
                  {displayedReconciliation.note}
                </p>
              </Card>
            ) : null}

            <Card
              title="Unresolved references"
              description="Everything staging could not match"
              action={committed && actionableRows > 0
                ? <ButtonLink href={correctionsHref}>Correct rows</ButtonLink>
                : undefined}
            >
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
                heldRows={counts!.needsReview + counts!.invalid}
              />
            </div>
          ) : null}

          {staging.warnings.length > 0 ? (
            <div className="mt-4">
              <Card
                title="Staging warnings"
                description={committed
                  ? `${staging.warnings.length} recorded at import time. Resolved warnings remain visible as history.`
                  : `${staging.warnings.length} recorded. Commit the file to create a correction queue; held rows enter the ledger only after an explicit reviewed apply.`}
              >
                <Table head={<><Th>Row</Th><Th>Severity</Th><Th>Category</Th><Th>What to do</Th></>}>
                  {staging.warnings.slice(0, 100).map((w, index) => (
                    <Tr key={`${w.category}-${w.sourceRowNumber}-${index}`}>
                      <Td className="tnum">{w.sourceRowNumber ?? "—"}</Td>
                      <Td><Badge value={w.severity === "error" ? "invalid" : w.severity === "warning" ? "needs_review" : "pending"} label={w.severity} /></Td>
                      <Td>{w.category.replace(/_/g, " ")}</Td>
                      <Td>{importIssueCopy(w.category, w.message)}</Td>
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
                <Table head={<><Th numeric>Source row</Th><Th>Status</Th><Th>Individual</Th><Th>Employee</Th><Th>Program</Th><Th>Fingerprint</Th><Th><span className="sr-only">Open</span></Th></>}>
                  {committedRows.rows.map((row) => (
                    <Tr key={row.id}>
                      <Td numeric className="tnum">{row.sourceRowNumber}</Td>
                      <Td><Badge value={row.status} /></Td>
                      <Td>{row.individual ?? <span className="text-[var(--color-ink-faint)]">{storedSourceCell(row.raw, "individual")}</span>}</Td>
                      <Td>{row.employee ?? <span className="text-[var(--color-ink-faint)]">{storedSourceCell(row.raw, "employee")}</span>}</Td>
                      <Td>{row.program ?? <span className="text-[var(--color-ink-faint)]">{storedSourceCell(row.raw, "programDescription")}</span>}</Td>
                      <Td><code className="text-xs">{row.fingerprint ? `${row.fingerprint.slice(0, 16)}…` : "—"}</code></Td>
                      <Td>
                        <Link className="text-xs font-semibold text-[var(--color-primary)] underline-offset-2 hover:underline" href={importCorrectionsHref(file.id, row.id)}>
                          {row.status === "imported" ? "Open source" : "Fix row"}
                        </Link>
                      </Td>
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
            <Card title="Recorded warnings" description="Historical warnings stay with the batch; only unresolved held rows offer a fix action">
              <Table head={<><Th>Row</Th><Th>Severity</Th><Th>Category</Th><Th>What to do</Th><Th><span className="sr-only">Open</span></Th></>}>
                {warnings.map((w) => (
                  <Tr key={w.id}>
                    <Td className="tnum">{w.sourceRowNumber ?? "—"}</Td>
                    <Td><Badge value={w.severity === "error" ? "invalid" : "needs_review"} label={w.severity} /></Td>
                    <Td>{w.category.replace(/_/g, " ")}</Td>
                    <Td>{w.resolvedAt ? "Resolved; retained as source history." : importIssueCopy(w.category, w.message)}</Td>
                    <Td>
                      {w.importRowId && !w.resolvedAt && ["needs_review", "invalid"].includes(w.rowStatus ?? "") ? (
                        <Link className="text-xs font-semibold text-[var(--color-primary)] underline-offset-2 hover:underline" href={importCorrectionsHref(file.id, w.importRowId)}>
                          Fix row
                        </Link>
                      ) : w.importRowId ? (
                        <Link className="text-xs font-semibold text-[var(--color-primary)] underline-offset-2 hover:underline" href={importCorrectionsHref(file.id, w.importRowId)}>
                          Source history
                        </Link>
                      ) : <span className="text-xs text-[var(--color-ink-faint)]">Import-level note</span>}
                    </Td>
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

function storedSourceCell(raw: Record<string, unknown>, field: string): string {
  const nested = raw?.raw;
  const cells = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : raw;
  const value = cells[field];
  return value == null || String(value).trim() === "" ? "—" : String(value);
}
