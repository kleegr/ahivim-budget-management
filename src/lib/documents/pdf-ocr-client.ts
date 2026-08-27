import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import type { PdfSourceTextItem } from "./pdfjs-client";

export interface PdfOcrProgress {
  status: string;
  progress: number;
}

export interface RecognizePdfPageOptions {
  document: PDFDocumentProxy;
  pageNumber: number;
  rotation?: number;
  onProgress?: (progress: PdfOcrProgress) => void;
}

interface OcrBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface OcrWord {
  text: string;
  confidence: number;
  font_name?: string;
  bbox?: OcrBbox;
}

interface OcrLine {
  text: string;
  confidence: number;
  bbox: OcrBbox;
  words: OcrWord[];
}

interface EditableOcrWord extends OcrWord {
  bbox: OcrBbox;
  boundaryBefore: boolean;
  boundaryAfter: boolean;
}

interface OcrLoggerMessage {
  status: string;
  progress: number;
}

type TesseractModule = typeof import("tesseract.js");
type TesseractWorker = Awaited<ReturnType<TesseractModule["createWorker"]>>;

let workerPromise: Promise<TesseractWorker> | null = null;
let currentLogger: ((message: OcrLoggerMessage) => void) | null = null;

function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = import("tesseract.js")
      .then((tesseract) => tesseract.createWorker("eng", tesseract.OEM.LSTM_ONLY, {
        workerPath: "/tesseract/7.0.0/worker.min.js",
        corePath: "/tesseract/7.0.0/core",
        langPath: "/tesseract/7.0.0/lang",
        workerBlobURL: false,
        logger: (message) => currentLogger?.(message),
      }))
      .catch((error) => {
        workerPromise = null;
        throw error;
      });
  }
  return workerPromise;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function colorKey(red: number, green: number, blue: number): string {
  return `${Math.round(red / 16) * 16},${Math.round(green / 16) * 16},${Math.round(blue / 16) * 16}`;
}

function parseColorKey(key: string): [number, number, number] {
  const values = key.split(",").map(Number);
  return [values[0] ?? 255, values[1] ?? 255, values[2] ?? 255];
}

