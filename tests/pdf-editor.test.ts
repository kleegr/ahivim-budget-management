import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  EMPTY_PDF_HISTORY,
  commitPdfHistory,
  createCoverOverlay,
  createImageOverlay,
  createInkOverlay,
  createShapeOverlay,
  createSourceTextReplacement,
  createTextOverlay,
  duplicateOverlay,
  hasPdfEditorChanges,
  moveOverlay,
  normalizePdfEditorSourcePath,
  redoPdfHistory,
  resizeOverlay,
  rotateOverlayPosition,
  undoPdfHistory,
} from "@/lib/documents/pdf-editor";
import { exportPdfWithOverlays, fitPdfTextToBox } from "@/lib/documents/pdf-export";
import {
  groupPdfNativeTextItems,
  type PdfSourceTextItem,
} from "@/lib/documents/pdfjs-client";
import {
  buildPdfFromRasterPages,
  planSecureRasterWorkload,
  requiresSecureRasterExport,
} from "@/lib/documents/pdf-secure-export";
import { resolvePdfExportMode } from "@/lib/documents/pdf-export-mode";

const ONE_PIXEL_PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

function nativeTextItem(patch: Partial<PdfSourceTextItem> = {}): PdfSourceTextItem {
  return {
    id: "native-1-0",
    text: "Text",
    x: 0.1,
    y: 0.1,
    width: 0.04,
    height: 0.02,
    fontSize: 12,
    fontId: "helvetica",
    fontName: "Helvetica",
    cssFamily: "Arial, sans-serif",
    fontWeight: 400,
    fontStyle: "normal",
    color: "#111111",
    backgroundColor: "#ffffff",
    alignment: "left",
    opacity: 1,
    lineHeight: 1.15,
    letterSpacing: 0,
    rotation: 0,
    direction: "ltr",
    origin: "native",
    ...patch,
  };
}

describe("PDF native text reconstruction", () => {
  it("groups fragmented runs and neighboring lines into one stable editable block", () => {
    const grouped = groupPdfNativeTextItems([
      nativeTextItem({ id: "native-1-3", text: "line", x: 0.154, y: 0.13, width: 0.03 }),
      nativeTextItem({ id: "native-1-0", text: "Hel", x: 0.1, width: 0.022 }),
      nativeTextItem({ id: "native-1-2", text: "Second", x: 0.1, y: 0.13, width: 0.048 }),
      nativeTextItem({ id: "native-1-1", text: "lo world", x: 0.123, width: 0.065 }),
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      id: "native-block:native-1-0:native-1-3",
      text: "Hello world\nSecond line",
      x: 0.1,
      y: 0.1,
      fontId: "helvetica",
      fontSize: 12,
    });
    expect(grouped[0]!.width).toBeCloseTo(0.088);
    expect(grouped[0]!.height).toBeCloseTo(0.05);
  });

  it("keeps separate columns and visibly different fonts in separate blocks", () => {
    const grouped = groupPdfNativeTextItems([
      nativeTextItem({ id: "native-1-0", text: "Left one", x: 0.08, y: 0.1, width: 0.16 }),
      nativeTextItem({ id: "native-1-1", text: "Right one", x: 0.62, y: 0.1, width: 0.16 }),
      nativeTextItem({ id: "native-1-2", text: "Left two", x: 0.08, y: 0.13, width: 0.16 }),
      nativeTextItem({ id: "native-1-3", text: "Right two", x: 0.62, y: 0.13, width: 0.16 }),
      nativeTextItem({
        id: "native-1-4",
        text: "Other font",
        x: 0.25,
        y: 0.1,
        width: 0.1,
        fontName: "Calibri",
        cssFamily: "Calibri, sans-serif",
      }),
    ]);

    expect(grouped.map((item) => item.text)).toEqual([
      "Left one\nLeft two",
      "Other font",
      "Right one\nRight two",
    ]);
  });

  it("orders RTL fragments from right to left and retains right alignment", () => {
    const grouped = groupPdfNativeTextItems([
      nativeTextItem({ id: "native-1-1", text: "\u05e2\u05d5\u05dc\u05dd", x: 0.2, width: 0.045, direction: "rtl", alignment: "right" }),
      nativeTextItem({ id: "native-1-0", text: "\u05e9\u05dc\u05d5\u05dd", x: 0.255, width: 0.05, direction: "rtl", alignment: "right" }),
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ text: "\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd", direction: "rtl", alignment: "right" });
  });
});

