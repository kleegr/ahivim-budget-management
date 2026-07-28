import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { listImports } from "@/lib/data/app-queries";
import { Card, Table, Th, Td, Tr, Badge, EmptyState, ErrorPanel, PageHeader } from "@/components/ui";
import UploadForm from "@/components/upload-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Imports — Ahivim Budget Management" };

export default async function ImportsPage() {
  const user = await requireUser("viewer");
  const result = await withDb((pool) => listImports(pool, 100));

  return (
    <>
      <PageHeader
        eyebrow="Workbooks"
        title="Imports"
        description="Upload → parse → stage → review → commit. Nothing reaches the ledger until a manager commits it, and the same file cannot be committed twice."
      />

      {user.role === "viewer" ? null : <UploadForm />}

      <div className="mt-6">
        {!result.ok ? (
          <ErrorPanel title="Could not load imports">{result.error}</ErrorPanel>
        ) : (
          <Card title="All uploads">
            {result.data.length === 0 ? (
              <EmptyState title="No workbooks have been uploaded">
                <p>
                  {user.role === "viewer"
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
                    <Th>Uploaded</Th>
                  </>
                }
              >
                {result.data.map((row) => (
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
                    <Td numeric className="tnum">{row.warningRows.toLocaleString()}</Td>
                    <Td numeric className="tnum">{row.duplicateRows.toLocaleString()}</Td>
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
