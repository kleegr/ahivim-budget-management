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
import { BigStat, ProgressBar, UtilizationBadge, type UtilizationStatus } from "@/components/ui-viz";
import { TabPanels, type TabPanel } from "@/components/ui-client";
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

const STATUS_SEVERITY: Record<string, number> = {
  over_authorization: 6,
  near_exhaustion: 5,
  fully_used: 4,
  behind_pace: 3,
  ahead_of_pace: 2,
  on_pace: 1,
  not_started: 0,
};

export default async function IndividualDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("viewer");
  const canEdit = user.role !== "viewer";
  const { id } = await params;
  const initialTab = typeof (await searchParams).tab === "string" ? ((await searchParams).tab as string) : undefined;
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
  const reportPrograms = report?.programs ?? [];
  const scheduledHoursFor = (code: string) => dec(scheduledByProgram[code]?.hours ?? 0);
  let totalAuthorized = dec(0);
  let totalUsed = dec(0);
  let totalScheduled = dec(0);
  let headlineStatus: UtilizationStatus | null = null;
  for (const p of reportPrograms) {
    totalAuthorized = totalAuthorized.plus(dec(p.utilization.authorizedHours));
    totalUsed = totalUsed.plus(dec(p.utilization.usedHours));
    totalScheduled = totalScheduled.plus(scheduledHoursFor(p.programCode));
    const s = p.utilization.status as UtilizationStatus;
    if (headlineStatus === null || (STATUS_SEVERITY[s] ?? 0) > (STATUS_SEVERITY[headlineStatus] ?? 0)) headlineStatus = s;
  }
  const totalRemaining = totalAuthorized.minus(totalUsed).minus(totalScheduled);
  const totalPctUsed = totalAuthorized.isZero() ? null : totalUsed.dividedBy(totalAuthorized);
  const totalPctCommitted = totalAuthorized.isZero()
    ? null
    : totalUsed.plus(totalScheduled).dividedBy(totalAuthorized);
  const overviewTone: "good" | "warn" | "danger" = totalRemaining.isNegative()
    ? "danger"
    : totalPctUsed && totalPctUsed.greaterThan("0.9")
      ? "warn"
      : "good";
  const pctUsedNum = totalPctUsed ? totalPctUsed.times(100).toNumber() : 0;
  const elapsedNum = report?.elapsed ? dec(report.elapsed.timeElapsedPercent).times(100).toNumber() : undefined;

  // --- Period boundaries: drive the expiry banner and days-remaining. ---
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

  /* ------------------------------------------------------------------ */
  /* Overview panel                                                     */
  /* ------------------------------------------------------------------ */
  const overviewPanel = (
    <>
      {showExpiryWarning && nearestBoundary ? (
        <div
          role="status"
          className="mb-4 rounded-lg border px-5 py-4"
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
            Review the authorizations in Projections and, if services are continuing, create the next budget period.
          </p>
        </div>
      ) : null}

      {report && report.unresolvedRowCount > 0 ? (
        <div className="mb-4">
          <ErrorPanel title={`${report.unresolvedRowCount} imported rows are still awaiting a mapping decision`}>
            <p>Those rows are excluded from every figure here, so totals may understate this individual&rsquo;s activity until resolved.</p>
          </ErrorPanel>
        </div>
      ) : null}

      {report && reportPrograms.length > 0 ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <BigStat label="Authorized" value={`${formatHours(totalAuthorized)} h`} hint="This budget period" />
            <BigStat
              label="Used"
              value={`${formatHours(totalUsed)} h`}
              tone={overviewTone}
              hint={totalPctUsed ? `${formatPercent(totalPctUsed)} of authorized` : undefined}
            />
            <BigStat
              label="Scheduled"
              value={`${formatHours(totalScheduled)} h`}
              tone={totalScheduled.isZero() ? "muted" : "info"}
              hint="not yet billed"
            />
            <BigStat
              label="Remaining after schedule"
              value={`${formatHours(totalRemaining)} h`}
              tone={totalRemaining.isNegative() ? "danger" : "good"}
              hint="authorized less used less scheduled"
            />
          </div>
          <div className="card mt-3 px-5 py-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="eyebrow">Utilization against plan</p>
              {headlineStatus ? <UtilizationBadge status={headlineStatus} /> : null}
            </div>
            <ProgressBar percent={pctUsedNum} tone={overviewTone} target={elapsedNum} label="Hours used" />
            <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
              The marker shows how far the budget period has elapsed. Fill ahead of the marker is ahead of pace; behind it is underutilizing.
              {totalPctCommitted ? ` ${formatPercent(totalPctCommitted)} committed once scheduled work is counted.` : ""}
            </p>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
        </>
      ) : (
        <EmptyState title="No authorization entered yet">
          <p>Utilization and remaining hours can only be shown once a budget period and authorization exist. Add them in the Projections tab.</p>
        </EmptyState>
      )}

      {reportPrograms.length > 0 ? (
        <div className="mt-6">
          <Card
            title="Budget summary by program"
            description="Actual, scheduled and remaining are shown separately. Scheduled is never folded into actual."
            action={<ButtonLink href={`/schedule?individualId=${id}`}>View schedule</ButtonLink>}
          >
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
                const pctCommitted = authorized.isZero() ? dec(0) : used.plus(scheduled).dividedBy(authorized);
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
                        <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">of {formatHours(authorized)} h authorized</p>
                      </div>
                      <div className="rounded border border-[var(--color-rule)] px-3 py-2">
                        <p className="eyebrow">Scheduled, not billed</p>
                        <p className={`tnum mt-1 text-lg font-semibold ${scheduled.isZero() ? "text-[var(--color-ink-faint)]" : ""}`}>{formatHours(scheduled)} h</p>
                        <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
                          {scheduled.isZero() ? "No pending sessions" : `${formatMoney(scheduledInternal ?? "0")} expected internal`}
                        </p>
                      </div>
                      <div className="rounded border border-[var(--color-rule)] px-3 py-2">
                        <p className="eyebrow">Remaining after schedule</p>
                        <p className="tnum mt-1 text-lg font-semibold" style={{ color: remainingAfter.isNegative() ? "var(--color-pace-over)" : undefined }}>
                          {formatHours(remainingAfter)} h
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{formatPercent(pctCommitted)} committed</p>
                      </div>
                    </div>
                    <div className="mt-3">
                      <PaceBar usagePercent={u.usagePercent} timeElapsedPercent={report?.elapsed?.timeElapsedPercent ?? "0"} color={STATUS_COLOR[u.status]} />
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
          </Card>
        </div>
      ) : null}

      <Card title="Notes" className="mt-6">
        <p className="px-5 py-4 text-sm whitespace-pre-wrap">
          {individual.notes ? individual.notes : <span className="text-[var(--color-ink-faint)]">No notes recorded.{canEdit ? " Use “Edit” to add some." : ""}</span>}
        </p>
      </Card>
    </>
  );

  /* ------------------------------------------------------------------ */
  /* Projections panel (ten-point + authorizations)                     */
  /* ------------------------------------------------------------------ */
  const projectionsPanel = (
    <>
      <div className="mb-4 flex justify-end">
        <ButtonLink href={`/calculations?individualId=${id}`} variant="secondary">Open in Projections grid</ButtonLink>
      </div>
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
              const pctCommitted = authorizedH.isZero() ? null : usedH.plus(scheduledH).dividedBy(authorizedH);
              const totalDays = elapsed?.totalDays ?? 0;
              const elapsedDays = elapsed?.elapsedDays ?? 0;
              const expectedPerDay = totalDays > 0 ? authorizedH.dividedBy(totalDays) : null;
              const actualPerDay = elapsedDays > 0 ? usedH.dividedBy(elapsedDays) : null;
              const f = program.forecast;
              const projectedUnusedH = f && f.available ? dec(f.projectedRemainingHours) : null;
              const points: { n: number; label: string; value: string; sub?: string }[] = [
                { n: 1, label: "Total available", value: `${formatHours(authorizedH)} h`, sub: formatMoney(u.authorizedValue) },
                { n: 2, label: "Actual billed", value: `${formatHours(usedH)} h`, sub: formatMoney(u.usedValue) },
                { n: 3, label: "Scheduled, not billed", value: `${formatHours(scheduledH)} h`, sub: scheduledH.isZero() ? "No pending sessions" : `${formatMoney(scheduledInternal)} expected` },
                { n: 4, label: "Remaining after scheduled", value: `${formatHours(remainingAfterH)} h`, sub: formatMoney(remainingAfterH.times(rate)) },
                { n: 5, label: "% used", value: pctUsed ? formatPercent(pctUsed) : "—", sub: "used ÷ authorized" },
                { n: 6, label: "% committed", value: pctCommitted ? formatPercent(pctCommitted) : "—", sub: "(used + scheduled) ÷ authorized" },
                { n: 7, label: "Days remaining", value: nearestBoundary ? `${Math.max(nearestBoundary.days, 0)}` : "—", sub: nearestBoundary ? `to ${nearestBoundary.kind} (${nearestBoundary.date})` : "No period end on file" },
                { n: 8, label: "Expected pace", value: actualPerDay ? `${formatHours(actualPerDay)} h/day` : "—", sub: expectedPerDay ? `plan ${formatHours(expectedPerDay)} h/day · ${STATUS_LABELS[u.status]}` : STATUS_LABELS[u.status] },
                { n: 9, label: "Projected unused", value: projectedUnusedH ? `${formatHours(projectedUnusedH)} h` : "—", sub: projectedUnusedH ? formatMoney(projectedUnusedH.times(rate)) : "Forecast not available yet" },
                { n: 10, label: "Projected exhaustion", value: f && f.available ? (f.estimatedExhaustionDate ?? "Beyond period end") : "—", sub: f && f.available ? "at the current pace" : f ? "forecast unavailable" : "no budget period" },
              ];
              return (
                <div key={program.programCode} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-medium">{program.programName}</p>
                    <span className="text-sm" style={{ color: STATUS_COLOR[u.status] }}>{STATUS_LABELS[u.status]} · {formatPercent(u.usagePercent)} used</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                    {points.map((p) => (
                      <div key={p.n} className="rounded border border-[var(--color-rule)] px-3 py-2">
                        <p className="eyebrow"><span className="tnum text-[var(--color-ink-faint)]">{p.n}.</span> {p.label}</p>
                        <p className="tnum mt-1 text-base font-semibold">{p.value}</p>
                        {p.sub ? <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{p.sub}</p> : null}
                      </div>
                    ))}
                  </div>
                  {f && !f.available ? <p className="mt-2 text-xs text-[var(--color-ink-faint)]">Forecast (points 9–10) unavailable: {f.message}</p> : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>

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
                      <Field label="Start date" name="startDate" type="date" required help="Rolling starts here; calendar takes the year from this date; custom uses it as the start." />
                      <Field label="End date" name="endDate" type="date" help="Used only for a custom range. Calendar and rolling periods derive their own end date." />
                      <Field label="Renewal date" name="renewalDate" type="date" help="Optional. A renewal (or period end) within 60 days raises an expiration warning." />
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
              <p>{periods.length === 0 ? "Create a budget period first, then add an authorization for each program." : "This individual has a budget period but no active authorization. Add one to begin tracking utilization."}</p>
            </EmptyState>
          ) : (
            <Table
              caption="Active authorizations"
              head={<><Th>Program</Th><Th numeric>Authorized</Th><Th numeric>Internal rate</Th><Th numeric>Rev.</Th><Th>Status</Th>{canEdit ? <Th>Actions</Th> : null}</>}
            >
              {activeAuths.map((a) => {
                const period = periodById.get(a.budgetPeriodId);
                return (
                  <Tr key={a.id}>
                    <Td>
                      {a.programName}
                      <p className="text-xs text-[var(--color-ink-faint)]">{a.programCode}{period ? ` · ${period.label}` : ""}</p>
                    </Td>
                    <Td numeric><Hours value={a.authorizedHours} /></Td>
                    <Td numeric><Money value={a.internalRate} /></Td>
                    <Td numeric className="tnum">{a.revision}</Td>
                    <Td><Badge value={a.status} /></Td>
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
                          <ActionButton label="Cancel" endpoint={`/api/authorizations/${a.id}`} body={{ action: "cancel" }} withReason variant="danger" />
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
              <summary className="cursor-pointer text-xs font-medium text-[var(--color-ink-faint)]">Revision history ({historyAuths.length})</summary>
              <ul className="mt-2 space-y-1 text-xs text-[var(--color-ink-faint)]">
                {historyAuths.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    <span className="tnum">rev {a.revision}</span>
                    <span>{a.programName}</span>
                    <span className="tnum">{formatHours(a.authorizedHours)} h @ {formatMoney(a.internalRate)}</span>
                    <Badge value={a.status} />
                    <span className="tnum">{a.createdAt.slice(0, 10)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Card>
      </div>
    </>
  );

  /* ------------------------------------------------------------------ */
  /* Transactions panel (delivered usage)                               */
  /* ------------------------------------------------------------------ */
  const transactionsPanel = (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-[var(--color-ink-soft)]">What was actually billed for this individual, summarised by program. Open the full ledger to filter every transaction.</p>
        <ButtonLink href="/transactions" variant="secondary">Open Transactions</ButtonLink>
      </div>
      {report && report.usageByProgram.length > 0 ? (
        <Card title="Usage by program" description="Delivered hours and money from the billed ledger">
          <Table head={<><Th>Program</Th><Th numeric>Hours</Th><Th numeric>Agency gross</Th><Th numeric>Internal</Th></>}>
            {report.usageByProgram.map((row) => (
              <Tr key={row.programCode}>
                <Td>{row.programName}<p className="text-xs text-[var(--color-ink-faint)]">{row.transactionCount} transactions</p></Td>
                <Td numeric><Hours value={row.usedHours} /></Td>
                <Td numeric><Money value={row.agencyGross} /></Td>
                <Td numeric><Money value={row.internalAmount} /></Td>
              </Tr>
            ))}
          </Table>
        </Card>
      ) : (
        <EmptyState title="No transactions recorded" />
      )}
    </>
  );

  /* ------------------------------------------------------------------ */
  /* Rates panel                                                        */
  /* ------------------------------------------------------------------ */
  const ratesPanel = (
    <Card
      title="Program rates"
      description="The internal rate applied to each active authorization. Rates are effective-dated; changing a future rate never rewrites historical billing."
    >
      {activeAuths.length === 0 ? (
        <EmptyState title="No rates to show">
          <p>Rates appear here once this individual has an active authorization. Add one in the Projections tab.</p>
        </EmptyState>
      ) : (
        <Table head={<><Th>Program</Th><Th numeric>Internal rate</Th><Th numeric>Authorized hours</Th><Th numeric>Authorized value</Th></>}>
          {activeAuths.map((a) => (
            <Tr key={a.id}>
              <Td>{a.programName}<p className="text-xs text-[var(--color-ink-faint)]">{a.programCode}</p></Td>
              <Td numeric><Money value={a.internalRate} /></Td>
              <Td numeric><Hours value={a.authorizedHours} /></Td>
              <Td numeric><Money value={dec(a.authorizedHours).times(dec(a.internalRate)).toString()} /></Td>
            </Tr>
          ))}
        </Table>
      )}
    </Card>
  );

  /* ------------------------------------------------------------------ */
  /* People panel (assignments + employees serving)                     */
  /* ------------------------------------------------------------------ */
  const peoplePanel = (
    <>
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
                  <SelectField label="Employee" name="employeeId" required options={employees.map((e) => ({ value: e.id, label: e.displayName }))} placeholder="Choose an employee" />
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
          <EmptyState title="No employees assigned"><p>No one is assigned to this individual yet.</p></EmptyState>
        ) : (
          <Table
            caption="Assigned employees"
            head={<><Th>Employee</Th><Th>Program</Th><Th>Dates</Th><Th numeric>Allowed hours</Th><Th>Status</Th>{canEdit ? <Th>Actions</Th> : null}</>}
          >
            {assignments.map((a) => (
              <Tr key={a.id}>
                <Td><Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={`/employees/${a.employeeId}`}>{a.employeeName}</Link></Td>
                <Td><Plain value={a.programName} /></Td>
                <Td><span className="tnum">{a.startDate ?? "—"}</span><span className="text-[var(--color-ink-faint)]"> → </span><span className="tnum">{a.endDate ?? "open"}</span></Td>
                <Td numeric><Hours value={a.allowedHours} /></Td>
                <Td><Badge value={a.status} /></Td>
                {canEdit ? (
                  <Td>
                    <div className="flex flex-wrap gap-2">
                      {a.status === "active" ? <ActionButton label="End" endpoint={`/api/assignments/${a.id}`} body={{ action: "end" }} withReason /> : null}
                      {a.status !== "archived" ? <ActionButton label="Archive" endpoint={`/api/assignments/${a.id}`} body={{ action: "archive" }} withReason /> : null}
                    </div>
                  </Td>
                ) : null}
              </Tr>
            ))}
          </Table>
        )}
      </Card>

      {report ? (
        <div className="mt-6">
          <Card title="Employees serving this individual" description="From the billed ledger">
            {report.employeesServing.length === 0 ? (
              <EmptyState title="No employees recorded" />
            ) : (
              <Table head={<><Th>Employee</Th><Th numeric>Hours</Th></>}>
                {report.employeesServing.map((e) => (
                  <Tr key={e.id}>
                    <Td><Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={`/employees/${e.id}`}>{e.displayName}</Link></Td>
                    <Td numeric><Hours value={e.hours} /></Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      ) : null}
    </>
  );

  /* ------------------------------------------------------------------ */
  /* Planning panel (scheduled + known spellings)                       */
  /* ------------------------------------------------------------------ */
  const scheduledEntries = Object.entries(scheduledByProgram);
  const planningPanel = (
    <>
      <Card
        title="Scheduled, not yet billed"
        description="Pending sessions that will consume budget once delivered."
        action={<ButtonLink href={`/schedule?individualId=${id}`}>Open calendar</ButtonLink>}
      >
        {scheduledEntries.length === 0 ? (
          <EmptyState title="Nothing scheduled">
            <p>There are no pending sessions for this individual. Plan work in the calendar to project future utilization.</p>
          </EmptyState>
        ) : (
          <Table head={<><Th>Program</Th><Th numeric>Scheduled hours</Th><Th numeric>Expected internal</Th></>}>
            {scheduledEntries.map(([code, s]) => (
              <Tr key={code}>
                <Td>{code}</Td>
                <Td numeric><Hours value={s.hours} /></Td>
                <Td numeric><Money value={s.internal} /></Td>
              </Tr>
            ))}
          </Table>
        )}
      </Card>

      <div className="mt-6">
        <Card title="Known spellings" description="Imported names that resolve to this individual." action={<ButtonLink href="/aliases">Manage aliases</ButtonLink>}>
          {aliases.length === 0 ? (
            <EmptyState title="No aliases recorded"><p>No alternative spellings have been mapped to this individual.</p></EmptyState>
          ) : (
            <Table caption="Imported spellings for this individual" head={<><Th>Imported name</Th><Th>Status</Th></>}>
              {aliases.map((al) => (
                <Tr key={al.id}><Td>{al.importedName}</Td><Td><Badge value={al.status} /></Td></Tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );

  const panels: TabPanel[] = [
    { id: "overview", label: "Overview", content: overviewPanel },
    { id: "projections", label: "Projections", badge: reportPrograms.length || undefined, content: projectionsPanel },
    { id: "transactions", label: "Transactions", badge: report?.usageByProgram.length || undefined, content: transactionsPanel },
    { id: "rates", label: "Rates", content: ratesPanel },
    { id: "people", label: "People", badge: assignments.length || undefined, content: peoplePanel },
    { id: "planning", label: "Planning", badge: scheduledEntries.length || undefined, content: planningPanel },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Individual"
        title={individual.displayName}
        description={
          [
            individual.preferredName ? `Known as “${individual.preferredName}”` : null,
            individual.legalName && individual.legalName !== individual.displayName ? `Legal name: ${individual.legalName}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "No preferred or legal name on file."
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

      <div className="mb-5 flex flex-wrap items-center gap-3 text-sm">
        <Badge value={individual.status} />
        <span className="text-[var(--color-ink-faint)]">
          {report?.budgetPeriod
            ? `${report.budgetPeriod.label}: ${report.budgetPeriod.startDate} to ${report.budgetPeriod.endDate}`
            : "No budget period recorded yet — pace and forecast cannot be computed."}
        </span>
        {individual.externalRef ? <span className="text-[var(--color-ink-faint)]">Ref: {individual.externalRef}</span> : null}
      </div>

      {/* Compact hero: the "are they OK?" answer, before any tab. */}
      {report && headlineStatus ? (
        <div className="card mb-5 flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:gap-5">
          <div className="flex items-center gap-2">
            <UtilizationBadge status={headlineStatus} />
            <span className="text-sm text-[var(--color-ink-soft)]">
              {totalPctUsed ? `${Math.round(pctUsedNum)}% of approved hours used` : "No approved hours to pace yet"}
              {" · "}
              {formatHours(totalRemaining)} h left
              {report.budgetPeriod ? ` · renews ${report.budgetPeriod.endDate}` : ""}
            </span>
          </div>
          <div className="min-w-0 flex-1 sm:max-w-sm">
            <ProgressBar percent={pctUsedNum} tone={overviewTone} target={elapsedNum} showValue={false} label="Approved hours used vs. time elapsed" />
          </div>
        </div>
      ) : null}

      <TabPanels panels={panels} initialId={initialTab} paramKey="tab" />

      <p className="mt-6 text-xs text-[var(--color-ink-faint)]">
        <Badge value="valid" label="Note" /> Hours shown are allocation hours. On a group session every participant is credited the full session hours; the money is what divides.
      </p>
    </>
  );
}