describe("PDF editor history", () => {
  it("undoes and redoes complete editing gestures", () => {
    const text = createTextOverlay(1, { text: "Replacement" });
    const withText = commitPdfHistory(EMPTY_PDF_HISTORY, [text]);
    const moved = moveOverlay(text, 0.2, 0.1);
    const withMove = commitPdfHistory(withText, [moved]);

    expect(withMove.present[0]).toMatchObject({ x: text.x + 0.2, y: text.y + 0.1 });
    expect(undoPdfHistory(withMove).present).toEqual([text]);
    expect(redoPdfHistory(undoPdfHistory(withMove)).present).toEqual([moved]);
  });

  it("keeps moved and resized overlays inside page bounds", () => {
    const cover = createCoverOverlay(1);
    const moved = moveOverlay(cover, 2, -2);
    const resized = resizeOverlay(moved, 2, -2);

    expect(moved.x).toBeLessThanOrEqual(1 - moved.width);
    expect(moved.y).toBe(0);
    expect(resized.width).toBeLessThanOrEqual(1);
    expect(resized.height).toBeGreaterThanOrEqual(0.02);
    expect(resized.x + resized.width).toBeLessThanOrEqual(1);
    expect(resized.y + resized.height).toBeLessThanOrEqual(1);
  });

  it("keeps an overlay on-page through clockwise and counterclockwise rotation", () => {
    const original = createTextOverlay(1, { x: 0.1, y: 0.2, width: 0.3, height: 0.08 });
    const clockwise = rotateOverlayPosition(original, "clockwise");
    const restored = rotateOverlayPosition(clockwise, "counterclockwise");

    expect(clockwise.x).toBeCloseTo(0.72);
    expect(clockwise).toMatchObject({ y: 0.1, width: 0.08, height: 0.3 });
    expect(restored.x).toBeCloseTo(0.1);
    expect(restored.y).toBeCloseTo(0.2);
    expect(restored).toMatchObject({ width: 0.3, height: 0.08 });
  });

  it("creates a white cover behind editable replacement text as one snapshot", () => {
    const [cover, text] = createSourceTextReplacement(2, {
      text: "Original label",
      x: 0.2,
      y: 0.3,
      width: 0.24,
      height: 0.04,
      fontSize: 12,
    });
    const history = commitPdfHistory(EMPTY_PDF_HISTORY, [cover, text]);

    expect(history.present.map((overlay) => overlay.kind)).toEqual(["cover", "text"]);
    expect(cover).toMatchObject({ page: 2, color: "#ffffff" });
    expect(cover.x).toBeLessThan(text.x);
    expect(cover.y).toBeLessThan(text.y);
    expect(cover.x + cover.width).toBeGreaterThan(text.x + text.width);
    expect(cover.y + cover.height).toBeGreaterThan(text.y + text.height);
    expect(text).toMatchObject({ text: "Original label", fontSize: 12 });
    expect(undoPdfHistory(history).present).toEqual([]);
  });

  it("preserves detected typography and sampled background in a source replacement", () => {
    const [cover, text] = createSourceTextReplacement(1, {
      text: "Invoice date",
      x: 0.2,
      y: 0.3,
      width: 0.18,
      height: 0.035,
      fontSize: 10.5,
      fontId: "times",
      fontName: "Times New Roman Bold",
      fontWeight: 700,
      fontStyle: "italic",
      color: "#222222",
      backgroundColor: "#eeeeee",
      alignment: "right",
      opacity: 0.9,
      lineHeight: 1.1,
      letterSpacing: 0.25,
      rotation: 2,
      direction: "rtl",
    });

    expect(cover.color).toBe("#eeeeee");
    expect(text).toMatchObject({
      fontId: "times",
      sourceFontName: "Times New Roman Bold",
      fontWeight: 700,
      fontStyle: "italic",
      color: "#222222",
      alignment: "right",
      opacity: 0.9,
      lineHeight: 1.1,
      letterSpacing: 0.25,
      rotation: 2,
      direction: "rtl",
    });
  });

  it("creates movable drawing and shape layers and duplicates without sharing identity", () => {
    const ink = createInkOverlay(1, [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.25 }, { x: 0.3, y: 0.22 }]);
    const highlight = createShapeOverlay(1, "highlight");
    const duplicate = duplicateOverlay(highlight);

    expect(ink.points).toHaveLength(3);
    expect(ink.width).toBeGreaterThan(0.1);
    expect(highlight).toMatchObject({ kind: "shape", shape: "highlight", opacity: 0.45 });
    expect(duplicate.id).not.toBe(highlight.id);
    expect(duplicate.x).toBeGreaterThan(highlight.x);
  });

  it("treats page rotations as unsaved work", () => {
    expect(hasPdfEditorChanges([], {})).toBe(false);
    expect(hasPdfEditorChanges([], { 1: 90 })).toBe(true);
    expect(hasPdfEditorChanges([], { 1: 360 })).toBe(false);
    expect(hasPdfEditorChanges([createCoverOverlay(1)], {})).toBe(true);
  });

  it("only accepts generated class PDFs for editor handoff", () => {
    const cover = "/api/classes/invoices/123e4567-e89b-42d3-a456-426614174000/cover-sheet";
    const invoice = "/api/classes/invoices/123e4567-e89b-42d3-a456-426614174000/pdf";
    expect(normalizePdfEditorSourcePath(cover)).toBe(cover);
    expect(normalizePdfEditorSourcePath(invoice)).toBe(invoice);
    expect(normalizePdfEditorSourcePath("https://example.com/document.pdf")).toBeNull();
    expect(normalizePdfEditorSourcePath("/api/classes/invoices/../../admin/cover-sheet")).toBeNull();
    expect(normalizePdfEditorSourcePath("/api/classes/invoices/not-a-uuid/cover-sheet")).toBeNull();
    expect(normalizePdfEditorSourcePath(`${invoice}?preview=1`)).toBeNull();
  });
});

