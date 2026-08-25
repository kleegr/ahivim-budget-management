import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  StandardFonts,
  type PDFFont,
  type PDFPage,
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
  helvetica: StandardFonts.Helvetica,
  times: StandardFonts.TimesRoman,
  courier: StandardFonts.Courier,
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
  });
}

function drawText(page: PDFPage, overlay: Extract<PdfOverlay, { kind: "text" }>, font: PDFFont): void {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const boxX = overlay.x * pageWidth;
  const boxWidth = overlay.width * pageWidth;
  const boxHeight = overlay.height * pageHeight;
  const boxTop = pageHeight - overlay.y * pageHeight;
  const lineHeight = overlay.fontSize * 1.2;
  const maxLines = Math.max(1, Math.floor(boxHeight / lineHeight));
  const lines = wrapPdfText(overlay.text, font, overlay.fontSize, boxWidth).slice(0, maxLines);

  lines.forEach((line, index) => {
    const lineWidth = font.widthOfTextAtSize(line, overlay.fontSize);
    page.drawText(line, {
      x: alignedX(overlay.alignment, boxX, boxWidth, lineWidth),
      y: boxTop - overlay.fontSize - index * lineHeight,
      size: overlay.fontSize,
      font,
      color: parseHexColor(overlay.color),
    });
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
  page.drawImage(image, {
    x: overlay.x * pageWidth,
    y: pageHeight - (overlay.y + overlay.height) * pageHeight,
    width: overlay.width * pageWidth,
    height: overlay.height * pageHeight,
    opacity: Math.max(0, Math.min(1, overlay.opacity)),
  });
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
): Promise<Uint8Array> {
  const document = await PDFDocument.load(source.slice(), { updateMetadata: false });
  const pages = document.getPages();
  const fontCache = new Map<string, PDFFont>();
  const customFontMap = new Map(customFonts.map((font) => [font.id, font]));
  const imageMap = new Map(images.map((image) => [image.id, image]));

  if (customFonts.length > 0) document.registerFontkit(fontkit);

  const resolveFont = async (fontId: string): Promise<PDFFont> => {
    const cached = fontCache.get(fontId);
    if (cached) return cached;

    const standardName = STANDARD_FONT_NAMES[fontId as keyof typeof STANDARD_FONT_NAMES];
    const custom = customFontMap.get(fontId);
    const font = standardName
      ? await document.embedFont(standardName)
      : custom
        ? await document.embedFont(custom.bytes.slice(), { subset: true })
        : await document.embedFont(StandardFonts.Helvetica);
    fontCache.set(fontId, font);
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

    try {
      drawText(page, overlay, await resolveFont(overlay.fontId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown font error";
      throw new Error(`Could not export text \"${overlay.text.slice(0, 30)}\". Import a TTF or OTF font that supports these characters. ${message}`);
    }
  }

  return document.save();
}
