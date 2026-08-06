import {
  ChartFigure,
  CHART_COLORS,
  clamp,
  pct,
  toNum,
  type LegendItem,
} from "./chart-utils";

/**
 * A minimal multi-series line chart and a burn-down built on top of it.
 *
 * Everything is server-rendered SVG. Points arrive as plain numbers because they
 * are pixel geometry; any money/hours upstream is converted once, at the edge,
 * with `toNum`. The burn-down plots budget remaining against the straight-line
 * ideal pace so "are we ahead or behind?" is legible at a glance.
 */

export interface LinePoint {
  x: number;
  y: number;
}

export interface LineSeries {
  label: string;
  points: LinePoint[];
  color: string;
  dashed?: boolean;
  width?: number;
  showDots?: boolean;
}

export interface LineMarker {
  x: number;
  label?: string;
  color?: string;
}

export interface LineChartProps {
  series: LineSeries[];
  title?: string;
  subtitle?: string;
  summary?: string;
  note?: string | null;
  legend?: LegendItem[];
  xDomain?: [number, number];
  yDomain?: [number, number];
  xTicks?: number[];
  yTicks?: number[];
  formatX?: (v: number) => string;
  formatY?: (v: number) => string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  markers?: LineMarker[];
}

export function LineChart({
  series,
  title,
  subtitle,
  summary,
  note,
  legend,
  xDomain = [0, 100],
  yDomain = [0, 100],
  xTicks = [0, 25, 50, 75, 100],
  yTicks = [0, 25, 50, 75, 100],
  formatX = (v) => String(v),
  formatY = (v) => String(v),
  xAxisLabel,
  yAxisLabel,
  markers = [],
}: LineChartProps) {
  const VW = 480;
  const VH = 250;
  const padL = 46;
  const padR = 16;
  const padT = 16;
  const padB = 40;
  const plotW = VW - padL - padR;
  const plotH = VH - padT - padB;
  const [x0, x1] = xDomain;
  const [y0, y1] = yDomain;
  const sx = (x: number) => padL + (x1 === x0 ? 0 : ((x - x0) / (x1 - x0)) * plotW);
  const sy = (y: number) => padT + (y1 === y0 ? 0 : (1 - (y - y0) / (y1 - y0)) * plotH);

  const aria = summary ?? title ?? "Line chart";

  return (
    <ChartFigure title={title} subtitle={subtitle} summary={aria} legend={legend}>
      <svg
        role="img"
        aria-label={aria}
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="xMinYMin meet"
        style={{ width: "100%", height: "auto", display: "block", overflow: "visible" }}
      >
        {yTicks.map((t, i) => {
          const y = sy(t);
          return (
            <g key={`y${i}`}>
              <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="var(--color-rule)" strokeWidth={1} />
              <text x={padL - 6} y={y} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--color-ink-faint)">
                {formatY(t)}
              </text>
            </g>
          );
        })}

        {xTicks.map((t, i) => (
          <text
            key={`x${i}`}
            x={sx(t)}
            y={padT + plotH + 16}
            textAnchor="middle"
            fontSize={11}
            fill="var(--color-ink-faint)"
          >
            {formatX(t)}
          </text>
        ))}

        <line
          x1={padL}
          y1={padT + plotH}
          x2={padL + plotW}
          y2={padT + plotH}
          stroke="var(--color-rule-strong)"
          strokeWidth={1}
        />

        {markers.map((m, i) => {
          const x = sx(m.x);
          return (
            <g key={`m${i}`}>
              <line
                x1={x}
                y1={padT}
                x2={x}
                y2={padT + plotH}
                stroke={m.color ?? "var(--color-ink-faint)"}
                strokeWidth={1}
                strokeDasharray="3 3"
                opacity={0.75}
              />
              {m.label ? (
                <text x={x} y={padT - 4} textAnchor="middle" fontSize={10} fill={m.color ?? "var(--color-ink-faint)"}>
                  {m.label}
                </text>
              ) : null}
            </g>
          );
        })}

        {series.map((s, i) => (
          <polyline
            key={`s${i}`}
            fill="none"
            stroke={s.color}
            strokeWidth={s.width ?? 2}
            strokeDasharray={s.dashed ? "5 4" : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
            points={s.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}
          />
        ))}

        {series.map((s) =>
          s.showDots
            ? s.points.map((p, j) => (
                <circle key={`d${s.label}${j}`} cx={sx(p.x)} cy={sy(p.y)} r={2.6} fill={s.color} />
              ))
            : null,
        )}

        {xAxisLabel ? (
          <text x={padL + plotW / 2} y={VH - 4} textAnchor="middle" fontSize={11} fill="var(--color-ink-soft)">
            {xAxisLabel}
          </text>
        ) : null}
        {yAxisLabel ? (
          <text
            transform={`rotate(-90 12 ${padT + plotH / 2})`}
            x={12}
            y={padT + plotH / 2}
            textAnchor="middle"
            fontSize={11}
            fill="var(--color-ink-soft)"
          >
            {yAxisLabel}
          </text>
        ) : null}
      </svg>
      {note ? <p className="mt-2 text-xs text-[var(--color-ink-faint)]">{note}</p> : null}
    </ChartFigure>
  );
}

