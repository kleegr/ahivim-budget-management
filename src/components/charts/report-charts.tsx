import type { ReactNode } from "react";
import { dec, formatMoney } from "@/lib/money";
import type { ForecastResult } from "@/lib/business/forecast";
import type { ReportTable, ReportCell } from "@/lib/data/report-queries";
import { BarChart, type BarDatum } from "./bar-chart";
import { Donut, type DonutSlice } from "./donut-chart";
import { BurndownChart } from "./burndown-chart";
import { CHART_COLORS, pct, sumCol, toNum, type ChartTone, type LegendItem } from "./chart-utils";

/**
 * Report-facing chart compositions.
 *
 * Each one adapts a report's existing rows (never a new shape) into one of the
 * generic SVG primitives. They are pure server components, safe to render above
 * the client `ReportGrid` without any client JavaScript of their own.
 */

/* ------------------------------------------------------------------ helpers */

const cell = (v: ReportCell | undefined, fallback = ""): string =>
  v === null || v === undefined ? fallback : String(v);

function NotAvailable({ message }: { message: string }) {
  return (
    <div className="px-1 py-6 text-sm">
      <p className="font-medium text-[var(--color-ink)]">Not available</p>
      <p className="mt-1 text-[var(--color-ink-soft)]">{message}</p>
    </div>
  );
}

/* ------------------------------------------------ portfolio burn-down (hub) */

type PortfolioForecast =
  | { available: false; reason: string }
  | { available: true; result: ForecastResult };

export function PortfolioBurndownCard({ forecast }: { forecast: PortfolioForecast }) {
  if (!forecast.available) return <NotAvailable message={forecast.reason} />;
  const r = forecast.result;
  if (r.available) {
    return (
      <BurndownChart
        title="Portfolio utilization"
        subtitle="Budget remaining against the straight-line ideal pace."
        timeElapsedFraction={r.timeElapsedPercent}
        usageFraction={r.usagePercent}
        hasProjection
        projectedToExhaustEarly={r.projectedToExhaustEarly}
        estimatedExhaustionDate={r.estimatedExhaustionDate}
      />
    );
  }
  return (
    <BurndownChart
      title="Portfolio utilization"
      subtitle="Budget remaining against the straight-line ideal pace."
      timeElapsedFraction={r.timeElapsedPercent}
      usageFraction={r.usagePercent}
      hasProjection={false}
      note={r.message}
    />
  );
}

/* ------------------------------------------- agency vs internal (hub + page) */

export function AgencyInternalDonut({
  items,
  title = "Agency vs internal",
  subtitle,
}: {
  items: { internal: string; additional: string }[];
  title?: string;
  subtitle?: string;
}) {
  const internal = sumCol(items.map((i) => i.internal));
  const additional = sumCol(items.map((i) => i.additional));
  const gross = dec(internal).plus(dec(additional)).toString();
  const slices: DonutSlice[] = [
    { label: "Employee amount", value: internal, display: formatMoney(internal), color: CHART_COLORS.primary },
    { label: "Agency difference", value: additional, display: formatMoney(additional), color: CHART_COLORS.accent },
  ];
  return (
    <Donut
      data={slices}
      title={title}
      subtitle={subtitle ?? "Share of agency gross retained internally vs the agency additional."}
      centerLabel="Agency total"
      centerValue={formatMoney(gross)}
    />
  );
}

/* -------------------------------------------- program totals bar (hub + page) */

export function ProgramTotalsBar({
  items,
  title = "Program totals",
  subtitle = "Agency total by program (top 10).",
}: {
  items: { label: string; value: string }[];
  title?: string;
  subtitle?: string;
}) {
  const top = [...items].sort((a, b) => toNum(b.value) - toNum(a.value)).slice(0, 10);
  const data: BarDatum[] = top.map((i) => ({
    label: i.label,
    value: i.value,
    display: formatMoney(i.value),
    tone: "primary",
  }));
  return <BarChart data={data} title={title} subtitle={subtitle} tone="primary" />;
}

