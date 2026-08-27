import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  StandardFonts,
  type PDFFont,
  type PDFPage,
  degrees,
  rgb,
} from "pdf-lib";
import type { PdfOverlay, PdfTextAlignment } from "./pdf-editor";

export interface PdfCustomFontSource {
  id: string;
  bytes: Uint8Array;
}

export interface PdfImageSource {
  id: string;
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
}

const STANDARD_FONT_NAMES = {
  helvetica: {
    regular: StandardFonts.Helvetica,
    bold: StandardFonts.HelveticaBold,
    italic: StandardFonts.HelveticaOblique,
    boldItalic: StandardFonts.HelveticaBoldOblique,
  },
  times: {
    regular: StandardFonts.TimesRoman,
    bold: StandardFonts.TimesRomanBold,
    italic: StandardFonts.TimesRomanItalic,
    boldItalic: StandardFonts.TimesRomanBoldItalic,
  },
  courier: {
    regular: StandardFonts.Courier,
    bold: StandardFonts.CourierBold,
    italic: StandardFonts.CourierOblique,
    boldItalic: StandardFonts.CourierBoldOblique,
  },
} as const;

function parseHexColor(value: string): ReturnType<typeof rgb> {
  const normalized = /^#[0-9a-f]{6}$/i.test(value) ? value.slice(1) : "17212b";
  return rgb(
    Number.parseInt(normalized.slice(0, 2), 16) / 255,
    Number.parseInt(normalized.slice(2, 4), 16) / 255,
    Number.parseInt(normalized.slice(4, 6), 16) / 255,
  );
}

export function wrapPdfText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const paragraphs = text.replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [];

  const splitLongWord = (word: string): string[] => {
    const pieces: string[] = [];
    let piece = "";
    for (const character of word) {
      if (piece && font.widthOfTextAtSize(piece + character, size) > maxWidth) {
        pieces.push(piece);
        piece = character;
      } else {
        piece += character;
      }
    }
    if (piece) pieces.push(piece);
    return pieces;
  };

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }

    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      const parts = font.widthOfTextAtSize(word, size) > maxWidth ? splitLongWord(word) : [word];
      for (const part of parts) {
        const candidate = line ? `${line} ${part}` : part;
        if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
          lines.push(line);
          line = part;
        } else {
          line = candidate;
        }
      }
    }
    if (line) lines.push(line);
  }

  return lines;
}

function alignedX(
  alignment: PdfTextAlignment,
  boxX: number,
  boxWidth: number,
  lineWidth: number,
): number {
  if (alignment === "center") return boxX + Math.max(0, (boxWidth - lineWidth) / 2);
  if (alignment === "right") return boxX + Math.max(0, boxWidth - lineWidth);
  return boxX;
}

function drawCover(page: PDFPage, overlay: Extract<PdfOverlay, { kind: "cover" }>): void {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  page.drawRectangle({
    x: overlay.x * pageWidth,
    y: pageHeight - (overlay.y + overlay.height) * pageHeight,
    width: overlay.width * pageWidth,
    height: overlay.height * pageHeight,
    color: parseHexColor(overlay.color),
    rotate: degrees(overlay.rotation),
  });
}

function drawText(page: PDFPage, overlay: Extract<PdfOverlay, { kind: "text" }>, font: PDFFont): void {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const boxX = overlay.x * pageWidth;
  const boxWidth = overlay.width * pageWidth;
  const boxHeight = overlay.height * pageHeight;
  const boxTop = pageHeight - overlay.y * pageHeight;
  const lineHeight = overlay.fontSize * overlay.lineHeight;
  const maxLines = Math.max(1, Math.floor(boxHeight / lineHeight));
  const lines = wrapPdfText(overlay.text, font, overlay.fontSize, boxWidth).slice(0, maxLines);

  lines.forEach((line, index) => {
    const lineWidth = font.widthOfTextAtSize(line, overlay.fontSize)
      + Math.max(0, line.length - 1) * overlay.letterSpacing;
    const startX = alignedX(overlay.alignment, boxX, boxWidth, lineWidth);
    const startY = boxTop - overlay.fontSize - index * lineHeight;
    if (overlay.letterSpacing === 0) {
      page.drawText(line, {
        x: startX,
        y: startY,
        size: overlay.fontSize,
        font,
        color: parseHexColor(overlay.color),
        opacity: overlay.opacity,
        rotate: degrees(overlay.rotation),
      });
      return;
    }

    const angle = overlay.rotation * Math.PI / 180;
    let offset = 0;
    for (const character of line) {
      page.drawText(character, {
        x: startX + offset * Math.cos(angle),
        y: startY + offset * Math.sin(angle),
        size: overlay.fontSize,
        font,
        color: parseHexColor(overlay.color),
        opacity: overlay.opacity,
        rotate: degrees(overlay.rotation),
      });
      offset += font.widthOfTextAtSize(character, overlay.fontSize) + overlay.letterSpacing;
    }
  });
}

