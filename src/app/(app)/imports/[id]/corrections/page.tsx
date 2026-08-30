import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getImport, isUuid, listPrograms } from "@/lib/data/app-queries";
import { correctionPersonPickerFilter, listCorrectionQueue } from "@/lib/manage/import-corrections";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import { listEmployeesManaged } from "@/lib/manage/employees";
import { PageHeader, EmptyState, ErrorPanel, ButtonLink } from "@/components/ui";
import CorrectionQueue from "@/components/corrections/correction-queue";
import { importCorrectionsHref } from "@/lib/nav/review-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import corrections — Ahivim Budget Management" };

export default async function CorrectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("manager");
  const canManage = user.role !== "viewer";
  const { id } = await params;
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const requestedRowId = one(sp.row);
  const rowId = requestedRowId && isUuid(requestedRowId) ? requestedRowId : undefined;
  const needingAttention = rowId ? false : one(sp.attention) !== "0";

  const result = await withDb(async (pool) => {
    const file = await getImport(pool, id);
    if (!file || !file.batchId) return { file, queue: null, programs: [], individuals: [], employees: [] };
    const [queue, programs, individuals, employees] = await Promise.all([
      listCorrectionQueue(pool, file.batchId, { needingAttention, rowId }),
      listPrograms(pool),
      // Historical imports may legitimately point to a discharged/inactive
      // person. Archived records stay excluded by the managed-list default.
      listIndividualsManaged(pool, correctionPersonPickerFilter()),
      listEmployeesManaged(pool, correctionPersonPickerFilter()),
    ]);
    return { file, queue, programs, individuals, employees };
  });

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="Import" title="Correction queue" />
        <ErrorPanel title="Correction queue is unavailable">{result.error}</ErrorPanel>
      </>
    );
  }

  const { file, queue, programs, individuals, employees } = result.data;
  if (!file) notFound();

  return (
    <>
      <PageHeader
        eyebrow="Import review"
        title="Correction queue"
        description={file.filename}
        action={<ButtonLink href={`/imports/${file.fileId}`}>Back to import</ButtonLink>}
      />

      {!file.batchId || !queue ? (
        <EmptyState
          title="No rows to correct"
          action={<ButtonLink href={`/imports/${file.fileId}`}>Back to import</ButtonLink>}
        >
          This import has no committed batch yet, so there are no staged rows to curate.
        </EmptyState>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-2">
            {rowId ? (
              <>
                <span className="badge">Source row selected</span>
                <ButtonLink href={importCorrectionsHref(file.fileId)} variant="secondary">
                  All rows needing attention
                </ButtonLink>
              </>
            ) : (
              <>
                <ButtonLink
                  href={importCorrectionsHref(file.fileId)}
                  variant={needingAttention ? "primary" : "secondary"}
                >
                  Needs attention
                </ButtonLink>
                <ButtonLink
                  href={`/imports/${file.fileId}/corrections?attention=0`}
                  variant={needingAttention ? "secondary" : "primary"}
                >
                  All rows
                </ButtonLink>
              </>
            )}
            <span className="ml-2 text-sm text-[var(--color-ink-faint)]">
              {queue.total.toLocaleString()} row{queue.total === 1 ? "" : "s"}
            </span>
          </div>

          {rowId && queue.total === 0 ? (
            <EmptyState
              title="This source row is not available"
              action={<ButtonLink href={importCorrectionsHref(file.fileId)}>Open rows needing attention</ButtonLink>}
            >
              It may belong to another import or may no longer be available.
            </EmptyState>
          ) : (
            <CorrectionQueue
              canManage={canManage}
              batchId={file.batchId}
              rows={queue.rows}
              total={queue.total}
              programs={programs.map((p) => ({ id: p.id, code: p.code, name: p.name }))}
              individuals={individuals.map((i) => ({
                id: i.id,
                label: i.status === "active" ? i.displayName : `${i.displayName} (${i.status})`,
              }))}
              employees={employees.map((employee) => ({
                id: employee.id,
                label: employee.status === "active"
                  ? employee.displayName
                  : `${employee.displayName} (${employee.status})`,
              }))}
            />
          )}
        </>
      )}
    </>
  );
}
