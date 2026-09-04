import type { PgLikePool } from "@/lib/import/commit";
import { calculateDirectEmployeeCheck } from "@/lib/business/deal-engine";
import { toHours, toMoney } from "@/lib/money";
import {
  employeePortalUpcomingSchedule,
  individualPortalUpcomingSchedule,
} from "@/lib/data/portal-schedule";
import type {
  IndividualRelationship,
  PortalAccessContext,
} from "@/lib/auth/portal-access";
import {
  DIRECT_PORTAL_HOURS_SCOPE,
  type DollarAggregateRow,
  type EmployeeDirectPayRow,
  type GiveBackRow,
  type HoursAggregateRow,
  type MoneyAggregateRow,
  type PayrollCheckRow,
  type PersonRow,
  type PortalEmployeeDirectPaySummary,
  type PortalEmployeeSummary,
  type PortalIndividualSummary,
  type PortalPayrollCheckSummary,
  directEmployeeIds,
  directIndividualIds,
  dollarUsage,
  effectivePortalHoursCte,
  employeeGiveBackActivity,
  employeeIdsWith,
  empty,
  individualIdsWith,
  mapByScope,
  mergeProgramBreakdowns,
  unique,
  usage,
} from "@/lib/data/portal-read-model-shared";

export async function directIndividualSummaries(
  pool: PgLikePool,
  context: PortalAccessContext,
  month: string,
): Promise<PortalIndividualSummary[]> {
  const monthStart = `${month}-01`;
  const ids = directIndividualIds(context);
  if (ids.length === 0) return [];
  const hourIds = individualIdsWith(context, ids, "hours_budgets.self.read");
  const dollarIds = individualIdsWith(context, ids, "dollar_budgets.self.read");
  const billedIds = individualIdsWith(context, ids, "financials.self.billed_totals.read");
  const setAsideIds = individualIdsWith(context, ids, "financials.self.cuts_set_asides.read");
  const directCheckIds = individualIdsWith(context, ids, "financials.self.direct_checks.read");
  const agencyPaidIds = individualIdsWith(context, ids, "financials.self.agency_paid.read");
  const scheduleIds = individualIdsWith(context, ids, "schedules.self.read");

  const [
    peopleResult,
    hourBudgetResult,
    dollarBudgetResult,
    billedResult,
    setAsideResult,
    directCheckResult,
    agencyPaidResult,
    scheduleResults,
  ] = await Promise.all([
    pool.query<PersonRow>(
      `SELECT id, display_name AS name FROM individuals
        WHERE id = ANY($1::uuid[]) AND status <> 'archived'
        ORDER BY display_name`,
      [ids],
    ),
    hourIds.length > 0
      ? pool.query<HoursAggregateRow>(
          `WITH ${effectivePortalHoursCte(DIRECT_PORTAL_HOURS_SCOPE)}
           SELECT effective_hours.individual_id AS scope_id,
                  COALESCE(sum(effective_hours.authorized_hours), 0)::text AS authorized_hours,
                  COALESCE(sum(effective_hours.used_hours), 0)::text AS used_hours,
                  COALESCE(sum(
                    effective_hours.authorized_hours - effective_hours.used_hours
                  ), 0)::text AS remaining_hours,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'authorized', program_totals.authorized_hours::text,
                      'used', program_totals.used_hours::text,
                      'remaining', program_totals.remaining_hours::text
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT program.id, program.code, program.name,
                               COALESCE(sum(detail.authorized_hours), 0) AS authorized_hours,
                               COALESCE(sum(detail.used_hours), 0) AS used_hours,
                               COALESCE(sum(detail.authorized_hours - detail.used_hours), 0) AS remaining_hours
                          FROM effective_hours detail
                          JOIN programs program ON program.id = detail.program_id
                         WHERE detail.individual_id = effective_hours.individual_id
                         GROUP BY program.id, program.code, program.name
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM effective_hours
            WHERE effective_hours.individual_id = ANY($1::uuid[])
            GROUP BY effective_hours.individual_id`,
          [hourIds],
        )
      : empty<HoursAggregateRow>(),
    dollarIds.length > 0
      ? pool.query<DollarAggregateRow>(
          `SELECT individual_id AS scope_id,
                  CASE WHEN count(authorized_dollars) > 0
                    THEN sum(authorized_dollars)::text END AS authorized_dollars,
                  COALESCE(sum(consumed_dollars), 0)::text AS used_dollars,
                  CASE WHEN count(remaining_dollars) > 0
                    THEN sum(remaining_dollars)::text END AS remaining_dollars,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'authorized', program_totals.authorized_dollars,
                      'used', program_totals.used_dollars,
                      'remaining', program_totals.remaining_dollars
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT program.id, program.code, program.name,
                               CASE WHEN count(detail.authorized_dollars) > 0
                                 THEN sum(detail.authorized_dollars)::text END AS authorized_dollars,
                               COALESCE(sum(detail.consumed_dollars), 0)::text AS used_dollars,
                               CASE WHEN count(detail.remaining_dollars) > 0
                                 THEN sum(detail.remaining_dollars)::text END AS remaining_dollars
                          FROM program_budget_balances detail
                          JOIN programs program ON program.id = detail.program_id
                         WHERE detail.individual_id = program_budget_balances.individual_id
                           AND detail.period_status = 'active'
                           AND (now() AT TIME ZONE 'America/New_York')::date
                               BETWEEN detail.start_date AND detail.end_date
                         GROUP BY program.id, program.code, program.name
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM program_budget_balances
            WHERE individual_id = ANY($1::uuid[])
              AND period_status = 'active'
              AND (now() AT TIME ZONE 'America/New_York')::date BETWEEN start_date AND end_date
            GROUP BY individual_id`,
          [dollarIds],
        )
      : empty<DollarAggregateRow>(),
    billedIds.length > 0
      ? pool.query<MoneyAggregateRow>(
          `SELECT individual_id AS scope_id, COALESCE(sum(imported_amount), 0)::text AS amount,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'amount', program_totals.amount
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT program.id, program.code,
                               COALESCE(program.name, detail.program_raw, 'Unassigned program') AS name,
                               COALESCE(sum(detail.imported_amount), 0)::text AS amount
                          FROM payroll_transactions detail
                          LEFT JOIN programs program ON program.id = detail.program_id
                         WHERE detail.individual_id = payroll_transactions.individual_id
                           AND canonical_service_date(detail.period_begin, detail.check_date, detail.period_end) IS NOT NULL
                           AND date_trunc('month', canonical_service_date(
                                 detail.period_begin, detail.check_date, detail.period_end
                               )) = $2::date
                         GROUP BY program.id, program.code,
                                  COALESCE(program.name, detail.program_raw, 'Unassigned program')
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM payroll_transactions
            WHERE individual_id = ANY($1::uuid[])
              AND canonical_service_date(period_begin, check_date, period_end) IS NOT NULL
              AND date_trunc('month', canonical_service_date(period_begin, check_date, period_end))
                  = $2::date
            GROUP BY individual_id`,
          [billedIds, monthStart],
        )
      : empty<MoneyAggregateRow>(),
    setAsideIds.length > 0
      ? pool.query<MoneyAggregateRow>(
          `SELECT se.individual_id AS scope_id, COALESCE(sum(se.amount), 0)::text AS amount
             FROM settlement_events se
             JOIN settlement_obligations obligation ON obligation.id = se.settlement_obligation_id
            WHERE se.individual_id = ANY($1::uuid[])
              AND obligation.direction = 'reserve'
              AND date_trunc('month', se.occurred_on) = $2::date
            GROUP BY se.individual_id`,
          [setAsideIds, monthStart],
        )
      : empty<MoneyAggregateRow>(),
    directCheckIds.length > 0
      ? pool.query<MoneyAggregateRow>(
          `SELECT transaction.individual_id AS scope_id,
                  COALESCE(sum(transaction.employee_payment_amount), 0)::text AS amount,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'amount', program_totals.amount
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT detail_program.id, detail_program.code,
                               COALESCE(detail_program.name, detail.program_raw, 'Unassigned program') AS name,
                               COALESCE(sum(detail.employee_payment_amount), 0)::text AS amount
                          FROM payroll_transactions detail
                          LEFT JOIN programs detail_program ON detail_program.id = detail.program_id
                         WHERE detail.individual_id = transaction.individual_id
                           AND effective_payment_recipient(
                                 detail.payment_recipient, detail_program.payment_recipient
                               ) = 'employee'
                           AND canonical_service_date(detail.period_begin, detail.check_date, detail.period_end) IS NOT NULL
                           AND date_trunc('month', canonical_service_date(
                                 detail.period_begin, detail.check_date, detail.period_end
                               )) = $2::date
                         GROUP BY detail_program.id, detail_program.code,
                                  COALESCE(detail_program.name, detail.program_raw, 'Unassigned program')
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM payroll_transactions transaction
             LEFT JOIN programs program ON program.id = transaction.program_id
            WHERE transaction.individual_id = ANY($1::uuid[])
              AND effective_payment_recipient(
                    transaction.payment_recipient, program.payment_recipient
                  ) = 'employee'
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ))
                  = $2::date
            GROUP BY transaction.individual_id`,
          [directCheckIds, monthStart],
        )
      : empty<MoneyAggregateRow>(),
    agencyPaidIds.length > 0
      ? pool.query<MoneyAggregateRow>(
          `SELECT transaction.individual_id AS scope_id,
                  COALESCE(sum(transaction.employee_payment_amount), 0)::text AS amount,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', program_totals.id,
                      'code', program_totals.code,
                      'name', program_totals.name,
                      'amount', program_totals.amount
                    ) ORDER BY program_totals.name)
                      FROM (
                        SELECT detail_program.id, detail_program.code,
                               COALESCE(detail_program.name, detail.program_raw, 'Unassigned program') AS name,
                               COALESCE(sum(detail.employee_payment_amount), 0)::text AS amount
                          FROM payroll_transactions detail
                          LEFT JOIN programs detail_program ON detail_program.id = detail.program_id
                         WHERE detail.individual_id = transaction.individual_id
                           AND effective_payment_recipient(
                                 detail.payment_recipient, detail_program.payment_recipient
                               ) = 'excellent_staffing'
                           AND canonical_service_date(detail.period_begin, detail.check_date, detail.period_end) IS NOT NULL
                           AND date_trunc('month', canonical_service_date(
                                 detail.period_begin, detail.check_date, detail.period_end
                               )) = $2::date
                         GROUP BY detail_program.id, detail_program.code,
                                  COALESCE(detail_program.name, detail.program_raw, 'Unassigned program')
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM payroll_transactions transaction
             LEFT JOIN programs program ON program.id = transaction.program_id
            WHERE transaction.individual_id = ANY($1::uuid[])
              AND effective_payment_recipient(
                    transaction.payment_recipient, program.payment_recipient
                  ) = 'excellent_staffing'
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ))
                  = $2::date
            GROUP BY transaction.individual_id`,
          [agencyPaidIds, monthStart],
        )
      : empty<MoneyAggregateRow>(),
    Promise.all(scheduleIds.map(async (id) => [
      id,
      await individualPortalUpcomingSchedule(pool, id),
    ] as const)),
  ]);

  const hourBudgets = mapByScope(hourBudgetResult.rows);
  const dollarBudgets = mapByScope(dollarBudgetResult.rows);
  const billed = mapByScope(billedResult.rows);
  const setAside = mapByScope(setAsideResult.rows);
  const directChecks = mapByScope(directCheckResult.rows);
  const agencyPaid = mapByScope(agencyPaidResult.rows);
  const schedules = new Map(scheduleResults);
  return peopleResult.rows.map((person) => ({
    id: person.id,
    name: person.name,
    relationships: unique(
      context.individualLinks
        .filter((link) => link.individualId === person.id)
        .map((link) => link.relationship),
    ) as IndividualRelationship[],
    hours: hourIds.includes(person.id) ? usage(hourBudgets.get(person.id)) : null,
    dollars: dollarIds.includes(person.id) ? dollarUsage(dollarBudgets.get(person.id)) : null,
    month,
    billedThisMonth: billedIds.includes(person.id) ? toMoney(billed.get(person.id)?.amount ?? 0) : null,
    setAsideThisMonth: setAsideIds.includes(person.id) ? toMoney(setAside.get(person.id)?.amount ?? 0) : null,
    directChecksThisMonth: directCheckIds.includes(person.id) ? toMoney(directChecks.get(person.id)?.amount ?? 0) : null,
    agencyPaidThisMonth: agencyPaidIds.includes(person.id) ? toMoney(agencyPaid.get(person.id)?.amount ?? 0) : null,
    programs: [hourIds, dollarIds, billedIds, directCheckIds, agencyPaidIds].some((allowed) => allowed.includes(person.id))
      ? mergeProgramBreakdowns({
          hours: hourBudgets.get(person.id)?.program_breakdown,
          dollars: dollarBudgets.get(person.id)?.program_breakdown,
          billed: billed.get(person.id)?.program_breakdown,
          directChecks: directChecks.get(person.id)?.program_breakdown,
          agencyPaid: agencyPaid.get(person.id)?.program_breakdown,
        })
      : null,
    upcomingSchedule: schedules.get(person.id) ?? null,
  }));
}