/**
 * Portfolio-style burn-down. Given the elapsed-time fraction and the used-hours
 * fraction (both 0..1 decimal strings), plot budget remaining vs the ideal
 * straight-line pace, and — when a projection is warranted — the current pace
 * extended to period end with a marker where it would exhaust the budget.
 */
export function BurndownChart({
  timeElapsedFraction,
  usageFraction,
  hasProjection = false,
  projectedToExhaustEarly = false,
  estimatedExhaustionDate = null,
  note = null,
  title,
  subtitle,
}: {
  timeElapsedFraction: string;
  usageFraction: string;
  hasProjection?: boolean;
  projectedToExhaustEarly?: boolean;
  estimatedExhaustionDate?: string | null;
  note?: string | null;
  title?: string;
  subtitle?: string;
}) {
  const te = clamp(toNum(timeElapsedFraction), 0, 1);
  const use = Math.max(0, toNum(usageFraction));
  const teP = te * 100;
  const remainNowRaw = (1 - use) * 100;
  const remainNow = clamp(remainNowRaw, 0, 100);

  const planned: LineSeries = {
    label: "Ideal pace",
    color: CHART_COLORS.idle,
    dashed: true,
    width: 1.75,
    points: [
      { x: 0, y: 100 },
      { x: 100, y: 0 },
    ],
  };
  const actual: LineSeries = {
    label: "Remaining",
    color: CHART_COLORS.primary,
    width: 2.5,
    showDots: true,
    points: [
      { x: 0, y: 100 },
      { x: teP, y: remainNow },
    ],
  };

  const series: LineSeries[] = [planned, actual];
  const markers: LineMarker[] = [{ x: teP, label: "Today", color: CHART_COLORS.neutral }];

  const projColor = projectedToExhaustEarly ? CHART_COLORS.over : CHART_COLORS.ahead;
  if (hasProjection && te > 0) {
    const projUse = use / te; // usage fraction projected to period end at current pace
    const projRemainEnd = clamp((1 - projUse) * 100, 0, 100);
    series.push({
      label: "Projected",
      color: projColor,
      dashed: true,
      width: 2,
      points: [
        { x: teP, y: remainNow },
        { x: 100, y: projRemainEnd },
      ],
    });
    if (projectedToExhaustEarly && use > 0) {
      const exhaustX = clamp((te / use) * 100, 0, 100);
      markers.push({ x: exhaustX, label: estimatedExhaustionDate ?? "Exhausted", color: CHART_COLORS.over });
    }
  }

  const legend: LegendItem[] = [
    { label: "Remaining", color: CHART_COLORS.primary, value: `${pct(remainNowRaw, 0)} left` },
    { label: "Ideal pace", color: CHART_COLORS.idle, value: `${pct(100 - teP, 0)} left` },
  ];
  if (hasProjection && te > 0) legend.push({ label: "Projected pace", color: projColor });

  const summary =
    `Portfolio burn-down: ${pct(use * 100, 0)} of authorized hours used with ` +
    `${pct(teP, 0)} of the period elapsed.${note ? ` ${note}` : ""}`;

  return (
    <LineChart
      title={title}
      subtitle={subtitle}
      series={series}
      markers={markers}
      xDomain={[0, 100]}
      yDomain={[0, 100]}
      xTicks={[0, 25, 50, 75, 100]}
      yTicks={[0, 25, 50, 75, 100]}
      formatX={(v) => `${v}%`}
      formatY={(v) => `${v}%`}
      xAxisLabel="Period elapsed"
      yAxisLabel="Budget remaining"
      legend={legend}
      summary={summary}
      note={note}
    />
  );
}
