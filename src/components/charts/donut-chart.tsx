import { dec } from "@/lib/money";
import {
  ChartFigure,
  categoricalColor,
  pct,
  toNum,
  toneColor,
  type ChartTone,
  type LegendItem,
} from "./chart-utils";

/**
 * Donut chart for a distribution (agency-vs-internal, utilization-status counts,
 * …). Server-rendered SVG using stacked stroke-dash arcs. Slice sizes come from
 * `Number(value)` (geometry only); the legend carries each slice's decimal-safe
 * display string and its share, so the figure is fully legible as text too.
 */

export interface DonutSlice {
  label: string;
  /** Decimal-safe, non-negative numeric string. */
  value: string;
  /** Formatted string shown in the legend (defaults to `value`). */
  display?: string;
  tone?: ChartTone;
  color?: string;
}

export function Donut({
  data,
  title,
  subtitle,
  centerLabel,
  centerValue,
  summary,
}: {
  data: DonutSlice[];
  title?: string;
  subtitle?: string;
  centerLabel?: string;
  centerValue?: string;
  summary?: string;
}) {
  const size = 176;
  const stroke = 30;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const C = 2 * Math.PI * r;

  const nums = data.map((d) => Math.max(0, toNum(d.value)));
  const total = nums.reduce((a, b) => a + b, 0);

  let cum = 0;
  const arcs = data.map((d, i) => {
    const frac = total > 0 ? nums[i] / total : 0;
    const len = frac * C;
    const off = -cum;
    cum += len;
    const color = d.color ?? (d.tone ? toneColor(d.tone) : categoricalColor(i));
    // Share computed with Decimal so the legend percentage is exact.
    const share = total > 0 ? dec(nums[i]).dividedBy(total).times(100) : dec(0);
    return { len, off, color, share };
  });

  const legend: LegendItem[] = data.map((d, i) => ({
    label: d.label,
    color: arcs[i].color,
    value: `${d.display ?? d.value}${total > 0 ? ` · ${pct(arcs[i].share, 0)}` : ""}`,
  }));

  const aria =
    summary ??
    `${title ?? "Distribution"}: ${data
      .map((d, i) => `${d.label} ${d.display ?? d.value} (${pct(arcs[i].share, 0)})`)
      .join(", ")}`;

  return (
    <ChartFigure title={title} subtitle={subtitle} summary={aria} legend={legend}>
      <div className="flex justify-center">
        <svg
          role="img"
          aria-label={aria}
          viewBox={`0 0 ${size} ${size}`}
          width={size}
          height={size}
          style={{ maxWidth: "100%", height: "auto", display: "block" }}
        >
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="var(--color-surface-strong)"
            strokeWidth={stroke}
          />
          <g transform={`rotate(-90 ${cx} ${cy})`}>
            {total > 0
              ? arcs.map((a, i) =>
                  a.len > 0 ? (
                    <circle
                      key={i}
                      cx={cx}
                      cy={cy}
                      r={r}
                      fill="none"
                      stroke={a.color}
                      strokeWidth={stroke}
                      strokeDasharray={`${a.len} ${C - a.len}`}
                      strokeDashoffset={a.off}
                    />
                  ) : null,
                )
              : null}
          </g>
          {centerValue ? (
            <text
              x={cx}
              y={cy - 2}
              textAnchor="middle"
              fontSize={18}
              fontWeight={600}
              fill="var(--color-ink)"
              className="tnum"
            >
              {centerValue}
            </text>
          ) : null}
          {centerLabel ? (
            <text x={cx} y={cy + 15} textAnchor="middle" fontSize={10.5} fill="var(--color-ink-faint)">
              {centerLabel}
            </text>
          ) : null}
        </svg>
      </div>
    </ChartFigure>
  );
}
