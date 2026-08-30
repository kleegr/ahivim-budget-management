import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listImports } from "@/lib/data/app-queries";
import { Card, Table, Th, Td, Tr, Badge, EmptyState, ErrorPanel, PageHeader, ButtonLink } from "@/components/ui";
import UploadForm from "@/components/upload-form";
import { importCorrectionsHref } from "@/lib/nav/review-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Imports — Ahivim Budget Management" };

export default async function ImportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("manager");
  const sp = await searchParams;
  const requestedView = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const reconciliationOnly = requestedView === "reconciliation";
  const result = await withDb((pool) => listImports(pool, 100, {
    reconciliationNeedsReview: reconciliationOnly ? true : undefined,
  }));
  const visibleRows = result.ok ? result.data : [];

  return (
    <>
      <PageHeader
        eyebrow="Data source"
        title="Backup imports"
        description="Stage and review a manual source file when the automatic sync is unavailable."
      />

      <div className="mb-6 rounded-lg border border-[var(--color-rule)] border-l-4 border-l-[var(--color-primary)] bg-[var(--color-primary-tint)] px-5 py-3.5">
        <p className="text-sm text-[var(--color-ink)]">
          Transactions now sync automatically from the Google Sheet.{" "}
          <Link className="font-medium underline underline-offset-2" href="/sync">
            Open Sheet sync
          </Link>{" "}
          for status, history and review. Use the upload below only as a manual backup.
        </p>
      </div>

      {user.role === "viewer" ? null : <UploadForm />}

      <div className="mt-6">
        {!result.ok ? (
          <ErrorPanel title="Imports are unavailable">{result.error}</ErrorPanel>
        ) : (
          <Card
            title={reconciliationOnly ? "Imports with total differences" : "All uploads"}
            action={reconciliationOnly ? <ButtonLink href="/imports" variant="secondary">All imports</ButtonLink> : undefined}
          >
            {visibleRows.length === 0 ? (
              <EmptyState title={reconciliationOnly ? "No import totals need review" : "No workbooks have been uploaded"}>
                <p>
                  {reconciliationOnly
                    ? "Every committed import agrees with its recorded control totals."
                    : user.role === "viewer"
                    ? "A manager or administrator uploads workbooks. Nothing has been uploaded yet."
                    : "Choose an .xlsx workbook above. It is parsed and staged for review; committing is a separate, deliberate step."}
                </p>
              </EmptyState>
            ) : (
              <Table
                caption="Uploaded workbooks with their staging and commit state"
                head={
                  <>
                    <Th>File</Th>
                    <Th>Status</Th>
                    <Th numeric>Source rows</Th>
                    <Th numeric>Imported</Th>
                    <Th numeric>Review</Th>
                    <Th numeric>Duplicates</Th>
                    <Th>Totals</Th>
                    <Th>Uploaded</Th>
                  </>
                }
              >
                {visibleRows.map((row) => (
                  <Tr key={row.fileId}>
                    <Td>
                      <Link className="underline underline-offset-2" href={`/imports/${row.fileId}`}>
                        {row.filename}
                      </Link>
                      <p className="tnum text-xs text-[var(--color-ink-faint)]">
                        {(row.byteSize / 1024).toFixed(0)} KB · sha256 {row.checksum.slice(0, 12)}…
                      </p>
                    </Td>
                    <Td><Badge value={row.status} /></Td>
                    <Td numeric className="tnum">{row.totalRows.toLocaleString()}</Td>
                    <Td numeric className="tnum">{row.importedRows.toLocaleString()}</Td>
                    <Td numeric className="tnum">
                      {row.actionableRows > 0 && row.batchId ? (
                        <Link className="font-semibold text-[var(--color-primary)] underline-offset-2 hover:underline" href={importCorrectionsHref(row.fileId)}>
                          {row.actionableRows.toLocaleString()}
                        </Link>
                      ) : row.actionableRows.toLocaleString()}
                    </Td>
                    <Td numeric className="tnum">{row.duplicateRows.toLocaleString()}</Td>
                    <Td>
                      {row.reconciliationNeedsReview ? (
                        <Link className="text-xs font-semibold text-[var(--color-warn)] underline-offset-2 hover:underline" href={`/imports/${row.fileId}#reconciliation`}>
                          Review difference
                        </Link>
                      ) : row.reconciliationChecked ? (
                        <span className="text-xs text-[var(--color-success)]">Totals match</span>
                      ) : (
                        <span className="text-xs text-[var(--color-ink-faint)]">Not checked</span>
                      )}
                    </Td>
                    <Td>
                      <span className="text-xs">{new Date(row.uploadedAt).toLocaleString()}</span>
                      {row.uploadedBy ? (
                        <p className="text-xs text-[var(--color-ink-faint)]">{row.uploadedBy}</p>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
