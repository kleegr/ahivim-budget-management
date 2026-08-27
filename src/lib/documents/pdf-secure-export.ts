import { PDFDocument } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import type { PdfOverlay } from "./pdf-editor";
import type { PdfImageSource } from "./pdf-export";

export type PdfExportMode = "standard" | "secure";

interface RasterPage {
  pngBytes: Uint8Array;
  width: number;
  height: number;
}

export interface SecurePdfExportOptions {
  document: PDFDocumentProxy;
  overlays: PdfOverlay[];
  pageRotations: Record<number, number>;
  pageOrder?: number[];
  fontFamilies: Record<string, string>;
  images: PdfImageSource[];
  onProgress?: (completedPages: number, totalPages: number) => void;
  workloadLimits?: SecureRasterWorkloadLimits;
}

export interface SecureRasterPageSize {
  width: number;
  height: number;
}

export interface SecureRasterWorkloadLimits {
  maxPages: number;
  totalPixelBudget: number;
  maxPixelsPerPage: number;
  maxScale: number;
}

export interface SecureRasterWorkloadPlan {
  scale: number;
  estimatedPixels: number;
  pageCount: number;
}

const STANDARD_WORKLOAD_LIMITS: SecureRasterWorkloadLimits = {
  maxPages: 120,
  totalPixelBudget: 120_000_000,
  maxPixelsPerPage: 24_000_000,
  maxScale: 2,
};

const CONSTRAINED_WORKLOAD_LIMITS: SecureRasterWorkloadLimits = {
  maxPages: 40,
  totalPixelBudget: 48_000_000,
  maxPixelsPerPage: 8_000_000,
  maxScale: 1.6,
};

const SECURE_EXPORT_TOO_LARGE =
  "This PDF is too large to flatten securely in this browser. Split it into smaller PDFs, or use Standard PDF only when you do not need permanent covers.";

export function planSecureRasterWorkload(
  pages: SecureRasterPageSize[],
  limits: SecureRasterWorkloadLimits = STANDARD_WORKLOAD_LIMITS,
): SecureRasterWorkloadPlan {
  if (pages.length === 0) throw new Error("This PDF has no pages to export.");
  if (pages.length > limits.maxPages) throw new Error(SECURE_EXPORT_TOO_LARGE);

  const areas = pages.map(({ width, height }) => Math.max(1, width) * Math.max(1, height));
  const basePixels = areas.reduce((sum, area) => sum + area, 0);
  if (basePixels > limits.totalPixelBudget) throw new Error(SECURE_EXPORT_TOO_LARGE);

  const totalScale = Math.sqrt(limits.totalPixelBudget / basePixels);
  const perPageScale = Math.min(...areas.map((area) => Math.sqrt(limits.maxPixelsPerPage / area)));
  const scale = Math.min(limits.maxScale, totalScale, perPageScale);
  if (!Number.isFinite(scale) || scale < 1) throw new Error(SECURE_EXPORT_TOO_LARGE);

  return {
    scale,
    estimatedPixels: Math.ceil(basePixels * scale * scale),
    pageCount: pages.length,
  };
}

function browserWorkloadLimits(): SecureRasterWorkloadLimits {
  const memory = typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const narrowScreen = typeof window !== "undefined"
    && window.matchMedia("(max-width: 768px)").matches;
  return narrowScreen || (memory !== undefined && memory <= 4)
    ? CONSTRAINED_WORKLOAD_LIMITS
    : STANDARD_WORKLOAD_LIMITS;
}

function yieldToBrowser(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Could not flatten this PDF page."));
        return;
      }
      void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, "image/png");
  });
}

function wrapCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

