import ExcelJS from "exceljs";

/**
 * A synthetic Ahivim workbook.
 *
 * The real Excellent_Staffing_2025-2026.xlsx is not committed to the
 * repository (it is client payroll data), so the import tests build a workbook
 * with the same structure: header on row 2, transactions from row 3, and the
 * control totals in P1/Q1/R1/S1 that make reconciliation possible.
 *
 * The fixture deliberately contains one of each interesting case:
 *   - a Com Hab agency row      (21/25 conversion)
 *   - a Respite agency row      (17/19 conversion)
 *   - a three-person Day Hab group priced on the AGENCY ladder (3 x $19 = $57)
 *   - a Self-Hire Respite row at $23 where the schedule says $18 (rate exception)
 *   - a self-hire row, which never converts (ratio 1.0)
 */

export const AGENCY_PAYEE = "Excellent Staffing";

export interface FixtureRow {
  payTo: string;
  checkDate: string;
  checkNumber: string;
  code: string;
  hours: number;
  rate: number;
  amount: number;
  totalNetPay: number;
  periodBegin: string;
  periodEnd: string;
  program: string;
  individual: string;
  employee: string;
  internalAmount: number;
}

/** 13h x $57 combined / 3 members = $247 agency each; 247 x 17/19 = $221 internal. */
export const GROUP_ROWS: FixtureRow[] = ["Aaron Levy", "Bella Stern", "Chaya Roth"].map(
  (individual) => ({
    payTo: AGENCY_PAYEE,
    checkDate: "2025-02-20",
    checkNumber: "1002",
    code: "RG",
    hours: 13,
    rate: 57,
    amount: 247,
    totalNetPay: 247,
    periodBegin: "2025-02-01",
    periodEnd: "2025-02-15",
    program: "Day Hab",
    individual,
    employee: "Miriam Klein",
    internalAmount: 221,
  }),
);

export const SINGLE_ROWS: FixtureRow[] = [
  {
    payTo: AGENCY_PAYEE,
    checkDate: "2025-01-10",
    checkNumber: "1001",
    code: "RG",
    hours: 10,
    rate: 25,
    amount: 250,
    totalNetPay: 250,
    periodBegin: "2025-01-01",
    periodEnd: "2025-01-15",
    program: "Com Hab",
    individual: "David Green",
    employee: "Sarah Cohen",
    internalAmount: 210, // 250 x 21/25
  },
  {
    payTo: AGENCY_PAYEE,
    checkDate: "2025-01-10",
    checkNumber: "1001",
    code: "RG",
    hours: 5,
    rate: 19,
    amount: 95,
    totalNetPay: 95,
    periodBegin: "2025-01-01",
    periodEnd: "2025-01-15",
    program: "Respite",
    individual: "David Green",
    employee: "Sarah Cohen",
    internalAmount: 85, // 95 x 17/19
  },
  {
    // Self-Hire Respite is configured at $18. This row is at $23: preserved
    // exactly, flagged as a rate exception, and still imported.
    payTo: "Rachel Adler",
    checkDate: "2025-03-05",
    checkNumber: "1003",
    code: "RG",
    hours: 4,
    rate: 23,
    amount: 92,
    totalNetPay: 92,
    periodBegin: "2025-03-01",
    periodEnd: "2025-03-15",
    program: "Self-Hire Respite",
    individual: "Esther Weiss",
    employee: "Rachel Adler",
    internalAmount: 92, // self-hire never converts
  },
];

export const ALL_ROWS: FixtureRow[] = [...SINGLE_ROWS, ...GROUP_ROWS];

export const EXPECTED_AGENCY_GROSS = ALL_ROWS.reduce((sum, r) => sum + r.amount, 0); // 1178
export const EXPECTED_INTERNAL_AMOUNT = ALL_ROWS.reduce((sum, r) => sum + r.internalAmount, 0); // 1050

const HEADERS = [
  "Pay to",
  "Check Date",
  "Check Number",
  "Code",
  "Hours",
  "Rate",
  "Amount",
  "Total Net Pay",
  "Period Begin",
  "Period End",
  "Paid CC2 Description",
  "Paid CC3 Description",
  "Employee Memo",
  "",
  "Non contract",
  "Internal Amount",
  "",
  "",
  "Deduplicated Net Pay",
];

export async function buildWorkbook(rows: FixtureRow[] = ALL_ROWS): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Ahivim");

  const agencyGross = rows.reduce((sum, r) => sum + r.amount, 0);
  const internalAmount = rows.reduce((sum, r) => sum + r.internalAmount, 0);
  const netPay = rows.reduce((sum, r) => sum + r.totalNetPay, 0);

  // Row 1: control totals in P1 (internal), Q1 (agency gross), R1, S1.
  const control = sheet.getRow(1);
  control.getCell(16).value = internalAmount;
  control.getCell(17).value = agencyGross;
  control.getCell(18).value = agencyGross - internalAmount;
  control.getCell(19).value = netPay;
  control.commit();

  const header = sheet.getRow(2);
  HEADERS.forEach((label, index) => {
    if (label) header.getCell(index + 1).value = label;
  });
  header.commit();

  rows.forEach((row, index) => {
    const r = sheet.getRow(3 + index);
    r.getCell(1).value = row.payTo;
    r.getCell(2).value = row.checkDate;
    r.getCell(3).value = row.checkNumber;
    r.getCell(4).value = row.code;
    r.getCell(5).value = row.hours;
    r.getCell(6).value = row.rate;
    r.getCell(7).value = row.amount;
    r.getCell(8).value = row.totalNetPay;
    r.getCell(9).value = row.periodBegin;
    r.getCell(10).value = row.periodEnd;
    r.getCell(11).value = row.program;
    r.getCell(12).value = row.individual;
    r.getCell(13).value = row.employee;
    r.getCell(15).value = "";
    r.getCell(16).value = row.internalAmount;
    r.getCell(19).value = row.totalNetPay;
    r.commit();
  });

  const calc = workbook.addWorksheet("Calculations");
  calc.getRow(1).values = ["Account", "First Cut %", "Second Cut %"];
  calc.getRow(2).values = ["rates", 21, 17];
  calc.commit?.();

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}
