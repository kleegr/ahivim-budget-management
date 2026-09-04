import type { PgLikePool } from "@/lib/import/commit";
import { toMoney } from "@/lib/money";
import {
  AGENCY_PORTAL_HOURS_SCOPE,
  type AgencyEmployeeCheckRow,
  type AgencyEmployeeGiveBackRow,
  type AgencyEmployeeMemberRow,
  type AgencyIndividualMemberRow,
  type AgencyPersonDollarRow,
  type AgencyPersonHoursRow,
  type AgencyPersonMoneyRow,
  type PortalAgencyEmployeeSummary,
  type PortalAgencyIndividualSummary,
  agencyGiveBackVisibilitySql,
  agencyPayrollChecks,
  agencyPayrollCheckVisibilitySql,
  agencyPersonKey,
  dollarUsage,
  effectivePortalHoursCte,
  empty,
  mapByAgencyPerson,
  mergeProgramBreakdowns,
  usage,
} from "@/lib/data/portal-read-model-shared";

export async function agencyMemberSummaries(
  pool: PgLikePool,
  month: string,
  peopleAgencyIds: readonly string[],
  hourAgencyIds: readonly string[],
  dollarAgencyIds: readonly string[],
  billedAgencyIds: readonly string[],
  setAsideAgencyIds: readonly string[],
  directCheckAgencyIds: readonly string[],
  agencyPaidAgencyIds: readonly string[],
  giveBackAgencyIds: readonly string[],
): Promise<{
  individuals: Map<string, PortalAgencyIndividualSummary[]>;
  employees: Map<string, PortalAgencyEmployeeSummary[]>;
}> {
  const monthStart = `${month}-01`;
  const peopleIds = new Set(peopleAgencyIds);
  const memberHours = hourAgencyIds.filter((id) => peopleIds.has(id));
  const memberDollars = dollarAgencyIds.filter((id) => peopleIds.has(id));
  const memberBilled = billedAgencyIds.filter((id) => peopleIds.has(id));
  const memberSetAside = setAsideAgencyIds.filter((id) => peopleIds.has(id));
  const memberDirectChecks = directCheckAgencyIds.filter((id) => peopleIds.has(id));
  const memberAgencyPaid = agencyPaidAgencyIds.filter((id) => peopleIds.has(id));
  const memberGiveBack = giveBackAgencyIds.filter((id) => peopleIds.has(id));

  const [
    individualResult,
    employeeResult,
    hoursBudgetResult,
    dollarBudgetResult,
    billedResult,
    setAsideResult,
    directCheckResult,
    agencyPaidResult,
    employeeCheckResult,
    employeeGiveBackResult,
  ] = await Promise.all([
    peopleAgencyIds.length > 0
      ? pool.query<AgencyIndividualMemberRow>(
          `WITH ranked_memberships AS (
             SELECT membership.agency_id,
                    membership.individual_id AS person_id,
                    individual.display_name AS name,
                    membership.manages_budget,
                    membership.bills_services,
                    row_number() OVER (
                      PARTITION BY membership.agency_id, membership.individual_id
                      ORDER BY membership.effective_from DESC,
                               membership.updated_at DESC,
                               membership.id DESC
                    ) AS responsibility_rank
               FROM agency_individuals membership
               JOIN individuals individual ON individual.id = membership.individual_id
              WHERE membership.agency_id = ANY($1::uuid[])
                AND membership.is_active = true
                AND membership.effective_from < ($2::date + interval '1 month')
                AND (membership.effective_to IS NULL OR membership.effective_to >= $2::date)
           )
           SELECT agency_id, person_id, name, manages_budget, bills_services
             FROM ranked_memberships
            WHERE responsibility_rank = 1
            ORDER BY agency_id, name`,
          [peopleAgencyIds, monthStart],
        )
      : empty<AgencyIndividualMemberRow>(),
    peopleAgencyIds.length > 0
      ? pool.query<AgencyEmployeeMemberRow>(
          `SELECT membership.agency_id,
                  membership.employee_id AS person_id,
                  employee.display_name AS name
             FROM agency_employees membership
             JOIN employees employee ON employee.id = membership.employee_id
            WHERE membership.agency_id = ANY($1::uuid[])
              AND membership.is_active = true
              AND (
                (
                  membership.effective_from < ($2::date + interval '1 month')
                  AND (membership.effective_to IS NULL OR membership.effective_to >= $2::date)
                )
                OR (
                  membership.agency_id = ANY($3::uuid[])
                  AND EXISTS (
                    SELECT 1
                      FROM settlement_obligations obligation
                     WHERE obligation.employee_id = membership.employee_id
                       AND obligation.status = 'active'
                       AND obligation.direction = 'receivable'
                       AND obligation.kind LIKE 'employee_giveback%'
                       AND canonical_service_date(
                             obligation.period_begin, obligation.check_date, obligation.period_end
                           ) BETWEEN membership.effective_from
                               AND COALESCE(membership.effective_to, 'infinity'::date)
                  )
                )
              )
            GROUP BY membership.agency_id, membership.employee_id, employee.display_name
            ORDER BY membership.agency_id, employee.display_name`,
          [peopleAgencyIds, monthStart, memberGiveBack],
        )
      : empty<AgencyEmployeeMemberRow>(),
    memberHours.length > 0
      ? pool.query<AgencyPersonHoursRow>(
          `WITH ${effectivePortalHoursCte(AGENCY_PORTAL_HOURS_SCOPE)}
           SELECT membership.agency_id,
                  membership.individual_id AS person_id,
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
                         WHERE detail.individual_id = membership.individual_id
                         GROUP BY program.id, program.code, program.name
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM agency_individuals membership
             LEFT JOIN effective_hours
               ON effective_hours.individual_id = membership.individual_id
            WHERE membership.agency_id = ANY($1::uuid[])
              AND membership.is_active = true
              AND membership.manages_budget = true
              AND membership.effective_from <= (now() AT TIME ZONE 'America/New_York')::date
              AND (membership.effective_to IS NULL
                OR membership.effective_to >= (now() AT TIME ZONE 'America/New_York')::date)
            GROUP BY membership.agency_id, membership.individual_id`,
          [memberHours],
        )
      : empty<AgencyPersonHoursRow>(),
    memberDollars.length > 0
      ? pool.query<AgencyPersonDollarRow>(
          `SELECT membership.agency_id,
                  membership.individual_id AS person_id,
                  CASE WHEN count(balance.authorized_dollars) > 0
                    THEN sum(balance.authorized_dollars)::text END AS authorized_dollars,
                  COALESCE(sum(balance.consumed_dollars), 0)::text AS used_dollars,
                  CASE WHEN count(balance.remaining_dollars) > 0
                    THEN sum(balance.remaining_dollars)::text END AS remaining_dollars,
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
                         WHERE detail.individual_id = membership.individual_id
                           AND detail.period_status = 'active'
                           AND (now() AT TIME ZONE 'America/New_York')::date
                               BETWEEN detail.start_date AND detail.end_date
                         GROUP BY program.id, program.code, program.name
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM agency_individuals membership
             LEFT JOIN program_budget_balances balance
               ON balance.individual_id = membership.individual_id
              AND balance.period_status = 'active'
              AND (now() AT TIME ZONE 'America/New_York')::date
                  BETWEEN balance.start_date AND balance.end_date
            WHERE membership.agency_id = ANY($1::uuid[])
              AND membership.is_active = true
              AND membership.manages_budget = true
              AND membership.effective_from <= (now() AT TIME ZONE 'America/New_York')::date
              AND (membership.effective_to IS NULL
                OR membership.effective_to >= (now() AT TIME ZONE 'America/New_York')::date)
            GROUP BY membership.agency_id, membership.individual_id`,
          [memberDollars],
        )
      : empty<AgencyPersonDollarRow>(),
    memberBilled.length > 0
      ? pool.query<AgencyPersonMoneyRow>(
          `SELECT membership.agency_id,
                  transaction.individual_id AS person_id,
                  COALESCE(sum(transaction.imported_amount), 0)::text AS amount,
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
                               COALESCE(sum(detail.imported_amount), 0)::text AS amount
                          FROM payroll_transactions detail
                          LEFT JOIN programs detail_program ON detail_program.id = detail.program_id
                         WHERE detail.individual_id = transaction.individual_id
                           AND canonical_service_date(detail.period_begin, detail.check_date, detail.period_end) IS NOT NULL
                           AND date_trunc('month', canonical_service_date(
                                 detail.period_begin, detail.check_date, detail.period_end
                               )) = $2::date
                           AND EXISTS (
                             SELECT 1
                               FROM agency_individuals detail_membership
                              WHERE detail_membership.agency_id = membership.agency_id
                                AND detail_membership.individual_id = detail.individual_id
                                AND detail_membership.is_active = true
                                AND detail_membership.bills_services = true
                                AND canonical_service_date(
                                      detail.period_begin, detail.check_date, detail.period_end
                                    ) BETWEEN detail_membership.effective_from
                                        AND COALESCE(detail_membership.effective_to, 'infinity'::date)
                           )
                         GROUP BY detail_program.id, detail_program.code,
                                  COALESCE(detail_program.name, detail.program_raw, 'Unassigned program')
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM payroll_transactions transaction
             JOIN agency_individuals membership
               ON membership.individual_id = transaction.individual_id
              AND membership.is_active = true
              AND membership.bills_services = true
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) BETWEEN membership.effective_from AND COALESCE(membership.effective_to, 'infinity'::date)
            WHERE membership.agency_id = ANY($1::uuid[])
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  )) = $2::date
            GROUP BY membership.agency_id, transaction.individual_id`,
          [memberBilled, monthStart],
        )
      : empty<AgencyPersonMoneyRow>(),
    memberSetAside.length > 0
      ? pool.query<AgencyPersonMoneyRow>(
          `SELECT membership.agency_id,
                  event.individual_id AS person_id,
                  COALESCE(sum(event.amount), 0)::text AS amount
             FROM settlement_events event
             JOIN settlement_obligations obligation ON obligation.id = event.settlement_obligation_id
             JOIN agency_individuals membership
               ON membership.individual_id = event.individual_id
              AND membership.is_active = true
              AND membership.manages_budget = true
              AND event.occurred_on BETWEEN membership.effective_from
                  AND COALESCE(membership.effective_to, 'infinity'::date)
            WHERE membership.agency_id = ANY($1::uuid[])
              AND obligation.direction = 'reserve'
              AND date_trunc('month', event.occurred_on) = $2::date
            GROUP BY membership.agency_id, event.individual_id`,
          [memberSetAside, monthStart],
        )
      : empty<AgencyPersonMoneyRow>(),
    memberDirectChecks.length > 0
      ? pool.query<AgencyPersonMoneyRow>(
          `SELECT membership.agency_id,
                  transaction.individual_id AS person_id,
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
                           AND EXISTS (
                             SELECT 1
                               FROM agency_individuals detail_membership
                              WHERE detail_membership.agency_id = membership.agency_id
                                AND detail_membership.individual_id = detail.individual_id
                                AND detail_membership.is_active = true
                                AND detail_membership.bills_services = true
                                AND canonical_service_date(
                                      detail.period_begin, detail.check_date, detail.period_end
                                    ) BETWEEN detail_membership.effective_from
                                        AND COALESCE(detail_membership.effective_to, 'infinity'::date)
                           )
                         GROUP BY detail_program.id, detail_program.code,
                                  COALESCE(detail_program.name, detail.program_raw, 'Unassigned program')
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM payroll_transactions transaction
             LEFT JOIN programs program ON program.id = transaction.program_id
             JOIN agency_individuals membership
               ON membership.individual_id = transaction.individual_id
              AND membership.is_active = true
              AND membership.bills_services = true
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) BETWEEN membership.effective_from AND COALESCE(membership.effective_to, 'infinity'::date)
            WHERE membership.agency_id = ANY($1::uuid[])
              AND effective_payment_recipient(
                    transaction.payment_recipient, program.payment_recipient
                  ) = 'employee'
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  )) = $2::date
            GROUP BY membership.agency_id, transaction.individual_id`,
          [memberDirectChecks, monthStart],
        )
      : empty<AgencyPersonMoneyRow>(),
    memberAgencyPaid.length > 0
      ? pool.query<AgencyPersonMoneyRow>(
          `SELECT membership.agency_id,
                  transaction.individual_id AS person_id,
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
                           AND EXISTS (
                             SELECT 1
                               FROM agency_individuals detail_membership
                              WHERE detail_membership.agency_id = membership.agency_id
                                AND detail_membership.individual_id = detail.individual_id
                                AND detail_membership.is_active = true
                                AND detail_membership.bills_services = true
                                AND canonical_service_date(
                                      detail.period_begin, detail.check_date, detail.period_end
                                    ) BETWEEN detail_membership.effective_from
                                        AND COALESCE(detail_membership.effective_to, 'infinity'::date)
                           )
                         GROUP BY detail_program.id, detail_program.code,
                                  COALESCE(detail_program.name, detail.program_raw, 'Unassigned program')
                      ) program_totals
                  ), '[]'::jsonb) AS program_breakdown
             FROM payroll_transactions transaction
             LEFT JOIN programs program ON program.id = transaction.program_id
             JOIN agency_individuals membership
               ON membership.individual_id = transaction.individual_id
              AND membership.is_active = true
              AND membership.bills_services = true
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) BETWEEN membership.effective_from AND COALESCE(membership.effective_to, 'infinity'::date)
            WHERE membership.agency_id = ANY($1::uuid[])
              AND effective_payment_recipient(
                    transaction.payment_recipient, program.payment_recipient
                  ) = 'excellent_staffing'
              AND canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  ) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    transaction.period_begin, transaction.check_date, transaction.period_end
                  )) = $2::date
            GROUP BY membership.agency_id, transaction.individual_id`,
          [memberAgencyPaid, monthStart],
        )
      : empty<AgencyPersonMoneyRow>(),
    memberDirectChecks.length > 0
      ? pool.query<AgencyEmployeeCheckRow>(
          `SELECT membership.agency_id,
                  checks.employee_id AS person_id,
                  CASE
                    WHEN count(*) FILTER (WHERE checks.actual_gross IS NULL) > 0 THEN NULL
                    ELSE COALESCE(sum(checks.actual_gross), 0)::text
                  END AS gross,
                  COALESCE(sum(checks.actual_net), 0)::text AS net,
                  jsonb_agg(jsonb_build_object(
                    'id', checks.id,
                    'checkNumber', checks.check_number,
                    'checkDate', to_char(checks.check_date, 'YYYY-MM-DD'),
                    'periodBegin', to_char(checks.period_begin, 'YYYY-MM-DD'),
                    'periodEnd', to_char(checks.period_end, 'YYYY-MM-DD'),
                    'serviceDate', to_char(canonical_service_date(
                      checks.period_begin, checks.check_date, checks.period_end
                    ), 'YYYY-MM-DD'),
                    'actualGross', checks.actual_gross::text,
                    'actualNet', checks.actual_net::text
                  ) ORDER BY canonical_service_date(
                    checks.period_begin, checks.check_date, checks.period_end
                  ) DESC, checks.id DESC) AS checks
             FROM employee_payroll_checks checks
             JOIN agency_employees membership
               ON membership.employee_id = checks.employee_id
              AND membership.is_active = true
              AND canonical_service_date(
                    checks.period_begin, checks.check_date, checks.period_end
                  ) BETWEEN membership.effective_from AND COALESCE(membership.effective_to, 'infinity'::date)
            WHERE membership.agency_id = ANY($1::uuid[])
              AND checks.verification_status = 'verified'
              AND canonical_service_date(
                    checks.period_begin, checks.check_date, checks.period_end
                  ) IS NOT NULL
              AND date_trunc('month', canonical_service_date(
                    checks.period_begin, checks.check_date, checks.period_end
                  )) = $2::date
              AND ${agencyPayrollCheckVisibilitySql("checks", "membership.agency_id")}
            GROUP BY membership.agency_id, checks.employee_id`,
          [memberDirectChecks, monthStart],
        )
      : empty<AgencyEmployeeCheckRow>(),
    memberGiveBack.length > 0
      ? pool.query<AgencyEmployeeGiveBackRow>(
          `WITH event_totals AS (
             SELECT settlement_obligation_id,
                    COALESCE(sum(amount), 0) AS applied,
                    COALESCE(sum(amount) FILTER (
                      WHERE date_trunc('month', occurred_on) = $2::date
                    ), 0) AS applied_month
               FROM settlement_events
              GROUP BY settlement_obligation_id
           )
           SELECT membership.agency_id,
                  obligation.employee_id AS person_id,
                  COALESCE(sum(obligation.original_amount) FILTER (
                    WHERE obligation.status = 'active'
                      AND canonical_service_date(
                            obligation.period_begin, obligation.check_date, obligation.period_end
                          ) IS NOT NULL
                      AND date_trunc('month', canonical_service_date(
                            obligation.period_begin, obligation.check_date, obligation.period_end
                          )) = $2::date
                  ), 0)::text AS due_this_month,
                  COALESCE(sum(events.applied_month), 0)::text AS collected_this_month,
                  COALESCE(sum(GREATEST(
                    obligation.original_amount - COALESCE(events.applied, 0), 0
                  )) FILTER (WHERE obligation.status = 'active'), 0)::text AS remaining
             FROM settlement_obligations obligation
             JOIN agency_employees membership
               ON membership.employee_id = obligation.employee_id
              AND membership.is_active = true
              AND canonical_service_date(
                    obligation.period_begin, obligation.check_date, obligation.period_end
                  ) BETWEEN membership.effective_from AND COALESCE(membership.effective_to, 'infinity'::date)
             LEFT JOIN event_totals events ON events.settlement_obligation_id = obligation.id
            WHERE membership.agency_id = ANY($1::uuid[])
              AND obligation.direction = 'receivable'
              AND obligation.kind LIKE 'employee_giveback%'
              AND ${agencyGiveBackVisibilitySql("obligation", "membership.agency_id")}
            GROUP BY membership.agency_id, obligation.employee_id`,
          [memberGiveBack, monthStart],
        )
      : empty<AgencyEmployeeGiveBackRow>(),
  ]);

  const hourBudgets = mapByAgencyPerson(hoursBudgetResult.rows);
  const dollarBudgets = mapByAgencyPerson(dollarBudgetResult.rows);
  const billed = mapByAgencyPerson(billedResult.rows);
  const setAside = mapByAgencyPerson(setAsideResult.rows);
  const directChecks = mapByAgencyPerson(directCheckResult.rows);
  const agencyPaid = mapByAgencyPerson(agencyPaidResult.rows);
  const employeeChecks = mapByAgencyPerson(employeeCheckResult.rows);
  const employeeGiveBack = mapByAgencyPerson(employeeGiveBackResult.rows);
  const individuals = new Map<string, PortalAgencyIndividualSummary[]>();
  const employees = new Map<string, PortalAgencyEmployeeSummary[]>();

  for (const person of individualResult.rows) {
    const key = agencyPersonKey(person.agency_id, person.person_id);
    const canReadHours = memberHours.includes(person.agency_id);
    const canReadDollars = memberDollars.includes(person.agency_id);
    const summary: PortalAgencyIndividualSummary = {
      id: person.person_id,
      name: person.name,
      managesBudget: canReadHours || canReadDollars ? person.manages_budget : null,
      billsServices: canReadHours || canReadDollars ? person.bills_services : null,
      hours: canReadHours && person.manages_budget
        ? usage(hourBudgets.get(key))
        : null,
      dollars: canReadDollars && person.manages_budget
        ? dollarUsage(dollarBudgets.get(key))
        : null,
      month,
      billedThisMonth: memberBilled.includes(person.agency_id)
        ? toMoney(billed.get(key)?.amount ?? 0)
        : null,
      setAsideThisMonth: memberSetAside.includes(person.agency_id)
        ? toMoney(setAside.get(key)?.amount ?? 0)
        : null,
      directChecksThisMonth: memberDirectChecks.includes(person.agency_id)
        ? toMoney(directChecks.get(key)?.amount ?? 0)
        : null,
      agencyPaidThisMonth: memberAgencyPaid.includes(person.agency_id)
        ? toMoney(agencyPaid.get(key)?.amount ?? 0)
        : null,
      programs: (
        (person.manages_budget && (canReadHours || canReadDollars))
        || memberBilled.includes(person.agency_id)
        || memberDirectChecks.includes(person.agency_id)
        || memberAgencyPaid.includes(person.agency_id)
      )
        ? mergeProgramBreakdowns({
            hours: canReadHours && person.manages_budget
              ? hourBudgets.get(key)?.program_breakdown
              : undefined,
            dollars: canReadDollars && person.manages_budget
              ? dollarBudgets.get(key)?.program_breakdown
              : undefined,
            billed: memberBilled.includes(person.agency_id)
              ? billed.get(key)?.program_breakdown
              : undefined,
            directChecks: memberDirectChecks.includes(person.agency_id)
              ? directChecks.get(key)?.program_breakdown
              : undefined,
            agencyPaid: memberAgencyPaid.includes(person.agency_id)
              ? agencyPaid.get(key)?.program_breakdown
              : undefined,
          })
        : null,
    };
    individuals.set(person.agency_id, [...(individuals.get(person.agency_id) ?? []), summary]);
  }

  for (const person of employeeResult.rows) {
    const key = agencyPersonKey(person.agency_id, person.person_id);
    const checks = employeeChecks.get(key);
    const giveBack = employeeGiveBack.get(key);
    const summary: PortalAgencyEmployeeSummary = {
      id: person.person_id,
      name: person.name,
      month,
      payrollGrossThisMonth: memberDirectChecks.includes(person.agency_id)
        ? checks?.gross === null
          ? null
          : toMoney(checks?.gross ?? 0)
        : null,
      payrollNetThisMonth: memberDirectChecks.includes(person.agency_id)
        ? toMoney(checks?.net ?? 0)
        : null,
      checks: memberDirectChecks.includes(person.agency_id)
        ? agencyPayrollChecks(checks?.checks)
        : null,
      giveBack: memberGiveBack.includes(person.agency_id) ? {
        dueThisMonth: toMoney(giveBack?.due_this_month ?? 0),
        collectedThisMonth: toMoney(giveBack?.collected_this_month ?? 0),
        remaining: toMoney(giveBack?.remaining ?? 0),
      } : null,
    };
    employees.set(person.agency_id, [...(employees.get(person.agency_id) ?? []), summary]);
  }

  return { individuals, employees };
}

/**
 * Portal DTOs are built only from direct subject relationships and explicit
 * agency memberships. No transaction/assignment connected-set expansion is
 * used, and every financial category is queried and returned only when its
 * exact subject- or agency-scoped capability is effective.
 */
