import { randomUUID } from "node:crypto";
import { AlertTriangle, CalendarDays, History, RefreshCcw } from "lucide-react";
import { ActionButton, CreateButton, Field, TextAreaField } from "@/components/manage/client";
import { ButtonLink, StatusBadge } from "@/components/ui";
import { dec, formatHours, formatMoney } from "@/lib/money";
import ProgramBudgetFields, { type ProgramBudgetOption } from "./program-budget-fields";

export interface VisibleProgramBudgetEvent {
  id: string;
  eventType: "consume" | "adjust" | "reverse";
  serviceDate: string;
  hours: string | null;
  amount: string | null;
  sourceType: string;
  reversesEventId: string | null;
  note: string | null;
  createdAt: string;
}

export interface VisibleProgramBudget {
  authorizationId: string;
  budgetPeriodId: string;
  programId: string;
  programCode: string;
  programName: string;
  periodLabel: string;
  startDate: string;
  endDate: string;
  renewalDate: string | null;
  periodType: string;
  periodStatus: string;
  requiredAuthType: string;
  consumptionSource: string;
  renewalPolicy: string;
  isGroupService: boolean;
  authorizedHours: string | null;
  authorizedDollars: string | null;
  internalRate: string | null;
  agencyRate: string | null;
  individualRateOverride: string | null;
  allowIndividualRateOverride: boolean;
  notes: string | null;
  consumedHours: string | null;
  consumedDollars: string | null;
  remainingHours: string | null;
  remainingDollars: string | null;
  scheduledHours: string | null;
  remainingAfterScheduledHours: string | null;
  undatedUsageCount: number | null;
  hasUndatedUsage: boolean;
  revision: number;
  canManageRenewal: boolean;
  showEventHistory: boolean;
  monthlyHistory: VisibleProgramBudgetMonth[];
  events: VisibleProgramBudgetEvent[];
  authorizationRevisions: VisibleAuthorizationRevision[];
}

export interface VisibleProgramBudgetMonth {
  month: string;
  usedHours: string;
  scheduledHours: string;
  cumulativeUsedHours: string;
  cumulativeScheduledHours: string;
  remainingHours: string;
  remainingAfterScheduledHours: string;
  expectedUsedHours: string | null;
  paceVarianceHours: string | null;
}

export interface VisibleAuthorizationRevision {
  id: string;
  revision: number;
  status: string;
  authorizedHours: string | null;
  authorizedDollars: string | null;
  internalRate: string | null;
  agencyRate: string | null;
  individualRateOverride: string | null;
  notes: string | null;
  createdAt: string;
}

