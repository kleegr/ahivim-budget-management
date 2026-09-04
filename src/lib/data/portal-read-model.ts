import type { PgLikePool } from "@/lib/import/commit";
import { toMoney } from "@/lib/money";
import {
  hasPortalCapability,
  isPortalOwner,
  portalCapabilities,
  type AgencyPortalRole,
  type PortalAccessContext,
  type PortalRole,
} from "@/lib/auth/portal-access";
import { directEmployeeSummaries, directIndividualSummaries } from "@/lib/data/portal-direct-read-model";
import { agencyMemberSummaries } from "@/lib/data/portal-agency-member-read-model";
import {
  AGENCY_PORTAL_HOURS_SCOPE,
  type AgencyAggregateRow,
  type AgencyFinancialRow,
  type AgencyRosterCountRow,
  type DollarAggregateRow,
  type HoursAggregateRow,
  type PortalAgencySummary,
  type PortalHomeReadModel,
  type PortalHomeReadModelOptions,
  agencyIdsWith,
  agencyGiveBackVisibilitySql,
  agencyPayrollCheckVisibilitySql,
  dollarUsage,
  effectivePortalHoursCte,
  empty,
  mapByScope,
  normalizePortalMonth,
  roleSummary,
  unique,
  usage,
} from "@/lib/data/portal-read-model-shared";

export { normalizePortalMonth } from "@/lib/data/portal-read-model-shared";
export type {
  PortalRoleSummary,
  PortalUsageSummary,
  PortalDollarUsageSummary,
  PortalIndividualProgramSummary,
  PortalIndividualSummary,
  PortalEmployeeDirectPaySummary,
  PortalPayrollCheckSummary,
  PortalEmployeeGiveBackActivity,
  PortalEmployeeSummary,
  PortalAgencyIndividualSummary,
  PortalAgencyEmployeeSummary,
  PortalAgencySummary,
  PortalHomeReadModel,
  PortalHomeReadModelOptions,
} from "@/lib/data/portal-read-model-shared";

