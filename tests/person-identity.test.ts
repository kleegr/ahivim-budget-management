import { describe, expect, it } from "vitest";
import { normalizePersonName } from "@/lib/business/name-matching";
import { createPersonIdentityResolver, type PersonIdentityDirectory } from "@/lib/business/person-identity";

const former = "Former Synthetic Individual", survivor = "Current Synthetic Individual";
function directory(): PersonIdentityDirectory {
  return { people: [
    { id: "old", displayName: former, normalizedName: normalizePersonName(former), status: "archived", mergedIntoId: "current" },
    { id: "current", displayName: survivor, normalizedName: normalizePersonName(survivor), status: "active", mergedIntoId: null },
  ], aliases: [{ normalizedAlias: normalizePersonName(former), targetId: "current", status: "approved" }],
  merges: [{ mergedId: "old", survivorId: "current", mergedName: former }] };
}

describe("Exact individual identity with current and historical merge evidence", () => {
  it("uses an approved surviving identity only when the current merge pointer and historical audit agree", () => {
    expect(createPersonIdentityResolver(directory())(former)).toMatchObject({ outcome: "alias", matchedId: "current" });
  });

  for (const pointer of [null, undefined, "other"] as const) {
    it(`holds a retained alias/audit when the predecessor's current merge pointer is ${String(pointer)}`, () => {
      const data = directory(); data.people = data.people.map(person => person.id === "old" ? { ...person, mergedIntoId: pointer } : person);
      expect(createPersonIdentityResolver(data)(former)).toMatchObject({ outcome: "ambiguous", matchedId: null });
    });
  }

  it("holds a survivor whose current merge pointer points elsewhere", () => {
    const data = directory(); data.people = data.people.map(person => person.id === "current" ? { ...person, mergedIntoId: "other" } : person);
    expect(createPersonIdentityResolver(data)(former)).toMatchObject({ outcome: "ambiguous", matchedId: null });
  });

  it("does not revive an old merge after a correction restores the person and withdraws the alias", () => {
    const data = directory();
    data.people = data.people.map(person => person.id === "old" ? { ...person, status: "active", mergedIntoId: null } : person);
    data.aliases = [];
    expect(createPersonIdentityResolver(data)(former)).toMatchObject({ outcome: "exact", matchedId: "old" });
    expect(data.merges).toHaveLength(1);
  });

  it("keeps an ordinary archived individual canonical without inventing a replacement", () => {
    const data = directory(); data.aliases = []; data.merges = [];
    data.people = data.people.map(person => ({ ...person, mergedIntoId: null }));
    expect(createPersonIdentityResolver(data)(former)).toMatchObject({ outcome: "exact", matchedId: "old" });
  });

  for (const status of [null, "pending", "archived"] as const) {
    it(`holds a folded individual when its merge alias is ${status ?? "missing"}`, () => {
      const data = directory();
      data.aliases = status === null ? [] : data.aliases.map(alias => ({ ...alias, status }));
      expect(createPersonIdentityResolver(data)(former)).toMatchObject({ outcome: "ambiguous", matchedId: null });
    });
    it(`holds a recorded archived employee merge when its alias is ${status ?? "missing"}`, () => {
      const data = directory();
      data.people = data.people.map(person => ({ ...person, mergedIntoId: undefined }));
      data.aliases = status === null ? [] : data.aliases.map(alias => ({ ...alias, status }));
      expect(createPersonIdentityResolver(data, {}, "employee")(former)).toMatchObject({ outcome: "ambiguous", matchedId: null });
    });
  }

  it("holds contradictory or missing merge audits even when a current pointer and alias exist", () => {
    const data = directory(); data.merges = [];
    expect(createPersonIdentityResolver(data)(former)).toMatchObject({ outcome: "ambiguous", matchedId: null });
    data.merges = [{ mergedId: "old", survivorId: "other", mergedName: former }];
    expect(createPersonIdentityResolver(data)(former)).toMatchObject({ outcome: "ambiguous", matchedId: null });
  });

  it("preserves unmatched/fuzzy suggestions without assigning a suggested person", () => {
    const data = directory(); data.aliases = [];
    expect(createPersonIdentityResolver(data)("Current Synthetic Individuals"))
      .toMatchObject({ outcome: "unmatched", matchedId: null, suggestions: [expect.objectContaining({ id: "current" })] });
  });
});