/* ------------------------------- utilization outlier distribution (hub + page) */

export function UtilizationDistribution({
  flags,
  title = "Utilization outliers",
  subtitle = "Authorizations under-utilizing (below half used past mid-period) or over-utilizing (above 100%).",
}: {
  flags: string[];
  title?: string;
  subtitle?: string;
}) {
  let under = 0;
  let over = 0;
  for (const f of flags) {
    if (f === "underutilizing") under += 1;
    else if (f === "overutilizing") over += 1;
  }
  const slices: DonutSlice[] = [
    { label: "Under-utilizing", value: String(under), display: String(under), color: CHART_COLORS.behind },
    { label: "Over-utilizing", value: String(over), display: String(over), color: CHART_COLORS.over },
  ];
  return (
    <Donut
      data={slices}
      title={title}
      subtitle={subtitle}
      centerLabel="Outliers"
      centerValue={String(under + over)}
    />
  );
}

/* --------------------------------------- budget utilization bar (report page) */

const paceTone = (percentUsed: number): ChartTone =>
  percentUsed > 100 ? "over" : percentUsed >= 90 ? "near" : percentUsed >= 50 ? "on" : "behind";

export function BudgetUtilizationBar({
  rows,
  title = "Utilization by authorization",
  subtitle = "Percent of authorized hours used (top 12 by usage).",
}: {
  rows: { label: string; percentUsed: string | null }[];
  title?: string;
  subtitle?: string;
}) {
  const withPct = rows.filter((r) => r.percentUsed !== null && r.percentUsed !== "");
  const top = [...withPct]
    .sort((a, b) => toNum(b.percentUsed) - toNum(a.percentUsed))
    .slice(0, 12);
  const data: BarDatum[] = top.map((r) => ({
    label: r.label,
    value: r.percentUsed ?? "0",
    display: pct(r.percentUsed ?? "0", 1),
    tone: paceTone(toNum(r.percentUsed)),
  }));
  const legend: LegendItem[] = [
    { label: "Under half", color: CHART_COLORS.behind },
    { label: "On track", color: CHART_COLORS.on },
    { label: "Near limit", color: CHART_COLORS.near },
    { label: "Over 100%", color: CHART_COLORS.over },
  ];
  return <BarChart data={data} title={title} subtitle={subtitle} legend={legend} />;
}

/* ----------------------------------- generic dispatch for the report page --- */

/**
 * For an individual report page: render a relevant chart above the grid, driven
 * only by the table's existing rows. Returns null for reports where a chart adds
 * nothing (or when there is no data to plot).
 */
export function ReportInlineChart({ table }: { table: ReportTable }) {
  if (table.rows.length === 0) return null;

  let chart: ReactNode = null;
  switch (table.key) {
    case "budget-utilization":
      chart = (
        <BudgetUtilizationBar
          rows={table.rows.map((r) => ({
            label: `${cell(r.individualName)} · ${cell(r.programCode)}`,
            percentUsed: r.percentUsed === null || r.percentUsed === undefined ? null : String(r.percentUsed),
          }))}
        />
      );
      break;
    case "agency-earnings":
      chart = (
        <AgencyInternalDonut
          items={table.rows.map((r) => ({
            internal: cell(r.internalAmount, "0"),
            additional: cell(r.agencyAdditional, "0"),
          }))}
        />
      );
      break;
    case "program-totals":
      chart = (
        <ProgramTotalsBar
          items={table.rows.map((r) => ({ label: cell(r.programName), value: cell(r.agencyGross, "0") }))}
        />
      );
      break;
    case "utilization-outliers":
      chart = <UtilizationDistribution flags={table.rows.map((r) => cell(r.flag))} />;
      break;
    default:
      return null;
  }

  return <div className="card px-4 py-4">{chart}</div>;
}
