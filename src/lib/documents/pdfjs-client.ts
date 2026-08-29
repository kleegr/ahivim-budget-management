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

interface PdfSourceTextBlock {
  item: PdfSourceTextItem;
  sourceIds: string[];
}

function textCenterY(item: PdfSourceTextItem): number {
  return item.y + item.height / 2;
}

function rotationDistance(left: number, right: number): number {
  const difference = Math.abs(((left - right + 180) % 360 + 360) % 360 - 180);
  return Math.min(difference, 360 - difference);
}

function compatibleTypography(left: PdfSourceTextItem, right: PdfSourceTextItem): boolean {
  const sizeTolerance = Math.max(0.6, Math.max(left.fontSize, right.fontSize) * 0.08);
  return left.fontId === right.fontId
    && left.fontName === right.fontName
    && left.fontWeight === right.fontWeight
    && left.fontStyle === right.fontStyle
    && left.direction === right.direction
    && left.color === right.color
    && Math.abs(left.fontSize - right.fontSize) <= sizeTolerance
    && rotationDistance(left.rotation, right.rotation) <= 1;
}

function readingGap(left: PdfSourceTextItem, right: PdfSourceTextItem): number {
  return left.direction === "rtl"
    ? left.x - (right.x + right.width)
    : right.x - (left.x + left.width);
}

function averageCharacterWidth(item: PdfSourceTextItem): number {
  return item.width / Math.max(1, [...item.text.trim()].length);
}

function canShareLine(left: PdfSourceTextItem, right: PdfSourceTextItem): boolean {
  if (!compatibleTypography(left, right)) return false;
  const centerTolerance = Math.max(0.0025, Math.min(left.height, right.height) * 0.42);
  return Math.abs(textCenterY(left) - textCenterY(right)) <= centerTolerance;
}

function canJoinLineRuns(left: PdfSourceTextItem, right: PdfSourceTextItem): boolean {
  const gap = readingGap(left, right);
  const maximumGap = Math.max(
    0.006,
    Math.max(left.height, right.height) * 0.8,
    Math.max(averageCharacterWidth(left), averageCharacterWidth(right)) * 1.5,
  );
  return gap >= -Math.max(left.height, right.height) * 0.55 && gap <= maximumGap;
}

