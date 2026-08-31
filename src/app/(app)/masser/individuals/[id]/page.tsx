import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { resolveAccessScope } from "@/lib/auth/access";
import { requireUser } from "@/lib/auth/session";
import { agencyMonth } from "@/lib/business/agency-time";
import { getIndividualMasserStatement } from "@/lib/data/direct-pay-operations";
import { withDb } from "@/lib/data/pool";
import { formatMoney } from "@/lib/money";
import PrintStatementButton from "@/components/masser/print-statement-button";
import { Card, ErrorPanel, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Masser statement - Ahivim" };

const MONTH_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function monthLabel(month: string) {
  return MONTH_FORMATTER.format(new Date(`${month}-01T00:00:00Z`));
}

export default async function IndividualMasserStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("viewer");
  const { id } = await params;
  const raw = await searchParams;
  const requestedMonth = Array.isArray(raw.month) ? raw.month[0] : raw.month;
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth ?? "")
    ? requestedMonth!
    : agencyMonth();
  const result = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    if (!scope.canSeeSettlements) return { denied: true as const, statement: null };
    return { denied: false as const, statement: await getIndividualMasserStatement(pool, scope, id, month) };
  });
  if (result.ok && result.data.denied) redirect("/masser");
  if (result.ok && !result.data.statement) notFound();
  const statement = result.ok ? result.data.statement : null;

  return (
    <>
      <PageHeader
        eyebrow="Masser statement"
        title={statement?.individualName ?? "Individual statement"}
        description={statement?.periodStart && statement.periodEnd
          ? `Month-end position for ${monthLabel(month)}, using the plan active on the final calendar day. Plan started ${statement.periodStart} and renews on ${statement.periodEnd}.`
          : `Month-end position for ${monthLabel(month)}, using the plan active on the final calendar day.`}
        action={statement ? <PrintStatementButton /> : undefined}
      />
      <div className="mb-4 print:hidden">
        <Link href={`/masser?month=${month}`} className="text-sm font-semibold text-[var(--color-primary)] hover:underline">Back to Masser</Link>
      </div>
      {!result.ok ? <ErrorPanel title="Could not load the statement">{result.error}</ErrorPanel>
        : !statement ? null
        : <div className="space-y-4">
            <div className="grid grid-cols-2 border-y border-[var(--color-rule-strong)] bg-[var(--color-surface)] sm:grid-cols-4 sm:divide-x sm:divide-[var(--color-rule)]">
              <div className="px-4 py-3"><p className="text-xs font-semibold text-[var(--color-ink-faint)]">Approved put-away</p><p className="tnum mt-1 text-xl font-semibold">{formatMoney(statement.approvedReserve)}</p></div>
              <div className="px-4 py-3"><p className="text-xs font-semibold text-[var(--color-ink-faint)]">Recorded</p><p className="tnum mt-1 text-xl font-semibold text-[var(--color-success)]">{formatMoney(statement.recordedReserve)}</p></div>
              <div className="px-4 py-3"><p className="text-xs font-semibold text-[var(--color-ink-faint)]">Remaining</p><p className="tnum mt-1 text-xl font-semibold">{formatMoney(statement.remainingReserve)}</p></div>
              <div className="px-4 py-3"><p className="text-xs font-semibold text-[var(--color-ink-faint)]">Credit</p><p className="tnum mt-1 text-xl font-semibold text-[var(--color-info)]">{formatMoney(statement.availableCredit)}</p></div>
            </div>
            <Card title="Monthly history" description="Only the individual's aggregate put-away activity is included. Employee and payroll details are excluded.">
              {statement.history.length === 0 ? <p className="px-4 py-6 text-sm text-[var(--color-ink-faint)]">No put-away activity has been recorded yet.</p>
                : <div className="overflow-x-auto"><table className="w-full min-w-[650px] text-sm"><thead className="border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] text-xs text-[var(--color-ink-soft)]"><tr><th className="px-4 py-2.5 text-left">Month</th><th className="px-4 py-2.5 text-right">Net set aside</th><th className="px-4 py-2.5 text-right">Corrections and credits</th><th className="px-4 py-2.5 text-right">Reversals included</th></tr></thead><tbody className="divide-y divide-[var(--color-rule)]">{statement.history.map((row) => <tr key={row.month}><td className="px-4 py-3 font-medium">{monthLabel(row.month)}</td><td className="tnum px-4 py-3 text-right font-semibold">{formatMoney(row.setAside)}</td><td className="tnum px-4 py-3 text-right text-[var(--color-ink-soft)]">{formatMoney(row.corrections)}</td><td className="tnum px-4 py-3 text-right text-[var(--color-ink-soft)]">{formatMoney(row.reversals)}</td></tr>)}</tbody></table></div>}
            </Card>
          </div>}
    </>
  );
}