async function drawImage(
  document: PDFDocument,
  page: PDFPage,
  overlay: Extract<PdfOverlay, { kind: "image" }>,
  source: PdfImageSource,
): Promise<void> {
  const image = source.mimeType === "image/png"
    ? await document.embedPng(source.bytes.slice())
    : await document.embedJpg(source.bytes.slice());
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const boxX = overlay.x * pageWidth;
  const boxY = pageHeight - (overlay.y + overlay.height) * pageHeight;
  const boxWidth = overlay.width * pageWidth;
  const boxHeight = overlay.height * pageHeight;
  const scale = Math.min(boxWidth / image.width, boxHeight / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  page.drawImage(image, {
    x: boxX + (boxWidth - width) / 2,
    y: boxY + (boxHeight - height) / 2,
    width,
    height,
    opacity: Math.max(0, Math.min(1, overlay.opacity)),
    rotate: degrees(overlay.rotation),
  });
}

function drawShape(page: PDFPage, overlay: Extract<PdfOverlay, { kind: "shape" }>): void {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const x = overlay.x * pageWidth;
  const y = pageHeight - (overlay.y + overlay.height) * pageHeight;
  const width = overlay.width * pageWidth;
  const height = overlay.height * pageHeight;
  if (overlay.shape === "line") {
    page.drawLine({
      start: { x, y: y + height },
      end: { x: x + width, y },
      thickness: overlay.strokeWidth,
      color: parseHexColor(overlay.strokeColor),
      opacity: overlay.opacity,
    });
    return;
  }
  if (overlay.shape === "ellipse") {
    page.drawEllipse({
      x: x + width / 2,
      y: y + height / 2,
      xScale: width / 2,
      yScale: height / 2,
      color: parseHexColor(overlay.fillColor),
      borderColor: parseHexColor(overlay.strokeColor),
      borderWidth: overlay.strokeWidth,
      opacity: overlay.opacity,
      borderOpacity: overlay.opacity,
    });
    return;
  }
  page.drawRectangle({
    x,
    y,
    width,
    height,
    color: parseHexColor(overlay.fillColor),
    borderColor: overlay.strokeWidth > 0 ? parseHexColor(overlay.strokeColor) : undefined,
    borderWidth: overlay.strokeWidth,
    opacity: overlay.opacity,
    borderOpacity: overlay.opacity,
    rotate: degrees(overlay.rotation),
  });
}

function drawInk(page: PDFPage, overlay: Extract<PdfOverlay, { kind: "ink" }>): void {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  for (let index = 1; index < overlay.points.length; index += 1) {
    const previous = overlay.points[index - 1]!;
    const current = overlay.points[index]!;
    page.drawLine({
      start: {
        x: (overlay.x + previous.x * overlay.width) * pageWidth,
        y: pageHeight - (overlay.y + previous.y * overlay.height) * pageHeight,
      },
      end: {
        x: (overlay.x + current.x * overlay.width) * pageWidth,
        y: pageHeight - (overlay.y + current.y * overlay.height) * pageHeight,
      },
      thickness: overlay.strokeWidth,
      color: parseHexColor(overlay.color),
      opacity: overlay.opacity,
    });
  }
}

/**
 * Loads a fresh copy of the source bytes and paints overlays into its page
 * content streams. The caller's source buffer is never modified.
 */
export async function exportPdfWithOverlays(
  source: Uint8Array,
  overlays: PdfOverlay[],
  customFonts: PdfCustomFontSource[] = [],
  images: PdfImageSource[] = [],
  pageOrder?: number[],
): Promise<Uint8Array> {
  const sourceDocument = await PDFDocument.load(source.slice(), { updateMetadata: false });
  const normalizedOrder = pageOrder?.length
    ? pageOrder
    : Array.from({ length: sourceDocument.getPageCount() }, (_, index) => index + 1);
  const orderChanged = normalizedOrder.length !== sourceDocument.getPageCount()
    || normalizedOrder.some((sourcePage, index) => sourcePage !== index + 1);
  const document = orderChanged ? await PDFDocument.create() : sourceDocument;
  if (orderChanged) {
    const copiedPages = await document.copyPages(
      sourceDocument,
      normalizedOrder.map((pageNumber) => pageNumber - 1),
    );
    for (const copiedPage of copiedPages) document.addPage(copiedPage);
  }
  const pages = document.getPages();
  const fontCache = new Map<string, PDFFont>();
  const customFontMap = new Map(customFonts.map((font) => [font.id, font]));
  const imageMap = new Map(images.map((image) => [image.id, image]));

  if (customFonts.length > 0) document.registerFontkit(fontkit);

  const resolveFont = async (
    overlay: Extract<PdfOverlay, { kind: "text" }>,
  ): Promise<PDFFont> => {
    const cacheKey = `${overlay.fontId}:${overlay.fontWeight}:${overlay.fontStyle}`;
    const cached = fontCache.get(cacheKey);
    if (cached) return cached;

    const standardFamily = STANDARD_FONT_NAMES[overlay.fontId as keyof typeof STANDARD_FONT_NAMES];
    const standardName = standardFamily
      ? overlay.fontWeight === 700 && overlay.fontStyle === "italic"
        ? standardFamily.boldItalic
        : overlay.fontWeight === 700
          ? standardFamily.bold
          : overlay.fontStyle === "italic"
            ? standardFamily.italic
            : standardFamily.regular
      : null;
    const custom = customFontMap.get(overlay.fontId);
    const font = standardName
      ? await document.embedFont(standardName)
      : custom
        ? await document.embedFont(custom.bytes.slice(), { subset: true })
        : await document.embedFont(StandardFonts.Helvetica);
    fontCache.set(cacheKey, font);
    return font;
  };

  for (const overlay of overlays) {
    const page = pages[overlay.page - 1];
    if (!page) continue;
    if (overlay.kind === "cover") {
      drawCover(page, overlay);
      continue;
    }
    if (overlay.kind === "image") {
      const sourceImage = imageMap.get(overlay.imageId);
      if (sourceImage) await drawImage(document, page, overlay, sourceImage);
      continue;
    }
    if (overlay.kind === "shape") {
      drawShape(page, overlay);
      continue;
    }
    if (overlay.kind === "ink") {
      drawInk(page, overlay);
      continue;
    }

    try {
      drawText(page, overlay, await resolveFont(overlay));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown font error";
      throw new Error(`Could not export text \"${overlay.text.slice(0, 30)}\". Import a TTF or OTF font that supports these characters. ${message}`);
    }
  }

  return document.save();
}
