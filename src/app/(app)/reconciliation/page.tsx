import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import {
  reconciliationSummary,
  listScheduledForReconcile,
  listBilledNotScheduled,
  reconciliationDetail,
} from "@/lib/manage/reconciliation";
import { listPrograms } from "@/lib/data/app-queries";
import { formatHours, formatMoney } from "@/lib/money";
import { PageHeader, StatTile, ErrorPanel, ButtonLink } from "@/components/ui";
import ReconcileClient from "@/components/reconciliation/reconcile-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reconciliation — Ahivim Budget Management" };

/** Default window: the first day of three months ago through today. */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1))
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("manager");
  const canManage = user.role !== "viewer";

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const isDate = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

  const range = defaultRange();
  const from = isDate(one(sp.from)) ? one(sp.from)! : range.from;
  const to = isDate(one(sp.to)) ? one(sp.to)! : range.to;
  const programId = one(sp.programId) ?? "";
  const onlyUnmatched = one(sp.unmatched) === "1";

  const filter = { from, to, programId: programId || undefined };

  const result = await withDb(async (pool) => ({
    summary: await reconciliationSummary(pool, filter),
    scheduled: await listScheduledForReconcile(pool, filter, onlyUnmatched),
    billed: await listBilledNotScheduled(pool, filter),
    detail: await reconciliationDetail(pool, filter),
    programs: await listPrograms(pool),
  }));

  return (
    <>
      <PageHeader
        eyebrow="Actuals"
        title="Reconciliation"
        description="Match planned sessions against imported transactions. Group sessions are surfaced but never auto-matched — their money divides across individuals, so they are matched by hand."
        action={<ButtonLink href="/reconciliation/groups">Group review</ButtonLink>}
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load reconciliation data">{result.error}</ErrorPanel>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile
              label="Matched"
              value={result.data.summary.matched.count.toLocaleString()}
              tone="good"
              hint={`${formatHours(result.data.summary.matched.hours)} · ${formatMoney(result.data.summary.matched.amount)}`}
            />
            <StatTile
              label="Scheduled, not billed"
              value={result.data.summary.scheduledNotBilled.count.toLocaleString()}
              tone={result.data.summary.scheduledNotBilled.count ? "warn" : "good"}
              hint={`${formatHours(result.data.summary.scheduledNotBilled.hours)} · ${formatMoney(result.data.summary.scheduledNotBilled.amount)}`}
            />
            <StatTile
              label="Billed, not scheduled"
              value={result.data.summary.billedNotScheduled.count.toLocaleString()}
              tone={result.data.summary.billedNotScheduled.count ? "warn" : "good"}
              hint={`${formatHours(result.data.summary.billedNotScheduled.hours)} · ${formatMoney(result.data.summary.billedNotScheduled.amount)}`}
            />
          </div>

          <form
            method="get"
            className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3 text-sm"
          >
            <label className="block">
              <span className="eyebrow">From</span>
              <input
                type="date"
                name="from"
                defaultValue={from}
                className="mt-1 block rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1 text-sm"
              />
            </label>
            <label className="block">
              <span className="eyebrow">To</span>
              <input
                type="date"
                name="to"
                defaultValue={to}
                className="mt-1 block rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1 text-sm"
              />
            </label>
            <label className="block">
              <span className="eyebrow">Program</span>
              <select
                name="programId"
                defaultValue={programId}
                className="mt-1 block rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1 text-sm"
              >
                <option value="">All programs</option>
                {result.data.programs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} — {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-flex items-center gap-1.5 pb-1.5">
              <input type="checkbox" name="unmatched" value="1" defaultChecked={onlyUnmatched} />
              Unmatched only
            </label>
            <button
              type="submit"
              className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white"
            >
              Apply
            </button>
          </form>

          <div className="mt-4">
            <ReconcileClient
              canManage={canManage}
              from={from}
              to={to}
              programId={programId}
              scheduled={result.data.scheduled}
              billed={result.data.billed}
            />
          </div>
        </>
      )}
    </>
  );
}
