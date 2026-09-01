import {
  PDFDocument,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import type { ClassInvoiceRecord } from "@/lib/data/class-invoices";
import type { ClassReimbursementProfile } from "@/lib/data/class-reimbursement-profiles";
import { loadPdfBrandAsset } from "@/lib/documents/pdf-brand-assets";
import { cleanPdfText, embedDocumentFonts, fitPdfText } from "@/lib/documents/pdf-fonts";
import { dec } from "@/lib/money";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 30;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const INK = rgb(0.07, 0.08, 0.1);
const RULE = rgb(0.22, 0.23, 0.25);
const FILL = rgb(0.92, 0.93, 0.94);
const OFFICE_FILL = rgb(0.86, 0.87, 0.88);
const PURPLE = rgb(0.39, 0.08, 0.43);

export const CLASS_REIMBURSEMENT_ATTESTATION = "We are requesting reimbursement for the below mentioned item(s). I understand that the items being purchased, or services being requested are for the sole purpose of helping the individual with independence, promote community inclusion, is provided exclusively for the participant, and does not compromise the individual's health and safety, and are included in the individual's current Life Plan and budget.";

function safe(value: string | null | undefined): string {
  return cleanPdfText(value);
}

function date(value: string | null): string {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${Number(month)}/${Number(day)}/${year}`;
}

function money(value: string): string {
  return `$${Number(dec(value).toDecimalPlaces(2).toFixed(2)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function wrap(value: string, font: PDFFont, size: number, width: number): string[] {
  const words = safe(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawRight(page: PDFPage, value: string, right: number, y: number, size: number, font: PDFFont, color = INK) {
  page.drawText(value, { x: right - font.widthOfTextAtSize(value, size), y, size, font, color });
}

function drawHeader(page: PDFPage, logo: PDFImage, regular: PDFFont, bold: PDFFont) {
  page.drawImage(logo, { x: 300, y: 699.5, width: 255, height: 82.5 });
  const contact = [
    "15 Adelake Fareway",
    "Monroe NY 10950",
    "Tel: 845-774-7000",
    "Fax: 845-774-7007",
    "Email: fi@ahivim.org",
  ];
  contact.forEach((line, index) => drawRight(page, line, PAGE_WIDTH - MARGIN, 688 - index * 12, 8, regular, PURPLE));
  page.drawLine({ start: { x: MARGIN, y: 612 }, end: { x: PAGE_WIDTH - MARGIN, y: 612 }, color: INK, thickness: 1.5 });
  const title = "IDGS REIMBURSEMENT APPLICATION";
  const titleWidth = bold.widthOfTextAtSize(title, 13);
  page.drawText(title, { x: (PAGE_WIDTH - titleWidth) / 2, y: 594, size: 13, font: bold, color: INK });
  page.drawLine({ start: { x: MARGIN, y: 584 }, end: { x: PAGE_WIDTH - MARGIN, y: 584 }, color: INK, thickness: 1.5 });
}

function profileRows(profile: ClassReimbursementProfile): Array<[string, string, string?, string?]> {
  const fullAddress = [profile.addressLine1, profile.addressLine2].filter(Boolean).join(", ");
  return [
    ["Name", profile.mailingName || profile.individualName, "FI", profile.fiscalIntermediary],
    ["Address", fullAddress],
    ["City, State, ZIP", profile.cityStateZip || ""],
    ["Phone", profile.phone || ""],
    ["DOB", date(profile.dateOfBirth)],
    ["Medicaid ID", profile.medicaidId || ""],
    ["Make Check Payable to", profile.payableTo],
  ];
}

function drawProfile(page: PDFPage, profile: ClassReimbursementProfile, regular: PDFFont, bold: PDFFont) {
  const x = MARGIN;
  const top = 560;
  const rowHeight = 18;
  const labelWidth = 142;
  const secondaryLabelX = 340;
  const secondaryValueX = 430;
  profileRows(profile).forEach((row, index) => {
    const y = top - index * rowHeight;
    page.drawRectangle({ x, y: y - rowHeight, width: CONTENT_WIDTH, height: rowHeight, borderColor: RULE, borderWidth: 0.55 });
    page.drawRectangle({ x, y: y - rowHeight, width: labelWidth, height: rowHeight, color: FILL });
    page.drawLine({ start: { x: x + labelWidth, y }, end: { x: x + labelWidth, y: y - rowHeight }, color: RULE, thickness: 0.55 });
    page.drawText(`${row[0]}:`, { x: x + 5, y: y - 12.5, size: 8, font: bold, color: INK });
    const primary = fitPdfText(safe(row[1]), regular, 8, row[2] ? 155 : CONTENT_WIDTH - labelWidth - 10);
    page.drawText(primary.text, { x: x + labelWidth + 5, y: y - 12.5, size: primary.size, font: regular, color: INK });
    if (row[2]) {
      page.drawRectangle({ x: secondaryLabelX, y: y - rowHeight, width: secondaryValueX - secondaryLabelX, height: rowHeight, color: FILL });
      page.drawLine({ start: { x: secondaryLabelX, y }, end: { x: secondaryLabelX, y: y - rowHeight }, color: RULE, thickness: 0.55 });
      page.drawLine({ start: { x: secondaryValueX, y }, end: { x: secondaryValueX, y: y - rowHeight }, color: RULE, thickness: 0.55 });
      page.drawText(`${row[2]}:`, { x: secondaryLabelX + 5, y: y - 12.5, size: 8, font: bold, color: INK });
      const secondary = fitPdfText(safe(row[3]), regular, 8, PAGE_WIDTH - MARGIN - secondaryValueX - 10);
      page.drawText(secondary.text, { x: secondaryValueX + 5, y: y - 12.5, size: secondary.size, font: regular, color: INK });
    }
  });
}

function drawAttestation(page: PDFPage, bold: PDFFont) {
  let size = 6.7;
  let lines = wrap(CLASS_REIMBURSEMENT_ATTESTATION, bold, size, CONTENT_WIDTH);
  while (lines.length > 4 && size > 5.5) {
    size -= 0.2;
    lines = wrap(CLASS_REIMBURSEMENT_ATTESTATION, bold, size, CONTENT_WIDTH);
  }
  lines.forEach((line, index) => {
    page.drawText(line, { x: MARGIN, y: 426 - index * 8, size, font: bold, color: INK });
  });
}

function drawExpenseTable(page: PDFPage, invoice: ClassInvoiceRecord, profile: ClassReimbursementProfile, regular: PDFFont, bold: PDFFont) {
  const top = 392;
  const headerHeight = 34;
  const rowHeight = 24;
  const widths = [76, 128, 92, 94, 92, 70];
  const labels = ["Invoice Date", "Description", "Life Plan", "Budget Category", "Office Use", "Amount"];
  let x = MARGIN;
  widths.forEach((width, index) => {
    page.drawRectangle({ x, y: top - headerHeight, width, height: headerHeight, color: index === 4 ? OFFICE_FILL : FILL, borderColor: RULE, borderWidth: 0.55 });
    const labelLines = wrap(labels[index]!, bold, 6.4, width - 8).slice(0, 3);
    labelLines.forEach((line, lineIndex) => {
      const labelWidth = bold.widthOfTextAtSize(line, 6.4);
      page.drawText(line, { x: x + (width - labelWidth) / 2, y: top - 12 - lineIndex * 8, size: 6.4, font: bold, color: INK });
    });
    x += width;
  });

  const activities = [...new Set(invoice.lines.map((line) => line.description))].join(", ");
  const values = [
    date(invoice.invoiceDate),
    activities,
    profile.lifePlanConfirmed ? "Yes" : "No",
    profile.budgetCategory,
    "",
    money(invoice.totalAmount),
  ];
  x = MARGIN;
  widths.forEach((width, index) => {
    page.drawRectangle({ x, y: top - headerHeight - rowHeight, width, height: rowHeight, color: index === 4 ? OFFICE_FILL : undefined, borderColor: RULE, borderWidth: 0.55 });
    const value = safe(values[index]);
    const font = index === 5 ? bold : regular;
    const fitted = fitPdfText(value, font, index === 5 ? 11 : 8, width - 8);
    const textWidth = font.widthOfTextAtSize(fitted.text, fitted.size);
    page.drawText(fitted.text, { x: x + Math.max(4, (width - textWidth) / 2), y: top - headerHeight - 16, size: fitted.size, font, color: INK });
    x += width;
  });

  for (let row = 1; row < 11; row += 1) {
    x = MARGIN;
    widths.forEach((width, index) => {
      page.drawRectangle({ x, y: top - headerHeight - rowHeight * (row + 1), width, height: rowHeight, color: index === 4 ? OFFICE_FILL : undefined, borderColor: RULE, borderWidth: 0.45 });
      x += width;
    });
  }

  const totalY = top - headerHeight - rowHeight * 11;
  page.drawRectangle({ x: MARGIN, y: totalY, width: CONTENT_WIDTH, height: 26, color: FILL, borderColor: RULE, borderWidth: 0.75 });
  page.drawText("TOTAL DUE", { x: MARGIN + 6, y: totalY + 8, size: 10, font: bold, color: INK });
  drawRight(page, money(invoice.totalAmount), PAGE_WIDTH - MARGIN - 7, totalY + 7, 12, bold, INK);

  return totalY;
}

function drawSignature(page: PDFPage, invoice: ClassInvoiceRecord, profile: ClassReimbursementProfile, y: number, regular: PDFFont, bold: PDFFont) {
  const rowHeight = 20;
  const split = 340;
  page.drawRectangle({ x: MARGIN, y: y - rowHeight, width: CONTENT_WIDTH, height: rowHeight, borderColor: RULE, borderWidth: 0.55 });
  page.drawLine({ start: { x: split, y }, end: { x: split, y: y - rowHeight }, color: RULE, thickness: 0.55 });
  page.drawText("Person Completing Form:", { x: MARGIN + 5, y: y - 13.5, size: 8, font: regular, color: INK });
  const completedBy = fitPdfText(safe(profile.formCompletedBy), bold, 8, split - 155);
  page.drawText(completedBy.text, { x: 150, y: y - 13.5, size: completedBy.size, font: bold, color: INK });
  page.drawText("Title/Relationship:", { x: split + 5, y: y - 13.5, size: 8, font: bold, color: INK });
  const relationship = fitPdfText(safe(profile.relationship), regular, 8, PAGE_WIDTH - MARGIN - 460);
  page.drawText(relationship.text, { x: 455, y: y - 13.5, size: relationship.size, font: regular, color: INK });

  page.drawRectangle({ x: MARGIN, y: y - rowHeight * 2, width: CONTENT_WIDTH, height: rowHeight, borderColor: RULE, borderWidth: 0.55 });
  page.drawLine({ start: { x: split, y: y - rowHeight }, end: { x: split, y: y - rowHeight * 2 }, color: RULE, thickness: 0.55 });
  page.drawText("Signature:", { x: MARGIN + 5, y: y - rowHeight - 13.5, size: 8, font: regular, color: INK });
  page.drawText("Date:", { x: split + 5, y: y - rowHeight - 13.5, size: 8, font: bold, color: INK });
  page.drawText(date(invoice.invoiceDate), { x: 455, y: y - rowHeight - 13.5, size: 8, font: regular, color: INK });
}

/** Build a searchable monthly reimbursement cover sheet with a blank signature line. */
export async function buildClassCoverSheetPdf(
  invoice: ClassInvoiceRecord,
  profile: ClassReimbursementProfile,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle(`Reimbursement application ${invoice.invoiceNumber}`);
  document.setAuthor("Ahivim");
  document.setCreator("Ahivim Budget Management");
  const [{ regular, bold }, logo] = await Promise.all([
    embedDocumentFonts(document, [
      invoice.individualName,
      invoice.billToName,
      invoice.purpose,
      ...invoice.lines.map((line) => line.description),
      ...Object.values(profile),
    ]),
    loadPdfBrandAsset("ahivim-cover.png").then((bytes) => document.embedPng(bytes)),
  ]);
  const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawHeader(page, logo, regular, bold);
  drawProfile(page, profile, regular, bold);
  drawAttestation(page, bold);
  const totalY = drawExpenseTable(page, invoice, profile, regular, bold);
  drawSignature(page, invoice, profile, totalY - 12, regular, bold);
  return document.save();
}
