/**
 * NAME MATCHING
 * =============
 *
 * The workbook contains at least one likely misspelling ("Neuwirth, Isaac" vs
 * "Neuwirth, Issac"). Similar names are SUGGESTED, never merged.
 *
 * Matching order:
 *   1. exact normalized match against a canonical record
 *   2. exact normalized match against an APPROVED alias
 *   3. otherwise -> review queue, with similarity suggestions attached
 *
 * A suggestion never resolves a row on its own. Once a human approves one it
 * becomes a permanent alias and subsequent imports match exactly.
 */

export interface CanonicalRecord {
  id: string;
  normalizedName: string;
  displayName: string;
}

export interface AliasRecord {
  normalizedAlias: string;
  targetId: string;
  status: "pending" | "approved";
}

/**
 * Normalize a person's name for comparison. Handles "Last, First" and
 * "First Last" by sorting the parts, so both orderings collapse to one key.
 */
export function normalizePersonName(name: string | null | undefined): string {
  const cleaned = (name ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, "")
    .replace(/[^a-z, ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return "";

  const parts = cleaned
    .split(",")
    .flatMap((p) => p.split(" "))
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.sort().join(" ");
}

/** Levenshtein distance, iterative with a single row of state. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      current.push(Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + cost));
    }
    previous = current;
  }
  return previous[b.length];
}

export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

export type MatchOutcome = "exact" | "alias" | "unmatched" | "ambiguous";

export interface NameMatchSuggestion {
  id: string;
  displayName: string;
  similarity: number;
}

export interface NameMatchResult {
  outcome: MatchOutcome;
  matchedId: string | null;
  normalizedName: string;
  sourceText: string;
  suggestions: NameMatchSuggestion[];
  reason: string;
}

export interface MatchOptions {
  /** Similarity at or above which a near miss is offered as a suggestion. */
  suggestionThreshold?: number;
  /** Maximum suggestions returned. */
  maxSuggestions?: number;
}

export function matchPerson(
  sourceText: string | null | undefined,
  canonical: readonly CanonicalRecord[],
  aliases: readonly AliasRecord[] = [],
  options: MatchOptions = {},
): NameMatchResult {
  const suggestionThreshold = options.suggestionThreshold ?? 0.82;
  const maxSuggestions = options.maxSuggestions ?? 5;

  const raw = (sourceText ?? "").trim();
  const normalizedName = normalizePersonName(raw);

  const base = { normalizedName, sourceText: raw };

  if (normalizedName === "") {
    return {
      ...base,
      outcome: "unmatched",
      matchedId: null,
      suggestions: [],
      reason: "Name is blank.",
    };
  }

  // 1. Exact match against canonical records.
  const exact = canonical.filter((c) => c.normalizedName === normalizedName);
  if (exact.length === 1) {
    return {
      ...base,
      outcome: "exact",
      matchedId: exact[0].id,
      suggestions: [],
      reason: "Exact match on the normalized name.",
    };
  }
  if (exact.length > 1) {
    return {
      ...base,
      outcome: "ambiguous",
      matchedId: null,
      suggestions: exact.map((c) => ({ id: c.id, displayName: c.displayName, similarity: 1 })),
      reason:
        "More than one canonical record shares this normalized name. " +
        "Resolve manually; nothing was matched automatically.",
    };
  }

  // 2. Exact match against an APPROVED alias. Pending aliases never match.
  const approved = aliases.filter(
    (a) => a.status === "approved" && a.normalizedAlias === normalizedName,
  );
  const distinctTargets = new Set(approved.map((a) => a.targetId));
  if (distinctTargets.size === 1) {
    return {
      ...base,
      outcome: "alias",
      matchedId: approved[0].targetId,
      suggestions: [],
      reason: "Matched an approved alias.",
    };
  }
  if (distinctTargets.size > 1) {
    return {
      ...base,
      outcome: "ambiguous",
      matchedId: null,
      suggestions: [...distinctTargets].map((id) => ({
        id,
        displayName: canonical.find((c) => c.id === id)?.displayName ?? id,
        similarity: 1,
      })),
      reason: "This alias points at more than one canonical record. Resolve manually.",
    };
  }

  // 3. No exact match. Offer suggestions only; do not resolve.
  const suggestions = canonical
    .map((c) => ({
      id: c.id,
      displayName: c.displayName,
      similarity: similarity(normalizedName, c.normalizedName),
    }))
    .filter((s) => s.similarity >= suggestionThreshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxSuggestions);

  return {
    ...base,
    outcome: "unmatched",
    matchedId: null,
    suggestions,
    reason: suggestions.length
      ? "No exact match. Similar names are suggested but were not applied automatically."
      : "No exact match and no similar existing record.",
  };
}
