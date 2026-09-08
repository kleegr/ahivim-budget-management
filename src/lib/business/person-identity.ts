import { matchPerson, normalizePersonName, type AliasRecord, type CanonicalRecord, type MatchOptions, type NameMatchResult } from "./name-matching";

export interface PersonIdentityDirectory {
  people: readonly (CanonicalRecord & { status?: string; mergedIntoId?: string | null })[];
  aliases: readonly AliasRecord[];
  merges?: readonly { mergedId: string; survivorId: string; mergedName: string }[];
}
export interface PersonIdentityMatch extends NameMatchResult {
  possibleIds: ReadonlySet<string>;
}

/** Exact identity and recorded merge evidence; fuzzy suggestions are never applied. */
export function createPersonIdentityResolver(
  directory: PersonIdentityDirectory, options: MatchOptions = {}, kind: "employee" | "individual" = "individual",
) {
  const personIds = new Set(directory.people.map(person => person.id));
  const canonical = directory.people.filter(person => {
    if (person.status !== "archived" || normalizePersonName(person.displayName) !== person.normalizedName) return true;
    const aliases = directory.aliases.filter(alias => alias.status === "approved" && alias.normalizedAlias === person.normalizedName);
    if (new Set(aliases.map(alias => alias.targetId)).size !== 1) return true;
    const survivorId = aliases[0]!.targetId;
    // Individuals retain an explicit merge pointer. Its absence/disagreement
    // can represent a correction; old append-only audits must not override it.
    if ((kind === "individual" || person.mergedIntoId !== undefined) && person.mergedIntoId !== survivorId) return true;
    if (!directory.people.some(candidate => candidate.id === survivorId && candidate.status === "active"
      && (candidate.mergedIntoId === null || (kind === "employee" && candidate.mergedIntoId === undefined)))) return true;
    const merges = (directory.merges ?? []).filter(merge => merge.mergedId === person.id);
    return !merges.length || merges.some(merge => merge.survivorId !== survivorId
      || typeof merge.mergedName !== "string" || normalizePersonName(merge.mergedName) !== person.normalizedName);
  });
  const cache = new Map<string, PersonIdentityMatch>();
  return (name: string | null | undefined): PersonIdentityMatch => {
    const key = normalizePersonName(name), cached = cache.get(key);
    if (cached) return { ...cached, sourceText: (name ?? "").trim() };
    const match = matchPerson(name, canonical, directory.aliases, options);
    const aliases = directory.aliases.filter(alias => alias.status === "approved" && alias.normalizedAlias === key);
    // Fold evidence alone never approves a survivor, but prevents new payroll
    // from falling back to an archived record when approval is withdrawn.
    const unresolvedFold = directory.people.some(person => person.id === match.matchedId
      && (kind === "individual" ? person.mergedIntoId != null
        : person.status === "archived" && (directory.merges ?? []).some(merge => merge.mergedId === person.id
          && typeof merge.mergedName === "string" && normalizePersonName(merge.mergedName) === person.normalizedName)));
    const contradictory = aliases.some(alias => alias.targetId !== match.matchedId)
      || (match.matchedId !== null && !personIds.has(match.matchedId)) || unresolvedFold;
    const result: PersonIdentityMatch = { ...match,
      ...(contradictory ? { outcome: "ambiguous" as const, matchedId: null,
        reason: `The recorded ${kind} and approved match or merge history disagree. Review the ${kind} match.` } : {}),
      possibleIds: new Set([...canonical.filter(person => person.normalizedName === key).map(person => person.id),
        ...aliases.map(alias => alias.targetId),
        // Guard-only candidates keep unresolved folded siblings inside a
        // possible whole-check group. They never produce a matched identity.
        ...directory.people.filter(person => person.normalizedName === key).flatMap(person => kind === "individual"
          ? person.mergedIntoId != null ? [person.mergedIntoId] : []
          : person.status === "archived" ? (directory.merges ?? []).filter(merge => merge.mergedId === person.id
            && typeof merge.mergedName === "string" && normalizePersonName(merge.mergedName) === key)
            .map(merge => merge.survivorId) : [])]),
    };
    cache.set(key, result);
    return result;
  };
}