export async function directEmployeeSummaries(
  pool: PgLikePool,
  context: PortalAccessContext,
  month: string,
): Promise<PortalEmployeeSummary[]> {
  const monthStart = `${month}-01`;
  const ids = directEmployeeIds(context);
  if (ids.length === 0) return [];
  const grossIds = employeeIdsWith(context, ids, "employee_checks.self.gross.read");
  const netIds = employeeIdsWith(context, ids, "employee_checks.self.net.read");
  const taxIds = employeeIdsWith(context, ids, "employee_checks.self.tax.read");
  const checkIds = unique([...grossIds, ...netIds, ...taxIds]);
  const directPayIds = employeeIdsWith(context, ids, "employee_pay.self.read");
  const giveBackIds = employeeIdsWith(context, ids, "employee_giveback.self.read");
  const finalKeepIds = netIds.filter((id) => directPayIds.includes(id) && giveBackIds.includes(id));
  const scheduleIds = employeeIdsWith(context, ids, "schedules.self.read");
  const dealProjection = finalKeepIds.length > 0
    ? `deal.direct_rule,
       deal.direct_percent::text AS direct_percent`
    : `NULL::text AS direct_rule,
       NULL::text AS direct_percent`;
  const dealJoin = finalKeepIds.length > 0
    ? `LEFT JOIN LATERAL (
         SELECT employee_deal.direct_rule, employee_deal.direct_percent
           FROM employee_deals employee_deal
          WHERE employee_deal.employee_id = c.employee_id
            AND employee_deal.status = 'active'
            AND employee_deal.effective_from <= canonical_service_date(
                  c.period_begin, c.check_date, c.period_end
                )
            AND (employee_deal.effective_to IS NULL
              OR employee_deal.effective_to >= canonical_service_date(
                   c.period_begin, c.check_date, c.period_end
                 ))
          ORDER BY employee_deal.effective_from DESC, employee_deal.revision DESC
          LIMIT 1
       ) deal ON true`
    : "";

  const [peopleResult, checksResult, directPayResult, giveBackResult, scheduleResults] = await Promise.all([
    pool.query<PersonRow>(
      `SELECT id, display_name AS name FROM employees
        WHERE id = ANY($1::uuid[]) AND status <> 'archived'
        ORDER BY display_name`,
      [ids],
    ),
    checkIds.length > 0
      ? pool.query<PayrollCheckRow>(
          `SELECT c.id, c.employee_id, c.check_number,
                  to_char(check_date, 'YYYY-MM-DD') AS check_date,
                  to_char(period_begin, 'YYYY-MM-DD') AS period_begin,
                  to_char(period_end, 'YYYY-MM-DD') AS period_end,
                  CASE WHEN c.employee_id = ANY($2::uuid[]) THEN c.actual_gross::text END AS actual_gross,
                  CASE WHEN c.employee_id = ANY($3::uuid[]) THEN c.actual_net::text END AS actual_net,
                  CASE WHEN c.employee_id = ANY($4::uuid[]) THEN c.tax_withheld::text END AS tax_withheld,
                  ${dealProjection}
             FROM employee_payroll_checks c
             ${dealJoin}
            WHERE c.employee_id = ANY($1::uuid[])
              AND c.verification_status = 'verified'
              AND canonical_service_date(c.period_begin, c.check_date, c.period_end) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    c.period_begin, c.check_date, c.period_end
                  )) = $5::date
            ORDER BY canonical_service_date(c.period_begin, c.check_date, c.period_end) DESC,
                     c.updated_at DESC`,
          [checkIds, grossIds, netIds, taxIds, monthStart],
        )
      : empty<PayrollCheckRow>(),
    directPayIds.length > 0
      ? pool.query<EmployeeDirectPayRow>(
          `SELECT transaction.id, transaction.employee_id,
                  to_char(canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ), 'YYYY-MM-DD') AS service_date,
                  COALESCE(checks.check_number, transaction.check_number) AS check_number,
                  COALESCE(individual.display_name, transaction.individual_raw, 'Unknown individual') AS individual_name,
                  program.code AS program_code,
                  COALESCE(program.name, transaction.program_raw, 'Unassigned program') AS program_name,
                  transaction.imported_hours::text AS hours,
                  transaction.employee_payment_amount::text AS gross_service_value
             FROM payroll_transactions transaction
             JOIN employee_payroll_checks checks
               ON checks.id = transaction.payroll_check_id
              AND checks.employee_id = transaction.employee_id
              AND checks.verification_status = 'verified'
             LEFT JOIN individuals individual ON individual.id = transaction.individual_id
             LEFT JOIN programs program ON program.id = transaction.program_id
            WHERE transaction.employee_id = ANY($1::uuid[])
              AND effective_payment_recipient(
                    transaction.payment_recipient, program.payment_recipient
                  ) = 'employee'
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  )) = $2::date
            ORDER BY canonical_service_date(
                       transaction.period_begin, transaction.check_date, transaction.period_end
                     ) DESC,
                     checks.check_number,
                     individual_name,
                     program_name`,
          [directPayIds, monthStart],
        )
      : empty<EmployeeDirectPayRow>(),
    giveBackIds.length > 0
      ? pool.query<GiveBackRow>(
          `WITH event_totals AS (
             SELECT settlement_obligation_id,
                    COALESCE(sum(amount), 0) AS applied,
                    COALESCE(sum(amount) FILTER (
                      WHERE date_trunc('month', occurred_on) = $2::date
                    ), 0) AS applied_month
               FROM settlement_events
              GROUP BY settlement_obligation_id
           )
           SELECT o.employee_id AS scope_id,
                  COALESCE(sum(o.original_amount) FILTER (
                    WHERE o.direction = 'receivable'
                      AND o.status = 'active'
                      AND canonical_service_date(o.period_begin, o.check_date, o.period_end) IS NOT NULL
                      AND date_trunc('month', canonical_service_date(
                            o.period_begin, o.check_date, o.period_end
                          ))
                          = $2::date
                  ), 0)::text AS due_this_month,
                  COALESCE(sum(events.applied_month) FILTER (WHERE o.direction = 'receivable'), 0)::text AS collected_this_month,
                  COALESCE(sum(GREATEST(o.original_amount - COALESCE(events.applied, 0), 0)) FILTER (
                    WHERE o.status = 'active' AND o.direction = 'receivable'
                  ), 0)::text AS remaining,
                  COALESCE(sum(GREATEST(COALESCE(events.applied, 0) - o.original_amount, 0)) FILTER (
                    WHERE o.status = 'active' AND o.direction = 'receivable'
                  ), 0)::text AS credit,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'occurredOn', recent.occurred_on,
                      'eventType', recent.event_type,
                      'amount', recent.amount
                    ) ORDER BY recent.occurred_on DESC, recent.created_at DESC)
                      FROM (
                        SELECT to_char(history.occurred_on, 'YYYY-MM-DD') AS occurred_on,
                               history.event_type,
                               history.amount::text AS amount,
                               history.created_at
                          FROM settlement_events history
                          JOIN settlement_obligations history_obligation
                            ON history_obligation.id = history.settlement_obligation_id
                         WHERE history_obligation.employee_id = o.employee_id
                           AND history_obligation.direction = 'receivable'
                           AND history_obligation.kind LIKE 'employee_giveback%'
                         ORDER BY history.occurred_on DESC, history.created_at DESC
                         LIMIT 8
                      ) recent
                  ), '[]'::jsonb) AS recent_activity
             FROM settlement_obligations o
             LEFT JOIN event_totals events ON events.settlement_obligation_id = o.id
            WHERE o.employee_id = ANY($1::uuid[]) AND o.kind LIKE 'employee_giveback%'
            GROUP BY o.employee_id`,
          [giveBackIds, monthStart],
        )
      : empty<GiveBackRow>(),
    Promise.all(scheduleIds.map(async (id) => [
      id,
      await employeePortalUpcomingSchedule(pool, id),
    ] as const)),
  ]);

  const checks = new Map<string, PortalPayrollCheckSummary[]>();
  for (const row of checksResult.rows) {
    const item: PortalPayrollCheckSummary = {
      id: row.id,
      checkNumber: row.check_number,
      checkDate: row.check_date,
      periodBegin: row.period_begin,
      periodEnd: row.period_end,
      serviceDate: row.period_begin ?? row.check_date ?? row.period_end,
    };
    if (grossIds.includes(row.employee_id)) item.actualGross = row.actual_gross === null ? null : toMoney(row.actual_gross);
    if (netIds.includes(row.employee_id) && row.actual_net !== null) item.actualNet = toMoney(row.actual_net);
    if (taxIds.includes(row.employee_id)) item.taxWithheld = row.tax_withheld === null ? null : toMoney(row.tax_withheld);
    if (finalKeepIds.includes(row.employee_id) && row.actual_net !== null && row.direct_rule) {
      const deal = row.direct_rule === "giveback_percent"
        ? { mode: row.direct_rule, givebackFraction: row.direct_percent ?? "0" } as const
        : { mode: row.direct_rule } as const;
      const direct = calculateDirectEmployeeCheck({
        flow: "direct_employee",
        checkId: row.id,
        checkNet: row.actual_net,
        checkGross: null,
        deal,
      });
      item.giveBackDue = direct.employeeOwesAgency;
      item.employeeKeeps = direct.employeeKeeps;
    }
    checks.set(row.employee_id, [...(checks.get(row.employee_id) ?? []), item]);
  }
  const directPay = new Map<string, PortalEmployeeDirectPaySummary[]>();
  for (const row of directPayResult.rows) {
    const item: PortalEmployeeDirectPaySummary = {
      id: row.id,
      serviceDate: row.service_date,
      checkNumber: row.check_number,
      individualName: row.individual_name,
      programCode: row.program_code,
      programName: row.program_name,
      hours: row.hours === null ? null : toHours(row.hours),
      grossServiceValue: row.gross_service_value === null ? null : toMoney(row.gross_service_value),
    };
    directPay.set(row.employee_id, [...(directPay.get(row.employee_id) ?? []), item]);
  }
  const giveBack = mapByScope(giveBackResult.rows);
  const schedules = new Map(scheduleResults);
  return peopleResult.rows.map((person) => {
    const collection = giveBack.get(person.id);
    return {
      id: person.id,
      name: person.name,
      month,
      checkVisibility: {
        gross: grossIds.includes(person.id),
        net: netIds.includes(person.id),
        tax: taxIds.includes(person.id),
      },
      checks: checkIds.includes(person.id) ? checks.get(person.id) ?? [] : null,
      directPay: directPayIds.includes(person.id) ? directPay.get(person.id) ?? [] : null,
      giveBack: giveBackIds.includes(person.id) ? {
        month,
        dueThisMonth: toMoney(collection?.due_this_month ?? 0),
        collectedThisMonth: toMoney(collection?.collected_this_month ?? 0),
        remaining: toMoney(collection?.remaining ?? 0),
        credit: toMoney(collection?.credit ?? 0),
        recentActivity: employeeGiveBackActivity(collection?.recent_activity),
      } : null,
      upcomingSchedule: schedules.get(person.id) ?? null,
    };
  });
}