describe("PDF overlay export", () => {
  it("reduces the font size until all multiline text fits without dropping words", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const text = "First explicit line with several words\nSecond explicit line also needs room";
    const layout = fitPdfTextToBox(text, font, 18, 125, 42, 1.2);

    expect(layout.fontSize).toBeLessThan(18);
    expect(layout.lines.length * layout.lineHeight).toBeLessThanOrEqual(42.001);
    expect(layout.lines.join(" ").split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it("fits a long unbroken value without omitting any characters", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Courier);
    const text = "LONGREFERENCEVALUE".repeat(12);
    const layout = fitPdfTextToBox(text, font, 16, 72, 30, 1.15, 0.2);

    expect(layout.fontSize).toBeLessThan(16);
    expect(layout.lines.join("")).toBe(text);
    expect(layout.lines.length * layout.lineHeight).toBeLessThanOrEqual(30.001);
    expect(layout.lines.every((line) => (
      font.widthOfTextAtSize(line, layout.fontSize)
      + Math.max(0, [...line].length - 1) * 0.2
    ) <= 72.001)).toBe(true);
  });

  it("preserves the source bytes and every source page while flattening a multi-page copy", async () => {
    const sourceDocument = await PDFDocument.create();
    sourceDocument.addPage([612, 792]);
    sourceDocument.addPage([792, 612]);
    const source = await sourceDocument.save();
    const sourceSnapshot = source.slice();

    const output = await exportPdfWithOverlays(source, [
      createCoverOverlay(1),
      createImageOverlay(1, "signature"),
      createTextOverlay(2, {
        text: "Approved cover sheet",
        x: 0.1,
        y: 0.2,
        width: 0.4,
        height: 0.08,
        alignment: "center",
      }),
    ], [], [{ id: "signature", bytes: ONE_PIXEL_PNG, mimeType: "image/png" }]);

    expect(source).toEqual(sourceSnapshot);
    expect(output).not.toEqual(source);
    const exported = await PDFDocument.load(output);
    expect(exported.getPageCount()).toBe(2);
    expect(exported.getPage(0).node.Contents()).toBeDefined();
    expect(exported.getPage(1).node.Contents()).toBeDefined();
  });

  it("exports shapes, ink, richer text, and a reordered duplicate page working copy", async () => {
    const sourceDocument = await PDFDocument.create();
    sourceDocument.addPage([612, 792]);
    sourceDocument.addPage([792, 612]);
    const source = await sourceDocument.save();
    const output = await exportPdfWithOverlays(source, [
      createShapeOverlay(1, "highlight"),
      createInkOverlay(1, [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.2 }]),
      createTextOverlay(2, {
        text: "Matched text",
        fontWeight: 700,
        fontStyle: "italic",
        letterSpacing: 0.5,
        rotation: 4,
      }),
    ], [], [], [2, 1, 2]);

    const exported = await PDFDocument.load(output);
    expect(exported.getPageCount()).toBe(3);
    expect(exported.getPage(0).getSize()).toEqual({ width: 792, height: 612 });
    expect(exported.getPage(1).getSize()).toEqual({ width: 612, height: 792 });
    expect(exported.getPage(2).getSize()).toEqual({ width: 792, height: 612 });
  });

  it("builds a new PDF from sanitized raster pages without carrying source objects", async () => {
    const output = await buildPdfFromRasterPages([
      { pngBytes: ONE_PIXEL_PNG, width: 612, height: 792 },
      { pngBytes: ONE_PIXEL_PNG, width: 792, height: 612 },
    ]);
    const rebuilt = await PDFDocument.load(output);

    expect(rebuilt.getPageCount()).toBe(2);
    expect(rebuilt.getForm().getFields()).toEqual([]);
    expect(requiresSecureRasterExport("secure", {})).toBe(true);
    expect(requiresSecureRasterExport("standard", { 1: 90 })).toBe(true);
    expect(requiresSecureRasterExport("standard", { 1: 0 })).toBe(false);
    expect(requiresSecureRasterExport("standard", {}, [{
      ...createTextOverlay(1),
      rotation: 15,
    }])).toBe(true);
  });

  it("adapts secure resolution to a total pixel budget and rejects unsafe workloads", () => {
    const pages = Array.from({ length: 10 }, () => ({ width: 612, height: 792 }));
    const plan = planSecureRasterWorkload(pages, {
      maxPages: 20,
      totalPixelBudget: 10_000_000,
      maxPixelsPerPage: 2_000_000,
      maxScale: 2,
    });

    expect(plan.pageCount).toBe(10);
    expect(plan.scale).toBeGreaterThanOrEqual(1);
    expect(plan.scale).toBeLessThan(2);
    expect(plan.estimatedPixels).toBeLessThanOrEqual(10_000_001);
    expect(() => planSecureRasterWorkload(pages, {
      maxPages: 5,
      totalPixelBudget: 10_000_000,
      maxPixelsPerPage: 2_000_000,
      maxScale: 2,
    })).toThrow(/too large to flatten securely/i);
  });
});

describe("PDF export mode resolution", () => {
  const unconstrained = {
    hasPageRotation: false,
    hasRotatedOverlay: false,
    pageOrderChanged: false,
    hasFormFields: false,
  };

  it("keeps high-fidelity as the default when the working copy supports it", () => {
    expect(resolvePdfExportMode("standard", unconstrained)).toEqual({
      mode: "standard",
      forced: false,
      reason: null,
    });
    expect(resolvePdfExportMode("secure", unconstrained)).toEqual({
      mode: "secure",
      forced: false,
      reason: null,
    });
  });

  it("forces and explains sanitized output before reordered form pages export", () => {
    const resolution = resolvePdfExportMode("standard", {
      ...unconstrained,
      pageOrderChanged: true,
      hasFormFields: true,
    });

    expect(resolution.mode).toBe("secure");
    expect(resolution.forced).toBe(true);
    expect(resolution.reason).toMatch(/reordering pages in a fillable PDF/i);
    expect(resolvePdfExportMode("standard", {
      ...unconstrained,
      pageOrderChanged: true,
      hasFormFields: false,
    }).mode).toBe("standard");
  });
});
