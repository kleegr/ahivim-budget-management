import {
  PDFDocument,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import type { ClassInvoiceRecord } from "@/lib/data/class-invoices";
import { loadPdfBrandAsset } from "@/lib/documents/pdf-brand-assets";
import { cleanPdfText, embedDocumentFonts, fitPdfText } from "@/lib/documents/pdf-fonts";
import { dec } from "@/lib/money";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 42;
const TABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;
const ROW_HEIGHT = 18;
const ROWS_PER_PAGE = 23;
const COLUMNS = [72, 170, 58, 72, 72, 84] as const;
const HEADER_LABELS = ["Date", "Description", "Qty", "Price", "Discount", "Total"] as const;

const BRAND = {
  name: "XCELLENT STAFFING",
  tagline: "THE #1 PLACE TO MAXIMIZE YOUR TALENT",
  address1: "17 VICTORIA DRIVE",
  address2: "AIRMONT NY, 10901",
  phone: "Phone 845-666-3533",
  email: "3303370@gmail.com",
};

const INK = rgb(0.07, 0.09, 0.11);
const MUTED = rgb(0.42, 0.44, 0.46);
const RULE = rgb(0.15, 0.17, 0.18);
const HEADER_FILL = rgb(0.94, 0.95, 0.95);
const TEAL = rgb(0.02, 0.39, 0.37);

function formatDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${Number(month)}/${Number(day)}/${year}`;
}

function money(value: string, blankZero = false): string {
  const amount = dec(value);
  if (blankZero && amount.isZero()) return "";
  return `$${Number(amount.toDecimalPlaces(2).toFixed(2)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function quantity(value: string): string {
  const amount = dec(value);
  return amount.isInteger() ? amount.toFixed(0) : amount.toDecimalPlaces(2).toString();
}

function drawRight(
  page: PDFPage,
  value: string,
  right: number,
  y: number,
  size: number,
  font: PDFFont,
  color = INK,
  maxWidth?: number,
) {
  const fitted = maxWidth ? fitPdfText(value, font, size, maxWidth) : { text: value, size };
  page.drawText(fitted.text, {
    x: right - font.widthOfTextAtSize(fitted.text, fitted.size),
    y,
    size: fitted.size,
    font,
    color,
  });
}

function drawBrand(page: PDFPage, logo: PDFImage, regular: PDFFont, bold: PDFFont, italic: PDFFont) {
  page.drawText(BRAND.name, { x: MARGIN, y: 741, size: 16, font: bold, color: INK });
  page.drawText(BRAND.tagline, { x: MARGIN, y: 720, size: 8, font: italic, color: MUTED });
  page.drawImage(logo, { x: 276, y: 688, width: 115, height: 50 });
  page.drawText(BRAND.address1, { x: MARGIN, y: 694, size: 9, font: regular, color: INK });
  page.drawText(BRAND.address2, { x: MARGIN, y: 681, size: 9, font: regular, color: INK });
  page.drawText(BRAND.phone, { x: MARGIN, y: 668, size: 9, font: regular, color: INK });
  page.drawText(BRAND.email, { x: MARGIN, y: 655, size: 9, font: regular, color: TEAL });
}

function drawInvoiceHeading(
  page: PDFPage,
  invoice: ClassInvoiceRecord,
  regular: PDFFont,
  bold: PDFFont,
) {
  drawRight(page, "INVOICE", PAGE_WIDTH - MARGIN, 733, 29, bold, MUTED);
  drawRight(page, cleanPdfText(invoice.invoiceNumber), PAGE_WIDTH - MARGIN, 714, 10, regular, INK, 170);
  page.drawText("DATE", { x: 408, y: 692, size: 9, font: bold, color: INK });
  page.drawText(formatDate(invoice.invoiceDate), { x: 447, y: 692, size: 9, font: regular, color: INK });
}

function drawBillingBlock(
  page: PDFPage,
  invoice: ClassInvoiceRecord,
  regular: PDFFont,
  bold: PDFFont,
) {
  page.drawText("BILL TO", { x: MARGIN, y: 625, size: 8, font: bold, color: MUTED });
  const billTo = fitPdfText(cleanPdfText(invoice.billToName), bold, 10, 345);
  page.drawText(billTo.text, { x: MARGIN, y: 608, size: billTo.size, font: bold, color: INK });
  const address = [
    invoice.billToAddressLine1,
    invoice.billToAddressLine2,
    invoice.billToCityStateZip,
  ].filter((line): line is string => Boolean(line));
  address.forEach((line, index) => {
    const fitted = fitPdfText(cleanPdfText(line), regular, 9, 345);
    page.drawText(fitted.text, { x: MARGIN, y: 593 - index * 14, size: fitted.size, font: regular, color: INK });
  });

  page.drawText("FOR", { x: 408, y: 625, size: 8, font: bold, color: MUTED });
  const purpose = fitPdfText(cleanPdfText(invoice.purpose), bold, 10, PAGE_WIDTH - MARGIN - 408);
  page.drawText(purpose.text, { x: 408, y: 608, size: purpose.size, font: bold, color: INK });
  page.drawText("SERVICE PERIOD", { x: 408, y: 584, size: 8, font: bold, color: MUTED });
  page.drawText(`${formatDate(invoice.servicePeriodStart)} - ${formatDate(invoice.servicePeriodEnd)}`, {
    x: 408,
    y: 568,
    size: 8,
    font: regular,
    color: INK,
  });
}

function cellX(index: number): number {
  return MARGIN + COLUMNS.slice(0, index).reduce((sum, width) => sum + width, 0);
}

function drawTableHeader(page: PDFPage, y: number, bold: PDFFont) {
  page.drawRectangle({ x: MARGIN, y: y - 24, width: TABLE_WIDTH, height: 24, color: HEADER_FILL });
  page.drawRectangle({ x: MARGIN, y: y - 24, width: TABLE_WIDTH, height: 24, borderColor: RULE, borderWidth: 1 });
  let x = MARGIN;
  COLUMNS.forEach((width, index) => {
    if (index > 0) page.drawLine({ start: { x, y }, end: { x, y: y - 24 }, color: RULE, thickness: 0.8 });
    const label = HEADER_LABELS[index];
    const labelWidth = bold.widthOfTextAtSize(label, 7.5);
    page.drawText(label, {
      x: index >= 2 ? x + Math.max(5, width - labelWidth - 6) : x + 6,
      y: y - 16,
      size: 7.5,
      font: bold,
      color: INK,
    });
    x += width;
  });
}

function drawTableRows(
  page: PDFPage,
  rows: ClassInvoiceRecord["lines"],
  y: number,
  regular: PDFFont,
) {
  rows.forEach((line, rowIndex) => {
    const top = y - rowIndex * ROW_HEIGHT;
    page.drawRectangle({
      x: MARGIN,
      y: top - ROW_HEIGHT,
      width: TABLE_WIDTH,
      height: ROW_HEIGHT,
      borderColor: RULE,
      borderWidth: 0.55,
    });
    let x = MARGIN;
    COLUMNS.forEach((width, index) => {
      if (index > 0) page.drawLine({ start: { x, y: top }, end: { x, y: top - ROW_HEIGHT }, color: RULE, thickness: 0.45 });
      x += width;
    });

    const values = [
      formatDate(line.serviceDate),
      cleanPdfText(line.description),
      quantity(line.quantity),
      money(line.unitPrice),
      money(line.discountAmount, true),
      money(line.lineTotal),
    ];
    values.forEach((value, index) => {
      const width = COLUMNS[index];
      const fitted = fitPdfText(value, regular, 8, width - 10);
      const rightAligned = index >= 2;
      page.drawText(fitted.text, {
        x: rightAligned
          ? cellX(index) + width - regular.widthOfTextAtSize(fitted.text, fitted.size) - 5
          : cellX(index) + 5,
        y: top - 12.5,
        size: fitted.size,
        font: regular,
        color: INK,
      });
    });
  });

  return y - rows.length * ROW_HEIGHT;
}

function drawTotal(page: PDFPage, invoice: ClassInvoiceRecord, bottom: number, regular: PDFFont, bold: PDFFont) {
  const width = COLUMNS[4] + COLUMNS[5];
  const x = PAGE_WIDTH - MARGIN - width;
  page.drawRectangle({ x, y: bottom - 31, width, height: 31, borderColor: RULE, borderWidth: 1.2 });
  page.drawText("TOTAL", { x: x + 8, y: bottom - 20, size: 9, font: bold, color: MUTED });
  drawRight(page, money(invoice.totalAmount), PAGE_WIDTH - MARGIN - 8, bottom - 21, 13, bold, INK);
  if (!dec(invoice.discountTotal).isZero()) {
    drawRight(page, `Discount ${money(invoice.discountTotal)}`, PAGE_WIDTH - MARGIN, bottom - 45, 7.5, regular, MUTED);
  }
}

function drawFooter(page: PDFPage, pageNumber: number, pageCount: number, regular: PDFFont, bold: PDFFont) {
  page.drawLine({ start: { x: MARGIN, y: 55 }, end: { x: PAGE_WIDTH - MARGIN, y: 55 }, color: HEADER_FILL, thickness: 1 });
  page.drawText("Make all checks payable to Xcellent Staffing", { x: MARGIN, y: 38, size: 8, font: regular, color: MUTED });
  drawRight(page, "THANK YOU FOR YOUR BUSINESS", PAGE_WIDTH - MARGIN, 38, 8, bold, TEAL);
  if (pageCount > 1) drawRight(page, `Page ${pageNumber} of ${pageCount}`, PAGE_WIDTH - MARGIN, 22, 7, regular, MUTED);
}

/** Build a clean, searchable invoice PDF from the immutable invoice snapshot. */
export async function buildClassInvoicePdf(invoice: ClassInvoiceRecord): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle(`Invoice ${invoice.invoiceNumber}`);
  document.setAuthor(BRAND.name);
  document.setSubject(`${invoice.purpose} - ${invoice.billToName}`);
  document.setCreator("Ahivim Budget Management");
  const [{ regular, bold, italic }, logo] = await Promise.all([
    embedDocumentFonts(document, [
      invoice.invoiceNumber,
      invoice.individualName,
      invoice.billToName,
      invoice.billToAddressLine1,
      invoice.billToAddressLine2,
      invoice.billToCityStateZip,
      invoice.purpose,
      invoice.notes,
      ...invoice.lines.flatMap((line) => [line.description, line.notes]),
    ]),
    loadPdfBrandAsset("xcellent-staffing.png").then((bytes) => document.embedPng(bytes)),
  ]);
  const chunks: Array<ClassInvoiceRecord["lines"]> = [];
  for (let index = 0; index < invoice.lines.length; index += ROWS_PER_PAGE) {
    chunks.push(invoice.lines.slice(index, index + ROWS_PER_PAGE));
  }
  if (chunks.length === 0) chunks.push([]);

  chunks.forEach((rows, pageIndex) => {
    const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    drawBrand(page, logo, regular, bold, italic);
    drawInvoiceHeading(page, invoice, regular, bold);
    drawBillingBlock(page, invoice, regular, bold);
    drawTableHeader(page, 535, bold);
    const bottom = drawTableRows(page, rows, 511, regular);
    if (pageIndex === chunks.length - 1) drawTotal(page, invoice, Math.max(92, bottom - 8), regular, bold);
    drawFooter(page, pageIndex + 1, chunks.length, regular, bold);
  });

  return document.save();
}
