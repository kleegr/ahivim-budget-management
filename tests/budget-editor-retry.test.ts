import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("financial plan retry safety", () => {
  it("remembers a newly created strategy before the later account-status save", () => {
    const source = readFileSync("src/components/individuals/budget-editor.tsx", "utf8");

    expect(source).toContain("const strategyIdRef = useRef(strategyId)");
    expect(source).toContain("}, [individualId, strategyId])");
    expect(source).toContain("let sid = strategyIdRef.current");
    expect(source).toContain("strategyIdRef.current = sid");
    expect(source.indexOf("strategyIdRef.current = sid"))
      .toBeLessThan(source.indexOf("const statusResponse = await fetch"));
    expect(source.match(/fetch\(\"\/api\/calculation-strategies\"/g)).toHaveLength(1);
  });
});
