/**
 * PROGRAM NORMALIZATION
 * =====================
 *
 * Imported program descriptions are mapped to canonical programs through an
 * EXPLICIT alias table. Unknown descriptions are never merged into a canonical
 * program by similarity — they are reported as unknown so a human can decide.
 *
 * VERIFIED: the 2025-2026 workbook contains exactly six distinct labels, all of
 * which resolve through the seed aliases below:
 *   Com Hab (887), Day Hab (829), Supplemental Group Day Hab (449),
 *   SD - Self Hired Com Hab (360), Respite (322), SD - Self Hired Respite (222)
 */

export const PROGRAM_CODES = {
  COM_HAB: "COM_HAB",
  RESPITE: "RESPITE",
  SH_COM_HAB: "SH_COM_HAB",
  SH_RESPITE: "SH_RESPITE",
  DAY_HAB: "DAY_HAB",
  SUPP_GROUP_DAY_HAB: "SUPP_GROUP_DAY_HAB",
} as const;

export type ProgramCode = (typeof PROGRAM_CODES)[keyof typeof PROGRAM_CODES];

export interface CanonicalProgram {
  code: ProgramCode;
  name: string;
  isGroupCapable: boolean;
}

export const CANONICAL_PROGRAMS: CanonicalProgram[] = [
  { code: "COM_HAB", name: "Com Hab", isGroupCapable: false },
  { code: "RESPITE", name: "Respite", isGroupCapable: false },
  { code: "SH_COM_HAB", name: "Self-Hire Com Hab", isGroupCapable: false },
  { code: "SH_RESPITE", name: "Self-Hire Respite", isGroupCapable: false },
  { code: "DAY_HAB", name: "Day Hab", isGroupCapable: true },
  { code: "SUPP_GROUP_DAY_HAB", name: "Supplemental Group Day Hab", isGroupCapable: true },
];

/** Seed aliases. Additional aliases are added to program_aliases at import review. */
export const SEED_PROGRAM_ALIASES: Record<string, ProgramCode> = {
  "com hab": "COM_HAB",
  comhab: "COM_HAB",
  ch: "COM_HAB",
  "community habilitation": "COM_HAB",

  respite: "RESPITE",
  resp: "RESPITE",

  "self hire com hab": "SH_COM_HAB",
  "self hired com hab": "SH_COM_HAB",
  "selfhire com hab": "SH_COM_HAB",
  shch: "SH_COM_HAB",
  "sd self hired com hab": "SH_COM_HAB",

  "self hire respite": "SH_RESPITE",
  "self hired respite": "SH_RESPITE",
  "sd self hired respite": "SH_RESPITE",
  shr: "SH_RESPITE",

  "day hab": "DAY_HAB",
  dayhab: "DAY_HAB",
  dh: "DAY_HAB",

  "supplemental group day hab": "SUPP_GROUP_DAY_HAB",
  "supplemental group day habilitation": "SUPP_GROUP_DAY_HAB",
  "suppl group day hab": "SUPP_GROUP_DAY_HAB",
  "group day hab": "SUPP_GROUP_DAY_HAB",
  sdh: "SUPP_GROUP_DAY_HAB",
};

/**
 * Collapse case, punctuation and spacing so that "SD - Self Hired Com Hab",
 * "SD  Self-Hired  Com Hab" and "sd self hired com hab" become one key.
 */
export function normalizeProgramLabel(label: string | null | undefined): string {
  return (label ?? "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[-_/\\.,()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ProgramResolution {
  matched: boolean;
  /** Database-backed catalogs may add programs beyond the six seed codes. */
  code: string | null;
  normalizedLabel: string;
  sourceText: string;
  reason: string;
}

export function resolveProgram(
  sourceText: string | null | undefined,
  aliases: Readonly<Record<string, string>> = SEED_PROGRAM_ALIASES,
): ProgramResolution {
  const normalizedLabel = normalizeProgramLabel(sourceText);
  const raw = (sourceText ?? "").trim();

  if (normalizedLabel === "") {
    return {
      matched: false,
      code: null,
      normalizedLabel,
      sourceText: raw,
      reason: "Program description is blank.",
    };
  }

  const code = aliases[normalizedLabel];
  if (code) {
    return {
      matched: true,
      code,
      normalizedLabel,
      sourceText: raw,
      reason: "Matched an approved program alias.",
    };
  }

  return {
    matched: false,
    code: null,
    normalizedLabel,
    sourceText: raw,
    reason:
      "No approved alias for this program description. Map it explicitly before importing; " +
      "it will not be merged automatically.",
  };
}
