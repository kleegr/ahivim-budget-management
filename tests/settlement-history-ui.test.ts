import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/settlements/settlement-dashboard.tsx", "utf8");

describe("Money operations history", () => {
  it("paginates the complete audit trail without limiting search to recent entries", () => {
    expect(source).toContain("const HISTORY_PAGE_SIZE = 50");
    expect(source).toContain("data.events.filter");
    expect(source).toContain("visibleHistoryEvents = filteredEvents.slice");
    expect(source).toContain("of {filteredEvents.length.toLocaleString()} complete history");
    expect(source).toContain("Page {visibleHistoryPage + 1} of {historyPageCount}");
    expect(source).toContain("<HistoryTable events={visibleHistoryEvents}");
    expect(source).not.toContain("<HistoryTable events={filteredEvents}");
  });
});
