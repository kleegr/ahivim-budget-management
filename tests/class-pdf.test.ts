import { describe, expect, it } from "vitest";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildClassCoverSheetPdf } from "@/lib/documents/class-cover-sheet-pdf";
import { buildClassInvoicePdf } from "@/lib/documents/class-invoice-pdf";
import type { ClassInvoiceRecord } from "@/lib/data/class-invoices";
import type { ClassReimbursementProfile } from "@/lib/data/class-reimbursement-profiles";
import { fitPdfText } from "@/lib/documents/pdf-fonts";

function invoice(lineCount = 22): ClassInvoiceRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    classBudgetPeriodId: "00000000-0000-4000-8000-000000000002",
    individualId: "00000000-0000-4000-8000-000000000003",
    individualName: "Sample Individual",
    budgetLabel: "2026 class allowance",
    invoiceNumber: "8514",
    invoiceDate: "2026-08-02",
    servicePeriodStart: "2026-07-01",
    servicePeriodEnd: "2026-07-31",
    billToName: "Sample Individual",
    billToAddressLine1: "100 Main Street",
    billToAddressLine2: null,
    billToCityStateZip: "Monroe NY 10950",
    purpose: "CLASSES",
    notes: null,
    status: "issued",
    subtotal: String(lineCount * 150),
    discountTotal: "0",
    totalAmount: String(lineCount * 150),
    budgetAuthorizedSnapshot: "20000",
    budgetConsumedBeforeSnapshot: "0",
    budgetOverageSnapshot: "0",
    overBudgetOverrideReason: null,
    issuedAt: "2026-08-02T12:00:00.000Z",
    voidedAt: null,
    voidReason: null,
    createdAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T12:00:00.000Z",
    lines: Array.from({ length: lineCount }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      activityId: null,
      activityCode: "EXERCISE",
      serviceDate: `2026-07-${String(index + 1).padStart(2, "0")}`,
      description: index % 3 === 0 ? "Exercise Class" : index % 3 === 1 ? "Art Class" : "Music Class",
      quantity: "1",
      unitPrice: "150",
      discountAmount: "0",
      lineTotal: "150",
      sortOrder: index,
      notes: null,
    })),
  };
}

const profile: ClassReimbursementProfile = {
  id: null,
  individualId: "00000000-0000-4000-8000-000000000003",
  individualName: "Sample Individual",
  mailingName: "Sample Individual",
  addressLine1: "100 Main Street",
  addressLine2: null,
  cityStateZip: "Monroe NY 10950",
  phone: "845-555-0100",
  dateOfBirth: "2000-01-01",
  medicaidId: "SAMPLE-ID",
  fiscalIntermediary: "Ahivim",
  payableTo: "Xcellent Staffing",
  lifePlanConfirmed: true,
  budgetCategory: "Community classes",
  formCompletedBy: "Authorized Representative",
  relationship: "Representative",
  updatedAt: null,
};

describe("class PDF generation", () => {
  it("keeps a standard 22-line monthly invoice on one letter page", async () => {
    const pdf = await PDFDocument.load(await buildClassInvoicePdf(invoice()));
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(pdf.getTitle()).toBe("Invoice 8514");
  });

  it("continues exceptional invoices onto another page", async () => {
    const pdf = await PDFDocument.load(await buildClassInvoicePdf(invoice(24)));
    expect(pdf.getPageCount()).toBe(2);
  });

  it("creates a one-page reimbursement application with no form fields", async () => {
    const pdf = await PDFDocument.load(await buildClassCoverSheetPdf(invoice(), profile));
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(pdf.getForm().getFields()).toEqual([]);
  });

  it("preserves Unicode names and activities without failing PDF generation", async () => {
    const unicodeInvoice = invoice(1);
    unicodeInvoice.billToName = "שלום לוי";
    unicodeInvoice.individualName = "שלום לוי";
    unicodeInvoice.lines[0]!.description = "מוזיקה";
    const unicodeProfile = {
      ...profile,
      individualName: "שלום לוי",
      mailingName: "שלום לוי",
    };

    await expect(buildClassInvoicePdf(unicodeInvoice)).resolves.toBeInstanceOf(Uint8Array);
    await expect(buildClassCoverSheetPdf(unicodeInvoice, unicodeProfile)).resolves.toBeInstanceOf(Uint8Array);
  }, 20_000);

  it("embeds real Hebrew glyphs rather than missing-glyph placeholders", async () => {
    const bytes = await readFile(join(process.cwd(), "assets", "fonts", "NotoSansHebrew-Regular.ttf"));
    const font = fontkit.create(bytes);
    const glyphIds = [0x05e9, 0x05dc, 0x05d5, 0x05dd]
      .map((codePoint) => font.glyphForCodePoint(codePoint).id);

    expect(glyphIds.every((id) => id > 0)).toBe(true);
  });

  it("hard-bounds unusually long dynamic fields", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const fitted = fitPdfText("A very long reimbursement value ".repeat(30), font, 10, 120);
    expect(font.widthOfTextAtSize(fitted.text, fitted.size)).toBeLessThanOrEqual(120);

    const longInvoice = invoice(1);
    longInvoice.billToName = "Long individual name ".repeat(25);
    longInvoice.purpose = "Community activity purpose ".repeat(20);
    longInvoice.lines[0]!.description = "Long activity description ".repeat(30);
    await expect(buildClassInvoicePdf(longInvoice)).resolves.toBeInstanceOf(Uint8Array);
    await expect(buildClassCoverSheetPdf(longInvoice, {
      ...profile,
      medicaidId: "MEDICAID-".repeat(60),
      relationship: "Authorized representative ".repeat(20),
    })).resolves.toBeInstanceOf(Uint8Array);
  }, 20_000);
});
