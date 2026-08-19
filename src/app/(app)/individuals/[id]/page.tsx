import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { withDb } from "@/lib/data/pool";
import { getIndividualBudgetView, getIndividualPeriodActivity } from "@/lib/data/queries";
import { BUDGET_STATUS_PRESENT, type BudgetLineStatus } from "@/lib/business/budget-status";
import { isUuid } from "@/lib/data/app-queries";
import { getIndividual } from "@/lib/manage/individuals";
import { listStrategies } from "@/lib/manage/calculation-strategies";
import { listAssignments } from "@/lib/manage/assignments";
import { listAliases } from "@/lib/manage/aliases";
import { scheduledByProgramForIndividual } from "@/lib/data/schedule-queries";
import {
  Card, Table, Th, Td, Tr, Money, Hours, ErrorPanel, PageHeader, ButtonLink,
} from "@/components/ui";
import { CreateButton, Field, TextAreaField } from "@/components/manage/client";
import BudgetEditor, { type BudgetEditorLine } from "@/components/individuals/budget-editor";
import { dec, formatHours, formatMoney } from "@/lib/money";
import { txLink } from "@/lib/nav/tx-link";

export const dynamic = "force-dynamic";
export const metadata = { title: "Individual — Ahivim Budget Management" };

/*
  The individual profile, rebuilt to answer one question first: WHERE ARE WE UP
  TO on this person's budget? It leads with a plain-language budget — used vs.
  authorized vs. left, per program, straight from the plan and the real
  transactions — then the money, then everything else folded away so a first-time
  reader is never buried. Authorized hours come from the same plan the Financial
  page uses, so the numbers here can never disagree with any other screen.
*/

