import { dec, formatHours, formatMoney } from "@/lib/money";
import type { PeriodProgramMonth, PeriodProgram } from "@/lib/data/queries";
import { isGroupSessionProgram } from "@/lib/business/calculation-strategy";

/**
 * Billed by month, ITEMIZED BY PROGRAM. Hours can't be added across programs
 * (each bills at a different rate), so each program is its own column in hours
 * and the month totals are in dollars — both the agency (billed-out) amount and
 * the company (internal) amount, side by side. A thin bar on the billed column
 * keeps the month-by-month pace the sheet is loved for.
 */

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_COLS = 5; // programs shown as their own column; the rest fold into "Other"

export default function BilledByMonth({
  periodStart,
  byProgramMonth,
  programsBilled,
  canSeeHours = true,
  canSeeBilledAmounts = true,
  canSeeEmployeeAmounts = true,
}: {
  periodStart: string;
  byProgramMonth: PeriodProgramMonth[];
  programsBilled: PeriodProgram[];
  canSeeHours?: boolean;
  canSeeBilledAmounts?: boolean;
  canSeeEmployeeAmounts?: boolean;
}) {
  // Column set: the biggest programs get their own column; anything past MAX_COLS
  // folds into a single "Other" column so the table never sprawls.
  const named = programsBilled.slice(0, MAX_COLS);
  const namedIds = new Set(named.map((p) => p.id ?? p.name));
  const hasOther = programsBilled.length > named.length;
  // Any group-session program on screen gets a footnote explaining its hours are
  // derived from the money (they bill a combined rate, so raw hours aren't real).
  const hasGroup = programsBilled.some((p) => isGroupSessionProgram(p.code));

  const key = (id: string | null, name: string) => id ?? `raw:${name}`;
  // month -> columnKey -> hours ; month -> {agency, internal}
  const cell = new Map<string, Map<string, ReturnType<typeof dec>>>();
  const monthMoney = new Map<string, { agency: ReturnType<typeof dec>; internal: ReturnType<typeof dec> }>();
  for (const r of byProgramMonth) {
    const col = namedIds.has(r.programId ?? r.programName) ? key(r.programId, r.programName) : "__other__";
    const m = cell.get(r.month) ?? new Map();
    m.set(col, (m.get(col) ?? dec(0)).plus(dec(r.hours)));
    cell.set(r.month, m);
    const mm = monthMoney.get(r.month) ?? { agency: dec(0), internal: dec(0) };
    mm.agency = mm.agency.plus(dec(r.agency));
    mm.internal = mm.internal.plus(dec(r.internal));
    monthMoney.set(r.month, mm);
  }

  // Build the 12 month rows from the period start.
  const [sy, sm] = periodStart.slice(0, 7).split("-").map(Number);
  const now = new Date();
  const todayYm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const cols = [
    ...named.map((p) => ({ id: key(p.id, p.name), label: p.name })),
    ...(hasOther ? [{ id: "__other__", label: "Other" }] : []),
  ];
  const visibleCols = canSeeHours ? cols : [];
  const months: { ym: string; label: string; future: boolean }[] = [];
  for (let i = 0; i < 12; i++) {
    const idx = (sm as number) - 1 + i;
    const y = (sy as number) + Math.floor(idx / 12);
    const mo = idx % 12;
    const ym = `${y}-${String(mo + 1).padStart(2, "0")}`;
    months.push({ ym, label: `${MONTHS_SHORT[mo]} '${String(y).slice(2)}`, future: ym > todayYm });
  }

  const maxAgency = Math.max(1, ...months.map((m) => (monthMoney.get(m.ym)?.agency ?? dec(0)).toNumber()));
  const colTotalH = new Map<string, ReturnType<typeof dec>>();
  let totAgency = dec(0), totInternal = dec(0);
  for (const m of months) {
    const mm = monthMoney.get(m.ym);
    if (mm) { totAgency = totAgency.plus(mm.agency); totInternal = totInternal.plus(mm.internal); }
    for (const c of visibleCols) {
      const h = cell.get(m.ym)?.get(c.id) ?? dec(0);
      colTotalH.set(c.id, (colTotalH.get(c.id) ?? dec(0)).plus(h));
    }
  }

  return (
    <div className="overflow-x-auto px-5 py-4">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-[var(--color-text-soft)]">
            <th className="py-2 pr-3 font-medium">Month</th>
            {visibleCols.map((c) => (
              <th key={c.id} className="px-2 py-2 text-right font-medium" title={`${c.label} — hours billed`}>{c.label}<span className="ml-0.5 text-[0.7rem] font-normal text-[var(--color-ink-faint)]">h</span></th>
            ))}
            {canSeeBilledAmounts ? <th className="px-2 py-2 text-right font-medium" title="Agency amount billed (what was invoiced)">Billed $</th> : null}
            {canSeeEmployeeAmounts ? <th className="py-2 pl-2 text-right font-medium" title="Company/internal amount">Company $</th> : null}
          </tr>
        </thead>
        <tbody>
          {months.map((m) => {
            const mm = monthMoney.get(m.ym);
            const agency = mm?.agency ?? dec(0);
            const fill = Math.max(0, Math.min(100, (agency.toNumber() / maxAgency) * 100));
            const anyBilled = agency.greaterThan(0);
            return (
              <tr key={m.ym} className="border-t border-[var(--color-rule)]">
                <td className="py-1.5 pr-3 text-[var(--color-ink-soft)]">{m.label}</td>
                {visibleCols.map((c) => {
                  const h = cell.get(m.ym)?.get(c.id);
                  return (
                    <td key={c.id} className="tnum px-2 py-1.5 text-right">
                      {h && h.greaterThan(0) ? formatHours(h.toString()) : <span className="text-[var(--color-ink-faint)]">·</span>}
                    </td>
                  );
                })}
                {canSeeBilledAmounts ? (
                  <td className="px-2 py-1.5 text-right">
                    {anyBilled ? (
                      <div className="flex items-center justify-end gap-2">
                        <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-[var(--color-surface-strong)] sm:block" aria-hidden>
                          <div className="h-full rounded-full" style={{ width: `${fill}%`, background: "var(--color-primary)" }} />
                        </div>
                        <span className="tnum font-medium">{formatMoney(agency.toString())}</span>
                      </div>
                    ) : (
                      <span className="text-[var(--color-ink-faint)]">{m.future ? "upcoming" : "—"}</span>
                    )}
                  </td>
                ) : null}
                {canSeeEmployeeAmounts ? <td className="tnum py-1.5 pl-2 text-right text-[var(--color-ink-soft)]">{mm ? formatMoney(mm.internal.toString()) : ""}</td> : null}
              </tr>
            );
          })}
          <tr className="border-t-2 border-[var(--color-rule-strong)] font-semibold">
            <td className="py-2 pr-3">Total</td>
            {visibleCols.map((c) => (
              <td key={c.id} className="tnum px-2 py-2 text-right text-xs font-normal text-[var(--color-ink-faint)]">{formatHours((colTotalH.get(c.id) ?? dec(0)).toString())} h</td>
            ))}
            {canSeeBilledAmounts ? <td className="tnum px-2 py-2 text-right">{formatMoney(totAgency.toString())}</td> : null}
            {canSeeEmployeeAmounts ? <td className="tnum py-2 pl-2 text-right">{formatMoney(totInternal.toString())}</td> : null}
          </tr>
        </tbody>
      </table>
      {canSeeHours && hasGroup ? (
        <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
          Day Hab and Supplemental are group sessions billed at a combined rate, so their hours are figured from the money at your budget rate (amount ÷ rate), not the raw session hours.
        </p>
      ) : null}
    </div>
  );
}
