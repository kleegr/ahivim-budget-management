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
  planYearlyGross: string; // Σ authorized × internal rate (the budget's own currency)
  planNetYearly: string; // Σ net per month × months

  // Actual side — ALL TIME.
  billedGrossAll: string; // Σ agency gross (imported_amount)
  employeesMadeAll: string; // Σ internal amount
  agencyMadeAll: string; // Σ agency additional
  taxesAll: string; // withholding: Σ (check gross − net) on non-agency checks
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

/** An individual with billing (or active) but no budget yet — offered in the
 *  "Add budget" picker so a plan can be created from someone already in the data. */
export interface BudgetCandidate {
  id: string;
  name: string;
  txCount: number;
  billed: string; // all-time agency gross, so the biggest billers surface first
}

export interface FinancialDashboard {
  rows: FinancialDashboardRow[];
  /** Individuals without a budget, for the "Add budget" picker (billers first). */
  candidates: BudgetCandidate[];
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
  // 1. Plan reserves per individual, from the canonical strategy calculator. The
  //    board shows ONLY people who have a budget (an active strategy); their ids
  //    are exactly the keys here.
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
        planYearlyGross: dec(s.yearlyGross),
        planNetYearly: netYearly,
      });
    } else {
      prev.strategyCount += 1;
      prev.masser = prev.masser.plus(dec(s.afterAll ?? 0));
      prev.hasMasser = prev.hasMasser || s.afterAll != null;
      prev.planYearlyGross = prev.planYearlyGross.plus(dec(s.yearlyGross));
      prev.planNetYearly = prev.planNetYearly.plus(netYearly);
      // Keep the primary plan's period/renewal (the first, highest-sorted).
    }
  }
  const budgetedIds = [...planByInd.keys()];

  // 2. The budgeted people, with their editable side info.
  const { rows: people } = budgetedIds.length
    ? await pool.query<{
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
          WHERE i.id = ANY($1::uuid[])
          ORDER BY name`,
        [budgetedIds],
      )
    : { rows: [] };

  // 2b. Candidates for the "Add budget" picker — people with billing (or active)
  //     but no budget yet, biggest billers first, so a plan can be started from
  //     someone already in the transactions. Merged-away records are excluded.
  const { rows: candidateRows } = await pool.query<{
    id: string; name: string; tx_count: string; billed: string;
  }>(
    `SELECT i.id,
            COALESCE(i.display_name, i.normalized_name) AS name,
            (SELECT count(*) FROM payroll_transactions t WHERE t.individual_id = i.id)::text AS tx_count,
            COALESCE((SELECT sum(t.imported_amount) FROM payroll_transactions t WHERE t.individual_id = i.id), 0)::text AS billed
       FROM individuals i
      WHERE NOT (i.id = ANY($1::uuid[]))
        AND i.merged_into_id IS NULL
        AND (i.status = 'active'
             OR EXISTS (SELECT 1 FROM payroll_transactions t WHERE t.individual_id = i.id))
      ORDER BY billed DESC NULLS LAST, name`,
    [budgetedIds.length ? budgetedIds : ["00000000-0000-0000-0000-000000000000"]],
  );
  const candidates: BudgetCandidate[] = candidateRows.map((c) => ({
    id: c.id, name: c.name, txCount: Number(c.tx_count), billed: toMoney(c.billed),
  }));

  // 3. Actual money per individual — all-time and windowed to the current period.
  //    The window is each individual's primary-plan budget period. A plan with
  //    no dates has no defensible period figure, so its period totals stay zero.
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
    `(w.start_date IS NOT NULL AND canonical_service_date(
       t.period_begin, t.check_date, t.period_end
     ) BETWEEN w.start_date AND w.end_date)`;
  const internalExpr =
    `COALESCE(t.calculated_internal_amount, t.spreadsheet_internal_amount, t.internal_rate_applied * t.imported_hours, 0)`;
  // Taxes = the ACTUAL withholding on a paycheck: the check's gross minus the
  // net the employee really received (total_net_pay is per-check). It has nothing
  // to do with the plan's cuts. Only checks canonically routed to the employee are
  // self-hire payroll checks; their gap is spread across rows by gross share so it
  // attributes cleanly to each individual.
  const whExpr =
    `CASE WHEN effective_payment_recipient(t.payment_recipient, p.payment_recipient) = 'employee'
            AND ct.allocation_gross > 0 AND ct.check_net IS NOT NULL
            AND ct.check_gross > ct.check_net
          THEN (ct.check_gross - ct.check_net)
               * COALESCE(t.imported_amount, 0) / ct.allocation_gross
          ELSE 0 END`;

  const actualByInd = new Map<
    string,
    {
      grossAll: string; internalAll: string; agencyAll: string; hoursAll: string; txAll: string; whAll: string;
      grossPeriod: string; internalPeriod: string; agencyPeriod: string; hoursPeriod: string; txPeriod: string; whPeriod: string;
    }
  >();

  if (ids.length > 0) {
    const { rows: actuals } = await pool.query<{
      individual_id: string;
      gross_all: string; internal_all: string; agency_all: string; hours_all: string; tx_all: string; wh_all: string;
      gross_period: string; internal_period: string; agency_period: string; hours_period: string; tx_period: string; wh_period: string;
    }>(
      `WITH win AS (
         SELECT * FROM unnest($1::uuid[], $2::date[], $3::date[]) AS w(individual_id, start_date, end_date)
       ),
       check_facts AS (
         SELECT check_row.id,
                CASE
                  WHEN verified_check.id IS NOT NULL
                    THEN concat('verified:', verified_check.id::text)
                  ELSE concat(
                    'source:', check_row.employee_id::text, ':',
                    COALESCE(NULLIF(btrim(check_row.check_number), ''), 'no-number'), ':',
                    COALESCE(check_row.check_date::text, 'no-date'), ':',
                    COALESCE(check_row.period_begin::text, 'no-period-begin'), ':',
                    COALESCE(check_row.period_end::text, 'no-period-end')
                  )
                END AS check_key,
                COALESCE(check_row.imported_amount, 0) AS row_gross,
                verified_check.actual_gross AS verified_gross,
                CASE WHEN verified_check.id IS NOT NULL
                  THEN verified_check.actual_net
                  ELSE check_row.total_net_pay
                END AS check_net
           FROM payroll_transactions check_row
           LEFT JOIN programs check_program ON check_program.id = check_row.program_id
           LEFT JOIN employee_payroll_checks verified_check
             ON verified_check.id = check_row.payroll_check_id
            AND verified_check.employee_id = check_row.employee_id
            AND verified_check.verification_status = 'verified'
          WHERE effective_payment_recipient(
                  check_row.payment_recipient, check_program.payment_recipient
                ) = 'employee'
            AND (
              verified_check.id IS NOT NULL
              OR NULLIF(btrim(check_row.check_number), '') IS NOT NULL
              OR check_row.check_date IS NOT NULL
              OR check_row.period_begin IS NOT NULL
              OR check_row.period_end IS NOT NULL
            )
       ),
       check_tot AS (
         SELECT check_key,
                sum(row_gross) AS allocation_gross,
                COALESCE(max(verified_gross), sum(row_gross)) AS check_gross,
                CASE WHEN count(DISTINCT check_net) = 1 THEN max(check_net) END AS check_net
           FROM check_facts
          GROUP BY check_key
       )
       SELECT t.individual_id,
              COALESCE(sum(t.imported_amount), 0)::text                          AS gross_all,
              COALESCE(sum(${internalExpr}), 0)::text                            AS internal_all,
              COALESCE(sum(t.agency_additional_amount), 0)::text                 AS agency_all,
              COALESCE(sum(t.imported_hours), 0)::text                           AS hours_all,
              count(*)::text                                                     AS tx_all,
              COALESCE(sum(${whExpr}), 0)::text                                  AS wh_all,
              COALESCE(sum(t.imported_amount) FILTER (WHERE ${inWindow}), 0)::text        AS gross_period,
              COALESCE(sum(${internalExpr}) FILTER (WHERE ${inWindow}), 0)::text          AS internal_period,
              COALESCE(sum(t.agency_additional_amount) FILTER (WHERE ${inWindow}), 0)::text AS agency_period,
              COALESCE(sum(t.imported_hours) FILTER (WHERE ${inWindow}), 0)::text         AS hours_period,
              count(*) FILTER (WHERE ${inWindow})::text                          AS tx_period,
              COALESCE(sum(${whExpr}) FILTER (WHERE ${inWindow}), 0)::text       AS wh_period
         FROM payroll_transactions t
         LEFT JOIN programs p ON p.id = t.program_id
         LEFT JOIN win w ON w.individual_id = t.individual_id
         LEFT JOIN check_facts cf ON cf.id = t.id
         LEFT JOIN check_tot ct ON ct.check_key = cf.check_key
        WHERE t.individual_id = ANY($4::uuid[])
        GROUP BY t.individual_id`,
      [winIds, winStarts, winEnds, ids],
    );
    for (const a of actuals) {
      actualByInd.set(a.individual_id, {
        grossAll: a.gross_all, internalAll: a.internal_all, agencyAll: a.agency_all, hoursAll: a.hours_all, txAll: a.tx_all, whAll: a.wh_all,
        grossPeriod: a.gross_period, internalPeriod: a.internal_period, agencyPeriod: a.agency_period, hoursPeriod: a.hours_period, txPeriod: a.tx_period, whPeriod: a.wh_period,
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

    const empAll = dec(act?.internalAll ?? 0);
    const empPeriod = dec(act?.internalPeriod ?? 0);
    // Taxes = actual withholding (paycheck gross − net), not a plan figure.
    const taxesAll = dec(act?.whAll ?? 0);
    const taxesPeriod = dec(act?.whPeriod ?? 0);
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

  return { rows, candidates, totals: { all: tAll, period: tPeriod, masser: toMoney(accMasser) } };
}