export async function getPortalHomeReadModel(
  pool: PgLikePool,
  context: PortalAccessContext,
  requestedMonth?: string | null,
  options?: PortalHomeReadModelOptions,
): Promise<PortalHomeReadModel> {
  const month = normalizePortalMonth(requestedMonth);
  const monthStart = `${month}-01`;
  const requestedAgencyIds = options?.agencyIds === undefined
    ? null
    : unique(options.agencyIds);
  const agencySummaryOnly = options?.agencySummaryOnly === true;
  const scopedAgencyIds = unique(
    context.agencyAccess
      .filter((access) => hasPortalCapability(context, "agencies.read", access.agencyId))
      .map((access) => access.agencyId),
  );
  const ownerCanReadAgencies = isPortalOwner(context) && hasPortalCapability(context, "agencies.read");

  const [individuals, employees, agencyResult] = await Promise.all([
    directIndividualSummaries(pool, context, month),
    directEmployeeSummaries(pool, context, month),
    ownerCanReadAgencies || scopedAgencyIds.length > 0
      ? pool.query<AgencyAggregateRow>(
          `SELECT a.id, a.code, a.name,
                  COALESCE(ai.managed_budget_count, 0)::int AS managed_budget_count,
                  COALESCE(ai.billing_without_budget_count, 0)::int AS billing_without_budget_count
             FROM agencies a
             LEFT JOIN LATERAL (
               SELECT COUNT(*) FILTER (WHERE selected.manages_budget) AS managed_budget_count,
                      COUNT(*) FILTER (
                        WHERE selected.bills_services AND NOT selected.manages_budget
                      ) AS billing_without_budget_count
                 FROM (
                   SELECT DISTINCT ON (membership.individual_id)
                          membership.individual_id,
                          membership.manages_budget,
                          membership.bills_services
                     FROM agency_individuals membership
                    WHERE membership.agency_id = a.id
                      AND membership.is_active = true
                      AND membership.effective_from < ($4::date + interval '1 month')
                      AND (membership.effective_to IS NULL OR membership.effective_to >= $4::date)
                    ORDER BY membership.individual_id,
                             membership.effective_from DESC,
                             membership.updated_at DESC,
                             membership.id DESC
                 ) selected
             ) ai ON true
            WHERE a.status = 'active'
              AND ($1::boolean = true OR a.id = ANY($2::uuid[]))
              AND ($3::uuid[] IS NULL OR a.id = ANY($3::uuid[]))
            ORDER BY a.is_home_agency DESC, a.name`,
          [ownerCanReadAgencies, scopedAgencyIds, requestedAgencyIds, monthStart],
        )
      : empty<AgencyAggregateRow>(),
  ]);

  const agencyIds = agencyResult.rows.map((row) => row.id);
  const peopleAgencyIds = agencyIdsWith(context, agencyIds, "people.agency.read");
  const hourAgencyIds = agencyIdsWith(context, agencyIds, "hours_budgets.agency.read");
  const dollarAgencyIds = agencySummaryOnly
    ? []
    : agencyIdsWith(context, agencyIds, "dollar_budgets.agency.read");
  const billedAgencyIds = agencyIdsWith(context, agencyIds, "financials.agency.billed_totals.read");
  const setAsideAgencyIds = agencySummaryOnly
    ? []
    : agencyIdsWith(context, agencyIds, "financials.agency.cuts_set_asides.read");
  const agencyPaidAgencyIds = agencySummaryOnly
    ? []
    : agencyIdsWith(context, agencyIds, "financials.agency.agency_paid.read");
  const checkAgencyIds = agencySummaryOnly
    ? []
    : agencyIdsWith(context, agencyIds, "financials.agency.direct_checks.read");
  const giveBackAgencyIds = agencySummaryOnly
    ? []
    : agencyIdsWith(context, agencyIds, "settlements.agency.read");
  const financialAgencyIds = unique([
    ...billedAgencyIds,
    ...setAsideAgencyIds,
    ...agencyPaidAgencyIds,
    ...checkAgencyIds,
    ...giveBackAgencyIds,
  ]);

  const [
    agencyHoursResult,
    agencyDollarsResult,
    agencyFinancialResult,
    agencyRosterCountResult,
    agencyMembers,
  ] = await Promise.all([
    hourAgencyIds.length > 0
      ? pool.query<HoursAggregateRow>(
          `WITH ${effectivePortalHoursCte(AGENCY_PORTAL_HOURS_SCOPE)}
           SELECT membership.agency_id AS scope_id,
                  COALESCE(sum(effective_hours.authorized_hours), 0)::text AS authorized_hours,
                  COALESCE(sum(effective_hours.used_hours), 0)::text AS used_hours,
                  COALESCE(sum(
                    effective_hours.authorized_hours - effective_hours.used_hours
                  ), 0)::text AS remaining_hours
             FROM agency_individuals membership
             LEFT JOIN effective_hours
               ON effective_hours.individual_id = membership.individual_id
            WHERE membership.agency_id = ANY($1::uuid[])
              AND membership.is_active = true
              AND membership.manages_budget = true
              AND membership.effective_from <= (now() AT TIME ZONE 'America/New_York')::date
              AND (membership.effective_to IS NULL
                OR membership.effective_to >= (now() AT TIME ZONE 'America/New_York')::date)
            GROUP BY membership.agency_id`,
          [hourAgencyIds],
        )
      : empty<HoursAggregateRow>(),
    dollarAgencyIds.length > 0
      ? pool.query<DollarAggregateRow>(
          `SELECT membership.agency_id AS scope_id,
                  CASE WHEN count(balance.authorized_dollars) > 0 THEN sum(balance.authorized_dollars)::text END AS authorized_dollars,
                  COALESCE(sum(balance.consumed_dollars), 0)::text AS used_dollars,
                  CASE WHEN count(balance.remaining_dollars) > 0 THEN sum(balance.remaining_dollars)::text END AS remaining_dollars
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
            GROUP BY membership.agency_id`,
          [dollarAgencyIds],
        )
      : empty<DollarAggregateRow>(),
    financialAgencyIds.length > 0
      ? pool.query<AgencyFinancialRow>(
          `SELECT requested.agency_id AS scope_id,
                  CASE WHEN requested.agency_id = ANY($2::uuid[]) THEN COALESCE((
                    SELECT sum(transaction.imported_amount)
                      FROM payroll_transactions transaction
                     WHERE canonical_service_date(
                             transaction.period_begin, transaction.check_date, transaction.period_end
                           ) IS NOT NULL
                       AND date_trunc('month', canonical_service_date(
                             transaction.period_begin, transaction.check_date, transaction.period_end
                           )) = $7::date
                       AND EXISTS (
                         SELECT 1
                           FROM agency_individuals membership
                          WHERE membership.agency_id = requested.agency_id
                            AND membership.individual_id = transaction.individual_id
                            AND membership.is_active = true
                            AND membership.bills_services = true
                            AND membership.effective_from <= canonical_service_date(
                                  transaction.period_begin, transaction.check_date, transaction.period_end)
                            AND (membership.effective_to IS NULL OR membership.effective_to >=
                                  canonical_service_date(transaction.period_begin, transaction.check_date,
                                    transaction.period_end))
                       )
                  ), 0)::text END AS billed_this_month,
                  CASE WHEN requested.agency_id = ANY($3::uuid[]) THEN COALESCE((
                    SELECT sum(event.amount)
                      FROM settlement_events event
                      JOIN settlement_obligations obligation ON obligation.id = event.settlement_obligation_id
                     WHERE obligation.direction = 'reserve'
                       AND date_trunc('month', event.occurred_on) = $7::date
                       AND EXISTS (
                         SELECT 1
                           FROM agency_individuals membership
                          WHERE membership.agency_id = requested.agency_id
                            AND membership.individual_id = event.individual_id
                            AND membership.is_active = true
                            AND membership.manages_budget = true
                            AND membership.effective_from <= event.occurred_on
                            AND (membership.effective_to IS NULL OR membership.effective_to >= event.occurred_on)
                       )
                  ), 0)::text END AS set_aside_this_month,
                  CASE WHEN requested.agency_id = ANY($4::uuid[]) THEN COALESCE((
                    SELECT sum(transaction.employee_payment_amount)
                      FROM payroll_transactions transaction
                      LEFT JOIN programs transaction_program
                        ON transaction_program.id = transaction.program_id
                     WHERE effective_payment_recipient(
                             transaction.payment_recipient, transaction_program.payment_recipient
                           ) = 'excellent_staffing'
                       AND canonical_service_date(
                             transaction.period_begin, transaction.check_date, transaction.period_end
                           ) IS NOT NULL
                       AND date_trunc('month', canonical_service_date(
                             transaction.period_begin, transaction.check_date, transaction.period_end
                           )) = $7::date
                       AND EXISTS (
                         SELECT 1
                           FROM agency_individuals membership
                          WHERE membership.agency_id = requested.agency_id
                            AND membership.individual_id = transaction.individual_id
                            AND membership.is_active = true
                            AND membership.bills_services = true
                            AND membership.effective_from <= canonical_service_date(
                                  transaction.period_begin, transaction.check_date, transaction.period_end)
                            AND (membership.effective_to IS NULL OR membership.effective_to >=
                                  canonical_service_date(transaction.period_begin, transaction.check_date,
                                    transaction.period_end))
                       )
                  ), 0)::text END AS agency_paid_this_month,
                  CASE WHEN requested.agency_id = ANY($5::uuid[]) THEN (
                    SELECT CASE
                             WHEN count(*) FILTER (WHERE checks.actual_gross IS NULL) > 0 THEN NULL
                             ELSE COALESCE(sum(checks.actual_gross), 0)::text
                           END
                       FROM employee_payroll_checks checks
                     WHERE checks.verification_status = 'verified'
                       AND canonical_service_date(
                             checks.period_begin, checks.check_date, checks.period_end
                           ) IS NOT NULL
                       AND date_trunc('month', canonical_service_date(
                             checks.period_begin, checks.check_date, checks.period_end
                           ))
                           = $7::date
                       AND EXISTS (
                         SELECT 1
                           FROM agency_employees membership
                          WHERE membership.agency_id = requested.agency_id
                            AND membership.employee_id = checks.employee_id
                            AND membership.is_active = true
                            AND membership.effective_from <= canonical_service_date(
                                  checks.period_begin, checks.check_date, checks.period_end)
                            AND (membership.effective_to IS NULL OR membership.effective_to >=
                                  canonical_service_date(checks.period_begin, checks.check_date,
                                    checks.period_end))
                        )
                       AND ${agencyPayrollCheckVisibilitySql("checks", "requested.agency_id")}
                  ) END AS payroll_gross_this_month,
                  CASE WHEN requested.agency_id = ANY($5::uuid[]) THEN COALESCE((
                    SELECT sum(checks.actual_net)
                      FROM employee_payroll_checks checks
                     WHERE checks.verification_status = 'verified'
                       AND canonical_service_date(
                             checks.period_begin, checks.check_date, checks.period_end
                           ) IS NOT NULL
                       AND date_trunc('month', canonical_service_date(
                             checks.period_begin, checks.check_date, checks.period_end
                           ))
                           = $7::date
                       AND EXISTS (
                         SELECT 1
                           FROM agency_employees membership
                          WHERE membership.agency_id = requested.agency_id
                            AND membership.employee_id = checks.employee_id
                            AND membership.is_active = true
                            AND membership.effective_from <= canonical_service_date(
                                  checks.period_begin, checks.check_date, checks.period_end)
                            AND (membership.effective_to IS NULL OR membership.effective_to >=
                                  canonical_service_date(checks.period_begin, checks.check_date,
                                    checks.period_end))
                       )
                       AND ${agencyPayrollCheckVisibilitySql("checks", "requested.agency_id")}
                  ), 0)::text END AS payroll_net_this_month,
                  CASE WHEN requested.agency_id = ANY($6::uuid[]) THEN COALESCE((
                    SELECT sum(GREATEST(obligation.original_amount - COALESCE(events.applied, 0), 0))
                      FROM settlement_obligations obligation
                      LEFT JOIN LATERAL (
                        SELECT COALESCE(sum(event.amount), 0) AS applied
                          FROM settlement_events event WHERE event.settlement_obligation_id = obligation.id
                      ) events ON true
                     WHERE obligation.status = 'active'
                       AND obligation.direction = 'receivable' AND obligation.kind LIKE 'employee_giveback%'
                       AND EXISTS (
                         SELECT 1
                           FROM agency_employees membership
                          WHERE membership.agency_id = requested.agency_id
                            AND membership.employee_id = obligation.employee_id
                            AND membership.is_active = true
                            AND canonical_service_date(
                                  obligation.period_begin, obligation.check_date, obligation.period_end
                                ) IS NOT NULL
                            AND membership.effective_from <= canonical_service_date(
                                  obligation.period_begin, obligation.check_date, obligation.period_end)
                            AND (membership.effective_to IS NULL OR membership.effective_to >=
                                  canonical_service_date(obligation.period_begin, obligation.check_date,
                                    obligation.period_end))
                       )
                       AND ${agencyGiveBackVisibilitySql("obligation", "requested.agency_id")}
                  ), 0)::text END AS giveback_remaining
             FROM unnest($1::uuid[]) AS requested(agency_id)`,
          [
            financialAgencyIds,
            billedAgencyIds,
            setAsideAgencyIds,
            agencyPaidAgencyIds,
            checkAgencyIds,
            giveBackAgencyIds,
            monthStart,
          ],
        )
      : empty<AgencyFinancialRow>(),
    agencySummaryOnly && peopleAgencyIds.length > 0
      ? pool.query<AgencyRosterCountRow>(
          `SELECT agency.id AS scope_id,
                  (
                    SELECT count(*)
                      FROM (
                        SELECT DISTINCT ON (membership.individual_id) membership.individual_id
                          FROM agency_individuals membership
                         WHERE membership.agency_id = agency.id
                           AND membership.is_active = true
                           AND membership.effective_from < ($2::date + interval '1 month')
                           AND (membership.effective_to IS NULL OR membership.effective_to >= $2::date)
                         ORDER BY membership.individual_id,
                                  membership.effective_from DESC,
                                  membership.updated_at DESC,
                                  membership.id DESC
                      ) selected_individuals
                  )::int AS individual_count,
                  (
                    SELECT count(DISTINCT membership.employee_id)
                      FROM agency_employees membership
                     WHERE membership.agency_id = agency.id
                       AND membership.is_active = true
                       AND membership.effective_from < ($2::date + interval '1 month')
                       AND (membership.effective_to IS NULL OR membership.effective_to >= $2::date)
                  )::int AS employee_count
             FROM agencies agency
            WHERE agency.id = ANY($1::uuid[])`,
          [peopleAgencyIds, monthStart],
        )
      : empty<AgencyRosterCountRow>(),
    agencyMemberSummaries(
      pool,
      month,
      agencySummaryOnly ? [] : peopleAgencyIds,
      hourAgencyIds,
      dollarAgencyIds,
      billedAgencyIds,
      setAsideAgencyIds,
      checkAgencyIds,
      agencyPaidAgencyIds,
      giveBackAgencyIds,
    ),
  ]);

  const agencyHours = mapByScope(agencyHoursResult.rows);
  const agencyDollars = mapByScope(agencyDollarsResult.rows);
  const agencyFinancials = mapByScope(agencyFinancialResult.rows);
  const agencyRosterCounts = mapByScope(agencyRosterCountResult.rows);
  const agencies = agencyResult.rows.map((row): PortalAgencySummary => {
    const accessRoles = context.agencyAccess
      .filter((access) => access.agencyId === row.id)
      .map((access) => access.role);
    const roles: PortalRole[] = isPortalOwner(context) ? ["owner", ...accessRoles] : accessRoles;
    const canReadPeople = hasPortalCapability(context, "people.agency.read", row.id);
    const canReadHours = hourAgencyIds.includes(row.id);
    const canReadDollars = dollarAgencyIds.includes(row.id);
    const financial = agencyFinancials.get(row.id);
    const rosterCounts = agencyRosterCounts.get(row.id);
    const agencyIndividuals = canReadPeople && !agencySummaryOnly
      ? agencyMembers.individuals.get(row.id) ?? []
      : null;
    const agencyEmployees = canReadPeople && !agencySummaryOnly
      ? agencyMembers.employees.get(row.id) ?? []
      : null;
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      roles: unique(roles).map((role) => roleSummary(role as PortalRole)),
      capabilities: portalCapabilities(context, row.id),
      individualCount: canReadPeople
        ? agencyIndividuals?.length ?? Number(rosterCounts?.individual_count ?? 0)
        : null,
      employeeCount: canReadPeople
        ? agencyEmployees?.length ?? Number(rosterCounts?.employee_count ?? 0)
        : null,
      managedBudgetCount: canReadHours ? Number(row.managed_budget_count) : null,
      billingWithoutBudgetCount: canReadHours ? Number(row.billing_without_budget_count) : null,
      budgetHours: canReadHours ? usage(agencyHours.get(row.id)) : null,
      budgetDollars: canReadDollars ? dollarUsage(agencyDollars.get(row.id)) : null,
      month,
      billedThisMonth: billedAgencyIds.includes(row.id) ? toMoney(financial?.billed_this_month ?? 0) : null,
      setAsideThisMonth: setAsideAgencyIds.includes(row.id) ? toMoney(financial?.set_aside_this_month ?? 0) : null,
      agencyPaidThisMonth: agencyPaidAgencyIds.includes(row.id) ? toMoney(financial?.agency_paid_this_month ?? 0) : null,
      payrollGrossThisMonth: checkAgencyIds.includes(row.id)
        ? financial?.payroll_gross_this_month === null
          ? null
          : toMoney(financial?.payroll_gross_this_month ?? 0)
        : null,
      payrollNetThisMonth: checkAgencyIds.includes(row.id) ? toMoney(financial?.payroll_net_this_month ?? 0) : null,
      giveBackRemaining: giveBackAgencyIds.includes(row.id) ? toMoney(financial?.giveback_remaining ?? 0) : null,
      individuals: agencyIndividuals,
      employees: agencyEmployees,
    };
  });

  return {
    month,
    globalRoles: context.globalRoles.map((assignment) => roleSummary(assignment.role)),
    globalCapabilities: portalCapabilities(context),
    directProfiles: { individualCount: individuals.length, employeeCount: employees.length },
    individuals,
    employees,
    agencies,
  };
}

export function agencyRoles(readModel: PortalHomeReadModel): AgencyPortalRole[] {
  return unique(
    readModel.agencies.flatMap((agency) =>
      agency.roles
        .map((role) => role.key)
        .filter((role): role is AgencyPortalRole =>
          role === "agency" || role === "staffing_manager" || role === "scheduler" || role === "collector",
        ),
    ),
  ) as AgencyPortalRole[];
}
