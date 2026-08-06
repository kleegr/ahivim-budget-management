import {
  ChartFigure,
  toNum,
  toneColor,
  truncate,
  type ChartTone,
  type LegendItem,
} from "./chart-utils";

/**
 * Horizontal bar chart, one series, tone-coloured.
 *
 * Server-rendered SVG: a fixed viewBox scales to the container width. Each bar's
 * numeric length comes from `Number(value)` (geometry only); the label shown at
 * the end of the bar is the caller's already-formatted, decimal-safe string.
 */

export interface BarDatum {
  label: string;
  /** Decimal-safe numeric string, used only to scale the bar. */
  value: string;
  /** Formatted string shown at the bar end (defaults to `value`). */
  display?: string;
  tone?: ChartTone;
  /** Explicit colour override (else `tone`, else the chart-level `tone`). */
  color?: string;
}

export function BarChart({
  data,
  title,
  subtitle,
  ariaLabel,
  tone = "primary",
  legend,
}: {
  data: BarDatum[];
  title?: string;
  subtitle?: string;
  ariaLabel?: string;
  tone?: ChartTone;
  legend?: LegendItem[];
}) {
  const VW = 480;
  const rowH = 30;
  const padT = 6;
  const padB = 6;
  const labelW = 140;
  const valueW = 92;
  const gap = 10;
  const trackX = labelW + gap;
  const trackW = VW - trackX - valueW - gap;
  const H = padT + padB + Math.max(1, data.length) * rowH;

  const values = data.map((d) => toNum(d.value));
  const max = Math.max(0, ...values);
  const barW = (v: number) => (max <= 0 ? 0 : (Math.max(0, v) / max) * trackW);

  const summary =
    ariaLabel ??
    `${title ?? "Bar chart"}: ${data.map((d) => `${d.label} ${d.display ?? d.value}`).join("; ")}`;

  return (
    <ChartFigure title={title} subtitle={subtitle} summary={summary} legend={legend}>
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${VW} ${H}`}
        preserveAspectRatio="xMinYMin meet"
        style={{ width: "100%", height: "auto", display: "block", overflow: "visible" }}
      >
        {data.length === 0 ? (
          <text
            x={VW / 2}
            y={H / 2}
            textAnchor="middle"
            dy="0.32em"
            fontSize={13}
            fill="var(--color-ink-faint)"
          >
            No data to chart
          </text>
        ) : (
          data.map((d, i) => {
            const cy = padT + i * rowH + rowH / 2;
            const w = barW(values[i]);
            const drawn = values[i] > 0 ? Math.max(w, 2) : 0;
            const color = d.color ?? toneColor(d.tone ?? tone);
            return (
              <g key={i}>
                <text
                  x={labelW}
                  y={cy}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={12}
                  fill="var(--color-ink-soft)"
                >
                  {truncate(d.label, 18)}
                </text>
                <rect
                  x={trackX}
                  y={cy - 8}
                  width={trackW}
                  height={16}
                  rx={4}
                  fill="var(--color-surface-strong)"
                />
                <rect x={trackX} y={cy - 8} width={drawn} height={16} rx={4} fill={color} />
                <text
                  x={VW}
                  y={cy}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={12}
                  fill="var(--color-ink)"
                  className="tnum"
                >
                  {d.display ?? d.value}
                </text>
              </g>
            );
          })
        )}
      </svg>
    </ChartFigure>
  );
}
