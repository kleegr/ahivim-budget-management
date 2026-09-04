import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("schedule month overflow", () => {
  it("opens the complete day instead of rendering inert hidden-session text", () => {
    const source = readFileSync("src/components/schedule/calendar.tsx", "utf8");

    expect(source).toContain("onOpenDay={(date) => { setAnchor(date); setView(\"day\"); }}");
    expect(source).toContain("onClick={() => onOpenDay(d)}");
    expect(source).toContain("aria-label={`Open all ${list.length} sessions on ${d}`}");
    expect(source).not.toContain('<span className="block px-1 text-[10px] text-[var(--color-ink-faint)]">+{list.length - 4} more</span>');
  });

  it("links each calendar identity to its underlying record", () => {
    const source = readFileSync("src/components/schedule/session-detail.tsx", "utf8");
    const querySource = readFileSync("src/lib/data/schedule-queries.ts", "utf8");

    expect(source).toContain("`/employees/${session.employeeId}`");
    expect(source).toContain("`/individuals/${id}`");
    expect(querySource).toContain("array_agg(i.display_name ORDER BY i.display_name, a.individual_id)");
    expect(querySource).toContain("array_agg(a.individual_id::text ORDER BY i.display_name, a.individual_id)");
  });
});
