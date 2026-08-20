import type { PgLikePool } from "@/lib/import/commit";
import { dec, toMoney, toHours } from "@/lib/money";
import { listStrategies } from "@/lib/manage/calculation-strategies";

/**
 * The Financial dashboard read model — one row per individual, the money side at
 * a glance across the whole roster (the "Masser" board).
 *
 * Each row carries, for one individual:
 *   • the PLAN reserves — Masser (the fixed "after all" set-aside) and the tax
 *     reserve (the first cut), summed across that person's active plans;
 *   • the ACTUAL money billed — split the way the business splits every dollar:
 *       total billed (agency gross) = what employees made (the internal / budget
 *       value of the work) + what the agency made (the billed-vs-budget rate
 *       spread, e.g. $17 budget → $19 billed = $2 agency). internal + agency
 *       additional = gross, exactly, so the three always reconcile.
 *   • both an ALL-TIME total and a THIS-BUDGET-YEAR total (windowed to the
 *     individual's current budget period), so the plan (annual) and the actuals
 *     can be read on the same footing.
 *   • the editable side info — phone, a category / account tag, and notes.
 *
 * Taxes are shown as the plan's first-cut rate applied to what employees actually
 * made, i.e. the reserve that scales with real billing rather than a flat plan
 * figure. Money is summed in SQL as numeric and carried as decimal strings.
 */

export interface FinancialDashboardRow {
  individualId: string;
  individualName: string;
  active: boolean;
  phone: string | null;
  category: string | null;
  notes: string | null;

  // Plan side (summed across the individual's active strategies).
  strategyCount: number;
  renewalDate: string | null; // effective (rolled) renewal of the primary plan
  periodStart: string | null;
  periodEnd: string | null;
  masser: string | null; // Σ after_all; null when no plan sets one
  cut1Fraction: string; // the primary plan's first-cut rate, for the tax reserve
  planYearlyGross: string; // Σ authorized × internal rate (the budget's own currency)
  planNetYearly: string; // Σ net per month × months

  // Actual side — ALL TIME.
  billedGrossAll: string; // Σ agency gross (imported_amount)
  employeesMadeAll: string; // Σ internal amount
  agencyMadeAll: string; // Σ agency additional
  taxesAll: string; // cut1 × employeesMadeAll
  hoursAll: string;
  txCountAll: number;

  // Actual side — THIS BUDGET YEAR (windowed to the current period).
  billedGrossPeriod: string;
  employeesMadePeriod: string;
  agencyMadePeriod: string;
  taxesPeriod: string;
  hoursPeriod: string;
  txCountPeriod: number;
}

export interface FinancialDashboard {
  rows: FinancialDashboardRow[];
  /** Portfolio totals for both windows (computed over every row). */
  totals: {
    all: DashboardTotals;
    period: DashboardTotals;
    masser: string;
  };
}

export interface DashboardTotals {
  billedGross: string;
  employeesMade: string;
  agencyMade: string;
  taxes: string;
}

interface PlanAgg {
  strategyCount: number;
  renewalDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  masser: ReturnType<typeof dec>;
  hasMasser: boolean;
  cut1Fraction: string;
  planYearlyGross: ReturnType<typeof dec>;
  planNetYearly: ReturnType<typeof dec>;
}

/**
 * Build the dashboard. One pass over the strategies (already rate-resolved by
 * listStrategies) folds the plan reserves per individual; one windowed SQL query
 * folds the actual money. Individuals with plans but no billing, or billing but
 * no plan, both appear — the union of the two id sets.
 */