async function decodeImage(source: PdfImageSource): Promise<ImageBitmap | HTMLImageElement> {
  const buffer = source.bytes.buffer.slice(
    source.bytes.byteOffset,
    source.bytes.byteOffset + source.bytes.byteLength,
  ) as ArrayBuffer;
  const blob = new Blob([buffer], { type: source.mimeType });
  if ("createImageBitmap" in window) return createImageBitmap(blob);

  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function paintText(
  context: CanvasRenderingContext2D,
  overlay: Extract<PdfOverlay, { kind: "text" }>,
  width: number,
  height: number,
  scale: number,
  fontFamily: string,
): void {
  const x = overlay.x * width;
  const y = overlay.y * height;
  const boxWidth = overlay.width * width;
  const boxHeight = overlay.height * height;
  const fontSize = overlay.fontSize * scale;
  const lineHeight = fontSize * overlay.lineHeight;

  context.save();
  context.translate(x, y);
  context.rotate(overlay.rotation * Math.PI / 180);
  context.beginPath();
  context.rect(0, 0, boxWidth, boxHeight);
  context.clip();
  context.globalAlpha = overlay.opacity;
  context.font = `${overlay.fontStyle} ${overlay.fontWeight} ${fontSize}px ${fontFamily}`;
  (context as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${overlay.letterSpacing * scale}px`;
  context.fillStyle = overlay.color;
  context.textBaseline = "top";
  context.direction = overlay.direction;
  context.textAlign = overlay.alignment === "center" ? "center" : overlay.alignment === "right" ? "right" : "left";
  const textX = overlay.alignment === "center" ? boxWidth / 2 : overlay.alignment === "right" ? boxWidth : 0;
  const maxLines = Math.max(1, Math.floor(boxHeight / lineHeight));
  wrapCanvasText(context, overlay.text, boxWidth).slice(0, maxLines).forEach((line, index) => {
    context.fillText(line, textX, index * lineHeight, boxWidth);
  });
  context.restore();
}

function paintShape(
  context: CanvasRenderingContext2D,
  overlay: Extract<PdfOverlay, { kind: "shape" }>,
  width: number,
  height: number,
  scale: number,
): void {
  const x = overlay.x * width;
  const y = overlay.y * height;
  const overlayWidth = overlay.width * width;
  const overlayHeight = overlay.height * height;
  context.save();
  context.translate(x, y);
  context.rotate(overlay.rotation * Math.PI / 180);
  context.globalAlpha = overlay.opacity;
  context.fillStyle = overlay.fillColor;
  context.strokeStyle = overlay.strokeColor;
  context.lineWidth = overlay.strokeWidth * scale;
  if (overlay.shape === "ellipse") {
    context.beginPath();
    context.ellipse(overlayWidth / 2, overlayHeight / 2, overlayWidth / 2, overlayHeight / 2, 0, 0, Math.PI * 2);
    context.fill();
    if (overlay.strokeWidth > 0) context.stroke();
  } else if (overlay.shape === "line") {
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(overlayWidth, overlayHeight);
    context.stroke();
  } else {
    context.fillRect(0, 0, overlayWidth, overlayHeight);
    if (overlay.strokeWidth > 0) context.strokeRect(0, 0, overlayWidth, overlayHeight);
  }
  context.restore();
}

function paintInk(
  context: CanvasRenderingContext2D,
  overlay: Extract<PdfOverlay, { kind: "ink" }>,
  width: number,
  height: number,
  scale: number,
): void {
  const first = overlay.points[0];
  if (!first) return;
  const x = overlay.x * width;
  const y = overlay.y * height;
  const overlayWidth = overlay.width * width;
  const overlayHeight = overlay.height * height;
  context.save();
  context.translate(x, y);
  context.rotate(overlay.rotation * Math.PI / 180);
  context.globalAlpha = overlay.opacity;
  context.strokeStyle = overlay.color;
  context.lineWidth = overlay.strokeWidth * scale;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(
    first.x * overlayWidth,
    first.y * overlayHeight,
  );
  for (const point of overlay.points.slice(1)) {
    context.lineTo(
      point.x * overlayWidth,
      point.y * overlayHeight,
    );
  }
  context.stroke();
  context.restore();
}

async function paintOverlays(
  context: CanvasRenderingContext2D,
  overlays: PdfOverlay[],
  width: number,
  height: number,
  scale: number,
  fontFamilies: Record<string, string>,
  imageMap: Map<string, ImageBitmap | HTMLImageElement>,
): Promise<void> {
  for (const overlay of overlays) {
    const x = overlay.x * width;
    const y = overlay.y * height;
    const overlayWidth = overlay.width * width;
    const overlayHeight = overlay.height * height;
    if (overlay.kind === "cover") {
      context.save();
      context.translate(x, y);
      context.rotate(overlay.rotation * Math.PI / 180);
      context.fillStyle = overlay.color;
      context.fillRect(0, 0, overlayWidth, overlayHeight);
      context.restore();
    } else if (overlay.kind === "image") {
      const image = imageMap.get(overlay.imageId);
      if (!image) continue;
      context.save();
      context.translate(x, y);
      context.rotate(overlay.rotation * Math.PI / 180);
      context.globalAlpha = Math.max(0, Math.min(1, overlay.opacity));
      const fit = Math.min(overlayWidth / image.width, overlayHeight / image.height);
      const fittedWidth = image.width * fit;
      const fittedHeight = image.height * fit;
      context.drawImage(
        image,
        (overlayWidth - fittedWidth) / 2,
        (overlayHeight - fittedHeight) / 2,
        fittedWidth,
        fittedHeight,
      );
      context.restore();
    } else if (overlay.kind === "shape") {
      paintShape(context, overlay, width, height, scale);
    } else if (overlay.kind === "ink") {
      paintInk(context, overlay, width, height, scale);
    } else {
      paintText(
        context,
        overlay,
        width,
        height,
        scale,
        fontFamilies[overlay.fontId] ?? "Arial, Helvetica, sans-serif",
      );
    }
  }
}

export async function buildPdfFromRasterPages(pages: RasterPage[]): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  for (const raster of pages) {
    const image = await output.embedPng(raster.pngBytes);
    const page = output.addPage([raster.width, raster.height]);
    page.drawImage(image, { x: 0, y: 0, width: raster.width, height: raster.height });
  }
  return output.save();
}

/**
 * Rebuilds the output from page pixels after overlays have been painted. The
 * source PDF objects and any covered text/pixels are absent from the new file.
 */
export async function exportSecureRasterizedPdf(options: SecurePdfExportOptions): Promise<Uint8Array> {
  const workloadLimits = options.workloadLimits ?? browserWorkloadLimits();
  const pageOrder = options.pageOrder?.length
    ? options.pageOrder
    : Array.from({ length: options.document.numPages }, (_, index) => index + 1);
  if (pageOrder.length > workloadLimits.maxPages) {
    throw new Error(SECURE_EXPORT_TOO_LARGE);
  }
  const sourcePages: Array<{
    page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>>;
    rotation: number;
    baseViewport: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["getViewport"]>;
  }> = [];
  for (let index = 0; index < pageOrder.length; index += 1) {
    const logicalPageNumber = index + 1;
    const sourcePageNumber = pageOrder[index]!;
    const page = await options.document.getPage(sourcePageNumber);
    const rotation = (page.rotate + (options.pageRotations[logicalPageNumber] ?? 0) + 360) % 360;
    sourcePages.push({
      page,
      rotation,
      baseViewport: page.getViewport({ scale: 1, rotation }),
    });
  }
  const plan = planSecureRasterWorkload(
    sourcePages.map(({ baseViewport }) => ({ width: baseViewport.width, height: baseViewport.height })),
    workloadLimits,
  );

  const imageMap = new Map<string, ImageBitmap | HTMLImageElement>();
  for (const source of options.images) imageMap.set(source.id, await decodeImage(source));

  const output = await PDFDocument.create();
  options.onProgress?.(0, sourcePages.length);
  try {
    for (let index = 0; index < sourcePages.length; index += 1) {
      const pageNumber = index + 1;
      const { page: sourcePage, rotation, baseViewport } = sourcePages[index]!;
      const viewport = sourcePage.getViewport({ scale: plan.scale, rotation });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("This browser cannot create a secure PDF canvas.");

      await sourcePage.render({ canvasContext: context, viewport }).promise;
      await paintOverlays(
        context,
        options.overlays.filter((overlay) => overlay.page === pageNumber),
        canvas.width,
        canvas.height,
        plan.scale,
        options.fontFamilies,
        imageMap,
      );
      const pngBytes = await canvasToPng(canvas);
      const image = await output.embedPng(pngBytes);
      const outputPage = output.addPage([baseViewport.width, baseViewport.height]);
      outputPage.drawImage(image, {
        x: 0,
        y: 0,
        width: baseViewport.width,
        height: baseViewport.height,
      });
      canvas.width = 1;
      canvas.height = 1;
      options.onProgress?.(pageNumber, sourcePages.length);
      await yieldToBrowser();
    }
  } finally {
    for (const image of imageMap.values()) {
      if ("close" in image && typeof image.close === "function") image.close();
    }
  }

  return output.save();
}

export function requiresSecureRasterExport(
  mode: PdfExportMode,
  pageRotations: Record<number, number>,
  overlays: PdfOverlay[] = [],
): boolean {
  return mode === "secure"
    || Object.values(pageRotations).some((rotation) => rotation % 360 !== 0)
    || overlays.some((overlay) => overlay.rotation % 360 !== 0);
}
