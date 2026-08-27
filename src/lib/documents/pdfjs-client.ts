import type { PDFDocumentProxy, PDFPageProxy, TextStyle } from "pdfjs-dist/types/src/display/api";
import type { PdfFontStyle, PdfFontWeight, PdfTextAlignment } from "./pdf-editor";

let pdfJsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

export type PdfSourceTextOrigin = "native" | "ocr";

export interface PdfSourceTextItem {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontId: string;
  fontName: string;
  cssFamily: string;
  fontWeight: PdfFontWeight;
  fontStyle: PdfFontStyle;
  color: string;
  backgroundColor: string;
  alignment: PdfTextAlignment;
  opacity: number;
  lineHeight: number;
  letterSpacing: number;
  rotation: number;
  direction: "ltr" | "rtl";
  origin: PdfSourceTextOrigin;
  confidence?: number;
}

export interface PdfDetectedFont {
  id: string;
  name: string;
  cssFamily: string;
  fontWeight: PdfFontWeight;
  fontStyle: PdfFontStyle;
  bytes: Uint8Array | null;
  embedded: boolean;
}

export interface PdfPageTextInspection {
  items: PdfSourceTextItem[];
  fonts: PdfDetectedFont[];
}

interface PdfJsFontObject {
  data?: Uint8Array | ArrayBuffer | ArrayBufferView;
  loadedName?: string;
  name?: string;
  fallbackName?: string;
  bold?: boolean;
  black?: boolean;
  italic?: boolean;
  cssFontInfo?: {
    fontFamily?: string;
    fontWeight?: string | number;
    italicAngle?: number;
  };
}

export function loadPdfJs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfJsPromise) {
    pdfJsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return pdfjs;
    });
  }
  return pdfJsPromise;
}

function cleanFontName(value: string): string {
  return value
    .replace(/^[A-Z]{6}\+/i, "")
    .replace(/["']/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Document font";
}

function inferFontWeight(name: string, font: PdfJsFontObject | null): PdfFontWeight {
  const numeric = Number(font?.cssFontInfo?.fontWeight);
  return font?.bold || font?.black || numeric >= 600 || /\b(?:bold|black|heavy|semibold|demi)\b/i.test(name)
    ? 700
    : 400;
}

function inferFontStyle(name: string, font: PdfJsFontObject | null): PdfFontStyle {
  return font?.italic || Boolean(font?.cssFontInfo?.italicAngle) || /\b(?:italic|oblique)\b/i.test(name)
    ? "italic"
    : "normal";
}

function cloneFontBytes(value: PdfJsFontObject["data"]): Uint8Array | null {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return null;
}

function standardFontId(name: string): "helvetica" | "times" | "courier" {
  if (/\b(?:times|serif|roman)\b/i.test(name)) return "times";
  if (/\b(?:courier|mono|typewriter)\b/i.test(name)) return "courier";
  return "helvetica";
}

function getResolvedFont(page: PDFPageProxy, fontName: string): PdfJsFontObject | null {
  try {
    return page.commonObjs.get(fontName) as PdfJsFontObject;
  } catch {
    return null;
  }
}

function fontDefinition(
  page: PDFPageProxy,
  fontName: string,
  style: TextStyle | undefined,
): PdfDetectedFont {
  const font = getResolvedFont(page, fontName);
  const rawName = font?.name
    ?? font?.cssFontInfo?.fontFamily
    ?? font?.fallbackName
    ?? style?.fontFamily
    ?? fontName;
  const name = cleanFontName(rawName);
  const bytes = cloneFontBytes(font?.data);
  const weight = inferFontWeight(name, font);
  const fontStyle = inferFontStyle(name, font);
  const fallback = standardFontId(name);

  return {
    id: bytes ? `document-${fontName}` : fallback,
    name,
    cssFamily: font?.cssFontInfo?.fontFamily
      ?? font?.loadedName
      ?? style?.fontFamily
      ?? (fallback === "times" ? "Times New Roman, Times, serif" : fallback === "courier" ? "Courier New, Courier, monospace" : "Arial, Helvetica, sans-serif"),
    fontWeight: weight,
    fontStyle,
    bytes,
    embedded: Boolean(bytes),
  };
}

function sourcePosition(
  viewport: ReturnType<PDFPageProxy["getViewport"]>,
  transform: number[],
  style: TextStyle | undefined,
  textWidth: number,
): { x: number; y: number; width: number; height: number; fontSize: number; rotation: number } {
  const [a, b, c, d, e, f] = transform;
  const [va, vb, vc, vd, ve, vf] = viewport.transform;
  const tx = [
    va * a + vc * b,
    vb * a + vd * b,
    va * c + vc * d,
    vb * c + vd * d,
    va * e + vc * f + ve,
    vb * e + vd * f + vf,
  ];
  let angle = Math.atan2(tx[1], tx[0]);
  if (style?.vertical) angle += Math.PI / 2;
  const fontHeight = Math.max(6, Math.hypot(tx[2], tx[3]));
  const ascentRatio = typeof style?.ascent === "number" && style.ascent > 0 ? style.ascent : 0.82;
  const fontAscent = fontHeight * ascentRatio;
  const left = tx[4] + fontAscent * Math.sin(angle);
  const top = tx[5] - fontAscent * Math.cos(angle);
  const width = Math.max(fontHeight * 0.55, textWidth * viewport.scale);
  const height = fontHeight * 1.18;

  return {
    x: Math.max(0, Math.min(0.995, left / viewport.width)),
    y: Math.max(0, Math.min(0.995, top / viewport.height)),
    width: Math.max(0.008, Math.min(1, width / viewport.width)),
    height: Math.max(0.012, Math.min(0.25, height / viewport.height)),
    fontSize: Math.max(4, Math.min(144, Math.round(fontHeight * 10) / 10)),
    rotation: Math.round((angle * 180 / Math.PI) * 10) / 10,
  };
}

export async function inspectPdfPage(
  document: PDFDocumentProxy,
  pageNumber: number,
  rotation = 0,
): Promise<PdfPageTextInspection> {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation + 360) % 360 });
  const content = await page.getTextContent();
  const fontMap = new Map<string, PdfDetectedFont>();

  const items = content.items.flatMap((item, index): PdfSourceTextItem[] => {
    if (!("str" in item) || !item.str.trim()) return [];
    const style = content.styles[item.fontName];
    const font = fontMap.get(item.fontName) ?? fontDefinition(page, item.fontName, style);
    fontMap.set(item.fontName, font);
    const position = sourcePosition(viewport, item.transform as number[], style, item.width);
    const direction = item.dir === "rtl" ? "rtl" : "ltr";

    return [{
      id: `native-${pageNumber}-${index}`,
      text: item.str,
      ...position,
      fontId: font.id,
      fontName: font.name,
      cssFamily: font.cssFamily,
      fontWeight: font.fontWeight,
      fontStyle: font.fontStyle,
      color: "#111111",
      backgroundColor: "#ffffff",
      alignment: direction === "rtl" ? "right" : "left",
      opacity: 1,
      lineHeight: 1.15,
      letterSpacing: 0,
      direction,
      origin: "native",
    }];
  });

  return { items, fonts: [...fontMap.values()] };
}

export async function inspectPdfPageText(
  document: PDFDocumentProxy,
  pageNumber: number,
  rotation = 0,
): Promise<PdfSourceTextItem[]> {
  return (await inspectPdfPage(document, pageNumber, rotation)).items;
}