export async function getFinancialDashboard(pool: PgLikePool): Promise<FinancialDashboard> {
  // 1. People (active first) with their editable side info.
  const { rows: people } = await pool.query<{
    id: string;
    name: string;
    status: string;
    phone: string | null;
    category: string | null;
    notes: string | null;
  }>(
    `SELECT i.id,
            COALESCE(i.display_name, i.normalized_name) AS name,
            i.status,
            i.phone, i.category, i.notes
       FROM individuals i
      WHERE i.status = 'active' OR EXISTS (
              SELECT 1 FROM payroll_transactions t WHERE t.individual_id = i.id
            )
      ORDER BY name`,
  );

  // 2. Plan reserves per individual, from the canonical strategy calculator.
  const { rows: strategies } = await listStrategies(pool, {});
  const planByInd = new Map<string, PlanAgg>();
  for (const s of strategies) {
    const prev = planByInd.get(s.individualId);
    const netYearly = dec(s.net).times(dec(s.monthDivisor || 12));
    if (!prev) {
      planByInd.set(s.individualId, {
        strategyCount: 1,
        renewalDate: s.effectiveRenewal ?? s.renewalDate,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        masser: dec(s.afterAll ?? 0),
        hasMasser: s.afterAll != null,
        cut1Fraction: s.cut1Percent ?? "0",
        planYearlyGross: dec(s.yearlyGross),
        planNetYearly: netYearly,
      });
    } else {
      prev.strategyCount += 1;
      prev.masser = prev.masser.plus(dec(s.afterAll ?? 0));
      prev.hasMasser = prev.hasMasser || s.afterAll != null;
      prev.planYearlyGross = prev.planYearlyGross.plus(dec(s.yearlyGross));
      prev.planNetYearly = prev.planNetYearly.plus(netYearly);
      // Keep the primary plan's period/renewal/cut1 (the first, highest-sorted).
    }
  }

  // 3. Actual money per individual — all-time and windowed to the current period.
  //    The window is each individual's primary-plan budget period; individuals
  //    with no dated plan fall back to all-time for the "period" figures too.
  const winIds: string[] = [];
  const winStarts: string[] = [];
  const winEnds: string[] = [];
  for (const [id, p] of planByInd) {
    if (p.periodStart && p.periodEnd) {
      winIds.push(id);
      winStarts.push(p.periodStart);
      winEnds.push(p.periodEnd);
    }
  }
  const ids = people.map((p) => p.id);

  const inWindow =
    `(w.start_date IS NULL OR (t.period_begin >= w.start_date AND t.period_begin <= w.end_date))`;
  const internalExpr =
    `COALESCE(t.calculated_internal_amount, t.spreadsheet_internal_amount, t.internal_rate_applied * t.imported_hours, 0)`;

  const actualByInd = new Map<
    string,
    {
      grossAll: string; internalAll: string; agencyAll: string; hoursAll: string; txAll: string;
      grossPeriod: string; internalPeriod: string; agencyPeriod: string; hoursPeriod: string; txPeriod: string;
    }
  >();

  if (ids.length > 0) {
    const { rows: actuals } = await pool.query<{
      individual_id: string;
      gross_all: string; internal_all: string; agency_all: string; hours_all: string; tx_all: string;
      gross_period: string; internal_period: string; agency_period: string; hours_period: string; tx_period: string;
    }>(
      `WITH win AS (
         SELECT * FROM unnest($1::uuid[], $2::date[], $3::date[]) AS w(individual_id, start_date, end_date)
       )
       SELECT t.individual_id,
              COALESCE(sum(t.imported_amount), 0)::text                          AS gross_all,
              COALESCE(sum(${internalExpr}), 0)::text                            AS internal_all,
              COALESCE(sum(t.agency_additional_amount), 0)::text                 AS agency_all,
              COALESCE(sum(t.imported_hours), 0)::text                           AS hours_all,
              count(*)::text                                                     AS tx_all,
              COALESCE(sum(t.imported_amount) FILTER (WHERE ${inWindow}), 0)::text        AS gross_period,
              COALESCE(sum(${internalExpr}) FILTER (WHERE ${inWindow}), 0)::text          AS internal_period,
              COALESCE(sum(t.agency_additional_amount) FILTER (WHERE ${inWindow}), 0)::text AS agency_period,
              COALESCE(sum(t.imported_hours) FILTER (WHERE ${inWindow}), 0)::text         AS hours_period,
              count(*) FILTER (WHERE ${inWindow})::text                          AS tx_period
         FROM payroll_transactions t
         LEFT JOIN win w ON w.individual_id = t.individual_id
        WHERE t.individual_id = ANY($4::uuid[])
        GROUP BY t.individual_id`,
      [winIds, winStarts, winEnds, ids],
    );
    for (const a of actuals) {
      actualByInd.set(a.individual_id, {
        grossAll: a.gross_all, internalAll: a.internal_all, agencyAll: a.agency_all, hoursAll: a.hours_all, txAll: a.tx_all,
        grossPeriod: a.gross_period, internalPeriod: a.internal_period, agencyPeriod: a.agency_period, hoursPeriod: a.hours_period, txPeriod: a.tx_period,
      });
    }
  }

  // 4. Fold plan + actuals into one row per individual, and accumulate totals.
  const tAll: DashboardTotals = { billedGross: "0", employeesMade: "0", agencyMade: "0", taxes: "0" };
  const tPeriod: DashboardTotals = { billedGross: "0", employeesMade: "0", agencyMade: "0", taxes: "0" };
  let accAllGross = dec(0), accAllEmp = dec(0), accAllAgency = dec(0), accAllTax = dec(0);
  let accPerGross = dec(0), accPerEmp = dec(0), accPerAgency = dec(0), accPerTax = dec(0);
  let accMasser = dec(0);

  const rows: FinancialDashboardRow[] = people.map((p) => {
    const plan = planByInd.get(p.id);
    const act = actualByInd.get(p.id);
    const cut1 = dec(plan?.cut1Fraction ?? "0");

    const empAll = dec(act?.internalAll ?? 0);
    const empPeriod = dec(act?.internalPeriod ?? 0);
    const taxesAll = empAll.times(cut1);
    const taxesPeriod = empPeriod.times(cut1);
    const masser = plan?.hasMasser ? plan.masser : null;

    accAllGross = accAllGross.plus(dec(act?.grossAll ?? 0));
    accAllEmp = accAllEmp.plus(empAll);
    accAllAgency = accAllAgency.plus(dec(act?.agencyAll ?? 0));
    accAllTax = accAllTax.plus(taxesAll);
    accPerGross = accPerGross.plus(dec(act?.grossPeriod ?? 0));
    accPerEmp = accPerEmp.plus(empPeriod);
    accPerAgency = accPerAgency.plus(dec(act?.agencyPeriod ?? 0));
    accPerTax = accPerTax.plus(taxesPeriod);
    if (masser) accMasser = accMasser.plus(masser);

    return {
      individualId: p.id,
      individualName: p.name,
      active: p.status === "active",
      phone: p.phone,
      category: p.category,
      notes: p.notes,
      strategyCount: plan?.strategyCount ?? 0,
      renewalDate: plan?.renewalDate ?? null,
      periodStart: plan?.periodStart ?? null,
      periodEnd: plan?.periodEnd ?? null,
      masser: masser ? toMoney(masser) : null,
      cut1Fraction: plan?.cut1Fraction ?? "0",
      planYearlyGross: toMoney(plan?.planYearlyGross ?? 0),
      planNetYearly: toMoney(plan?.planNetYearly ?? 0),
      billedGrossAll: toMoney(act?.grossAll ?? 0),
      employeesMadeAll: toMoney(empAll),
      agencyMadeAll: toMoney(act?.agencyAll ?? 0),
      taxesAll: toMoney(taxesAll),
      hoursAll: toHours(act?.hoursAll ?? 0),
      txCountAll: Number(act?.txAll ?? 0),
      billedGrossPeriod: toMoney(act?.grossPeriod ?? 0),
      employeesMadePeriod: toMoney(empPeriod),
      agencyMadePeriod: toMoney(act?.agencyPeriod ?? 0),
      taxesPeriod: toMoney(taxesPeriod),
      hoursPeriod: toHours(act?.hoursPeriod ?? 0),
      txCountPeriod: Number(act?.txPeriod ?? 0),
    };
  });

  tAll.billedGross = toMoney(accAllGross);
  tAll.employeesMade = toMoney(accAllEmp);
  tAll.agencyMade = toMoney(accAllAgency);
  tAll.taxes = toMoney(accAllTax);
  tPeriod.billedGross = toMoney(accPerGross);
  tPeriod.employeesMade = toMoney(accPerEmp);
  tPeriod.agencyMade = toMoney(accPerAgency);
  tPeriod.taxes = toMoney(accPerTax);

  return { rows, totals: { all: tAll, period: tPeriod, masser: toMoney(accMasser) } };
}
