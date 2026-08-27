export type PdfTextAlignment = "left" | "center" | "right";

export type PdfStandardFont = "helvetica" | "times" | "courier";

export type PdfFontWeight = 400 | 700;

export type PdfFontStyle = "normal" | "italic";

export type PdfShapeType = "highlight" | "rectangle" | "ellipse" | "line";

export interface PdfOverlayBase {
  id: string;
  page: number;
  /** Positions and dimensions are stored as fractions of the page. */
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export interface PdfTextOverlay extends PdfOverlayBase {
  kind: "text";
  text: string;
  fontId: PdfStandardFont | string;
  fontSize: number;
  color: string;
  alignment: PdfTextAlignment;
  fontWeight: PdfFontWeight;
  fontStyle: PdfFontStyle;
  opacity: number;
  lineHeight: number;
  letterSpacing: number;
  direction: "ltr" | "rtl";
  sourceFontName?: string;
}

export interface PdfCoverOverlay extends PdfOverlayBase {
  kind: "cover";
  color: string;
}

export interface PdfImageOverlay extends PdfOverlayBase {
  kind: "image";
  imageId: string;
  opacity: number;
}

export interface PdfShapeOverlay extends PdfOverlayBase {
  kind: "shape";
  shape: PdfShapeType;
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  opacity: number;
}

export interface PdfInkPoint {
  x: number;
  y: number;
}

export interface PdfInkOverlay extends PdfOverlayBase {
  kind: "ink";
  /** Points are normalized within the overlay's own bounding box. */
  points: PdfInkPoint[];
  color: string;
  strokeWidth: number;
  opacity: number;
}

export type PdfOverlay = PdfTextOverlay | PdfCoverOverlay | PdfImageOverlay | PdfShapeOverlay | PdfInkOverlay;

export interface PdfEditorHistory {
  past: PdfOverlay[][];
  present: PdfOverlay[];
  future: PdfOverlay[][];
}

export interface PdfSourceTextPlacement {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontId?: string;
  fontName?: string;
  fontWeight?: PdfFontWeight;
  fontStyle?: PdfFontStyle;
  color?: string;
  alignment?: PdfTextAlignment;
  opacity?: number;
  lineHeight?: number;
  letterSpacing?: number;
  rotation?: number;
  direction?: "ltr" | "rtl";
  backgroundColor?: string;
}

export const EMPTY_PDF_HISTORY: PdfEditorHistory = {
  past: [],
  present: [],
  future: [],
};

const MAX_HISTORY = 100;
const MIN_SIZE = 0.02;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function createOverlayId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `overlay-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createTextOverlay(page: number, patch: Partial<PdfTextOverlay> = {}): PdfTextOverlay {
  return normalizeOverlay({
    id: createOverlayId(),
    kind: "text",
    page,
    x: 0.14,
    y: 0.14,
    width: 0.42,
    height: 0.09,
    rotation: 0,
    text: "Type replacement text",
    fontId: "helvetica",
    fontSize: 14,
    color: "#17212b",
    alignment: "left",
    fontWeight: 400,
    fontStyle: "normal",
    opacity: 1,
    lineHeight: 1.2,
    letterSpacing: 0,
    direction: "ltr",
    ...patch,
  }) as PdfTextOverlay;
}

export function createCoverOverlay(page: number, color: PdfCoverOverlay["color"] = "#ffffff"): PdfCoverOverlay {
  return normalizeOverlay({
    id: createOverlayId(),
    kind: "cover",
    page,
    x: 0.14,
    y: 0.22,
    width: 0.38,
    height: 0.06,
    rotation: 0,
    color,
  }) as PdfCoverOverlay;
}

export function createImageOverlay(
  page: number,
  imageId: string,
  aspectRatio = 2.5,
): PdfImageOverlay {
  const width = 0.3;
  return normalizeOverlay({
    id: createOverlayId(),
    kind: "image",
    page,
    x: 0.14,
    y: 0.18,
    width,
    height: Math.max(0.04, Math.min(0.3, width / Math.max(0.2, aspectRatio))),
    rotation: 0,
    imageId,
    opacity: 1,
  }) as PdfImageOverlay;
}

export function createShapeOverlay(
  page: number,
  shape: PdfShapeType = "highlight",
  patch: Partial<PdfShapeOverlay> = {},
): PdfShapeOverlay {
  return normalizeOverlay({
    id: createOverlayId(),
    kind: "shape",
    page,
    x: 0.14,
    y: 0.2,
    width: 0.42,
    height: shape === "line" ? 0.025 : 0.055,
    rotation: 0,
    shape,
    fillColor: shape === "highlight" ? "#fff176" : "#ffffff",
    strokeColor: shape === "highlight" ? "#fff176" : "#d04444",
    strokeWidth: shape === "highlight" ? 0 : 1.5,
    opacity: shape === "highlight" ? 0.45 : 1,
    ...patch,
  }) as PdfShapeOverlay;
}

export function createInkOverlay(
  page: number,
  pagePoints: PdfInkPoint[],
  patch: Partial<PdfInkOverlay> = {},
): PdfInkOverlay {
  const points = pagePoints.length > 0 ? pagePoints : [{ x: 0.18, y: 0.2 }, { x: 0.42, y: 0.26 }];
  const padding = 0.006;
  const minimumX = Math.max(0, Math.min(...points.map((point) => point.x)) - padding);
  const minimumY = Math.max(0, Math.min(...points.map((point) => point.y)) - padding);
  const maximumX = Math.min(1, Math.max(...points.map((point) => point.x)) + padding);
  const maximumY = Math.min(1, Math.max(...points.map((point) => point.y)) + padding);
  const width = Math.max(MIN_SIZE, maximumX - minimumX);
  const height = Math.max(MIN_SIZE, maximumY - minimumY);

  return normalizeOverlay({
    id: createOverlayId(),
    kind: "ink",
    page,
    x: minimumX,
    y: minimumY,
    width,
    height,
    rotation: 0,
    points: points.map((point) => ({
      x: clamp((point.x - minimumX) / width, 0, 1),
      y: clamp((point.y - minimumY) / height, 0, 1),
    })),
    color: "#17212b",
    strokeWidth: 2,
    opacity: 1,
    ...patch,
  }) as PdfInkOverlay;
}

/**
 * Creates one replacement operation in paint order: an opaque cover followed
 * by editable text. The small inset protects against antialiasing around the
 * original glyphs without noticeably changing the selected text box.
 */
export function createSourceTextReplacement(
  page: number,
  source: PdfSourceTextPlacement,
): [PdfCoverOverlay, PdfTextOverlay] {
  const horizontalPadding = Math.min(0.006, source.width * 0.08);
  const verticalPadding = Math.min(0.004, source.height * 0.12);
  const cover = normalizeOverlay({
    id: createOverlayId(),
    kind: "cover",
    page,
    x: source.x - horizontalPadding,
    y: source.y - verticalPadding,
    width: source.width + horizontalPadding * 2,
    height: source.height + verticalPadding * 2,
    rotation: source.rotation ?? 0,
    color: source.backgroundColor ?? "#ffffff",
  } as PdfCoverOverlay);
  const text = createTextOverlay(page, {
    text: source.text,
    x: source.x,
    y: source.y,
    width: source.width,
    height: source.height,
    fontSize: source.fontSize,
    fontId: source.fontId ?? "helvetica",
    sourceFontName: source.fontName,
    fontWeight: source.fontWeight ?? 400,
    fontStyle: source.fontStyle ?? "normal",
    color: source.color ?? "#111111",
    alignment: source.alignment ?? "left",
    opacity: source.opacity ?? 1,
    lineHeight: source.lineHeight ?? 1.15,
    letterSpacing: source.letterSpacing ?? 0,
    rotation: source.rotation ?? 0,
    direction: source.direction ?? "ltr",
  });
  return [cover, text];
}

export function hasPdfEditorChanges(
  overlays: PdfOverlay[],
  pageRotations: Record<number, number>,
): boolean {
  return overlays.length > 0
    || Object.values(pageRotations).some((rotation) => rotation % 360 !== 0);
}

/** Only generated class cover sheets may be handed directly into the editor. */
export function normalizePdfEditorSourcePath(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\/api\/classes\/invoices\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/cover-sheet$/i.test(value)
    ? value
    : null;
}

export function rotateOverlayPosition(
  overlay: PdfOverlay,
  direction: "clockwise" | "counterclockwise",
): PdfOverlay {
  if (direction === "clockwise") {
    return normalizeOverlay({
      ...overlay,
      x: 1 - overlay.y - overlay.height,
      y: overlay.x,
      width: overlay.height,
      height: overlay.width,
      rotation: overlay.rotation + 90,
    });
  }
  return normalizeOverlay({
    ...overlay,
    x: overlay.y,
    y: 1 - overlay.x - overlay.width,
    width: overlay.height,
    height: overlay.width,
    rotation: overlay.rotation - 90,
  });
}

export function normalizeOverlay<T extends PdfOverlay>(overlay: T): T {
  const width = clamp(overlay.width, MIN_SIZE, 1);
  const height = clamp(overlay.height, MIN_SIZE, 1);
  return {
    ...overlay,
    width,
    height,
    x: clamp(overlay.x, 0, 1 - width),
    y: clamp(overlay.y, 0, 1 - height),
    rotation: ((overlay.rotation % 360) + 360) % 360,
  };
}

export function moveOverlay(overlay: PdfOverlay, deltaX: number, deltaY: number): PdfOverlay {
  return normalizeOverlay({ ...overlay, x: overlay.x + deltaX, y: overlay.y + deltaY });
}

export function resizeOverlay(overlay: PdfOverlay, deltaWidth: number, deltaHeight: number): PdfOverlay {
  return normalizeOverlay({ ...overlay, width: overlay.width + deltaWidth, height: overlay.height + deltaHeight });
}

export function replaceOverlay(overlays: PdfOverlay[], next: PdfOverlay): PdfOverlay[] {
  return overlays.map((overlay) => (overlay.id === next.id ? normalizeOverlay(next) : overlay));
}

export function commitPdfHistory(history: PdfEditorHistory, overlays: PdfOverlay[]): PdfEditorHistory {
  if (history.present === overlays) return history;
  return {
    past: [...history.past.slice(-(MAX_HISTORY - 1)), history.present],
    present: overlays,
    future: [],
  };
}

export function undoPdfHistory(history: PdfEditorHistory): PdfEditorHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoPdfHistory(history: PdfEditorHistory): PdfEditorHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

export function deleteOverlay(overlays: PdfOverlay[], id: string): PdfOverlay[] {
  return overlays.filter((overlay) => overlay.id !== id);
}

export function duplicateOverlay(overlay: PdfOverlay): PdfOverlay {
  return normalizeOverlay({
    ...overlay,
    id: createOverlayId(),
    x: overlay.x + 0.015,
    y: overlay.y + 0.015,
  });
}