function parseHexRgb(value: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{6}$/i.test(value) ? value.slice(1) : "ffffff";
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function sampleRegionColors(
  context: CanvasRenderingContext2D,
  bbox: OcrBbox,
): { foreground: string; background: string } {
  const canvas = context.canvas;
  const padding = Math.max(3, Math.round((bbox.y1 - bbox.y0) * 0.2));
  const left = clamp(Math.floor(bbox.x0 - padding), 0, Math.max(0, canvas.width - 1));
  const top = clamp(Math.floor(bbox.y0 - padding), 0, Math.max(0, canvas.height - 1));
  const right = clamp(Math.ceil(bbox.x1 + padding), left + 1, canvas.width);
  const bottom = clamp(Math.ceil(bbox.y1 + padding), top + 1, canvas.height);
  const image = context.getImageData(left, top, right - left, bottom - top);
  const modes = new Map<string, number>();

  for (let y = 0; y < image.height; y += 2) {
    for (let x = 0; x < image.width; x += 2) {
      const pageX = left + x;
      const pageY = top + y;
      const outsideText = pageX < bbox.x0 || pageX > bbox.x1 || pageY < bbox.y0 || pageY > bbox.y1;
      if (!outsideText) continue;
      const offset = (y * image.width + x) * 4;
      const key = colorKey(image.data[offset] ?? 255, image.data[offset + 1] ?? 255, image.data[offset + 2] ?? 255);
      modes.set(key, (modes.get(key) ?? 0) + 1);
    }
  }

  const backgroundKey = [...modes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "256,256,256";
  const background = parseColorKey(backgroundKey);
  const candidates: Array<[number, number, number, number]> = [];
  const textLeft = clamp(Math.floor(bbox.x0 - left), 0, image.width - 1);
  const textTop = clamp(Math.floor(bbox.y0 - top), 0, image.height - 1);
  const textRight = clamp(Math.ceil(bbox.x1 - left), textLeft + 1, image.width);
  const textBottom = clamp(Math.ceil(bbox.y1 - top), textTop + 1, image.height);

  for (let y = textTop; y < textBottom; y += 2) {
    for (let x = textLeft; x < textRight; x += 2) {
      const offset = (y * image.width + x) * 4;
      const red = image.data[offset] ?? 0;
      const green = image.data[offset + 1] ?? 0;
      const blue = image.data[offset + 2] ?? 0;
      const contrast = Math.abs(red - background[0]) + Math.abs(green - background[1]) + Math.abs(blue - background[2]);
      candidates.push([contrast, red, green, blue]);
    }
  }

  candidates.sort((a, b) => b[0] - a[0]);
  const strongest = candidates.slice(0, Math.max(4, Math.ceil(candidates.length * 0.12)));
  const foreground = strongest.length > 0
    ? rgbToHex(
        median(strongest.map((sample) => sample[1])),
        median(strongest.map((sample) => sample[2])),
        median(strongest.map((sample) => sample[3])),
      )
    : "#111111";

  return {
    foreground,
    background: rgbToHex(...background),
  };
}

function refineTextBbox(
  context: CanvasRenderingContext2D,
  bbox: OcrBbox,
  backgroundHex: string,
): OcrBbox {
  const canvas = context.canvas;
  const left = clamp(Math.floor(bbox.x0), 0, Math.max(0, canvas.width - 1));
  const top = clamp(Math.floor(bbox.y0), 0, Math.max(0, canvas.height - 1));
  const right = clamp(Math.ceil(bbox.x1), left + 1, canvas.width);
  const bottom = clamp(Math.ceil(bbox.y1), top + 1, canvas.height);
  const image = context.getImageData(left, top, right - left, bottom - top);
  if (image.width < 3 || image.height < 3) return bbox;

  const background = parseHexRgb(backgroundHex);
  const active = new Uint8Array(image.width * image.height);
  const rowCounts = new Uint32Array(image.height);
  const columnCounts = new Uint32Array(image.width);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const contrast = Math.abs((image.data[offset] ?? 255) - background[0])
        + Math.abs((image.data[offset + 1] ?? 255) - background[1])
        + Math.abs((image.data[offset + 2] ?? 255) - background[2]);
      if (contrast < 72) continue;
      active[y * image.width + x] = 1;
      rowCounts[y] += 1;
      columnCounts[x] += 1;
    }
  }

  const borderRows = new Set<number>();
  const borderColumns = new Set<number>();
  for (let y = 0; y < image.height; y += 1) {
    const nearEdge = y <= image.height * 0.22 || y >= image.height * 0.78;
    if (nearEdge && rowCounts[y]! >= image.width * 0.62) borderRows.add(y);
  }
  for (let x = 0; x < image.width; x += 1) {
    const nearEdge = x <= image.width * 0.16 || x >= image.width * 0.84;
    if (nearEdge && columnCounts[x]! >= image.height * 0.68) borderColumns.add(x);
  }

  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    if (borderRows.has(y)) continue;
    for (let x = 0; x < image.width; x += 1) {
      if (borderColumns.has(x) || active[y * image.width + x] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return bbox;

  const refinedWidth = maxX - minX + 1;
  const refinedHeight = maxY - minY + 1;
  if (refinedWidth < image.width * 0.12 || refinedHeight < image.height * 0.18) return bbox;
  const padding = Math.max(1, Math.round(refinedHeight * 0.06));
  return {
    x0: clamp(left + minX - padding, 0, canvas.width - 1),
    y0: clamp(top + minY - padding, 0, canvas.height - 1),
    x1: clamp(left + maxX + 1 + padding, 1, canvas.width),
    y1: clamp(top + maxY + 1 + padding, 1, canvas.height),
  };
}

function mostCommonFont(words: OcrWord[]): string {
  const counts = new Map<string, number>();
  for (const word of words) {
    const name = word.font_name?.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Arial";
}

function fontPresentation(name: string): {
  id: "helvetica" | "times" | "courier";
  family: string;
  weight: 400 | 700;
  style: "normal" | "italic";
} {
  const id = /\b(?:times|serif|roman)\b/i.test(name)
    ? "times"
    : /\b(?:courier|mono|typewriter)\b/i.test(name)
      ? "courier"
      : "helvetica";
  return {
    id,
    family: id === "times"
      ? "Times New Roman, Times, serif"
      : id === "courier"
        ? "Courier New, Courier, monospace"
        : "Arial, Helvetica, sans-serif",
    weight: /\b(?:bold|black|heavy|semibold|demi)\b/i.test(name) ? 700 : 400,
    style: /\b(?:italic|oblique)\b/i.test(name) ? "italic" : "normal",
  };
}

function flattenLines(blocks: unknown): OcrLine[] {
  if (!Array.isArray(blocks)) return [];
  const lines: OcrLine[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object" || !("paragraphs" in block) || !Array.isArray(block.paragraphs)) continue;
    for (const paragraph of block.paragraphs) {
      if (!paragraph || typeof paragraph !== "object" || !("lines" in paragraph) || !Array.isArray(paragraph.lines)) continue;
      for (const line of paragraph.lines) {
        if (!line || typeof line !== "object" || !("text" in line) || !("bbox" in line)) continue;
        lines.push(line as OcrLine);
      }
    }
  }
  return lines;
}

function splitLineIntoEditableRegions(line: OcrLine): OcrLine[] {
  const rtl = /[\u0590-\u05ff]/.test(line.text);
  const words = (line.words ?? [])
    .filter((word): word is OcrWord & { bbox: OcrBbox } => (
      Boolean(word.text.trim())
      && word.confidence >= 20
      && Boolean(word.bbox)
    ))
    .map((word) => {
      const raw = word.text.trim();
      const boundaryBefore = /^[|_\[\]{}~]+/.test(raw);
      const boundaryAfter = /[|_\[\]{}~]+$/.test(raw);
      return {
        ...word,
        text: raw
          .replace(/^[|_\[\]{}~]+/, "")
          .replace(/[|_\[\]{}~]+$/, "")
          .trim(),
        boundaryBefore,
        boundaryAfter,
      };
    })
    .filter((word) => Boolean(word.text))
    .sort((left, right) => rtl
      ? right.bbox.x1 - left.bbox.x1
      : left.bbox.x0 - right.bbox.x0);
  if (words.length === 0) return [line];

  const groups: EditableOcrWord[][] = [];
  for (const word of words) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (!group || !previous) {
      groups.push([word]);
      continue;
    }
    const previousHeight = Math.max(1, previous.bbox.y1 - previous.bbox.y0);
    const wordHeight = Math.max(1, word.bbox.y1 - word.bbox.y0);
    const gap = rtl
      ? previous.bbox.x0 - word.bbox.x1
      : word.bbox.x0 - previous.bbox.x1;
    const overlap = Math.max(0, Math.min(previous.bbox.y1, word.bbox.y1) - Math.max(previous.bbox.y0, word.bbox.y0));
    const sameBaseline = overlap / Math.min(previousHeight, wordHeight) >= 0.45;
    const naturalSpace = gap <= Math.max(5, Math.min(previousHeight, wordHeight) * 0.95);
    const sameCell = !word.boundaryBefore && !previous.boundaryAfter;
    if (sameBaseline && naturalSpace && sameCell) group.push(word);
    else groups.push([word]);
  }

  const regions = groups.map((group) => {
    const bbox = {
      x0: Math.min(...group.map((word) => word.bbox.x0)),
      y0: Math.min(...group.map((word) => word.bbox.y0)),
      x1: Math.max(...group.map((word) => word.bbox.x1)),
      y1: Math.max(...group.map((word) => word.bbox.y1)),
    };
    const text = group.map((word) => word.text.trim()).join(" ");
    const weight = group.reduce((sum, word) => sum + Math.max(1, word.text.length), 0);
    const confidence = group.reduce(
      (sum, word) => sum + word.confidence * Math.max(1, word.text.length),
      0,
    ) / weight;
    return { text, confidence, bbox, words: group };
  });

  const heights = regions
    .filter((region) => region.text.replace(/\s/g, "").length >= 2)
    .map((region) => region.bbox.y1 - region.bbox.y0)
    .filter((height) => height > 0)
    .sort((left, right) => left - right);
  const referenceHeight = heights[0] ?? 0;
  if (regions.length < 3 || referenceHeight <= 0) return regions;
  const compactRegions = regions.filter(
    (region) => region.bbox.y1 - region.bbox.y0 <= referenceHeight * 1.45,
  );
  const centerY = median(compactRegions.map(
    (region) => (region.bbox.y0 + region.bbox.y1) / 2,
  ));
  if (compactRegions.length === 0 || centerY <= 0) return regions;

  return regions.map((region) => {
    const height = region.bbox.y1 - region.bbox.y0;
    if (height <= referenceHeight * 1.55) return region;
    const targetHeight = referenceHeight * 1.2;
    return {
      ...region,
      bbox: {
        ...region.bbox,
        y0: centerY - targetHeight / 2,
        y1: centerY + targetHeight / 2,
      },
    };
  });
}

export async function recognizePdfPage(options: RecognizePdfPageOptions): Promise<PdfSourceTextItem[]> {
  const page = await options.document.getPage(options.pageNumber);
  const baseViewport = page.getViewport({
    scale: 1,
    rotation: (page.rotate + (options.rotation ?? 0) + 360) % 360,
  });
  const scale = Math.max(2, Math.min(4, 2800 / Math.max(baseViewport.width, baseViewport.height)));
  const viewport = page.getViewport({
    scale,
    rotation: (page.rotate + (options.rotation ?? 0) + 360) % 360,
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) throw new Error("This browser cannot prepare the page for text recognition.");

  options.onProgress?.({ status: "Preparing page", progress: 0.03 });
  await page.render({ canvasContext: context, viewport }).promise;
  const worker = await getWorker();
  currentLogger = (message) => options.onProgress?.({
    status: message.status.replace(/_/g, " "),
    progress: clamp(message.progress, 0.05, 0.98),
  });

  try {
    const result = await worker.recognize(
      canvas,
      { rotateAuto: false },
      { text: true, blocks: true, tsv: false, hocr: false },
    );
    const regions = flattenLines(result.data.blocks).flatMap(splitLineIntoEditableRegions);
    return regions.flatMap((line, index): PdfSourceTextItem[] => {
      const text = line.text.replace(/\s+/g, " ").trim();
      if (!text || line.confidence < 20) return [];
      const initialColors = sampleRegionColors(context, line.bbox);
      const bbox = refineTextBbox(context, line.bbox, initialColors.background);
      const width = Math.max(1, bbox.x1 - bbox.x0);
      const height = Math.max(1, bbox.y1 - bbox.y0);
      const fontName = mostCommonFont(line.words ?? []);
      const font = fontPresentation(fontName);
      const colors = sampleRegionColors(context, bbox);
      const direction = /[\u0590-\u05ff]/.test(text) ? "rtl" : "ltr";

      return [{
        id: `ocr-${options.pageNumber}-${index}`,
        text,
        x: clamp(bbox.x0 / canvas.width, 0, 0.995),
        y: clamp(bbox.y0 / canvas.height, 0, 0.995),
        width: clamp(width / canvas.width, 0.008, 1),
        height: clamp(height / canvas.height, 0.012, 0.25),
        fontSize: clamp(Math.round((height / scale) * 0.78 * 10) / 10, 4, 144),
        fontId: font.id,
        fontName,
        cssFamily: font.family,
        fontWeight: font.weight,
        fontStyle: font.style,
        color: colors.foreground,
        backgroundColor: colors.background,
        alignment: direction === "rtl" ? "right" : "left",
        opacity: 1,
        lineHeight: 1.12,
        letterSpacing: 0,
        rotation: 0,
        direction,
        origin: "ocr",
        confidence: line.confidence,
      }];
    });
  } finally {
    currentLogger = null;
    canvas.width = 1;
    canvas.height = 1;
    options.onProgress?.({ status: "Text ready", progress: 1 });
  }
}

export async function terminatePdfOcrWorker(): Promise<void> {
  const pending = workerPromise;
  workerPromise = null;
  currentLogger = null;
  if (!pending) return;
  try {
    await (await pending).terminate();
  } catch {
    // A failed or already-terminated worker has nothing left to release.
  }
}
