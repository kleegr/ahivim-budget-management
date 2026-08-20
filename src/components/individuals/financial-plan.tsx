import { dec, formatHours, formatMoney } from "@/lib/money";
import type { BudgetLine } from "@/lib/data/queries";
import CutsEditor from "@/components/individuals/cuts-editor";

/**
 * The financial plan, now projected-vs-actual. The PROJECTED side is the budget
 * priced out — authorized hours × rate, then the two cuts to a net — and it does
 * not move. The ACTUAL side values the hours actually billed so far at the same
 * rates, so you can see, in both the agency (billed-out) and company (internal)
 * currencies: what the year should be, what should have been billed by now, what
 * actually has been, how far off that is, and what's left to bill over the months
 * remaining. "How much are we off" is the whole point.
 */

type Strat = {
  cut1Percent: string;
  cut2Percent: string;
  monthDivisor: string;
  net: string; // projected net per month (internal), from the full calc incl. adjustments
  monthlyGross: string;
  clockAdjustment: string;
  otherAdjustment: string;
  afterAll: string | null;
};

export default function FinancialPlan({
  strategyId,
  lines,
  strategy,
  timeElapsedPercent,
  monthsToRenewal,
  canManage,
}: {
  strategyId: string | null;
  lines: BudgetLine[];
  strategy: Strat;
  timeElapsedPercent: number | null;
  monthsToRenewal: number | null;
  canManage: boolean;
}) {
  const plan = lines.filter((l) => l.inPlan);
  const sum = (f: (l: BudgetLine) => ReturnType<typeof dec>) => plan.reduce((s, l) => s.plus(f(l)), dec(0));
  const agencyRate = (l: BudgetLine) => dec(l.perHourAgency ?? l.perHour); // self-hire has no agency rate

  // Gross = hours × rate, valued the same way for projected and actual so the
  // variance is a clean rate×hour gap. Two currencies: company (internal) + agency.
  const annualInt = sum((l) => dec(l.authorizedHours).times(dec(l.perHour)));
  const annualAg = sum((l) => dec(l.authorizedHours).times(agencyRate(l)));
  const actualInt = sum((l) => dec(l.usedHours).times(dec(l.perHour)));
  const actualAg = sum((l) => dec(l.usedHours).times(agencyRate(l)));

  const elapsed = timeElapsedPercent === null ? null : Math.max(0, Math.min(1, timeElapsedPercent / 100));
  const expInt = elapsed === null ? null : annualInt.times(elapsed);
  const expAg = elapsed === null ? null : annualAg.times(elapsed);
  const varInt = expInt === null ? null : actualInt.minus(expInt);
  const varAg = expAg === null ? null : actualAg.minus(expAg);
  const remInt = annualInt.minus(actualInt);
  const remAg = annualAg.minus(actualAg);

  const remHours = sum((l) => dec(l.authorizedHours).minus(dec(l.usedHours)));
  // Only express a MONTHLY pace when at least a month remains; under a month,
  // dividing by a fraction inflates the rate above what's actually left, which
  // reads as nonsense (the takeaway then just states the hours left to bill).
  const months = monthsToRenewal && monthsToRenewal >= 1 ? monthsToRenewal : null;
  const perMoHours = months && remHours.greaterThan(0) ? remHours.dividedBy(months) : null;
  const perMoInt = months && remInt.greaterThan(0) ? remInt.dividedBy(months) : null;
  const perMoAg = months && remAg.greaterThan(0) ? remAg.dividedBy(months) : null;

  const money = (d: ReturnType<typeof dec>) => formatMoney(d.toString());
  const signed = (d: ReturnType<typeof dec> | null) =>
    d === null ? "—" : `${d.isNegative() ? "−" : "+"}${formatMoney(d.abs().toString())}`;
  const varColor = (d: ReturnType<typeof dec> | null) =>
    d === null ? undefined : d.isNegative() ? "var(--color-danger)" : "var(--color-success)";

  const elapsedLabel = elapsed === null ? "" : `${Math.round(elapsed * 100)}% of the year in`;

  // Projected net per month (the fixed pricing model, incl. adjustments) and a
  // realistic net if the year lands where billing is currently paced.
  const projNet = dec(strategy.net);
  const realizedRatio = annualInt.greaterThan(0) ? actualInt.dividedBy(annualInt) : dec(0);
  const projAnnualNet = projNet.times(dec(strategy.monthDivisor));
  const realizedAnnualNet = projAnnualNet.times(realizedRatio); // net scales with how much of the plan is billed

  const Row = ({ label, hint, company, agency, bold, color }: { label: string; hint?: string; company: React.ReactNode; agency: React.ReactNode; bold?: boolean; color?: string }) => (
    <div className={`grid grid-cols-[1fr_auto_auto] items-baseline gap-x-6 border-b border-[var(--color-rule)] py-1.5 last:border-0 ${bold ? "font-semibold" : ""}`}>
      <div>
        <span>{label}</span>
        {hint ? <span className="ml-2 text-xs font-normal text-[var(--color-ink-faint)]">{hint}</span> : null}
      </div>
      <span className="tnum w-28 text-right" style={{ color }}>{company}</span>
      <span className="tnum w-28 text-right" style={{ color }}>{agency}</span>
    </div>
  );

  return (
    <div className="space-y-5 px-5 py-4 text-sm">
      {/* Projected vs actual — the pace, both currencies */}
      <div>
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-6 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-soft)]">
          <span>Projected vs. actual</span>
          <span className="w-28 text-right">Company</span>
          <span className="w-28 text-right">Agency</span>
        </div>
        <Row label="Plan for the year" hint="authorized × rate" company={money(annualInt)} agency={money(annualAg)} />
        <Row label="Should be billed by now" hint={elapsedLabel} company={expInt === null ? "—" : money(expInt)} agency={expAg === null ? "—" : money(expAg)} />
        <Row label="Actually billed so far" company={money(actualInt)} agency={money(actualAg)} />
        <Row label="Off (ahead / behind)" company={signed(varInt)} agency={signed(varAg)} color={varColor(varInt)} bold />
        <Row label="Left to bill" hint="rest of the year" company={money(remInt)} agency={money(remAg)} />
      </div>

      {/* The plain-language takeaway */}
      <p className="rounded-lg bg-[var(--color-surface-muted)] px-3 py-2.5 text-sm text-[var(--color-ink-soft)]">
        {remHours.greaterThan(0) ? (
          <>
            <span className="font-medium text-[var(--color-ink)]">{formatHours(remHours.toString())} hours</span> left to bill
            {months ? <> over about <span className="font-medium text-[var(--color-ink)]">{months.toFixed(1)} months</span></> : null}
            {perMoHours ? (
              <> — roughly <span className="font-medium text-[var(--color-ink)]">{formatHours(perMoHours.toString())} h/month</span>
                {perMoInt ? <> (≈ {money(perMoInt)} company{perMoAg ? <> · {money(perMoAg)} agency</> : null} a month)</> : null}.
              </>
            ) : "."}
            {varInt && varInt.isNegative() ? (
              <> You&rsquo;re <span className="font-medium text-[var(--color-danger)]">{money(varInt.abs())}</span> behind the even pace so far.</>
            ) : varInt && varInt.greaterThan(0) ? (
              <> You&rsquo;re <span className="font-medium text-[var(--color-success)]">{money(varInt)}</span> ahead of the even pace.</>
            ) : null}
          </>
        ) : (
          <>The plan is fully billed for the year — nothing left to bill.</>
        )}
      </p>

      {/* How it's priced — cuts editable inline, the same as the budget. The cuts
          always apply to the budget (the plan), never to the transactions. */}
      <CutsEditor
        strategyId={strategyId}
        yearlyGross={annualInt.toString()}
        cut1Percent={strategy.cut1Percent}
        cut2Percent={strategy.cut2Percent}
        monthDivisor={strategy.monthDivisor}
        clockAdjustment={strategy.clockAdjustment}
        otherAdjustment={strategy.otherAdjustment}
        afterAll={strategy.afterAll}
        canManage={canManage}
      />
      <p className="text-xs text-[var(--color-ink-soft)]">
        The cuts apply to the budget (the plan), not the transactions. If billing lands where it is now ({Math.round(realizedRatio.times(100).toNumber())}% of plan), the net would come to about{" "}
        <span className="tnum font-medium text-[var(--color-ink)]">{money(realizedAnnualNet)}</span> for the year vs. the projected {money(projAnnualNet)}.
      </p>
    </div>
  );
}