function textRunSeparator(left: PdfSourceTextItem, right: PdfSourceTextItem): string {
  if (/\s$/u.test(left.text) || /^\s/u.test(right.text)) return "";
  if (/^[,.;:!?%\u2026)\]}]/u.test(right.text) || /[(\[{]$/u.test(left.text)) return "";
  const compactGap = Math.max(averageCharacterWidth(left), averageCharacterWidth(right)) * 0.35;
  return readingGap(left, right) <= compactGap ? "" : " ";
}

function blockId(sourceIds: string[]): string {
  const first = sourceIds[0] ?? "empty";
  const last = sourceIds.at(-1) ?? first;
  return first === last ? `native-block:${first}` : `native-block:${first}:${last}`;
}

function mergeRuns(runs: PdfSourceTextItem[]): PdfSourceTextBlock {
  const ordered = [...runs].sort((left, right) => (
    left.direction === "rtl" ? right.x - left.x : left.x - right.x
  ));
  const first = ordered[0]!;
  const sourceIds = ordered.map((item) => item.id);
  const minimumX = Math.min(...ordered.map((item) => item.x));
  const minimumY = Math.min(...ordered.map((item) => item.y));
  const maximumX = Math.max(...ordered.map((item) => item.x + item.width));
  const maximumY = Math.max(...ordered.map((item) => item.y + item.height));
  const text = ordered.slice(1).reduce(
    (value, item, index) => `${value}${textRunSeparator(ordered[index]!, item)}${item.text}`,
    first.text,
  ).trim();

  return {
    sourceIds,
    item: {
      ...first,
      id: blockId(sourceIds),
      text,
      x: minimumX,
      y: minimumY,
      width: maximumX - minimumX,
      height: maximumY - minimumY,
      alignment: first.direction === "rtl" ? "right" : first.alignment,
    },
  };
}

function horizontalOverlap(left: PdfSourceTextItem, right: PdfSourceTextItem): number {
  return Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
}

function paragraphAlignmentDistance(left: PdfSourceTextItem, right: PdfSourceTextItem): number {
  return left.direction === "rtl"
    ? Math.abs(left.x + left.width - right.x - right.width)
    : Math.abs(left.x - right.x);
}

function canJoinParagraph(previous: PdfSourceTextItem, next: PdfSourceTextItem): boolean {
  if (!compatibleTypography(previous, next)) return false;
  const height = Math.max(previous.height, next.height);
  const centerDistance = textCenterY(next) - textCenterY(previous);
  if (centerDistance < Math.min(previous.height, next.height) * 0.58 || centerDistance > height * 2.45) {
    return false;
  }

  const overlap = horizontalOverlap(previous, next);
  const overlapRatio = overlap / Math.max(0.001, Math.min(previous.width, next.width));
  const edgeAligned = paragraphAlignmentDistance(previous, next) <= Math.max(0.015, height * 1.25);
  return overlapRatio >= 0.3 || edgeAligned;
}

function mergeParagraph(lines: PdfSourceTextBlock[]): PdfSourceTextItem {
  const first = lines[0]!.item;
  const sourceIds = lines.flatMap((line) => line.sourceIds);
  const minimumX = Math.min(...lines.map(({ item }) => item.x));
  const minimumY = Math.min(...lines.map(({ item }) => item.y));
  const maximumX = Math.max(...lines.map(({ item }) => item.x + item.width));
  const maximumY = Math.max(...lines.map(({ item }) => item.y + item.height));
  return {
    ...first,
    id: blockId(sourceIds),
    text: lines.map(({ item }) => item.text).join("\n"),
    x: minimumX,
    y: minimumY,
    width: maximumX - minimumX,
    height: maximumY - minimumY,
  };
}

function visualOrder(left: PdfSourceTextItem, right: PdfSourceTextItem): number {
  const centerDifference = textCenterY(left) - textCenterY(right);
  const sameVisualRow = Math.abs(centerDifference) <= Math.max(left.height, right.height) * 0.45;
  if (!sameVisualRow) return centerDifference;
  return left.direction === "rtl" && right.direction === "rtl"
    ? right.x - left.x
    : left.x - right.x;
}

/**
 * Reconstructs the fragmented text runs returned by PDF.js into editable
 * blocks. Geometry and typography gates keep adjacent columns and visibly
 * different fonts independent, while direction-aware ordering preserves RTL.
 */
export function groupPdfNativeTextItems(items: PdfSourceTextItem[]): PdfSourceTextItem[] {
  if (items.length < 2) return items;
  const nativeItems = items.filter((item) => item.origin === "native" && item.text.trim());
  const passthrough = items.filter((item) => item.origin !== "native" || !item.text.trim());
  const rows: PdfSourceTextItem[][] = [];

  for (const item of [...nativeItems].sort(visualOrder)) {
    const row = rows
      .filter((candidate) => canShareLine(candidate[0]!, item))
      .sort((left, right) => (
        Math.abs(textCenterY(left[0]!) - textCenterY(item))
        - Math.abs(textCenterY(right[0]!) - textCenterY(item))
      ))[0];
    if (row) row.push(item);
    else rows.push([item]);
  }

  const lines: PdfSourceTextBlock[] = [];
  for (const row of rows) {
    const ordered = [...row].sort((left, right) => (
      left.direction === "rtl" ? right.x - left.x : left.x - right.x
    ));
    let segment: PdfSourceTextItem[] = [];
    for (const item of ordered) {
      const previous = segment.at(-1);
      if (previous && !canJoinLineRuns(previous, item)) {
        lines.push(mergeRuns(segment));
        segment = [];
      }
      segment.push(item);
    }
    if (segment.length > 0) lines.push(mergeRuns(segment));
  }

  const paragraphs: PdfSourceTextBlock[][] = [];
  for (const line of lines.sort((left, right) => visualOrder(left.item, right.item))) {
    const candidate = paragraphs
      .filter((paragraph) => canJoinParagraph(paragraph.at(-1)!.item, line.item))
      .sort((left, right) => {
        const leftLast = left.at(-1)!.item;
        const rightLast = right.at(-1)!.item;
        const verticalDifference = Math.abs(textCenterY(leftLast) - textCenterY(line.item))
          - Math.abs(textCenterY(rightLast) - textCenterY(line.item));
        return verticalDifference || paragraphAlignmentDistance(leftLast, line.item)
          - paragraphAlignmentDistance(rightLast, line.item);
      })[0];
    if (candidate) candidate.push(line);
    else paragraphs.push([line]);
  }

  return [
    ...paragraphs.map(mergeParagraph),
    ...passthrough,
  ].sort(visualOrder);
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

  const runs = content.items.flatMap((item, index): PdfSourceTextItem[] => {
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

  return { items: groupPdfNativeTextItems(runs), fonts: [...fontMap.values()] };
}

export async function inspectPdfPageText(
  document: PDFDocumentProxy,
  pageNumber: number,
  rotation = 0,
): Promise<PdfSourceTextItem[]> {
  return (await inspectPdfPage(document, pageNumber, rotation)).items;
}