function StatusPill({ status }: { status: BudgetLineStatus }) {
  const s = BUDGET_STATUS_PRESENT[status];
  return (
    <span className="badge" style={{ background: s.tint, color: s.color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

/** A used-vs-authorized bar with a marker for how far the period has elapsed. */
function BudgetBar({ usagePercent, elapsedPercent, color }: { usagePercent: number | null; elapsedPercent: number | null; color: string }) {
  const used = usagePercent === null ? 0 : Math.max(0, Math.min(100, usagePercent * 100));
  return (
    <div className="pace-track" role="img" aria-label={`${Math.round(used)}% of hours used`}
      title={elapsedPercent !== null ? `${Math.round(used)}% of hours used · ${Math.round(elapsedPercent)}% of the year elapsed` : `${Math.round(used)}% of hours used`}>
      <div className="pace-fill" style={{ width: `${used}%`, background: color }} />
      {elapsedPercent !== null ? <div className="pace-notch" style={{ left: `${Math.max(0, Math.min(100, elapsedPercent))}%` }} /> : null}
    </div>
  );
}

function renewLine(active: boolean, daysToRenewal: number | null, effectiveRenewal: string | null): string {
  if (!effectiveRenewal) return "No renewal date on file";
  if (!active) return `Inactive · renewal frozen at ${effectiveRenewal}`;
  if (daysToRenewal === null) return `Renews ${effectiveRenewal}`;
  if (daysToRenewal <= 0) return `Renews today (${effectiveRenewal})`;
  return `Renews in ${daysToRenewal} day${daysToRenewal === 1 ? "" : "s"} (${effectiveRenewal})`;
}

export default async function IndividualDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser("viewer");
  const canEdit = user.role !== "viewer";
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const result = await withDb(async (pool) => {
    const individual = await getIndividual(pool, id);
    if (!individual) return null;
    const budget = await getIndividualBudgetView(pool, id);
    // The monthly bars measure budget pace, so they count only the programs the
    // plan authorizes — matching the hero's used/authorized and the ÷12 target.
    const planProgramIds = budget.lines.filter((l) => l.inPlan).map((l) => l.programId);
    const [strategies, assignments, aliasesAll, scheduledByProgram, activity] = await Promise.all([
      listStrategies(pool, { individualId: id, withAnalytics: true }),
      listAssignments(pool, { individualId: id, includeInactive: true }),
      listAliases(pool, { kind: "individual" }),
      scheduledByProgramForIndividual(pool, id),
      getIndividualPeriodActivity(pool, id, budget.periodStart, budget.periodEnd, planProgramIds),
    ]);
    return {
      individual, budget, activity,
      strategy: strategies.rows[0] ?? null,
      programs: strategies.programs, // program list with default per-hour rates, for the editor
      assignments: assignments.filter((a) => a.status === "active"),
      aliases: aliasesAll.filter((a) => a.canonicalId === id),
      scheduled: Object.entries(scheduledByProgram),
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

  const { individual, budget, activity, strategy, programs, assignments, aliases, scheduled } = result.data;
  const t = budget.totals;
  const headline = budget.headline ? BUDGET_STATUS_PRESENT[budget.headline] : null;

  // Months left until the (rolled) renewal, for "bill X h/month to finish".
  const monthsToRenewal = budget.daysToRenewal !== null && budget.daysToRenewal > 0 ? budget.daysToRenewal / 30.4375 : null;
  const remaining = dec(t.remainingHours);
  const perMonthToFinish = monthsToRenewal && remaining.greaterThan(0) ? remaining.dividedBy(monthsToRenewal) : null;

  const editorLines: BudgetEditorLine[] = budget.lines.map((l) => ({
    programId: l.programId,
    programName: l.programName,
    perHour: l.perHour,
    authorizedHours: l.authorizedHours,
    usedHours: l.usedHours,
    inPlan: l.inPlan,
  }));
  const editorPrograms = programs.map((p) => ({ id: p.id, code: p.code, name: p.name, defaultRate: p.internalRate }));

  /* ---- header action: edit the person's name/notes. Active/inactive is a
     switch inside the budget below, not an outside button. ---- */
  const headerActions = canEdit ? (
    <CreateButton
      label="Edit name"
      title="Edit individual"
      endpoint={`/api/individuals/${id}`}
      method="PATCH"
      variant="secondary"
      fields={
        <>
          <Field label="Display name" name="displayName" defaultValue={individual.displayName} required />
          <Field label="Preferred name" name="preferredName" defaultValue={individual.preferredName} />
          <Field label="Legal name" name="legalName" defaultValue={individual.legalName} />
          <TextAreaField label="Notes" name="notes" defaultValue={individual.notes} />
        </>
      }
    />
  ) : (
    <ButtonLink href="/individuals">All individuals</ButtonLink>
  );

  return (
    <>
      <PageHeader eyebrow="Individual" title={individual.displayName} action={headerActions} />

      {/* ---- The one-glance answer: where are we up to? ---- */}
      {budget.hasPlan ? (
        <section className="card fade-in-up mb-6 px-5 py-5" style={{ borderTop: `3px solid ${headline?.color ?? "var(--color-primary)"}` }}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="eyebrow">Budget this period</p>
              <p className="mt-1 text-2xl font-semibold leading-tight">
                Used <span className="tnum">{formatHours(t.usedHours)}</span> of <span className="tnum">{formatHours(t.authorizedHours)}</span> hours
              </p>
              <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                <span className="tnum font-medium" style={{ color: dec(t.remainingHours).isNegative() ? "var(--color-pace-over)" : "var(--color-ink)" }}>
                  {formatHours(t.remainingHours)} h {dec(t.remainingHours).isNegative() ? "over" : "left"}
                </span>
                {" · "}{renewLine(budget.active, budget.daysToRenewal, budget.effectiveRenewal)}
              </p>
              {perMonthToFinish ? (
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                  To use it all by renewal, bill <span className="tnum font-semibold text-[var(--color-ink)]">{formatHours(perMonthToFinish.toString())} h/month</span> from now.
                </p>
              ) : null}
            </div>
            {headline ? <StatusPill status={budget.headline!} /> : null}
          </div>
          <div className="mt-4 max-w-xl">
            <BudgetBar usagePercent={t.usagePercent} elapsedPercent={budget.timeElapsedPercent} color={headline?.color ?? "var(--color-pace-on)"} />
            <p className="mt-1.5 text-xs text-[var(--color-ink-faint)]">
              The bar is hours used; the notch is how far the year has gone. Fill past the notch = using faster than time; short of it = slower.
            </p>
          </div>
        </section>
      ) : (
        <section className="card mb-6 px-5 py-5">
          <p className="eyebrow">Budget</p>
          <p className="mt-1 text-lg font-semibold">No budget set yet</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            {canEdit
              ? "Add this person's programs, hours and renewal date in the budget below — it's all editable right here."
              : "Once this person has a budget, this is where you'll see used vs. left for every program."}
            {budget.money.txCount > 0 ? ` They already have ${budget.money.txCount.toLocaleString()} billed transactions on file.` : ""}
          </p>
        </section>
      )}

      {/* ---- Budget by program — editable inline, shaped like the rollover sheet ---- */}
      {budget.lines.length > 0 || canEdit ? (
        <BudgetEditor
          individualId={id}
          strategyId={budget.strategyId}
          active={budget.active}
          renewalDate={budget.renewalDate}
          effectiveRenewal={budget.effectiveRenewal}
          monthsToRenewal={monthsToRenewal}
          periodStart={budget.periodStart}
          periodEnd={budget.periodEnd}
          lines={editorLines}
          programs={editorPrograms}
          canEdit={canEdit}
        />
      ) : null}

      {/* ---- Money billed this period (this budget year only) ---- */}
      {budget.money.txCount > 0 ? (
        <Card title="Money billed this period" description="This budget year only — not the whole history." className="mb-6"
          action={<ButtonLink href={txLink({ individualId: id, pbFrom: budget.periodStart ?? undefined, pbTo: budget.periodEnd ?? undefined })} variant="secondary">See these rows →</ButtonLink>}>
          <div className="grid gap-3 px-5 py-4 sm:grid-cols-3">
            <MoneyTile label="Agency total (billed)" value={formatMoney(budget.money.agencyBilled)} />
            <MoneyTile label="Employee amount" value={formatMoney(budget.money.internalBilled)} />
            <MoneyTile label="Transactions" value={budget.money.txCount.toLocaleString()} plain />
          </div>
        </Card>
      ) : null}

      {/* ---- Billed this period, by month: plan vs actual ---- */}
      {budget.hasPlan && budget.periodStart && activity.byMonth.length > 0 ? (
        <Card
          title="Billed by month"
          description="Hours billed each month on the budgeted program(s) this renewal year, against the even monthly target (authorized ÷ 12). See where you're ahead or behind."
          className="mb-6"
        >
          <MonthlyBilling periodStart={budget.periodStart} byMonth={activity.byMonth} authorizedTotal={t.authorizedHours} />
        </Card>
      ) : null}

      {/* ---- Employees working with this individual, this period, auto-filtered ---- */}
      {activity.byEmployee.length > 0 ? (
        <Card
          title="Employees working with this individual"
          description="Who did the work this budget year. Click a name to open that person's rows for this individual."
          className="mb-6"
          action={<ButtonLink href={txLink({ individualId: id, pbFrom: budget.periodStart ?? undefined, pbTo: budget.periodEnd ?? undefined })} variant="secondary">All rows →</ButtonLink>}
        >
          <Table head={<><Th>Employee</Th><Th numeric>Hours</Th><Th numeric>Agency total</Th><Th numeric>Transactions</Th><Th>Open</Th></>}>
            {activity.byEmployee.map((e) => (
              <Tr key={e.id ?? e.name}>
                <Td>
                  {e.id ? (
                    <Link className="font-medium text-[var(--color-primary)] hover:underline" href={`/employees/${e.id}`}>{e.name}</Link>
                  ) : (
                    e.name
                  )}
                </Td>
                <Td numeric><Hours value={e.hours} /></Td>
                <Td numeric><Money value={e.agency} /></Td>
                <Td numeric className="tnum">{e.txCount}</Td>
                <Td>
                  <Link className="text-xs text-[var(--color-primary)] hover:underline" href={txLink({ individualId: id, employeeId: e.id ?? undefined, pbFrom: budget.periodStart ?? undefined, pbTo: budget.periodEnd ?? undefined })}>rows →</Link>
                </Td>
              </Tr>
            ))}
          </Table>
        </Card>
      ) : null}

      {/* ---- Financial plan (the cuts → net money model), only if present ---- */}
      {strategy ? (
        <Card
          title="Financial plan"
          description="How this account's money is worked out: the budget above valued at the per-hour rate, taken to a month, then the two cuts and any adjustments — ending at the net."
          action={canEdit ? <ButtonLink href={`/calculations?individualId=${id}`} variant="secondary">Adjust cuts →</ButtonLink> : undefined}
          className="mb-6"
        >
          <div className="px-5 py-4 text-sm">
            <FinLine label="Yearly gross" value={<Money value={strategy.yearlyGross} />} sub="authorized hours × internal rate" />
            <FinLine label="Monthly gross" value={<Money value={strategy.monthlyGross} />} sub={`÷ ${dec(strategy.monthDivisor).toDecimalPlaces(2)} months`} />
            <FinLine label={`First cut (${pct(strategy.cut1Percent)})`} value={<span className="text-[var(--color-danger)]">− <Money value={dec(strategy.monthlyGross).times(dec(strategy.cut1Percent)).toString()} /></span>} />
            <FinLine label={`Second cut (${pct(strategy.cut2Percent)})`} value={<span className="text-[var(--color-danger)]">− <Money value={dec(strategy.monthlyGross).minus(dec(strategy.monthlyGross).times(dec(strategy.cut1Percent))).times(dec(strategy.cut2Percent)).toString()} /></span>} sub="from the balance after the first cut" />
            <FinLine label="Net per month" value={<Money value={strategy.net} />} strong />
            {strategy.afterAll ? <FinLine label="Final (“after all”)" value={<Money value={strategy.afterAll} />} strong sub="the workbook's final figure" /> : null}
          </div>
        </Card>
      ) : null}

      {/* ---- Everything else, folded away and only if it has content ---- */}
      <MoreDetails
        assignments={assignments}
        aliases={aliases}
        scheduled={scheduled}
        notes={individual.notes}
      />

      <p className="mt-6 text-xs text-[var(--color-ink-faint)]">
        Used hours are the real billed transactions inside this renewal year, so every number here matches the Transactions grid and the Financial page.
      </p>
    </>
  );
}

/* ---------------------------------------------------------------- pieces */

function MoneyTile({ label, value, plain }: { label: string; value: string; plain?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-3 py-2.5">
      <p className="eyebrow text-[var(--color-text-soft)]">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${plain ? "" : "tnum"}`}>{value}</p>
    </div>
  );
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Plan vs. actual by month: each bar is hours billed that month; the notch is
    the even monthly target (authorized ÷ 12), so ahead/behind reads at a glance. */
function MonthlyBilling({ periodStart, byMonth, authorizedTotal }: { periodStart: string; byMonth: { month: string; hours: string }[]; authorizedTotal: string }) {
  const target = dec(authorizedTotal).dividedBy(12);
  const targetNum = target.toNumber();
  const billedMap = new Map(byMonth.map((m) => [m.month, dec(m.hours).toNumber()]));
  const [sy, sm] = periodStart.slice(0, 7).split("-").map(Number);
  const now = new Date();
  const todayYm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const cells: { ym: string; label: string; billed: number; future: boolean }[] = [];
  for (let i = 0; i < 12; i++) {
    const idx = (sm as number) - 1 + i;
    const y = (sy as number) + Math.floor(idx / 12);
    const mo = idx % 12;
    const ym = `${y}-${String(mo + 1).padStart(2, "0")}`;
    cells.push({ ym, label: `${MONTHS_SHORT[mo]} '${String(y).slice(2)}`, billed: billedMap.get(ym) ?? 0, future: ym > todayYm });
  }
  const scale = Math.max(targetNum * 1.6, ...cells.map((c) => c.billed), 1);
  return (
    <div className="px-5 py-4">
      <p className="mb-3 text-xs text-[var(--color-ink-faint)]">
        Even monthly target: <span className="tnum font-medium text-[var(--color-ink-soft)]">{formatHours(target.toString())} h/month</span>. The notch is the target; green means that month met it, amber is below, grey is upcoming.
      </p>
      <div className="space-y-1.5">
        {cells.map((c) => {
          const fill = Math.max(0, Math.min(100, (c.billed / scale) * 100));
          const notch = Math.max(0, Math.min(100, (targetNum / scale) * 100));
          const color = c.future ? "var(--color-pace-idle)" : c.billed >= targetNum ? "var(--color-pace-on)" : "var(--color-pace-ahead)";
          return (
            <div key={c.ym} className="flex items-center gap-3">
              <span className="tnum w-14 shrink-0 text-xs text-[var(--color-ink-faint)]">{c.label}</span>
              <div className="pace-track flex-1">
                <div className="pace-fill" style={{ width: `${fill}%`, background: color }} />
                <div className="pace-notch" style={{ left: `${notch}%` }} />
              </div>
              <span className="tnum w-24 shrink-0 text-right text-xs">
                {c.future ? <span className="text-[var(--color-ink-faint)]">upcoming</span> : <><span className="font-medium">{formatHours(String(c.billed))}</span> h</>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function pct(fraction: string): string {
  return `${dec(fraction).times(100).toDecimalPlaces(2)}%`;
}

function FinLine({ label, value, sub, strong }: { label: string; value: React.ReactNode; sub?: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--color-rule)] py-1.5 last:border-0">
      <div>
        <span className={strong ? "font-semibold" : ""}>{label}</span>
        {sub ? <span className="ml-2 text-xs text-[var(--color-ink-faint)]">{sub}</span> : null}
      </div>
      <span className={`tnum ${strong ? "text-base font-semibold" : ""}`}>{value}</span>
    </div>
  );
}

/* Everything advanced, collapsed by default and hidden entirely when empty. */
function MoreDetails({
  assignments, aliases, scheduled, notes,
}: {
  assignments: Awaited<ReturnType<typeof listAssignments>>;
  aliases: { id: string; importedName: string; status: string }[];
  scheduled: [string, { hours: string; internal: string }][];
  notes: string | null;
}) {
  const hasAnything = assignments.length > 0 || scheduled.length > 0 || aliases.length > 0 || !!notes;
  if (!hasAnything) return null;
  return (
    <details className="card px-5 py-4">
      <summary className="cursor-pointer text-sm font-semibold text-[var(--color-ink)]">More details</summary>
      <div className="mt-4 space-y-6">
        {assignments.length > 0 ? (
          <div>
            <p className="eyebrow mb-2">Assigned employees</p>
            <Table head={<><Th>Employee</Th><Th>Program</Th><Th numeric>Allowed hours</Th></>}>
              {assignments.map((a) => (
                <Tr key={a.id}>
                  <Td><Link className="font-medium text-[var(--color-primary)] hover:underline" href={`/employees/${a.employeeId}`}>{a.employeeName}</Link></Td>
                  <Td>{a.programName ?? "Any"}</Td>
                  <Td numeric>{a.allowedHours ? <Hours value={a.allowedHours} /> : "—"}</Td>
                </Tr>
              ))}
            </Table>
          </div>
        ) : null}

        {scheduled.length > 0 ? (
          <div>
            <p className="eyebrow mb-2">Scheduled, not yet billed</p>
            <Table head={<><Th>Program</Th><Th numeric>Hours</Th><Th numeric>Expected</Th></>}>
              {scheduled.map(([code, sc]) => (
                <Tr key={code}><Td>{code}</Td><Td numeric><Hours value={sc.hours} /></Td><Td numeric><Money value={sc.internal} /></Td></Tr>
              ))}
            </Table>
          </div>
        ) : null}

        {aliases.length > 0 ? (
          <div>
            <p className="eyebrow mb-2">Known spellings</p>
            <p className="text-sm text-[var(--color-ink-soft)]">{aliases.map((a) => a.importedName).join(", ")}</p>
          </div>
        ) : null}

        {notes ? (
          <div>
            <p className="eyebrow mb-2">Notes</p>
            <p className="whitespace-pre-wrap text-sm">{notes}</p>
          </div>
        ) : null}
      </div>
    </details>
  );
}
