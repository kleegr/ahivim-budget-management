import { z } from "zod";

/**
 * WORKBOOK COLUMN MAP
 * ===================
 *
 * VERIFIED against Excellent_Staffing_2025-2026.xlsx.
 *
 * The Ahivim sheet is 3,071 rows x 25 columns. The header is row 2 and the
 * first transaction is row 3, giving 3,069 data rows with no blank rows.
 *
 * Three header labels differ from the names used in the brief. The data behind
 * them is what the brief described, but the labels matter for header matching:
 *
 *   K  "Paid CC2 Description"  -> the PROGRAM
 *   L  "Paid CC3 Description"  -> the INDIVIDUAL receiving the service
 *   M  "Employee Memo"         -> the EMPLOYEE performing the service
 *
 * Row 1 carries workbook control totals used for reconciliation:
 *   P1 = SUBTOTAL(109, P3:P3071)  internal amount   1,430,370.965
 *   Q1 = SUBTOTAL(109, G3:G3071)  agency gross      1,575,583.05
 *   R1 = Q1 - P1                  agency retention    145,212.0853
 *   S1 = SUBTOTAL(109, S3:S3071)  deduplicated net  1,516,250.51
 */

export const AHIVIM_SHEET = "Ahivim";
export const CALCULATIONS_SHEET = "Calculations";

/** Cells on the Ahivim sheet holding workbook control totals. */
export const CONTROL_TOTAL_CELLS = {
  internalAmount: { row: 1, col: 16 }, // P1
  agencyGross: { row: 1, col: 17 }, // Q1
  agencyRetention: { row: 1, col: 18 }, // R1
  deduplicatedNetPay: { row: 1, col: 19 }, // S1
} as const;

export type AhivimField =
  | "payTo"
  | "checkDate"
  | "checkNumber"
  | "code"
  | "hours"
  | "rate"
  | "amount"
  | "totalNetPay"
  | "periodBegin"
  | "periodEnd"
  | "programDescription"
  | "individual"
  | "employee"
  | "nonContractHeader"
  | "calculatedInternalAmount"
  | "dedupNetPayFormula";

/** Verified positional map (1-indexed columns). */
export const AHIVIM_POSITIONAL: Record<AhivimField, number> = {
  payTo: 1, // A  Pay to
  checkDate: 2, // B  Check Date
  checkNumber: 3, // C  Check Number
  code: 4, // D  Code            (always "RG" in the 2025-2026 file)
  hours: 5, // E  Hours
  rate: 6, // F  Rate            (COMBINED rate on a group row)
  amount: 7, // G  Amount          (agency gross)
  totalNetPay: 8, // H  Total Net Pay
  periodBegin: 9, // I  Period Begin
  periodEnd: 10, // J  Period End
  programDescription: 11, // K  Paid CC2 Description
  individual: 12, // L  Paid CC3 Description
  employee: 13, // M  Employee Memo
  nonContractHeader: 15, // O  Non contract
  calculatedInternalAmount: 16, // P  Amount (internal)
  dedupNetPayFormula: 19, // S  Total Net Pay (deduplicated)
};

/**
 * Header labels accepted for each field, normalized.
 *
 * Both the brief's names and the workbook's actual names are listed, so the
 * parser matches this file and stays tolerant of a relabelled future export.
 */
export const AHIVIM_HEADER_ALIASES: Record<AhivimField, string[]> = {
  payTo: ["pay to", "payto", "payee"],
  checkDate: ["check date", "chk date", "date"],
  checkNumber: ["check number", "check no", "check #", "chk no", "check num"],
  code: ["code"],
  hours: ["hours", "hrs", "qty", "quantity"],
  rate: ["rate", "hourly rate"],
  amount: ["amount", "gross", "gross amount"],
  totalNetPay: ["total net pay", "net pay", "total net"],
  periodBegin: ["period begin", "period beginning", "pay period begin", "begin"],
  periodEnd: ["period end", "period ending", "pay period end", "end"],
  programDescription: [
    "paid cc2 description",
    "program description",
    "program",
    "description",
    "service",
  ],
  individual: ["paid cc3 description", "individual", "consumer", "participant"],
  employee: ["employee memo", "employee", "staff", "worker"],
  nonContractHeader: ["non contract", "non-contract", "noncontract"],
  calculatedInternalAmount: ["internal amount", "calculated internal amount", "internal"],
  dedupNetPayFormula: ["dedup net pay", "deduplicated net pay", "unique net pay"],
};

