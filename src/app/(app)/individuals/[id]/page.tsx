import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getIndividualReport } from "@/lib/data/queries";
import { isUuid, listPrograms, listEmployees } from "@/lib/data/app-queries";
import { getIndividual } from "@/lib/manage/individuals";
import { listAuthorizationsForIndividual } from "@/lib/manage/authorizations";
import { listAssignments } from "@/lib/manage/assignments";
import { listAliases } from "@/lib/manage/aliases";
import { scheduledByProgramForIndividual } from "@/lib/data/schedule-queries";
import {
  Card, Table, Th, Td, Tr, Money, Hours, Plain, Badge, EmptyState, ErrorPanel, PageHeader, StatTile, PaceBar, ButtonLink,
} from "@/components/ui";
import { CreateButton, ActionButton, Field, TextAreaField, SelectField } from "@/components/manage/client";
import { STATUS_LABELS } from "@/lib/business/utilization";
import { dec, formatHours, formatMoney, formatPercent } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Individual — Ahivim Budget Management" };

const STATUS_COLOR: Record<string, string> = {
  not_started: "var(--color-pace-idle)",
  behind_pace: "var(--color-pace-behind)",
  on_pace: "var(--color-pace-on)",
  ahead_of_pace: "var(--color-pace-ahead)",
  near_exhaustion: "var(--color-pace-near)",
  fully_used: "var(--color-pace-near)",
  over_authorization: "var(--color-pace-over)",
};

