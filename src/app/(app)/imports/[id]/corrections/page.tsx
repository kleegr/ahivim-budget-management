import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getImport, listPrograms } from "@/lib/data/app-queries";
import { listCorrectionQueue } from "@/lib/manage/import-corrections";
import { listIndividualsManaged } from "@/lib/manage/individuals";
import { PageHeader, EmptyState, ErrorPanel, ButtonLink } from "@/components/ui";
import CorrectionQueue from "@/components/corrections/correction-queue";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import corrections — Ahivim Budget Management" };

export default async function CorrectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("viewer");
  const canManage = user.role !== "viewer";
  const { id } = await params;
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const needingAttention = one(sp.attention) !== "0";

  const result = await withDb(async (pool) => {
    const file = await getImport(pool, id);
    if (!file || !file.batchId) return { file, queue: null, programs: [], individuals: [] };
    const [queue, programs, individuals] = await Promise.all([
      listCorrectionQueue(pool, file.batchId, { needingAttention }),
      listPrograms(pool),
      listIndividualsManaged(pool, { status: "active" }),
    ]);
    return { file, queue, programs, individuals };
  });

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="Import" title="Correction queue" />
        <ErrorPanel title="Could not load the correction queue">{result.error}</ErrorPanel>
      </>
    );
  }

  const { file, queue, programs, individuals } = result.data;
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
            <ButtonLink
              href={`/imports/${file.fileId}/corrections`}
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
            <span className="ml-2 text-sm text-[var(--color-ink-faint)]">
              {queue.total.toLocaleString()} row{queue.total === 1 ? "" : "s"}
            </span>
          </div>

          <CorrectionQueue
            canManage={canManage}
            batchId={file.batchId}
            rows={queue.rows}
            total={queue.total}
            programs={programs.map((p) => ({ id: p.id, code: p.code, name: p.name }))}
            individuals={individuals.map((i) => ({ id: i.id, label: i.displayName }))}
          />
        </>
      )}
    </>
  );
}
