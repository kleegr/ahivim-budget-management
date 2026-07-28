import { describe, it, expect } from "vitest";
import { evaluateRateException } from "@/lib/business/rate-exceptions";
import { resolveProgram, normalizeProgramLabel, PROGRAM_CODES, SEED_PROGRAM_ALIASES } from "@/lib/business/program-normalization";
import { matchPerson, normalizePersonName, similarity, levenshtein } from "@/lib/business/name-matching";
import { dec } from "@/lib/money";

describe("rate exceptions", () => {
  it("accepts a rate that matches the schedule", () => {
    const result = evaluateRateException({ importedRate: "18", expectedRate: "18" });
    expect(result.isException).toBe(false);
  });

  it("flags the Self-Hire Respite $23 case and preserves the imported value", () => {
    const result = evaluateRateException({ importedRate: "23", expectedRate: "18" });
    expect(result.isException).toBe(true);
    expect(result.direction).toBe("higher");
    expect(dec(result.varianceAmount).toNumber()).toBe(5);
    expect(dec(result.variancePercent).toDecimalPlaces(6).toNumber()).toBeCloseTo(0.277778, 6);
    expect(dec(result.importedRate).toNumber()).toBe(23);
  });

  it("flags a rate below the schedule as lower", () => {
    const result = evaluateRateException({ importedRate: "15", expectedRate: "18" });
    expect(result.isException).toBe(true);
    expect(result.direction).toBe("lower");
    expect(dec(result.varianceAmount).toNumber()).toBe(-3);
  });

  it("never replaces the imported rate with the expected one", () => {
    for (const rate of ["15", "15.5", "16", "17", "23", "25", "40"]) {
      const result = evaluateRateException({ importedRate: rate, expectedRate: "18" });
      expect(dec(result.importedRate).toNumber()).toBe(Number(rate));
    }
  });
});

describe("program normalization", () => {
  it("resolves every seeded alias to a known program code", () => {
    const codes = new Set(Object.values(PROGRAM_CODES));
    for (const [alias, code] of Object.entries(SEED_PROGRAM_ALIASES)) {
      expect(codes.has(code), `${alias} -> ${code}`).toBe(true);
      const resolved = resolveProgram(alias);
      expect(resolved.code).toBe(code);
      expect(resolved.matched).toBe(true);
    }
  });

  it("is insensitive to case, punctuation and spacing", () => {
    for (const label of ["Day Hab", "  DAY   HAB ", "day-hab", "DayHab"]) {
      expect(resolveProgram(label).code).toBe(PROGRAM_CODES.DAY_HAB);
    }
  });

  it("does not guess at an unknown label", () => {
    const result = resolveProgram("Interpretive Dance Therapy");
    expect(result.matched).toBe(false);
    expect(result.code).toBeNull();
  });

  it("treats a blank label as unmatched rather than defaulting", () => {
    expect(resolveProgram("").matched).toBe(false);
    expect(resolveProgram(null).matched).toBe(false);
  });

  it("distinguishes self-hire from agency programs", () => {
    expect(resolveProgram("Self Hired Respite").code).toBe(PROGRAM_CODES.SH_RESPITE);
    expect(resolveProgram("Respite").code).toBe(PROGRAM_CODES.RESPITE);
    expect(normalizeProgramLabel("SD - Self Hired Com Hab")).toBe("sd self hired com hab");
  });
});

describe("name matching", () => {
  const canonical = [
    { id: "1", normalizedName: normalizePersonName("Neuwirth, Isaac"), displayName: "Neuwirth, Isaac" },
    { id: "2", normalizedName: normalizePersonName("Cohen, Sarah"), displayName: "Cohen, Sarah" },
  ];

  it("collapses 'Last, First' and 'First Last' to the same key", () => {
    expect(normalizePersonName("Cohen, Sarah")).toBe(normalizePersonName("Sarah Cohen"));
  });

  it("matches an exact name", () => {
    const result = matchPerson("Sarah Cohen", canonical);
    expect(result.outcome).toBe("exact");
    expect(result.matchedId).toBe("2");
  });

  it("suggests a near miss but never merges it", () => {
    const result = matchPerson("Neuwirth, Issac", canonical);
    expect(result.outcome).toBe("unmatched");
    expect(result.matchedId).toBeNull();
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0].id).toBe("1");
  });

  it("reports a genuinely new name with no suggestions", () => {
    const result = matchPerson("Zylberstein, Wolf", canonical);
    expect(result.outcome).toBe("unmatched");
    expect(result.suggestions).toHaveLength(0);
  });

  it("only matches APPROVED aliases", () => {
    const pending = matchPerson("Nooywirth Isaac", canonical, [
      { normalizedAlias: normalizePersonName("Nooywirth Isaac"), targetId: "1", status: "pending" },
    ]);
    expect(pending.outcome).toBe("unmatched");

    const approved = matchPerson("Nooywirth Isaac", canonical, [
      { normalizedAlias: normalizePersonName("Nooywirth Isaac"), targetId: "1", status: "approved" },
    ]);
    expect(approved.outcome).toBe("alias");
    expect(approved.matchedId).toBe("1");
  });

  it("refuses an alias that points at two different people", () => {
    const result = matchPerson("Shared Name", canonical, [
      { normalizedAlias: normalizePersonName("Shared Name"), targetId: "1", status: "approved" },
      { normalizedAlias: normalizePersonName("Shared Name"), targetId: "2", status: "approved" },
    ]);
    expect(result.outcome).toBe("ambiguous");
    expect(result.matchedId).toBeNull();
  });

  it("treats a blank name as unmatched", () => {
    expect(matchPerson("", canonical).outcome).toBe("unmatched");
    expect(matchPerson(null, canonical).normalizedName).toBe("");
  });

  it("measures edit distance and similarity sanely", () => {
    expect(levenshtein("isaac", "issac")).toBe(1); // one substitution
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(similarity("abc", "abc")).toBe(1);
    expect(similarity("isaac", "issac")).toBeGreaterThan(0.5);
    expect(similarity("isaac", "zylberstein")).toBeLessThan(0.5);
  });
});