function dateLabel(value: string): string {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${month}/${day}/${year}` : value;
}

function titleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function SourceLabel({ source }: { source: string }) {
  const labels: Record<string, string> = {
    class_invoice: "Class invoice",
    manual: "Manual entry",
    payroll: "Payroll",
    import: "Import",
  };
  return <span>{labels[source] ?? titleCase(source)}</span>;
}

function UsageBar({
  used,
  authorized,
  unit,
}: {
  used: string;
  authorized: string;
  unit: "hours" | "dollars";
}) {
  const allowed = dec(authorized);
  const consumed = dec(used);
  const percent = allowed.gt(0)
    ? consumed.dividedBy(allowed).times(100).toNumber()
    : consumed.gt(0)
      ? 100
      : 0;
  const over = consumed.gt(allowed);
  const width = Math.max(0, Math.min(100, percent));

  return (
    <div
      className="mt-3"
      role="img"
      aria-label={`${percent.toFixed(1)} percent of authorized ${unit} used`}
    >
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-strong)]">
        <div
          className={`h-full rounded-full ${over ? "bg-[var(--color-danger)]" : "bg-[var(--color-primary)]"}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function HoursMetrics({ budget }: { budget: VisibleProgramBudget }) {
  if (
    budget.authorizedHours === null
    || budget.consumedHours === null
    || budget.remainingHours === null
    || budget.scheduledHours === null
    || budget.remainingAfterScheduledHours === null
  ) return null;
  const isOver = dec(budget.remainingHours).isNegative();
  const scheduleIsOver = dec(budget.remainingAfterScheduledHours).isNegative();
  return (
    <div className="border-t border-[var(--color-rule)] pt-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div><p className="text-xs text-[var(--color-ink-faint)]">Hours authorized</p><p className="tnum mt-1 text-lg font-semibold">{formatHours(budget.authorizedHours)}</p></div>
        <div><p className="text-xs text-[var(--color-ink-faint)]">{budget.isGroupService ? "Individual hours used" : "Hours used"}</p><p className="tnum mt-1 text-lg font-semibold">{formatHours(budget.consumedHours)}</p></div>
        <div><p className="text-xs text-[var(--color-ink-faint)]">Scheduled</p><p className="tnum mt-1 text-lg font-semibold">{formatHours(budget.scheduledHours)}</p></div>
        <div><p className="text-xs text-[var(--color-ink-faint)]">Remaining now</p><p className={`tnum mt-1 text-lg font-semibold ${isOver ? "text-[var(--color-danger)]" : ""}`}>{formatHours(budget.remainingHours)}</p></div>
        <div><p className="text-xs text-[var(--color-ink-faint)]">After schedule</p><p className={`tnum mt-1 text-lg font-semibold ${scheduleIsOver ? "text-[var(--color-danger)]" : ""}`}>{formatHours(budget.remainingAfterScheduledHours)}</p></div>
      </div>
      <UsageBar used={budget.consumedHours} authorized={budget.authorizedHours} unit="hours" />
      <p className="mt-2 text-xs text-[var(--color-ink-faint)]">Scheduled includes pending sessions in this authorization period that are not yet matched to a transaction.</p>
      {budget.isGroupService ? (
        <p className="mt-1 text-xs font-medium text-[var(--color-ink-soft)]">Group service totals are hours credited to this individual. Physical employee time is counted separately in employee reports.</p>
      ) : null}
    </div>
  );
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(value: string): string {
  const [year, month] = value.split("-");
  const label = MONTH_LABELS[Number(month) - 1];
  return label && year ? `${label} ${year}` : value;
}

function paceLabel(variance: string | null): { label: string; className: string } {
  if (variance === null) return { label: "Upcoming", className: "text-[var(--color-ink-faint)]" };
  const amount = dec(variance);
  if (amount.isZero()) return { label: "On pace", className: "text-[var(--color-success)]" };
  if (amount.isPositive()) {
    return { label: `${formatHours(amount)} h ahead`, className: "text-[var(--color-success)]" };
  }
  return { label: `${formatHours(amount.abs())} h behind`, className: "text-[var(--color-danger)]" };
}

function MonthlyHistory({ months, isGroupService }: { months: VisibleProgramBudgetMonth[]; isGroupService: boolean }) {
  if (months.length === 0) return null;
  return (
    <details className="border-t border-[var(--color-rule)] px-4 py-3 sm:px-5">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-[var(--color-ink-soft)]">
        <CalendarDays aria-hidden className="h-4 w-4" />
        Monthly authorization trend
        <span className="tnum text-xs font-normal text-[var(--color-ink-faint)]">{months.length}</span>
      </summary>
      <div className="scroll-thin mt-3 overflow-x-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--color-rule)] text-left text-xs text-[var(--color-ink-faint)]">
              <th className="py-2 pr-4 font-semibold">Month</th>
              <th className="px-3 py-2 text-right font-semibold">{isGroupService ? "Credited" : "Used"}</th>
              <th className="px-3 py-2 text-right font-semibold">Scheduled</th>
              <th className="px-3 py-2 text-right font-semibold">Used to date</th>
              <th className="px-3 py-2 text-right font-semibold">Expected</th>
              <th className="px-3 py-2 text-right font-semibold">After scheduled</th>
              <th className="py-2 pl-3 text-right font-semibold">Pace</th>
            </tr>
          </thead>
          <tbody>
            {months.map((month) => {
              const pace = paceLabel(month.paceVarianceHours);
              return (
                <tr key={month.month} className="border-b border-[var(--color-rule)] last:border-0">
                  <td className="whitespace-nowrap py-2.5 pr-4 font-medium">{monthLabel(month.month)}</td>
                  <td className="px-3 py-2.5 text-right tnum">{formatHours(month.usedHours)}</td>
                  <td className="px-3 py-2.5 text-right tnum">{formatHours(month.scheduledHours)}</td>
                  <td className="px-3 py-2.5 text-right tnum">{formatHours(month.cumulativeUsedHours)}</td>
                  <td className="px-3 py-2.5 text-right tnum">{month.expectedUsedHours === null ? "-" : formatHours(month.expectedUsedHours)}</td>
                  <td className="px-3 py-2.5 text-right tnum">{formatHours(month.remainingAfterScheduledHours)}</td>
                  <td className={`whitespace-nowrap py-2.5 pl-3 text-right text-xs font-semibold ${pace.className}`}>{pace.label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-[var(--color-ink-faint)]">Used comes from committed transactions and ledger adjustments. Scheduled includes pending unmatched sessions.</p>
    </details>
  );
}

function DollarMetrics({ budget }: { budget: VisibleProgramBudget }) {
  if (budget.authorizedDollars === null || budget.consumedDollars === null || budget.remainingDollars === null) return null;
  const isOver = dec(budget.remainingDollars).isNegative();
  return (
    <div className="border-t border-[var(--color-rule)] pt-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div><p className="text-xs text-[var(--color-ink-faint)]">Amount authorized</p><p className="tnum mt-1 text-lg font-semibold">{formatMoney(budget.authorizedDollars)}</p></div>
        <div><p className="text-xs text-[var(--color-ink-faint)]">Amount used</p><p className="tnum mt-1 text-lg font-semibold">{formatMoney(budget.consumedDollars)}</p></div>
        <div><p className="text-xs text-[var(--color-ink-faint)]">Amount remaining</p><p className={`tnum mt-1 text-lg font-semibold ${isOver ? "text-[var(--color-danger)]" : ""}`}>{formatMoney(budget.remainingDollars)}</p></div>
      </div>
      <UsageBar used={budget.consumedDollars} authorized={budget.authorizedDollars} unit="dollars" />
    </div>
  );
}

function EventFields({ budget, eventType }: { budget: VisibleProgramBudget; eventType: "consume" | "adjust" }) {
  const needsHours = budget.requiredAuthType === "hours" || budget.requiredAuthType === "both";
  const needsDollars = budget.requiredAuthType === "dollars" || budget.requiredAuthType === "both";
  return (
    <>
      <input type="hidden" name="eventType" value={eventType} />
      <Field label="Service date" name="serviceDate" type="date" required />
      <div className={`grid gap-3 ${needsHours && needsDollars ? "sm:grid-cols-2" : ""}`}>
        {needsHours ? <Field label="Hours" name="hours" type="number" required /> : <input type="hidden" name="hours" value="0" />}
        {needsDollars ? <Field label="Amount" name="amount" type="number" required /> : <input type="hidden" name="amount" value="0" />}
      </div>
      <TextAreaField
        label={eventType === "adjust" ? "Adjustment reason" : "Note"}
        name="note"
        required={eventType === "adjust"}
        minLength={eventType === "adjust" ? 5 : undefined}
      />
      <TextAreaField label="Over-budget override reason" name="overBudgetOverrideReason" />
    </>
  );
}

function eventName(event: VisibleProgramBudgetEvent): string {
  if (event.eventType === "reverse") return "Reversal";
  if (event.eventType === "adjust") return "Adjustment";
  return "Usage";
}

function EventHistory({ budget, canManage }: { budget: VisibleProgramBudget; canManage: boolean }) {
  const reversedIds = new Set(
    budget.events
      .filter((event) => event.eventType === "reverse" && event.reversesEventId)
      .map((event) => event.reversesEventId!),
  );
  const hasHours = budget.events.some((event) => event.hours !== null);
  const hasAmounts = budget.events.some((event) => event.amount !== null);

  return (
    <details className="border-t border-[var(--color-rule)] px-4 py-3 sm:px-5">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-[var(--color-ink-soft)]">
        <History aria-hidden className="h-4 w-4" />
        Append-only history
        <span className="tnum text-xs font-normal text-[var(--color-ink-faint)]">{budget.events.length}</span>
      </summary>
      {budget.events.length === 0 ? (
        <p className="py-5 text-sm text-[var(--color-ink-faint)]">No ledger entries are recorded for this authorization.</p>
      ) : (
        <div className="scroll-thin mt-3 overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--color-rule)] text-left text-xs text-[var(--color-ink-faint)]">
                <th className="py-2 pr-4 font-semibold">Date</th>
                <th className="px-4 py-2 font-semibold">Entry</th>
                {hasHours ? <th className="px-4 py-2 text-right font-semibold">Hours</th> : null}
                {hasAmounts ? <th className="px-4 py-2 text-right font-semibold">Amount</th> : null}
                <th className="px-4 py-2 font-semibold">Source</th>
                <th className="px-4 py-2 font-semibold">Note</th>
                {canManage ? <th className="py-2 pl-4 text-right font-semibold">Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {budget.events.map((event) => {
                const wasReversed = reversedIds.has(event.id);
                return (
                  <tr key={event.id} className="border-b border-[var(--color-rule)] last:border-0">
                    <td className="whitespace-nowrap py-2.5 pr-4 tnum">{dateLabel(event.serviceDate)}</td>
                    <td className="px-4 py-2.5">
                      <span className={event.eventType === "reverse" || wasReversed ? "text-[var(--color-ink-faint)]" : ""}>{eventName(event)}</span>
                      {wasReversed ? <span className="ml-2 text-xs text-[var(--color-ink-faint)]">Reversed</span> : null}
                    </td>
                    {hasHours ? <td className="px-4 py-2.5 text-right tnum">{event.hours === null ? "" : formatHours(event.hours)}</td> : null}
                    {hasAmounts ? <td className="px-4 py-2.5 text-right tnum">{event.amount === null ? "" : formatMoney(event.amount)}</td> : null}
                    <td className="whitespace-nowrap px-4 py-2.5 text-[var(--color-ink-soft)]"><SourceLabel source={event.sourceType} /></td>
                    <td className="max-w-64 px-4 py-2.5 text-[var(--color-ink-soft)]">{event.note ?? ""}</td>
                    {canManage ? (
                      <td className="py-2.5 pl-4 text-right">
                        {event.eventType !== "reverse" && !wasReversed ? (
                          <ActionButton
                            label="Reverse"
                            endpoint={`/api/program-budget-events/${event.id}/reverse`}
                            method="POST"
                            withReason
                            variant="danger"
                          />
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

function FixedAuthorizationRate({ label, value }: { label: string; value: string | null }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        type="number"
        value={value ?? ""}
        disabled
        className="mt-1 w-full rounded border border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-3 py-1.5 text-sm text-[var(--color-ink-soft)]"
      />
    </label>
  );
}

function AuthorizationRevisionFields({
  budget,
  showAgencyRate,
  showInternalRate,
}: {
  budget: VisibleProgramBudget;
  showAgencyRate: boolean;
  showInternalRate: boolean;
}) {
  const hasHours = budget.authorizedHours !== null;
  return (
    <>
      <div className={`grid gap-3 ${budget.authorizedHours !== null && budget.authorizedDollars !== null ? "sm:grid-cols-2" : ""}`}>
        {budget.authorizedHours !== null ? (
          <Field label="Authorized hours" name="authorizedHours" type="number" defaultValue={budget.authorizedHours} required />
        ) : null}
        {budget.authorizedDollars !== null ? (
          <Field label="Authorized amount" name="authorizedDollars" type="number" defaultValue={budget.authorizedDollars} required />
        ) : null}
      </div>
      {hasHours && (showAgencyRate || showInternalRate) ? (
        <div className={`grid gap-3 ${showAgencyRate && showInternalRate ? "sm:grid-cols-2" : ""}`}>
          {showAgencyRate ? budget.allowIndividualRateOverride ? (
            <Field label="Funder / agency rate" name="agencyRate" type="number" defaultValue={budget.agencyRate ?? ""} />
          ) : (
            <FixedAuthorizationRate label="Funder / agency rate" value={budget.agencyRate} />
          ) : null}
          {showInternalRate ? budget.allowIndividualRateOverride ? (
            <Field label="Employee / internal rate" name="individualRateOverride" type="number" defaultValue={budget.internalRate ?? ""} required />
          ) : (
            <FixedAuthorizationRate label="Employee / internal rate" value={budget.internalRate} />
          ) : null}
        </div>
      ) : null}
      <TextAreaField label="Authorization notes" name="notes" defaultValue={budget.notes} />
      <TextAreaField label="Change reason" name="reason" required minLength={5} />
    </>
  );
}

function AuthorizationHistory({ budget }: { budget: VisibleProgramBudget }) {
  if (budget.authorizationRevisions.length === 0) return null;
  const showHours = budget.authorizationRevisions.some((revision) => revision.authorizedHours !== null);
  const showDollars = budget.authorizationRevisions.some((revision) => revision.authorizedDollars !== null);
  const showAgencyRate = budget.authorizationRevisions.some((revision) => revision.agencyRate !== null);
  const showInternalRate = budget.authorizationRevisions.some((revision) => revision.internalRate !== null);
  return (
    <details className="border-t border-[var(--color-rule)] px-4 py-3 sm:px-5">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-[var(--color-ink-soft)]">
        <History aria-hidden className="h-4 w-4" />
        Authorization revisions
        <span className="tnum text-xs font-normal text-[var(--color-ink-faint)]">{budget.authorizationRevisions.length}</span>
      </summary>
      <div className="scroll-thin mt-3 overflow-x-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--color-rule)] text-left text-xs text-[var(--color-ink-faint)]">
              <th className="py-2 pr-4 font-semibold">Revision</th>
              <th className="px-4 py-2 font-semibold">Status</th>
              {showHours ? <th className="px-4 py-2 text-right font-semibold">Hours</th> : null}
              {showDollars ? <th className="px-4 py-2 text-right font-semibold">Amount</th> : null}
              {showAgencyRate ? <th className="px-4 py-2 text-right font-semibold">Funder rate</th> : null}
              {showInternalRate ? <th className="px-4 py-2 text-right font-semibold">Employee rate</th> : null}
              <th className="px-4 py-2 font-semibold">Recorded</th>
              <th className="py-2 pl-4 font-semibold">Notes</th>
            </tr>
          </thead>
          <tbody>
            {budget.authorizationRevisions.map((revision) => (
              <tr key={revision.id} className="border-b border-[var(--color-rule)] last:border-0">
                <td className="py-2.5 pr-4 tnum">{revision.revision}</td>
                <td className="px-4 py-2.5">{titleCase(revision.status)}</td>
                {showHours ? <td className="px-4 py-2.5 text-right tnum">{revision.authorizedHours === null ? "" : formatHours(revision.authorizedHours)}</td> : null}
                {showDollars ? <td className="px-4 py-2.5 text-right tnum">{revision.authorizedDollars === null ? "" : formatMoney(revision.authorizedDollars)}</td> : null}
                {showAgencyRate ? <td className="px-4 py-2.5 text-right tnum">{revision.agencyRate === null ? "" : formatMoney(revision.agencyRate)}</td> : null}
                {showInternalRate ? <td className="px-4 py-2.5 text-right tnum">{revision.internalRate === null ? "" : formatMoney(revision.internalRate)}</td> : null}
                <td className="whitespace-nowrap px-4 py-2.5 tnum">{dateLabel(revision.createdAt.slice(0, 10))}</td>
                <td className="max-w-64 py-2.5 pl-4 text-[var(--color-ink-soft)]">{revision.notes ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export default function ProgramBudgetWorkspace({
  individualId,
  budgets,
  programs,
  canManage,
  hoursOnlyManagement,
  showInternalRate,
  showAgencyRate,
}: {
  individualId: string;
  budgets: VisibleProgramBudget[];
  programs: ProgramBudgetOption[];
  canManage: boolean;
  hoursOnlyManagement: boolean;
  showInternalRate: boolean;
  showAgencyRate: boolean;
}) {
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-rule)] pb-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-ink)]">Service authorizations</h2>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">Current and prior program periods, utilization, and renewal timing.</p>
        </div>
        {canManage ? (
          programs.length > 0 ? (
            <CreateButton
              label="New authorization"
              title="New program authorization"
              endpoint="/api/program-budgets"
              hidden={{ individualId }}
              fields={<ProgramBudgetFields programs={programs} showInternalRate={showInternalRate} showAgencyRate={showAgencyRate} />}
            />
          ) : (
            hoursOnlyManagement ? (
              <p className="text-sm text-[var(--color-ink-faint)]">No hours-based programs are available.</p>
            ) : (
              <ButtonLink href="/settings#programs" variant="primary">Add a program first</ButtonLink>
            )
          )
        ) : null}
      </div>

      {budgets.length === 0 ? (
        <div className="border-y border-[var(--color-rule)] py-10 text-center">
          <p className="font-semibold text-[var(--color-ink)]">No program authorizations</p>
          <p className="mt-1 text-sm text-[var(--color-ink-faint)]">This individual does not have a visible service allowance yet.</p>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {budgets.map((budget) => {
            const manualUsageAllowed = budget.consumptionSource === "manual" || budget.consumptionSource === "mixed";
            const canManageAuthorization = canManage
              && (!hoursOnlyManagement || budget.requiredAuthType === "hours");
            return (
              <article key={`${budget.budgetPeriodId}:${budget.programId}`} className="overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)]">
                <div className="px-4 py-4 sm:px-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-[var(--color-ink)]">{budget.programName}</h3>
                        <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--color-ink-soft)]">{budget.programCode}</code>
                      </div>
                      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{budget.periodLabel}, revision {budget.revision}</p>
                    </div>
                    <StatusBadge tone={budget.periodStatus === "active" ? "good" : "muted"} label={titleCase(budget.periodStatus)} />
                  </div>

                  <div className="mt-4 grid gap-x-5 gap-y-2 border-t border-[var(--color-rule)] pt-3 text-sm sm:grid-cols-2">
                    <div className="flex items-center gap-2 text-[var(--color-ink-soft)]">
                      <CalendarDays aria-hidden className="h-4 w-4 shrink-0 text-[var(--color-ink-faint)]" />
                      <span className="tnum">{dateLabel(budget.startDate)} - {dateLabel(budget.endDate)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[var(--color-ink-soft)]">
                      <RefreshCcw aria-hidden className="h-4 w-4 shrink-0 text-[var(--color-ink-faint)]" />
                      <span className={budget.renewalDate ? "" : "font-semibold text-[var(--color-danger)]"}>
                        {budget.renewalDate ? `Renews ${dateLabel(budget.renewalDate)}` : "Renewal date missing"}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 space-y-4">
                    <HoursMetrics budget={budget} />
                    <DollarMetrics budget={budget} />
                  </div>

                  {budget.hasUndatedUsage ? (
                    <div
                      className="mt-4 flex items-start gap-2 border-l-2 border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-ink-soft)]"
                      role="status"
                    >
                      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warn)]" />
                      {budget.undatedUsageCount === null ? (
                        <p>Some imported usage needs a service date before it can count toward this authorization.</p>
                      ) : (
                        <p>
                          <span className="tnum font-semibold text-[var(--color-ink)]">{budget.undatedUsageCount}</span>{" "}
                          payroll {budget.undatedUsageCount === 1 ? "row needs" : "rows need"} a service date before {budget.undatedUsageCount === 1 ? "it" : "they"} can count toward this authorization.
                        </p>
                      )}
                    </div>
                  ) : null}

                  {budget.authorizedHours !== null && (
                    (showAgencyRate && budget.agencyRate !== null)
                    || (showInternalRate && budget.internalRate !== null)
                  ) ? (
                    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--color-ink-faint)]">
                      {showAgencyRate && budget.agencyRate !== null ? (
                        <p>Funder / agency rate <span className="tnum font-semibold text-[var(--color-ink-soft)]">{formatMoney(budget.agencyRate)}/hr</span></p>
                      ) : null}
                      {showInternalRate && budget.internalRate !== null ? (
                        <p>
                          Employee / internal rate <span className="tnum font-semibold text-[var(--color-ink-soft)]">{formatMoney(budget.internalRate)}/hr</span>
                          {budget.individualRateOverride !== null ? <span className="ml-1">Individual override</span> : null}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {canManageAuthorization && budget.periodStatus === "active" && budget.programCode !== "CLASSES" ? (
                    <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--color-rule)] pt-3">
                      <CreateButton
                        label="Revise"
                        title={`Revise authorization - ${budget.programName}`}
                        endpoint={`/api/authorizations/${budget.authorizationId}`}
                        method="PATCH"
                        size="sm"
                        variant="secondary"
                        fields={(
                          <AuthorizationRevisionFields
                            budget={budget}
                            showAgencyRate={showAgencyRate}
                            showInternalRate={showInternalRate}
                          />
                        )}
                      />
                      {budget.canManageRenewal ? <CreateButton
                        label={budget.renewalDate ? "Change renewal" : "Set renewal"}
                        title={`${budget.renewalDate ? "Change" : "Set"} renewal - ${budget.programName}`}
                        endpoint={`/api/budget-periods/${budget.budgetPeriodId}`}
                        method="PATCH"
                        size="sm"
                        variant={budget.renewalDate ? "secondary" : "primary"}
                        fields={(
                          <>
                            <Field label="Renewal date" name="renewalDate" type="date" defaultValue={budget.renewalDate ?? ""} required />
                            <TextAreaField label="Change reason" name="reason" required minLength={5} />
                          </>
                        )}
                      /> : null}
                      {!hoursOnlyManagement && manualUsageAllowed ? (
                        <CreateButton
                          label="Record usage"
                          title={`Record usage - ${budget.programName}`}
                          endpoint="/api/program-budget-events"
                          size="sm"
                          variant="secondary"
                          hidden={{
                            budgetPeriodId: budget.budgetPeriodId,
                            programId: budget.programId,
                            sourceType: "manual",
                            sourceId: `manual-${randomUUID()}`,
                          }}
                          fields={<EventFields budget={budget} eventType="consume" />}
                        />
                      ) : null}
                      {!hoursOnlyManagement ? <CreateButton
                        label="Add adjustment"
                        title={`Adjust balance - ${budget.programName}`}
                        endpoint="/api/program-budget-events"
                        size="sm"
                        variant="secondary"
                        hidden={{
                          budgetPeriodId: budget.budgetPeriodId,
                          programId: budget.programId,
                          sourceType: "manual",
                          sourceId: `manual-${randomUUID()}`,
                        }}
                        fields={<EventFields budget={budget} eventType="adjust" />}
                      /> : null}
                      <ActionButton
                        label="Cancel authorization"
                        endpoint={`/api/authorizations/${budget.authorizationId}`}
                        body={{ action: "cancel" }}
                        withReason
                        variant="danger"
                      />
                    </div>
                  ) : null}
                </div>
                <MonthlyHistory months={budget.monthlyHistory} isGroupService={budget.isGroupService} />
                <AuthorizationHistory budget={budget} />
                {budget.showEventHistory ? <EventHistory budget={budget} canManage={!hoursOnlyManagement && canManageAuthorization && budget.programCode !== "CLASSES"} /> : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
