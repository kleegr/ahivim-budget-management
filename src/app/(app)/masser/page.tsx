import { requireUser } from "@/lib/auth/session";
import { resolveAccessScope } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { getMasserSheet } from "@/lib/data/masser-sheet";
import { getSettlementDashboard, type SettlementRow } from "@/lib/data/settlements";
import { dec } from "@/lib/money";
import { PageHeader, ErrorPanel } from "@/components/ui";
import MasserDashboard, { type AnnualFundingProgress } from "@/components/financial/masser-dashboard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Annual plans - Ahivim Budget Management" };

type FundingGroup = AnnualFundingProgress & { sortDate: string };

function elapsedFraction(row: SettlementRow): string {
  const value = row.calculation.timeElapsedPercent;
  if (typeof value === "string" || typeof value === "number") {
    try {
      const fraction = dec(value);
      return fraction.isNegative() ? "0" : fraction.greaterThan(1) ? "1" : fraction.toString();
    } catch {
      // Fall through to the dated calculation below.
    }
  }
  if (!row.periodBegin || !row.periodEnd) return "0";
  const start = Date.parse(`${row.periodBegin}T00:00:00Z`);
  const end = Date.parse(`${row.periodEnd}T00:00:00Z`);
  const today = Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "0";
  const fraction = dec(today - start).dividedBy(end - start);
  return fraction.isNegative() ? "0" : fraction.greaterThan(1) ? "1" : fraction.toString();
}

function annualFunding(rows: SettlementRow[]): Record<string, AnnualFundingProgress> {
  const periods = new Map<string, FundingGroup>();
  for (const row of rows) {
    if (row.personType !== "individual" || !row.kind.startsWith("individual_masser") || row.state === "void") continue;
    const periodKey = `${row.personId}:${row.periodBegin ?? ""}:${row.periodEnd ?? ""}`;
    const current = periods.get(periodKey) ?? {
      target: "0",
      expectedToDate: "0",
      actualSetAside: "0",
      remaining: "0",
      variance: "0",
      periodBegin: row.periodBegin,
      periodEnd: row.periodEnd,
      sortDate: row.periodEnd ?? row.periodBegin ?? "0000-00-00",
    };
    current.target = dec(current.target).plus(dec(row.originalAmount)).toFixed(2);
    current.actualSetAside = dec(current.actualSetAside).plus(dec(row.appliedAmount)).toFixed(2);
    const openBalance = dec(row.balance);
    current.remaining = dec(current.remaining).plus(openBalance.isPositive() ? openBalance : 0).toFixed(2);
    current.expectedToDate = dec(current.expectedToDate)
      .plus(dec(row.originalAmount).times(elapsedFraction(row)))
      .toFixed(2);
    current.variance = dec(current.actualSetAside).minus(dec(current.expectedToDate)).toFixed(2);
    periods.set(periodKey, current);
  }

  const byPerson: Record<string, FundingGroup> = {};
  for (const [key, value] of periods) {
    const personId = key.split(":", 1)[0];
    const existing = byPerson[personId];
    const today = new Date().toISOString().slice(0, 10);
    const valueCurrent = Boolean(value.periodBegin && value.periodEnd && value.periodBegin <= today && value.periodEnd >= today);
    const existingCurrent = Boolean(existing?.periodBegin && existing.periodEnd && existing.periodBegin <= today && existing.periodEnd >= today);
    if (!existing || (valueCurrent && !existingCurrent) || (valueCurrent === existingCurrent && value.sortDate > existing.sortDate)) {
      byPerson[personId] = value;
    }
  }
  return byPerson;
}

/**
 * The Masser board — the cuts / calculation sheet across the whole budgeted
 * roster, one row per plan: the two cuts, the clock and other adjustments, the
 * authorized hours per program (the budget), then yearly gross → monthly gross →
 * gross net → net, and Masser (the "After All" set-aside). Columns show / hide /
 * reorder; account, phone and notes edit inline. Managers only.
 */
export default async function MasserPage() {
  const user = await requireUser("manager");
  const canManage = user.role !== "viewer";

  const result = await withDb(async (pool) => {
    const scope = await resolveAccessScope(pool, user);
    const [plans, settlements] = await Promise.all([
      getMasserSheet(pool),
      getSettlementDashboard(pool, scope),
    ]);
    return { plans, funding: annualFunding(settlements.rows) };
  });

  return (
    <>
      <PageHeader
        eyebrow="Planning"
        title="Annual plans"
        description="Annual set-aside targets, actual funding, remaining balances, and renewal readiness by person."
      />

      {!result.ok ? (
        <ErrorPanel title="Could not load annual plans">{result.error}</ErrorPanel>
      ) : (
        <MasserDashboard data={result.data.plans} funding={result.data.funding} canManage={canManage} />
      )}
    </>
  );
}
