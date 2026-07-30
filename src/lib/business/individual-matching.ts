import { levenshtein, similarity } from "@/lib/business/name-matching";

/**
 * Decide whether two DISTINCT individual rows are the same person whose name
 * was spelled differently in the two workbook tabs.
 *
 * `normalizePersonName` already collapses spacing, ordering, punctuation and
 * numbering, so any pair reaching here differs by SPELLING. The rule set is
 * deliberately conservative:
 *   - AUTO only for a clear single-name-part typo (same token count, exactly one
 *     token differs, and that token pair is very close) — e.g. Markowitz vs
 *     Markovitz, Fleishman vs Fleischman.
 *   - REVIEW for anything else that is plausibly the same person (decent overall
 *     similarity, or a near-identical shared surname) — e.g. Duestch vs Deutsch.
 *   - NONE otherwise.
 * A merge is destructive, so when in doubt we queue for a human, never guess.
 */

export interface IndividualForMatch {
  id: string;
  normalizedName: string; // sorted-token normalized form
  displayName: string;
  weight: number; // heavier row (more transactions/history) survives a merge
}

export type MatchKind = "auto" | "review" | "none";

export interface MatchCandidate {
  keep: IndividualForMatch;
  merge: IndividualForMatch;
  score: number;
  kind: MatchKind;
  reason: string;
}

const AUTO_MIN = 0.88;
const AUTO_TOKEN_MIN = 0.8;
// Require the WHOLE name to be similar to queue a review. A merely-shared surname
// is not enough — otherwise every pair of siblings (Yaakov vs Yoel Neuwirth) would
// be flagged. Genuine spelling variants of a full name (Duestch vs Deutsch ≈ 0.75)
// clear this bar; clearly-different first names do not.
const REVIEW_MIN = 0.72;

export interface PairScore {
  score: number;
  kind: MatchKind;
  reason: string;
}

export function scorePair(aName: string, bName: string): PairScore {
  if (!aName || !bName || aName === bName) return { score: aName === bName ? 1 : 0, kind: "none", reason: "" };
  const score = similarity(aName, bName);
  const ta = aName.split(" ").filter(Boolean);
  const tb = bName.split(" ").filter(Boolean);

  // Single-token typo: same token count, exactly one position differs.
  if (ta.length === tb.length) {
    const diffIdx: number[] = [];
    for (let i = 0; i < ta.length; i++) if (ta[i] !== tb[i]) diffIdx.push(i);
    if (diffIdx.length === 1) {
      const i = diffIdx[0]!;
      const pairSim = similarity(ta[i]!, tb[i]!);
      const editDist = levenshtein(ta[i]!, tb[i]!);
      if (pairSim >= AUTO_TOKEN_MIN && score >= AUTO_MIN) {
        return {
          score,
          kind: "auto",
          reason: `“${ta[i]}” vs “${tb[i]}” — one name part differs by ${editDist} letter${editDist === 1 ? "" : "s"}.`,
        };
      }
    }
  }

  if (score >= REVIEW_MIN) {
    return { score, kind: "review", reason: `Names are ${(score * 100).toFixed(0)}% similar overall.` };
  }
  return { score, kind: "none", reason: "" };
}

/** Compare every pair once; return candidates (kind ≠ none), heaviest row as keep. */
export function findMatchCandidates(individuals: readonly IndividualForMatch[]): MatchCandidate[] {
  const out: MatchCandidate[] = [];
  for (let i = 0; i < individuals.length; i++) {
    for (let j = i + 1; j < individuals.length; j++) {
      const a = individuals[i]!;
      const b = individuals[j]!;
      const { score, kind, reason } = scorePair(a.normalizedName, b.normalizedName);
      if (kind === "none") continue;
      const [keep, merge] =
        a.weight >= b.weight ? [a, b] : [b, a]; // heavier survives; ties keep `a`
      out.push({ keep, merge, score, kind, reason });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}