export const REQUIRED_AHIVIM_FIELDS: AhivimField[] = [
  "hours",
  "rate",
  "amount",
  "programDescription",
  "individual",
];

export function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\\u2010-\\u2015]/g, "-")
    .replace(/[^a-z0-9 #-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/** Money/hours arrive as spreadsheet text. Keep them as strings end to end. */
const numericText = z
  .string()
  .trim()
  .refine((v) => v === "" || /^-?\$?[\d,]*\.?\d+$/.test(v.replace(/\s/g, "")), {
    message: "Not a usable number",
  });

const dateText = z
  .string()
  .trim()
  .refine((v) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v), {
    message: "Expected an ISO date (YYYY-MM-DD)",
  });

/**
 * Only the five fields that actually define a billable transaction are strict:
 * hours, rate, amount, program and individual. Everything else is metadata. A
 * bad value in an optional column (a stray character in Total Net Pay, an
 * unparseable secondary date) must NEVER discard an otherwise-valid transaction
 * — that quietly understated the ledger. `.catch("")` blanks the offending
 * optional value and keeps the row; the raw text is still preserved on the
 * import row for audit.
 */
export const ahivimRowSchema = z.object({
  payTo: z.string().trim().max(200).catch(""),
  checkDate: dateText.catch(""),
  checkNumber: z.string().trim().max(50).catch(""),
  code: z.string().trim().max(50).catch(""),
  hours: numericText,
  rate: numericText,
  amount: numericText,
  totalNetPay: numericText.catch(""),
  periodBegin: dateText.catch(""),
  periodEnd: dateText.catch(""),
  programDescription: z.string().trim().min(1, "Program description is required").max(200),
  individual: z.string().trim().min(1, "Individual is required").max(200),
  employee: z.string().trim().max(200).catch(""),
  nonContractHeader: z.string().trim().max(200).catch(""),
  calculatedInternalAmount: numericText.catch(""),
  dedupNetPayFormula: z.string().trim().max(500).catch(""),
});

export type AhivimRow = z.infer<typeof ahivimRowSchema>;

/**
 * Calculations sheet, VERIFIED.
 *
 * Row 1 is the header, row 2 holds the internal rates, and individual account
 * records run from row 5 to row 27 (23 accounts).
 *
 *   A  name              B  budget period start   C  1st %      D  2nd %
 *   E  Clock             F  Adjustments
 *   G  ComHab  H Respite  I SHCH  J SHR  K DayHab  L SDH   <- AUTHORIZED HOURS
 *   N  Yearly Gross      O  Monthly Gross         P  Gross Net
 *   Q  Net               R  After All (third cut) S  unresolved category label
 *
 * Row 2 rates: G=21 H=17 I=38 J=18 K=17 L=17 — all six confirmed.
 *
 * N is SUM(hours x rate) over G..L, which is why hours are the authoritative
 * authorization and the dollar figure is derived.
 *
 * P implements the sequential cut:
 *   O - (O * C/100) - ((O - (O * C/100)) * D/100)
 * confirming the second cut is taken from the balance after the first.
 */
export const CALCULATIONS_LAYOUT = {
  headerRow: 1,
  rateRow: 2,
  firstAccountRow: 5,
  columns: {
    name: 1,
    periodStart: 2,
    firstCutPercent: 3,
    secondCutPercent: 4,
    clock: 5,
    adjustments: 6,
    hoursComHab: 7,
    hoursRespite: 8,
    hoursSelfHireComHab: 9,
    hoursSelfHireRespite: 10,
    hoursDayHab: 11,
    hoursSuppGroupDayHab: 12,
    yearlyGross: 14,
    monthlyGross: 15,
    grossNet: 16,
    net: 17,
    afterAll: 18,
    unresolvedColumnS: 19,
  },
  /** Rate-row column -> canonical program code. */
  rateColumnToProgram: {
    7: "COM_HAB",
    8: "RESPITE",
    9: "SH_COM_HAB",
    10: "SH_RESPITE",
    11: "DAY_HAB",
    12: "SUPP_GROUP_DAY_HAB",
  } as Record<number, string>,
} as const;

export const calculationsConfigSchema = z.object({
  programLabel: z.string().trim().min(1),
  internalRate: numericText,
});

export const UPLOAD_LIMITS = {
  maxBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 20 * 1024 * 1024),
  allowedExtensions: [".xlsx"],
  allowedMimeTypes: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream", // some browsers send this for .xlsx
  ],
} as const;
