import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import {
  listGroupCandidates,
  classifyGroupCandidate,
  GROUP_STATUSES,
} from "@/lib/manage/group-detection";
import { PageHeader, ErrorPanel, ButtonLink } from "@/components/ui";
import GroupReviewClient, { type ReviewCandidate } from "@/components/reconciliation/group-review";

export const dynamic = "force-dynamic";
export const metadata = { title: "Group review — Ahivim Budget Management" };

const STATUS_LABELS: Record<string, string> = {
  single: "Single",
  detected: "Detected",
  needs_review: "Needs review",
  confirmed: "Confirmed",
};

export default async function GroupReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("manager");
  const canManage = user.role !== "viewer";

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const statusParam = one(sp.status);
  const status = statusParam && (GROUP_STATUSES as readonly string[]).includes(statusParam) ? statusParam : "";

  const result = await withDb(async (pool) => {
    const candidates = await listGroupCandidates(pool, { status: status || undefined });
    return candidates.map<ReviewCandidate>((c) => ({ ...c, classification: classifyGroupCandidate(c) }));
  });

  return (
    <>
      <PageHeader
        eyebrow="Actuals"
        title="Group-detection review"
        description="Multi-individual sessions the importer detected, with the money-conservation check behind each split. Confirming or rejecting a group changes only its status — the allocations the importer wrote are never rewritten here."
        action={<ButtonLink href="/reconciliation">Back to reconciliation</ButtonLink>}
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load group candidates">{result.error}</ErrorPanel>
      ) : (
        <>
          <form
            method="get"
            className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3 text-sm"
          >
            <label className="block">
              <span className="eyebrow">Detection status</span>
              <select
                name="status"
                defaultValue={status}
                className="mt-1 block rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1 text-sm"
              >
                <option value="">All candidates</option>
                {GROUP_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s] ?? s}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white"
            >
              Apply
            </button>
          </form>

          <GroupReviewClient canManage={canManage} candidates={result.data} />
        </>
      )}
    </>
  );
}
