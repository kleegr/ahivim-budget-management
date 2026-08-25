import { dec, formatHours, formatMoney } from "@/lib/money";
import type { BillingHistoryPeriod } from "@/lib/data/queries";
import { isGroupSessionProgram } from "@/lib/business/calculation-strategy";

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_COLS = 5;

function shortDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return `${MONTHS_SHORT[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

function PeriodTable({
  period,
  canSeeHours,
  canSeeBilledAmounts,
  canSeeEmployeeAmounts,
  canSeeTransactions,
}: {
  period: BillingHistoryPeriod;
  canSeeHours: boolean;
  canSeeBilledAmounts: boolean;
  canSeeEmployeeAmounts: boolean;
  canSeeTransactions: boolean;
}) {
  const named = period.programs.slice(0, MAX_COLS);
  const namedIds = new Set(named.map((program) => program.id ?? program.name));
  const hasOther = period.programs.length > named.length;
  const hasGroup = period.programs.some((program) => isGroupSessionProgram(program.code));
  const key = (id: string | null, name: string) => id ?? `raw:${name}`;

  const cell = new Map<string, Map<string, ReturnType<typeof dec>>>();
  const monthMoney = new Map<string, { agency: ReturnType<typeof dec>; internal: ReturnType<typeof dec> }>();
  for (const row of period.byProgramMonth) {
    const column = namedIds.has(row.programId ?? row.programName) ? key(row.programId, row.programName) : "__other__";
    const month = cell.get(row.month) ?? new Map();
    month.set(column, (month.get(column) ?? dec(0)).plus(dec(row.hours)));
    cell.set(row.month, month);
    const money = monthMoney.get(row.month) ?? { agency: dec(0), internal: dec(0) };
    money.agency = money.agency.plus(dec(row.agency));
    money.internal = money.internal.plus(dec(row.internal));
    monthMoney.set(row.month, money);
  }

  const [startYear, startMonth] = period.start.slice(0, 7).split("-").map(Number);
  const now = new Date();
  const todayYm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const columns = [
    ...named.map((program) => ({ id: key(program.id, program.name), label: program.name })),
    ...(hasOther ? [{ id: "__other__", label: "Other" }] : []),
  ];
  const visibleColumns = canSeeHours ? columns : [];
  const months: { ym: string; label: string; future: boolean }[] = [];
  for (let index = 0; index < 12; index++) {
    const monthIndex = (startMonth as number) - 1 + index;
    const year = (startYear as number) + Math.floor(monthIndex / 12);
    const month = monthIndex % 12;
    const ym = `${year}-${String(month + 1).padStart(2, "0")}`;
    months.push({ ym, label: `${MONTHS_SHORT[month]} '${String(year).slice(2)}`, future: ym > todayYm });
  }

  const maxAgency = Math.max(1, ...months.map((month) => (monthMoney.get(month.ym)?.agency ?? dec(0)).toNumber()));
  const columnHours = new Map<string, ReturnType<typeof dec>>();
  let totalAgency = dec(0);
  let totalInternal = dec(0);
  for (const month of months) {
    const money = monthMoney.get(month.ym);
    if (money) {
      totalAgency = totalAgency.plus(money.agency);
      totalInternal = totalInternal.plus(money.internal);
    }
    for (const column of visibleColumns) {
      const hours = cell.get(month.ym)?.get(column.id) ?? dec(0);
      columnHours.set(column.id, (columnHours.get(column.id) ?? dec(0)).plus(hours));
    }
  }

  return (
    <section className="border-t border-[var(--color-rule)] first:border-t-0" aria-labelledby={`billing-period-${period.key}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4">
        <div>
          <h4 id={`billing-period-${period.key}`} className="font-semibold text-[var(--color-ink)]">{period.label}</h4>
          <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">{shortDate(period.start)} to {shortDate(period.end)}</p>
        </div>
        {period.byProgramMonth.length === 0 ? <span className="badge bg-[var(--color-surface-strong)] text-[var(--color-ink-soft)]">{canSeeTransactions ? "No billing yet" : "No recorded service yet"}</span> : null}
      </div>
      <div className="overflow-x-auto px-5 pb-4 pt-2">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-[var(--color-text-soft)]">
              <th className="py-2 pr-3 font-medium">Month</th>
              {visibleColumns.map((column) => (
                <th key={column.id} className="px-2 py-2 text-right font-medium" title={`${column.label} ${canSeeTransactions ? "hours billed" : "recorded hours"}`}>
                  {column.label}<span className="ml-0.5 text-[0.7rem] font-normal text-[var(--color-ink-faint)]">h</span>
                </th>
              ))}
              {canSeeBilledAmounts ? <th className="px-2 py-2 text-right font-medium" title="Funder amount billed">Funder billed</th> : null}
              {canSeeEmployeeAmounts ? <th className="py-2 pl-2 text-right font-medium">Employee base</th> : null}
            </tr>
          </thead>
          <tbody>
            {months.map((month) => {
              const money = monthMoney.get(month.ym);
              const agency = money?.agency ?? dec(0);
              const fill = Math.max(0, Math.min(100, (agency.toNumber() / maxAgency) * 100));
              const anyBilled = agency.greaterThan(0);
              return (
                <tr key={month.ym} className="border-t border-[var(--color-rule)]">
                  <td className="py-1.5 pr-3 text-[var(--color-ink-soft)]">{month.label}</td>
                  {visibleColumns.map((column) => {
                    const hours = cell.get(month.ym)?.get(column.id);
                    return (
                      <td key={column.id} className="tnum px-2 py-1.5 text-right">
                        {hours && hours.greaterThan(0) ? formatHours(hours.toString()) : <span className="text-[var(--color-ink-faint)]">-</span>}
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
                        <span className="text-[var(--color-ink-faint)]">{month.future ? "Upcoming" : "-"}</span>
                      )}
                    </td>
                  ) : null}
                  {canSeeEmployeeAmounts ? (
                    <td className="tnum py-1.5 pl-2 text-right text-[var(--color-ink-soft)]">
                      {money ? formatMoney(money.internal.toString()) : ""}
                    </td>
                  ) : null}
                </tr>
              );
            })}
            <tr className="border-t-2 border-[var(--color-rule-strong)] font-semibold">
              <td className="py-2 pr-3">Total</td>
              {visibleColumns.map((column) => (
                <td key={column.id} className="tnum px-2 py-2 text-right text-xs font-normal text-[var(--color-ink-faint)]">
                  {formatHours((columnHours.get(column.id) ?? dec(0)).toString())} h
                </td>
              ))}
              {canSeeBilledAmounts ? <td className="tnum px-2 py-2 text-right">{formatMoney(totalAgency.toString())}</td> : null}
              {canSeeEmployeeAmounts ? <td className="tnum py-2 pl-2 text-right">{formatMoney(totalInternal.toString())}</td> : null}
            </tr>
          </tbody>
        </table>
        {canSeeHours && hasGroup ? (
          <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
            {canSeeEmployeeAmounts
              ? "Group-session hours are calculated from the employee-base amount at the budget rate, matching the budget totals above."
              : "Each individual receives the full service hours for a group session."}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export default function BilledByMonth({
  periods,
  canSeeHours = true,
  canSeeBilledAmounts = true,
  canSeeEmployeeAmounts = true,
  canSeeTransactions = true,
}: {
  periods: BillingHistoryPeriod[];
  canSeeHours?: boolean;
  canSeeBilledAmounts?: boolean;
  canSeeEmployeeAmounts?: boolean;
  canSeeTransactions?: boolean;
}) {
  return (
    <div>
      {periods.map((period) => (
        <PeriodTable
          key={period.key}
          period={period}
          canSeeHours={canSeeHours}
          canSeeBilledAmounts={canSeeBilledAmounts}
          canSeeEmployeeAmounts={canSeeEmployeeAmounts}
          canSeeTransactions={canSeeTransactions}
        />
      ))}
    </div>
  );
}