export default async function IndividualDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser("viewer");
  const canEdit = user.role !== "viewer";
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const result = await withDb(async (pool) => {
    const individual = await getIndividual(pool, id);
    if (!individual) return null;
    const [report, authz, assignments, aliasesAll, programs, employees, scheduledByProgram] = await Promise.all([
      getIndividualReport(pool, id),
      listAuthorizationsForIndividual(pool, id),
      listAssignments(pool, { individualId: id, includeInactive: true }),
      listAliases(pool, { kind: "individual" }),
      listPrograms(pool),
      listEmployees(pool),
      scheduledByProgramForIndividual(pool, id),
    ]);
    return {
      individual,
      report,
      periods: authz.periods,
      authorizations: authz.authorizations,
      assignments,
      aliases: aliasesAll.filter((a) => a.canonicalId === id),
      programs,
      employees,
      scheduledByProgram,
    };
  });

  if (!result.ok) {
    return (
      <>
        <PageHeader eyebrow="Individual" title="Individual" />
        <ErrorPanel title="Could not load this individual">{result.error}</ErrorPanel>
      </>
    );
  }
  if (!result.data) notFound();

  const { individual, report, periods, authorizations, assignments, aliases, programs, employees, scheduledByProgram } = result.data;

  const programOptions = programs.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }));
  const periodOptions = periods.map((p) => ({
    value: p.id,
    label: `${p.label} (${p.startDate} → ${p.endDate})`,
  }));

  const activeAuths = authorizations.filter((a) => a.status === "active");
  const historyAuths = authorizations.filter((a) => a.status !== "active");
  const periodById = new Map(periods.map((p) => [p.id, p]));

  // --- Budget summary: actual / scheduled / remaining kept strictly separate ---
  // Scheduled hours come from pending sessions (Phase 2), keyed by program code.
  const reportPrograms = report?.programs ?? [];
  const scheduledHoursFor = (code: string) => dec(scheduledByProgram[code]?.hours ?? 0);
  let totalAuthorized = dec(0);
  let totalUsed = dec(0);
  let totalScheduled = dec(0);
  for (const p of reportPrograms) {
    totalAuthorized = totalAuthorized.plus(dec(p.utilization.authorizedHours));
    totalUsed = totalUsed.plus(dec(p.utilization.usedHours));
    totalScheduled = totalScheduled.plus(scheduledHoursFor(p.programCode));
  }
  const totalRemaining = totalAuthorized.minus(totalUsed).minus(totalScheduled);
  const totalPctUsed = totalAuthorized.isZero() ? null : totalUsed.dividedBy(totalAuthorized);
  const totalPctCommitted = totalAuthorized.isZero()
    ? null
    : totalUsed.plus(totalScheduled).dividedBy(totalAuthorized);

  // --- Period boundaries: drive the ten-point panel and the expiry banner. ---
  const elapsed = report?.elapsed ?? null;
  const reportPeriodId = report?.budgetPeriod?.id ?? null;
  const activePeriod =
    (reportPeriodId ? periods.find((p) => p.id === reportPeriodId) : undefined) ??
    periods.find((p) => p.status === "active") ??
    null;

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysUntil = (iso: string | null | undefined): number | null => {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    return Math.round((new Date(`${iso}T00:00:00Z`).getTime() - todayUtc) / MS_PER_DAY);
  };
  const boundaries = activePeriod
    ? ([
        { kind: "period end", date: activePeriod.endDate, days: daysUntil(activePeriod.endDate) },
        { kind: "renewal date", date: activePeriod.renewalDate, days: daysUntil(activePeriod.renewalDate) },
      ].filter((b) => b.days !== null) as { kind: string; date: string; days: number }[])
    : [];
  const nearestBoundary = [...boundaries].sort((a, b) => a.days - b.days)[0] ?? null;
  const showExpiryWarning = nearestBoundary !== null && nearestBoundary.days <= 60;

  const editIndividual = canEdit ? (
    <CreateButton
      label="Edit"
      title="Edit individual"
      endpoint={`/api/individuals/${id}`}
      method="PATCH"
      variant="secondary"
      fields={
        <>
          <Field label="Display name" name="displayName" defaultValue={individual.displayName} required />
          <Field label="Legal name" name="legalName" defaultValue={individual.legalName} />
          <Field label="Preferred name" name="preferredName" defaultValue={individual.preferredName} />
          <Field label="External reference" name="externalRef" defaultValue={individual.externalRef} />
          <TextAreaField label="Notes" name="notes" defaultValue={individual.notes} />
        </>
      }
    />
  ) : null;

  return (
    <>
      <PageHeader
        eyebrow="Individual"
        title={individual.legalName || individual.displayName}
        description={
          individual.preferredName
            ? `Known as “${individual.preferredName}”`
            : "No preferred name on file."
        }
        action={
          canEdit ? (
            <div className="flex flex-wrap gap-2">
              {editIndividual}
              {individual.status === "active" ? (
                <>
                  <ActionButton label="Deactivate" endpoint={`/api/individuals/${id}`} body={{ action: "deactivate" }} withReason />
                  <ActionButton label="Discharge" endpoint={`/api/individuals/${id}`} body={{ action: "discharge" }} withReason />
                  <ActionButton label="Archive" endpoint={`/api/individuals/${id}`} body={{ action: "archive" }} withReason />
                </>
              ) : (
                <ActionButton label="Restore" endpoint={`/api/individuals/${id}`} body={{ action: "restore" }} withReason variant="primary" />
              )}
            </div>
          ) : (
            <ButtonLink href="/individuals">All individuals</ButtonLink>
          )
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
        <Badge value={individual.status} />
        <span className="text-[var(--color-ink-faint)]">
          {report?.budgetPeriod
            ? `${report.budgetPeriod.label}: ${report.budgetPeriod.startDate} to ${report.budgetPeriod.endDate}`
            : "No budget period recorded yet — pace and forecast cannot be computed."}
        </span>
        {individual.externalRef ? (
          <span className="text-[var(--color-ink-faint)]">Ref: {individual.externalRef}</span>
        ) : null}
      </div>

      <Card title="Notes" className="mb-6">
        <p className="px-5 py-4 text-sm whitespace-pre-wrap">
          {individual.notes ? (
            individual.notes
          ) : (
            <span className="text-[var(--color-ink-faint)]">
              No notes recorded.{canEdit ? " Use “Edit” to add some." : ""}
            </span>
          )}
        </p>
      </Card>

      {report ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Agency gross" value={formatMoney(report.totals.agencyGross)} />
          <StatTile label="Internal amount" value={formatMoney(report.totals.internalAmount)} />
          <StatTile label="Hours used" value={`${formatHours(report.totals.usedHours)} h`} hint="From service allocations" />
          <StatTile
            label="Group sessions"
            value={report.groupSessions.toLocaleString()}
            hint={`${report.rateExceptions} rate exceptions · ${report.importWarnings} warnings`}
            tone={report.rateExceptions ? "warn" : "neutral"}
          />
        </div>
      ) : null}

      {report && report.unresolvedRowCount > 0 ? (
        <div className="mt-4">
          <ErrorPanel title={`${report.unresolvedRowCount} imported rows are still awaiting a mapping decision`}>
            <p>
              Those rows are excluded from every figure on this page, so the totals may understate
              this individual&rsquo;s activity until they are resolved.
            </p>
          </ErrorPanel>
        </div>
      ) : null}

      {showExpiryWarning && nearestBoundary ? (
        <div
          role="status"
          className="mt-4 rounded-lg border px-5 py-4"
          style={{ borderColor: "var(--color-pace-near)", background: "#fff8f1" }}
        >
          <p className="text-sm font-medium" style={{ color: "var(--color-pace-near)" }}>
            {nearestBoundary.days < 0
              ? `This budget period’s ${nearestBoundary.kind} passed ${Math.abs(nearestBoundary.days)} day${Math.abs(nearestBoundary.days) === 1 ? "" : "s"} ago (${nearestBoundary.date}).`
              : nearestBoundary.days === 0
                ? `This budget period’s ${nearestBoundary.kind} is today (${nearestBoundary.date}).`
                : `This budget period’s ${nearestBoundary.kind} is in ${nearestBoundary.days} day${nearestBoundary.days === 1 ? "" : "s"} (${nearestBoundary.date}).`}
          </p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            Review the authorizations below and, if services are continuing, create the next budget period.
          </p>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* Budget summary: actual, scheduled, and remaining, never merged.  */}
      {/* ---------------------------------------------------------------- */}
      <div className="mt-6">
        <Card
          title="Budget summary"
          description="Actual, scheduled and remaining are shown separately. Scheduled is never folded into actual."
          action={<ButtonLink href={`/schedule?individualId=${id}`}>View schedule</ButtonLink>}
        >
          {reportPrograms.length === 0 ? (
            <EmptyState title="No authorization entered — add one below.">
              <p>
                Utilization and remaining hours cannot be calculated without an authorization. They
                are not shown as zero, because zero would be a different, and wrong, statement. Add a
                budget period and an authorization in the section below.
              </p>
            </EmptyState>
          ) : (
            <>
              <div className="grid gap-3 border-b border-[var(--color-rule)] px-5 py-4 sm:grid-cols-2 lg:grid-cols-5">
                <StatTile label="Actual used" value={`${formatHours(totalUsed)} h`} hint="Billed / delivered" />
                <StatTile
                  label="Scheduled, not yet billed"
                  value={`${formatHours(totalScheduled)} h`}
                  hint={totalScheduled.isZero() ? "No pending sessions" : "From pending sessions"}
                  tone={totalScheduled.isZero() ? "neutral" : "warn"}
                />
                <StatTile
                  label="Remaining after schedule"
                  value={`${formatHours(totalRemaining)} h`}
                  hint="Authorized − used − scheduled"
                  tone={totalRemaining.isNegative() ? "alert" : "good"}
                />
                <StatTile label="% used" value={totalPctUsed ? formatPercent(totalPctUsed) : "—"} hint="Used ÷ authorized" />
                <StatTile
                  label="% committed"
                  value={totalPctCommitted ? formatPercent(totalPctCommitted) : "—"}
                  hint="(Used + scheduled) ÷ authorized"
                />
              </div>

              <div className="divide-y divide-[var(--color-rule)]">
                {reportPrograms.map((program) => {
                  const u = program.utilization;
                  const authorized = dec(u.authorizedHours);
                  const used = dec(u.usedHours);
                  const scheduled = scheduledHoursFor(program.programCode);
                  const scheduledInternal = scheduledByProgram[program.programCode]?.internal ?? null;
                  const remainingAfter = authorized.minus(used).minus(scheduled);
                  const pctCommitted = authorized.isZero()
                    ? dec(0)
                    : used.plus(scheduled).dividedBy(authorized);
                  return (
                    <div key={program.programCode} className="px-5 py-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="text-sm font-medium">{program.programName}</p>
                        <span className="text-sm" style={{ color: STATUS_COLOR[u.status] }}>
                          {STATUS_LABELS[u.status]} · {formatPercent(u.usagePercent)} used
                        </span>
                      </div>

                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <div className="rounded border border-[var(--color-rule)] px-3 py-2">
                          <p className="eyebrow">Actual used</p>
                          <p className="tnum mt-1 text-lg font-semibold">{formatHours(used)} h</p>
                          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
                            of {formatHours(authorized)} h authorized
                          </p>
                        </div>
                        <div className="rounded border border-[var(--color-rule)] px-3 py-2">
                          <p className="eyebrow">Scheduled, not billed</p>
                          <p className={`tnum mt-1 text-lg font-semibold ${scheduled.isZero() ? "text-[var(--color-ink-faint)]" : ""}`}>
                            {formatHours(scheduled)} h
                          </p>
                          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
                            {scheduled.isZero()
                              ? "No pending sessions"
                              : `${formatMoney(scheduledInternal ?? "0")} expected internal`}
                          </p>
                        </div>
                        <div className="rounded border border-[var(--color-rule)] px-3 py-2">
                          <p className="eyebrow">Remaining after schedule</p>
                          <p
                            className="tnum mt-1 text-lg font-semibold"
                            style={{ color: remainingAfter.isNegative() ? "var(--color-pace-over)" : undefined }}
                          >
                            {formatHours(remainingAfter)} h
                          </p>
                          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
                            {formatPercent(pctCommitted)} committed
                          </p>
                        </div>
                      </div>

                      <div className="mt-3">
                        <PaceBar
                          usagePercent={u.usagePercent}
                          timeElapsedPercent={report?.elapsed?.timeElapsedPercent ?? "0"}
                          color={STATUS_COLOR[u.status]}
                        />
                      </div>
                      <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
                        {program.forecast === null
                          ? "No forecast: this program has no budget period to project across."
                          : program.forecast.available
                            ? `Projected exhaustion ${program.forecast.estimatedExhaustionDate ?? "beyond the period end"} at ${formatHours(program.forecast.averageWeeklyUsage)} h/week (${program.forecast.observationCount} observations).`
                            : `Forecast unavailable: ${program.forecast.message}`}
                      </p>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Card>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Ten-point authorization panel                                    */}
      {/* ---------------------------------------------------------------- */}
      <div className="mt-6">
        <Card
          title="Authorization panel"
          description="Ten decision points per active authorization. Every figure is computed decimal-safe; scheduled hours are never folded into actual."
        >
          {reportPrograms.length === 0 ? (
            <EmptyState title="No active authorization to analyse">
              <p>Add a budget period and an authorization below to populate this panel.</p>
            </EmptyState>
          ) : (
            <div className="divide-y divide-[var(--color-rule)]">
              {reportPrograms.map((program) => {
                const u = program.utilization;
                const rate = dec(u.internalRate);
                const authorizedH = dec(u.authorizedHours);
                const usedH = dec(u.usedHours);
                const sched = scheduledByProgram[program.programCode] ?? null;
                const scheduledH = dec(sched?.hours ?? 0);
                const scheduledInternal = dec(sched?.internal ?? 0);
                const remainingAfterH = authorizedH.minus(usedH).minus(scheduledH);
                const pctUsed = authorizedH.isZero() ? null : usedH.dividedBy(authorizedH);
                const pctCommitted = authorizedH.isZero()
                  ? null
                  : usedH.plus(scheduledH).dividedBy(authorizedH);

                const totalDays = elapsed?.totalDays ?? 0;
                const elapsedDays = elapsed?.elapsedDays ?? 0;
                const expectedPerDay = totalDays > 0 ? authorizedH.dividedBy(totalDays) : null;
                const actualPerDay = elapsedDays > 0 ? usedH.dividedBy(elapsedDays) : null;

                const f = program.forecast;
                const projectedUnusedH = f && f.available ? dec(f.projectedRemainingHours) : null;

                const points: { n: number; label: string; value: string; sub?: string }[] = [
                  {
                    n: 1,
                    label: "Total available",
                    value: `${formatHours(authorizedH)} h`,
                    sub: formatMoney(u.authorizedValue),
                  },
                  {
                    n: 2,
                    label: "Actual billed",
                    value: `${formatHours(usedH)} h`,
                    sub: formatMoney(u.usedValue),
                  },
                  {
                    n: 3,
                    label: "Scheduled, not billed",
                    value: `${formatHours(scheduledH)} h`,
                    sub: scheduledH.isZero() ? "No pending sessions" : `${formatMoney(scheduledInternal)} expected`,
                  },
                  {
                    n: 4,
                    label: "Remaining after scheduled",
                    value: `${formatHours(remainingAfterH)} h`,
                    sub: formatMoney(remainingAfterH.times(rate)),
                  },
                  {
                    n: 5,
                    label: "% used",
                    value: pctUsed ? formatPercent(pctUsed) : "—",
                    sub: "used ÷ authorized",
                  },
                  {
                    n: 6,
                    label: "% committed",
                    value: pctCommitted ? formatPercent(pctCommitted) : "—",
                    sub: "(used + scheduled) ÷ authorized",
                  },
                  {
                    n: 7,
                    label: "Days remaining",
                    value: nearestBoundary ? `${Math.max(nearestBoundary.days, 0)}` : "—",
                    sub: nearestBoundary ? `to ${nearestBoundary.kind} (${nearestBoundary.date})` : "No period end on file",
                  },
                  {
                    n: 8,
                    label: "Expected pace",
                    value: actualPerDay ? `${formatHours(actualPerDay)} h/day` : "—",
                    sub: expectedPerDay
                      ? `plan ${formatHours(expectedPerDay)} h/day · ${STATUS_LABELS[u.status]}`
                      : STATUS_LABELS[u.status],
                  },
                  {
                    n: 9,
                    label: "Projected unused",
                    value: projectedUnusedH ? `${formatHours(projectedUnusedH)} h` : "—",
                    sub: projectedUnusedH
                      ? formatMoney(projectedUnusedH.times(rate))
                      : "Forecast not available yet",
                  },
                  {
                    n: 10,
                    label: "Projected exhaustion",
                    value: f && f.available ? (f.estimatedExhaustionDate ?? "Beyond period end") : "—",
                    sub:
                      f && f.available
                        ? "at the current pace"
                        : f
                          ? "forecast unavailable"
                          : "no budget period",
                  },
                ];

                return (
                  <div key={program.programCode} className="px-5 py-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium">{program.programName}</p>
                      <span className="text-sm" style={{ color: STATUS_COLOR[u.status] }}>
                        {STATUS_LABELS[u.status]} · {formatPercent(u.usagePercent)} used
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                      {points.map((p) => (
                        <div key={p.n} className="rounded border border-[var(--color-rule)] px-3 py-2">
                          <p className="eyebrow">
                            <span className="tnum text-[var(--color-ink-faint)]">{p.n}.</span> {p.label}
                          </p>
                          <p className="tnum mt-1 text-base font-semibold">{p.value}</p>
                          {p.sub ? (
                            <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{p.sub}</p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    {f && !f.available ? (
                      <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
                        Forecast (points 9–10) unavailable: {f.message}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Authorizations                                                   */}
      {/* ---------------------------------------------------------------- */}
      <div className="mt-6">
        <Card
          title="Authorizations"
          description="Hours granted per program, inside a budget period. Editing supersedes the prior revision; history is kept."
          action={
            canEdit ? (
              <div className="flex flex-wrap gap-2">
                <CreateButton
                  label="New budget period"
                  title="New budget period"
                  endpoint="/api/budget-periods"
                  variant="secondary"
                  size="sm"
                  hidden={{ individualId: id }}
                  fields={
                    <>
                      <Field label="Label" name="label" placeholder="e.g. 2026 plan year" />
                      <SelectField
                        label="Period type"
                        name="periodType"
                        defaultValue="custom"
                        options={[
                          { value: "custom", label: "Custom range" },
                          { value: "calendar", label: "Calendar year (Jan 1 – Dec 31)" },
                          { value: "rolling", label: "Rolling 12 months" },
                        ]}
                      />
                      <Field
                        label="Start date"
                        name="startDate"
                        type="date"
                        required
                        help="Rolling starts here; calendar takes the year from this date; custom uses it as the start."
                      />
                      <Field
                        label="End date"
                        name="endDate"
                        type="date"
                        help="Used only for a custom range. Calendar and rolling periods derive their own end date."
                      />
                      <Field
                        label="Renewal date"
                        name="renewalDate"
                        type="date"
                        help="Optional. A renewal (or period end) within 60 days raises an expiration warning."
                      />
                      <TextAreaField label="Notes" name="notes" />
                    </>
                  }
                />
                {periods.length > 0 ? (
                  <CreateButton
                    label="New authorization"
                    title="New authorization"
                    endpoint="/api/authorizations"
                    size="sm"
                    fields={
                      <>
                        <SelectField label="Budget period" name="budgetPeriodId" required options={periodOptions} placeholder="Choose a period" />
                        <SelectField label="Program" name="programId" required options={programOptions} placeholder="Choose a program" />
                        <Field label="Authorized hours" name="authorizedHours" type="number" required />
                        <Field label="Internal rate" name="internalRate" type="number" required />
                        <Field label="Authorized dollars" name="authorizedDollars" type="number" help="Optional." />
                        <Field label="Rate basis" name="rateBasis" placeholder="hours" />
                        <TextAreaField label="Notes" name="notes" />
                      </>
                    }
                  />
                ) : null}
              </div>
            ) : undefined
          }
        >
          {activeAuths.length === 0 ? (
            <EmptyState title="No active authorizations">
              <p>
                {periods.length === 0
                  ? "Create a budget period first, then add an authorization for each program."
                  : "This individual has a budget period but no active authorization. Add one to begin tracking utilization."}
              </p>
            </EmptyState>
          ) : (
            <Table
              caption="Active authorizations"
              head={
                <>
                  <Th>Program</Th>
                  <Th numeric>Authorized</Th>
                  <Th numeric>Internal rate</Th>
                  <Th numeric>Rev.</Th>
                  <Th>Status</Th>
                  {canEdit ? <Th>Actions</Th> : null}
                </>
              }
            >
              {activeAuths.map((a) => {
                const period = periodById.get(a.budgetPeriodId);
                return (
                  <Tr key={a.id}>
                    <Td>
                      {a.programName}
                      <p className="text-xs text-[var(--color-ink-faint)]">
                        {a.programCode}
                        {period ? ` · ${period.label}` : ""}
                      </p>
                    </Td>
                    <Td numeric>
                      <Hours value={a.authorizedHours} />
                    </Td>
                    <Td numeric>
                      <Money value={a.internalRate} />
                    </Td>
                    <Td numeric className="tnum">
                      {a.revision}
                    </Td>
                    <Td>
                      <Badge value={a.status} />
                    </Td>
                    {canEdit ? (
                      <Td>
                        <div className="flex flex-wrap gap-2">
                          <CreateButton
                            label="Revise"
                            title={`Revise ${a.programName}`}
                            endpoint={`/api/authorizations/${a.id}`}
                            method="PATCH"
                            variant="secondary"
                            size="sm"
                            fields={
                              <>
                                <Field label="Authorized hours" name="authorizedHours" type="number" defaultValue={a.authorizedHours} required />
                                <Field label="Internal rate" name="internalRate" type="number" defaultValue={a.internalRate} required />
                                <TextAreaField label="Notes" name="notes" defaultValue={a.notes} />
                              </>
                            }
                          />
                          <ActionButton
                            label="Cancel"
                            endpoint={`/api/authorizations/${a.id}`}
                            body={{ action: "cancel" }}
                            withReason
                            variant="danger"
                          />
                        </div>
                      </Td>
                    ) : null}
                  </Tr>
                );
              })}
            </Table>
          )}

          {historyAuths.length > 0 ? (
            <details className="border-t border-[var(--color-rule)] px-5 py-3">
              <summary className="cursor-pointer text-xs font-medium text-[var(--color-ink-faint)]">
                Revision history ({historyAuths.length})
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-[var(--color-ink-faint)]">
                {historyAuths.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    <span className="tnum">rev {a.revision}</span>
                    <span>{a.programName}</span>
                    <span className="tnum">
                      {formatHours(a.authorizedHours)} h @ {formatMoney(a.internalRate)}
                    </span>
                    <Badge value={a.status} />
                    <span className="tnum">{a.createdAt.slice(0, 10)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Card>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Assignments                                                      */}
      {/* ---------------------------------------------------------------- */}
      <div className="mt-6">
        <Card
          title="Assigned employees"
          description="Who is permitted to serve this individual, and for how many hours."
          action={
            canEdit ? (
              <CreateButton
                label="Assign employee"
                title="Assign employee"
                endpoint="/api/assignments"
                size="sm"
                hidden={{ individualId: id }}
                fields={
                  <>
                    <SelectField
                      label="Employee"
                      name="employeeId"
                      required
                      options={employees.map((e) => ({ value: e.id, label: e.displayName }))}
                      placeholder="Choose an employee"
                    />
                    <SelectField label="Program" name="programId" options={programOptions} placeholder="Any program" />
                    <Field label="Start date" name="startDate" type="date" />
                    <Field label="End date" name="endDate" type="date" />
                    <Field label="Allowed hours" name="allowedHours" type="number" />
                    <TextAreaField label="Notes" name="notes" />
                  </>
                }
              />
            ) : undefined
          }
        >
          {assignments.length === 0 ? (
            <EmptyState title="No employees assigned">
              <p>No one is assigned to this individual yet.</p>
            </EmptyState>
          ) : (
            <Table
              caption="Assigned employees"
              head={
                <>
                  <Th>Employee</Th>
                  <Th>Program</Th>
                  <Th>Dates</Th>
                  <Th numeric>Allowed hours</Th>
                  <Th>Status</Th>
                  {canEdit ? <Th>Actions</Th> : null}
                </>
              }
            >
              {assignments.map((a) => (
                <Tr key={a.id}>
                  <Td>
                    <Link className="underline underline-offset-2" href={`/employees/${a.employeeId}`}>
                      {a.employeeName}
                    </Link>
                  </Td>
                  <Td>
                    <Plain value={a.programName} />
                  </Td>
                  <Td>
                    <span className="tnum">{a.startDate ?? "—"}</span>
                    <span className="text-[var(--color-ink-faint)]"> → </span>
                    <span className="tnum">{a.endDate ?? "open"}</span>
                  </Td>
                  <Td numeric>
                    <Hours value={a.allowedHours} />
                  </Td>
                  <Td>
                    <Badge value={a.status} />
                  </Td>
                  {canEdit ? (
                    <Td>
                      <div className="flex flex-wrap gap-2">
                        {a.status === "active" ? (
                          <ActionButton label="End" endpoint={`/api/assignments/${a.id}`} body={{ action: "end" }} withReason />
                        ) : null}
                        {a.status !== "archived" ? (
                          <ActionButton label="Archive" endpoint={`/api/assignments/${a.id}`} body={{ action: "archive" }} withReason />
                        ) : null}
                      </div>
                    </Td>
                  ) : null}
                </Tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Delivered usage (preserved from the report)                      */}
      {/* ---------------------------------------------------------------- */}
      {report ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Card title="Usage by program" description="What was actually delivered">
            {report.usageByProgram.length === 0 ? (
              <EmptyState title="No transactions recorded" />
            ) : (
              <Table head={<><Th>Program</Th><Th numeric>Hours</Th><Th numeric>Agency</Th><Th numeric>Internal</Th></>}>
                {report.usageByProgram.map((row) => (
                  <Tr key={row.programCode}>
                    <Td>
                      {row.programName}
                      <p className="text-xs text-[var(--color-ink-faint)]">{row.transactionCount} transactions</p>
                    </Td>
                    <Td numeric><Hours value={row.usedHours} /></Td>
                    <Td numeric><Money value={row.agencyGross} /></Td>
                    <Td numeric><Money value={row.internalAmount} /></Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>

          <Card title="Employees serving this individual">
            {report.employeesServing.length === 0 ? (
              <EmptyState title="No employees recorded" />
            ) : (
              <Table head={<><Th>Employee</Th><Th numeric>Hours</Th></>}>
                {report.employeesServing.map((e) => (
                  <Tr key={e.id}>
                    <Td>
                      <Link className="underline underline-offset-2" href={`/employees/${e.id}`}>
                        {e.displayName}
                      </Link>
                    </Td>
                    <Td numeric><Hours value={e.hours} /></Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* Aliases                                                          */}
      {/* ---------------------------------------------------------------- */}
      <div className="mt-6">
        <Card
          title="Known spellings"
          description="Imported names that resolve to this individual."
          action={<ButtonLink href="/aliases">Manage aliases</ButtonLink>}
        >
          {aliases.length === 0 ? (
            <EmptyState title="No aliases recorded">
              <p>No alternative spellings have been mapped to this individual.</p>
            </EmptyState>
          ) : (
            <Table
              caption="Imported spellings for this individual"
              head={<><Th>Imported name</Th><Th>Status</Th></>}
            >
              {aliases.map((al) => (
                <Tr key={al.id}>
                  <Td>{al.importedName}</Td>
                  <Td>
                    <Badge value={al.status} />
                  </Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <p className="mt-4 text-xs text-[var(--color-ink-faint)]">
        <Badge value="valid" label="Note" /> Hours shown are allocation hours. On a group session
        every participant is credited the full session hours; the money is what divides.
      </p>
    </>
  );
}
