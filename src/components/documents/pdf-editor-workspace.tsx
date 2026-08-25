"use client";

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Eraser,
  FileText,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  Redo2,
  RotateCcw,
  RotateCw,
  Settings2,
  Trash2,
  Type,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { PdfPageCanvas, PdfThumbnailCanvas } from "./pdf-page-canvas";
import {
  EMPTY_PDF_HISTORY,
  commitPdfHistory,
  createCoverOverlay,
  createImageOverlay,
  createSourceTextReplacement,
  createTextOverlay,
  deleteOverlay,
  hasPdfEditorChanges,
  moveOverlay,
  normalizeOverlay,
  redoPdfHistory,
  replaceOverlay,
  resizeOverlay,
  rotateOverlayPosition,
  undoPdfHistory,
  type PdfEditorHistory,
  type PdfOverlay,
  type PdfTextOverlay,
} from "@/lib/documents/pdf-editor";
import type { PdfImageSource } from "@/lib/documents/pdf-export";
import type { PdfExportMode } from "@/lib/documents/pdf-secure-export";
import {
  inspectPdfPageText,
  loadPdfJs,
  type PdfSourceTextItem,
} from "@/lib/documents/pdfjs-client";

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const STANDARD_FONTS = [
  { id: "helvetica", label: "Helvetica", css: "Arial, Helvetica, sans-serif" },
  { id: "times", label: "Times Roman", css: '"Times New Roman", Times, serif' },
  { id: "courier", label: "Courier", css: '"Courier New", Courier, monospace' },
] as const;

interface LoadedPdf {
  name: string;
  bytes: Uint8Array;
  document: PDFDocumentProxy;
}

interface CustomFont {
  id: string;
  name: string;
  bytes: Uint8Array;
  cssFamily: string;
  objectUrl: string;
  face: FontFace;
}

interface EditorImage extends PdfImageSource {
  name: string;
  objectUrl: string;
}

function downloadName(sourceName: string, secure: boolean): string {
  const base = sourceName.replace(/\.pdf$/i, "") || "document";
  return `${base}-edited${secure ? "-secure" : ""}.pdf`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && /password/i.test(`${error.name} ${error.message}`)) {
    return "This PDF is password protected. Open an unlocked copy to edit it.";
  }
  return error instanceof Error ? error.message : "The PDF could not be opened.";
}

function responsePdfName(response: Response): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const name = match?.[1]?.replace(/[\\/]/g, "-").trim();
  return name?.toLowerCase().endsWith(".pdf") ? name : "reimbursement-cover-sheet.pdf";
}

function percent(value: number): string {
  return String(Math.round(value * 1000) / 10);
}

function fontCss(fontId: string, customFonts: CustomFont[]): string {
  return customFonts.find((font) => font.id === fontId)?.cssFamily
    ?? STANDARD_FONTS.find((font) => font.id === fontId)?.css
    ?? STANDARD_FONTS[0].css;
}

function ToolButton({
  label,
  disabled,
  onClick,
  children,
  active = false,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active ? true : undefined}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`btn btn-sm btn-icon ${active ? "border-[var(--color-primary)] bg-[var(--color-primary-tint)] text-[var(--color-primary)]" : "btn-ghost"}`}
    >
      {children}
    </button>
  );
}

export default function PdfEditorWorkspace({
  initialSourcePath = null,
}: {
  initialSourcePath?: string | null;
}) {
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [history, setHistory] = useState<PdfEditorHistory>(EMPTY_PDF_HISTORY);
  const [draft, setDraft] = useState<PdfOverlay[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState({ width: 612, height: 792 });
  const [viewportWidth, setViewportWidth] = useState(760);
  const [fitPage, setFitPage] = useState(true);
  const [manualScale, setManualScale] = useState(1);
  const [opening, setOpening] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ completed: number; total: number } | null>(null);
  const [draggingOver, setDraggingOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sourceText, setSourceText] = useState<PdfSourceTextItem[] | null>(null);
  const [inspectorTab, setInspectorTab] = useState<"properties" | "source">("properties");
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([]);
  const [images, setImages] = useState<EditorImage[]>([]);
  const [pageRotations, setPageRotations] = useState<Record<number, number>>({});
  const [exportMode, setExportMode] = useState<PdfExportMode>("standard");
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pageViewportRef = useRef<HTMLDivElement>(null);
  const pageSurfaceRef = useRef<HTMLDivElement>(null);
  const customFontsRef = useRef<CustomFont[]>([]);
  const imagesRef = useRef<EditorImage[]>([]);
  const loadedDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const mountedRef = useRef(true);
  const initialSourceLoadedRef = useRef<string | null>(null);
  const displayOverlays = draft ?? history.present;
  const selected = displayOverlays.find((overlay) => overlay.id === selectedId) ?? null;
  const pageRotation = pageRotations[pageNumber] ?? 0;
  const hasChanges = hasPdfEditorChanges(history.present, pageRotations);

  const effectiveScale = useMemo(() => {
    if (!fitPage) return manualScale;
    return Math.max(0.25, Math.min(1.6, (viewportWidth - 40) / pageSize.width));
  }, [fitPage, manualScale, pageSize.width, viewportWidth]);

  const setBasePageSize = useCallback((next: { width: number; height: number }) => {
    setPageSize((current) => (
      current.width === next.width && current.height === next.height ? current : next
    ));
  }, []);

  useEffect(() => {
    const viewport = pageViewportRef.current;
    if (!viewport) return;
    const update = () => setViewportWidth(viewport.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    let active = true;
    setSourceText(null);
    void inspectPdfPageText(loaded.document, pageNumber, pageRotation)
      .then((items) => {
        if (active) setSourceText(items);
      })
      .catch(() => {
        if (active) setSourceText([]);
      });
    return () => {
      active = false;
    };
  }, [loaded, pageNumber, pageRotation]);

  useEffect(() => {
    if (selectedId && !history.present.some((overlay) => overlay.id === selectedId)) {
      setSelectedId(null);
    }
  }, [history.present, selectedId]);

  useEffect(() => {
    if (!hasChanges) return;
    const protectWork = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", protectWork);
    return () => window.removeEventListener("beforeunload", protectWork);
  }, [hasChanges]);

  useEffect(() => {
    customFontsRef.current = customFonts;
  }, [customFonts]);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void loadedDocumentRef.current?.destroy();
      for (const font of customFontsRef.current) {
        document.fonts.delete(font.face);
        URL.revokeObjectURL(font.objectUrl);
      }
      for (const image of imagesRef.current) URL.revokeObjectURL(image.objectUrl);
    };
  }, []);

  const commit = useCallback((overlays: PdfOverlay[]) => {
    setHistory((current) => commitPdfHistory(current, overlays));
    setDraft(null);
    setNotice(null);
  }, []);

  const undo = useCallback(() => {
    setDraft(null);
    setHistory((current) => undoPdfHistory(current));
  }, []);

  const redo = useCallback(() => {
    setDraft(null);
    setHistory((current) => redoPdfHistory(current));
  }, []);

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    commit(deleteOverlay(history.present, selectedId));
    setSelectedId(null);
  }, [commit, history.present, selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const editingText = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement;
      if ((event.metaKey || event.ctrlKey) && !editingText && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if ((event.metaKey || event.ctrlKey) && !editingText && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if (!editingText && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        removeSelected();
      } else if (event.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redo, removeSelected, undo]);

  const clearCustomFonts = useCallback(() => {
    setCustomFonts((fonts) => {
      for (const font of fonts) {
        document.fonts.delete(font.face);
        URL.revokeObjectURL(font.objectUrl);
      }
      return [];
    });
  }, []);

  const clearImages = useCallback(() => {
    setImages((current) => {
      for (const image of current) URL.revokeObjectURL(image.objectUrl);
      return [];
    });
  }, []);

  const openPdf = useCallback(async (file: File, skipDiscardConfirmation = false) => {
    setError(null);
    setNotice(null);
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      setError("Choose a PDF file.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setError("This PDF is larger than 100 MB.");
      return;
    }
    if (
      !skipDiscardConfirmation
      && loaded
      && hasChanges
      && !window.confirm("Open a new PDF and discard the current edits?")
    ) {
      return;
    }

    setOpening(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pdfjs = await loadPdfJs();
      const loadingTask = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
      const pdfDocument = await loadingTask.promise;
      if (!mountedRef.current) {
        void pdfDocument.destroy();
        return;
      }
      const previousDocument = loadedDocumentRef.current;
      loadedDocumentRef.current = pdfDocument;
      setLoaded({ name: file.name, bytes, document: pdfDocument });
      setHistory(EMPTY_PDF_HISTORY);
      setDraft(null);
      setSelectedId(null);
      setPageNumber(1);
      setFitPage(true);
      setPageRotations({});
      setExportMode("standard");
      setInspectorTab("properties");
      setMobileInspectorOpen(false);
      clearCustomFonts();
      clearImages();
      void previousDocument?.destroy();
    } catch (openError) {
      setError(errorMessage(openError));
    } finally {
      setOpening(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [clearCustomFonts, clearImages, hasChanges, loaded]);

  useEffect(() => {
    if (!initialSourcePath || initialSourceLoadedRef.current === initialSourcePath) return;
    const controller = new AbortController();
    let active = true;
    setOpening(true);
    setError(null);
    void fetch(initialSourcePath, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok || !response.headers.get("content-type")?.includes("application/pdf")) {
          throw new Error("The generated cover sheet could not be opened.");
        }
        const blob = await response.blob();
        return new File([blob], responsePdfName(response), { type: "application/pdf" });
      })
      .then(async (file) => {
        if (!active) return;
        initialSourceLoadedRef.current = initialSourcePath;
        await openPdf(file, true);
        window.history.replaceState(null, "", "/documents/pdf-editor");
      })
      .catch((sourceError: unknown) => {
        if (active && !(sourceError instanceof DOMException && sourceError.name === "AbortError")) {
          setError(errorMessage(sourceError));
        }
      })
      .finally(() => {
        if (active) setOpening(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [initialSourcePath, openPdf]);

  const addText = (source?: PdfSourceTextItem) => {
    const overlay = createTextOverlay(pageNumber, source ? {
      text: source.text,
      x: source.x,
      y: source.y,
      width: Math.min(1 - source.x, Math.max(0.12, source.width)),
      height: Math.min(1 - source.y, Math.max(0.04, source.height)),
      fontSize: source.fontSize,
    } : {});
    commit([...history.present, overlay]);
    setSelectedId(overlay.id);
    setInspectorTab("properties");
    setMobileInspectorOpen(true);
  };

  const replaceSourceText = (source: PdfSourceTextItem) => {
    const [cover, text] = createSourceTextReplacement(pageNumber, source);
    commit([...history.present, cover, text]);
    setSelectedId(text.id);
    setInspectorTab("properties");
    setMobileInspectorOpen(true);
    setExportMode("secure");
  };

  const addCover = () => {
    const overlay = createCoverOverlay(pageNumber);
    commit([...history.present, overlay]);
    setSelectedId(overlay.id);
    setInspectorTab("properties");
    setMobileInspectorOpen(true);
    setExportMode("secure");
  };

  const importImage = async (file: File) => {
    const mimeType = file.type === "image/png" || file.name.toLowerCase().endsWith(".png")
      ? "image/png"
      : file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name)
        ? "image/jpeg"
        : null;
    if (!mimeType) {
      setError("Choose a PNG or JPEG image.");
      return;
    }

    setError(null);
    const objectUrl = URL.createObjectURL(file);
    try {
      const preview = new Image();
      preview.src = objectUrl;
      await preview.decode();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const id = `image-${crypto.randomUUID()}`;
      const image: EditorImage = { id, name: file.name, bytes, mimeType, objectUrl };
      setImages((current) => [...current, image]);
      const visualAspect = preview.naturalWidth / Math.max(1, preview.naturalHeight);
      const normalizedAspect = visualAspect * pageSize.height / pageSize.width;
      const overlay = createImageOverlay(pageNumber, id, normalizedAspect);
      commit([...history.present, overlay]);
      setSelectedId(overlay.id);
      setInspectorTab("properties");
      setMobileInspectorOpen(true);
    } catch (imageError) {
      URL.revokeObjectURL(objectUrl);
      setError(`That image could not be loaded. ${errorMessage(imageError)}`);
    } finally {
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  };

  const rotatePage = (direction: "clockwise" | "counterclockwise") => {
    const delta = direction === "clockwise" ? 90 : -90;
    const transform = (snapshot: PdfOverlay[]) => snapshot.map((overlay) => (
      overlay.page === pageNumber ? rotateOverlayPosition(overlay, direction) : overlay
    ));
    setHistory((current) => ({
      past: current.past.map(transform),
      present: transform(current.present),
      future: current.future.map(transform),
    }));
    setDraft(null);
    setPageRotations((current) => ({
      ...current,
      [pageNumber]: ((current[pageNumber] ?? 0) + delta + 360) % 360,
    }));
    setExportMode("secure");
  };

  const updateSelected = (patch: Partial<PdfOverlay>) => {
    const current = history.present.find((overlay) => overlay.id === selectedId);
    if (!current) return;
    commit(replaceOverlay(history.present, normalizeOverlay({ ...current, ...patch } as PdfOverlay)));
  };

  const reorderSelected = (direction: "up" | "down") => {
    const index = history.present.findIndex((overlay) => overlay.id === selectedId);
    const target = direction === "up" ? index + 1 : index - 1;
    if (index < 0 || target < 0 || target >= history.present.length) return;
    const next = [...history.present];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };

  const startGesture = (
    event: React.PointerEvent,
    overlay: PdfOverlay,
    mode: "move" | "resize",
  ) => {
    if (event.button !== 0 || !pageSurfaceRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(overlay.id);
    setInspectorTab("properties");
    setMobileInspectorOpen(true);
    const bounds = pageSurfaceRef.current.getBoundingClientRect();
    const origin = { x: event.clientX, y: event.clientY };
    const initial = history.present;
    let latest = initial;
    let changed = false;

    const move = (moveEvent: PointerEvent) => {
      const deltaX = (moveEvent.clientX - origin.x) / bounds.width;
      const deltaY = (moveEvent.clientY - origin.y) / bounds.height;
      const nextOverlay = mode === "move"
        ? moveOverlay(overlay, deltaX, deltaY)
        : resizeOverlay(overlay, deltaX, deltaY);
      latest = replaceOverlay(initial, nextOverlay);
      changed = true;
      setDraft(latest);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (changed) commit(latest);
      else setDraft(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  const importFont = async (file: File) => {
    setError(null);
    let objectUrl: string | null = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const id = `custom-${crypto.randomUUID()}`;
      const cssFamily = `AhivimPdfFont-${id}`;
      objectUrl = URL.createObjectURL(file);
      const face = new FontFace(cssFamily, `url(${objectUrl})`);
      await face.load();
      document.fonts.add(face);
      const font: CustomFont = {
        id,
        name: file.name.replace(/\.(?:ttf|otf)$/i, ""),
        bytes,
        cssFamily,
        objectUrl,
        face,
      };
      setCustomFonts((current) => [...current, font]);
      if (selected?.kind === "text") updateSelected({ fontId: id } as Partial<PdfTextOverlay>);
    } catch (fontError) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setError(`That font could not be loaded. ${errorMessage(fontError)}`);
    } finally {
      if (fontInputRef.current) fontInputRef.current.value = "";
    }
  };

  const exportPdf = async () => {
    if (!loaded) return;
    setExporting(true);
    setError(null);
    setNotice(null);
    try {
      const secureExport = await import("@/lib/documents/pdf-secure-export");
      let secure = secureExport.requiresSecureRasterExport(exportMode, pageRotations);
      if (!secure) {
        for (let page = 1; page <= loaded.document.numPages; page += 1) {
          if ((await loaded.document.getPage(page)).rotate % 360 !== 0) {
            secure = true;
            break;
          }
        }
      }
      const fontFamilies = Object.fromEntries([
        ...STANDARD_FONTS.map((font) => [font.id, font.css]),
        ...customFonts.map((font) => [font.id, font.cssFamily]),
      ]);
      if (secure) setExportProgress({ completed: 0, total: loaded.document.numPages });
      const output = secure
        ? await secureExport.exportSecureRasterizedPdf({
            document: loaded.document,
            overlays: history.present,
            pageRotations,
            fontFamilies,
            images,
            onProgress: (completed, total) => setExportProgress({ completed, total }),
          })
        : await (await import("@/lib/documents/pdf-export")).exportPdfWithOverlays(
            loaded.bytes,
            history.present,
            customFonts.map(({ id, bytes }) => ({ id, bytes })),
            images,
          );
      const buffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([buffer], { type: "application/pdf" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = downloadName(loaded.name, secure);
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setNotice(secure ? "Secure flattened copy downloaded." : "Edited copy downloaded. Source preserved.");
    } catch (exportError) {
      setError(errorMessage(exportError));
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

  if (!loaded) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <p className="eyebrow">Documents</p>
          <h1 className="display mt-1 text-2xl text-[var(--color-ink)] sm:text-3xl">PDF workspace</h1>
        </header>

        <section
          onDragEnter={(event) => { event.preventDefault(); setDraggingOver(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingOver(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDraggingOver(false);
            const file = event.dataTransfer.files[0];
            if (file) void openPdf(file);
          }}
          className={`card grid min-h-[26rem] place-items-center border-2 border-dashed p-6 text-center transition-colors ${draggingOver ? "border-[var(--color-primary)] bg-[var(--color-primary-tint)]" : "border-[var(--color-rule-strong)]"}`}
        >
          <div className="max-w-sm">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-lg bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
              {opening ? <LoaderCircle className="h-7 w-7 animate-spin" aria-hidden /> : <FileText className="h-7 w-7" aria-hidden />}
            </div>
            <h2 className="mt-5 text-lg font-semibold">Open a PDF</h2>
            <p className="mt-2 text-xs text-[var(--color-ink-faint)]">PDF · 100 MB maximum · Local session</p>
            <button
              type="button"
              className="btn btn-primary mt-5"
              disabled={opening}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-4 w-4" aria-hidden />
              Choose PDF
            </button>
            {error ? <p className="mt-4 text-sm font-medium text-[var(--color-danger)]" role="alert">{error}</p> : null}
          </div>
        </section>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void openPdf(file);
          }}
        />
      </div>
    );
  }

  const pageOverlays = displayOverlays.filter((overlay) => overlay.page === pageNumber);
  const textSourceState = sourceText === null
    ? "Checking text"
    : sourceText.length > 0
      ? "Searchable text"
      : "Image or scan";

  return (
    <div className="space-y-4 pb-16 lg:pb-0">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Documents / PDF workspace</p>
          <h1 className="display mt-1 truncate text-2xl text-[var(--color-ink)]">{loaded.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-faint)]">
            <span>{loaded.document.numPages} {loaded.document.numPages === 1 ? "page" : "pages"}</span>
            <span aria-hidden>·</span>
            <span>{textSourceState}</span>
            <span aria-hidden>·</span>
            <span>Original preserved</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <label className="sr-only" htmlFor="pdf-export-mode">Export mode</label>
          <select
            id="pdf-export-mode"
            className="select"
            value={exportMode}
            onChange={(event) => setExportMode(event.target.value as PdfExportMode)}
            title="Standard preserves source objects. Secure flattened rebuilds pages from final pixels."
          >
            <option value="standard">Standard PDF</option>
            <option value="secure">Secure flattened PDF</option>
          </select>
          <button type="button" className="btn btn-secondary" disabled={opening || exporting} onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-4 w-4" aria-hidden />
            Replace PDF
          </button>
          <button type="button" className="btn btn-primary" disabled={exporting || opening} onClick={() => void exportPdf()}>
            {exporting ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
            {exportProgress ? `Flattening ${exportProgress.completed}/${exportProgress.total}` : "Download copy"}
          </button>
        </div>
      </header>

      {error ? (
        <div className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-lg border border-[var(--color-success)] bg-[var(--color-success-soft)] px-4 py-3 text-sm text-[var(--color-success)]" role="status">
          {notice}
        </div>
      ) : null}
      {exportProgress ? (
        <div className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-4 py-3 text-sm text-[var(--color-ink-soft)]" role="status" aria-live="polite">
          Securely flattening page {Math.min(exportProgress.completed + 1, exportProgress.total)} of {exportProgress.total}. Keep this page open.
        </div>
      ) : null}
      {exportMode === "standard" && history.present.some((overlay) => overlay.kind === "cover") ? (
        <div className="rounded-lg border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn)]" role="status">
          Standard PDF keeps source content beneath covers. Secure flattened PDF removes it.
        </div>
      ) : null}

      <section className="card overflow-hidden">
        <div className="flex min-h-14 flex-wrap items-center gap-1 border-b border-[var(--color-rule)] px-2 py-2 sm:px-3">
          <div className="flex items-center gap-1 border-r border-[var(--color-rule)] pr-2">
            <ToolButton label="Add text" onClick={() => addText()}>
              <Type className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Add visual cover" onClick={addCover}>
              <Eraser className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Add image or signature" onClick={() => imageInputRef.current?.click()}>
              <ImagePlus className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
          </div>
          <div className="flex items-center gap-1 border-r border-[var(--color-rule)] px-2">
            <ToolButton label="Undo" disabled={history.past.length === 0} onClick={undo}>
              <Undo2 className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Redo" disabled={history.future.length === 0} onClick={redo}>
              <Redo2 className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Delete selected item" disabled={!selected} onClick={removeSelected}>
              <Trash2 className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
          </div>
          <div className="flex items-center gap-1 px-2">
            <ToolButton
              label="Zoom out"
              onClick={() => { setFitPage(false); setManualScale((scale) => Math.max(0.25, scale - 0.15)); }}
            >
              <ZoomOut className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <span className="tnum min-w-12 text-center text-xs font-semibold">{Math.round(effectiveScale * 100)}%</span>
            <ToolButton
              label="Zoom in"
              onClick={() => { setFitPage(false); setManualScale((scale) => Math.min(3, scale + 0.15)); }}
            >
              <ZoomIn className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Fit page width" active={fitPage} onClick={() => setFitPage(true)}>
              <Maximize2 className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
          </div>
          <div className="ml-auto flex items-center gap-1 pl-2">
            <ToolButton label="Rotate page counterclockwise" onClick={() => rotatePage("counterclockwise")}>
              <RotateCcw className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Rotate page clockwise" onClick={() => rotatePage("clockwise")}>
              <RotateCw className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Previous page" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => page - 1)}>
              <ChevronLeft className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <label className="flex items-center gap-1 text-xs text-[var(--color-ink-soft)]">
              <span className="sr-only">Current page</span>
              <input
                type="number"
                className="input tnum h-9 w-14 px-2 text-center"
                min={1}
                max={loaded.document.numPages}
                value={pageNumber}
                onChange={(event) => setPageNumber(Math.max(1, Math.min(loaded.document.numPages, Number(event.target.value) || 1)))}
              />
              <span>of {loaded.document.numPages}</span>
            </label>
            <ToolButton label="Next page" disabled={pageNumber >= loaded.document.numPages} onClick={() => setPageNumber((page) => page + 1)}>
              <ChevronRight className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
          </div>
        </div>

        <div className="grid min-h-[42rem] min-w-0 grid-cols-1 lg:grid-cols-[8.5rem_minmax(0,1fr)_19rem]">
          <aside className="scroll-thin flex gap-2 overflow-x-auto border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] p-2 lg:block lg:space-y-3 lg:overflow-x-hidden lg:overflow-y-auto lg:border-b-0 lg:border-r">
            {Array.from({ length: loaded.document.numPages }, (_, index) => index + 1).map((page) => (
              <button
                key={page}
                type="button"
                onClick={() => setPageNumber(page)}
                aria-current={page === pageNumber ? "page" : undefined}
                aria-label={`Open page ${page}`}
                className={`w-24 shrink-0 rounded-md border p-1.5 text-left transition-colors lg:w-full ${page === pageNumber ? "border-[var(--color-primary)] bg-[var(--color-primary-tint)]" : "border-transparent hover:border-[var(--color-rule-strong)]"}`}
              >
                <PdfThumbnailCanvas document={loaded.document} pageNumber={page} rotation={pageRotations[page] ?? 0} />
                <span className="mt-1 block text-center text-[0.7rem] font-medium text-[var(--color-ink-soft)]">Page {page}</span>
              </button>
            ))}
          </aside>

          <div
            ref={pageViewportRef}
            className="scroll-thin min-w-0 overflow-auto bg-[var(--color-surface-strong)] p-3 sm:p-5"
          >
            <div
              ref={pageSurfaceRef}
              onPointerDown={() => setSelectedId(null)}
              className="relative mx-auto bg-white shadow-md"
              style={{
                width: pageSize.width * effectiveScale,
                height: pageSize.height * effectiveScale,
              }}
              role="region"
              aria-label={`Editing page ${pageNumber}`}
            >
              <PdfPageCanvas
                document={loaded.document}
                pageNumber={pageNumber}
                scale={effectiveScale}
                rotation={pageRotation}
                onBaseSize={setBasePageSize}
                className="block"
              />
              {pageOverlays.map((overlay, index) => {
                const isSelected = overlay.id === selectedId;
                return (
                  <div
                    key={overlay.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    aria-label={overlay.kind === "text" ? `Text: ${overlay.text}` : overlay.kind === "image" ? "Image or signature" : "Visual cover"}
                    onPointerDown={(event) => startGesture(event, overlay, "move")}
                    onFocus={() => {
                      setSelectedId(overlay.id);
                      setInspectorTab("properties");
                      setMobileInspectorOpen(true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedId(overlay.id);
                        setInspectorTab("properties");
                        setMobileInspectorOpen(true);
                      }
                    }}
                    className={`absolute select-none ${isSelected ? "outline outline-2 outline-offset-1 outline-[var(--color-accent)]" : "hover:outline hover:outline-1 hover:outline-[var(--color-accent)]"}`}
                    style={{
                      left: `${overlay.x * 100}%`,
                      top: `${overlay.y * 100}%`,
                      width: `${overlay.width * 100}%`,
                      height: `${overlay.height * 100}%`,
                      zIndex: index + 1,
                      touchAction: "none",
                      color: overlay.kind === "text" ? overlay.color : undefined,
                      fontFamily: overlay.kind === "text" ? fontCss(overlay.fontId, customFonts) : undefined,
                      fontSize: overlay.kind === "text" ? `${overlay.fontSize * effectiveScale}px` : undefined,
                      lineHeight: overlay.kind === "text" ? 1.2 : undefined,
                      textAlign: overlay.kind === "text" ? overlay.alignment : undefined,
                      whiteSpace: overlay.kind === "text" ? "pre-wrap" : undefined,
                    }}
                  >
                    <div
                      className="h-full w-full overflow-hidden"
                      style={{ background: overlay.kind === "cover" ? overlay.color : "transparent" }}
                    >
                      {overlay.kind === "text" ? overlay.text : null}
                      {overlay.kind === "image" ? (
                        // eslint-disable-next-line @next/next/no-img-element -- local object URLs are not image-optimizer inputs.
                        <img
                          src={images.find((image) => image.id === overlay.imageId)?.objectUrl}
                          alt=""
                          draggable={false}
                          className="h-full w-full object-contain"
                          style={{ opacity: overlay.opacity }}
                        />
                      ) : null}
                    </div>
                    {isSelected ? (
                      <button
                        type="button"
                        aria-label="Resize selected item"
                        title="Resize"
                        onPointerDown={(event) => startGesture(event, overlay, "resize")}
                        className="absolute -bottom-3.5 -right-3.5 grid h-11 w-11 cursor-se-resize place-items-center bg-transparent p-0"
                        style={{ touchAction: "none" }}
                      >
                        <span className="h-4 w-4 border border-white bg-[var(--color-accent)] shadow-sm" aria-hidden />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          <aside
            aria-label="PDF inspector"
            className={`${mobileInspectorOpen ? "fixed" : "hidden"} inset-x-2 bottom-2 z-40 min-w-0 max-h-[58vh] overflow-hidden rounded-lg border border-[var(--color-rule-strong)] bg-white shadow-2xl lg:static lg:inset-auto lg:z-auto lg:block lg:max-h-none lg:rounded-none lg:border-y-0 lg:border-r-0 lg:shadow-none`}
          >
            <div className="flex items-center gap-2 p-3">
              <div className="segmented-control grid min-w-0 flex-1 grid-cols-2" role="group" aria-label="Inspector view">
                <button type="button" aria-pressed={inspectorTab === "properties"} onClick={() => setInspectorTab("properties")}>Properties</button>
                <button type="button" aria-pressed={inspectorTab === "source"} onClick={() => setInspectorTab("source")}>Source text</button>
              </div>
              <div className="shrink-0 lg:hidden">
                <button
                  type="button"
                  className="btn btn-ghost btn-icon h-11 w-11"
                  onClick={() => setMobileInspectorOpen(false)}
                  aria-label="Close inspector"
                  title="Close inspector"
                >
                  <ChevronDown className="h-5 w-5" aria-hidden />
                </button>
              </div>
            </div>

            {inspectorTab === "properties" ? (
              <div className="scroll-thin max-h-[calc(58vh-4.5rem)] space-y-5 overflow-y-auto border-t border-[var(--color-rule)] p-4 lg:max-h-[42rem]">
                {!selected ? (
                  <div className="py-8 text-center">
                    <p className="text-sm font-medium">No item selected</p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="eyebrow">Selected item</p>
                        <p className="mt-1 text-sm font-semibold">{selected.kind === "text" ? "Text box" : selected.kind === "image" ? "Image / signature" : "Visual cover"}</p>
                      </div>
                      <button type="button" className="btn btn-sm btn-ghost btn-icon text-[var(--color-danger)]" onClick={removeSelected} aria-label="Delete selected item" title="Delete">
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </div>

                    {selected.kind === "text" ? (
                      <>
                        <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
                          Text
                          <textarea
                            className="input mt-1 min-h-24 w-full resize-y"
                            value={selected.text}
                            onChange={(event) => updateSelected({ text: event.target.value } as Partial<PdfTextOverlay>)}
                          />
                        </label>
                        <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
                          Font
                          <select className="select mt-1 w-full" value={selected.fontId} onChange={(event) => updateSelected({ fontId: event.target.value } as Partial<PdfTextOverlay>)}>
                            {STANDARD_FONTS.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}
                            {customFonts.map((font) => <option key={font.id} value={font.id}>{font.name}</option>)}
                          </select>
                        </label>
                        <input
                          ref={fontInputRef}
                          type="file"
                          hidden
                          accept=".ttf,.otf,font/ttf,font/otf"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void importFont(file);
                          }}
                        />
                        <button type="button" className="btn btn-sm btn-secondary w-full" onClick={() => fontInputRef.current?.click()}>
                          <Upload className="h-4 w-4" aria-hidden />
                          Import TTF or OTF font
                        </button>

                        <div className="grid grid-cols-2 gap-3">
                          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
                            Size
                            <input
                              className="input tnum mt-1 w-full"
                              type="number"
                              min={6}
                              max={144}
                              value={selected.fontSize}
                              onChange={(event) => updateSelected({ fontSize: Math.max(6, Math.min(144, Number(event.target.value) || 6)) } as Partial<PdfTextOverlay>)}
                            />
                          </label>
                          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
                            Color
                            <span className="mt-1 flex min-h-9 items-center gap-2 rounded-lg border border-[var(--color-rule-strong)] px-2">
                              <input
                                type="color"
                                className="h-6 w-8 cursor-pointer border-0 bg-transparent p-0"
                                value={selected.color}
                                onChange={(event) => updateSelected({ color: event.target.value } as Partial<PdfTextOverlay>)}
                                aria-label="Text color"
                              />
                              <span className="tnum text-xs font-normal">{selected.color.toUpperCase()}</span>
                            </span>
                          </label>
                        </div>

                        <div>
                          <p className="text-xs font-semibold text-[var(--color-ink-soft)]">Alignment</p>
                          <div className="segmented-control mt-1 grid w-full grid-cols-3" role="group" aria-label="Text alignment">
                            {([
                              ["left", AlignLeft],
                              ["center", AlignCenter],
                              ["right", AlignRight],
                            ] as const).map(([alignment, Icon]) => (
                              <button
                                key={alignment}
                                type="button"
                                aria-label={`Align ${alignment}`}
                                title={`Align ${alignment}`}
                                aria-pressed={selected.alignment === alignment}
                                onClick={() => updateSelected({ alignment } as Partial<PdfTextOverlay>)}
                                className="justify-center"
                              >
                                <Icon className="h-4 w-4" aria-hidden />
                              </button>
                            ))}
                          </div>
                        </div>
                      </>
                    ) : selected.kind === "cover" ? (
                      <div>
                        <p className="text-xs font-semibold text-[var(--color-ink-soft)]">Cover color</p>
                        <div className="segmented-control mt-1 grid w-full grid-cols-2" role="group" aria-label="Cover color">
                          <button type="button" aria-pressed={selected.color === "#ffffff"} onClick={() => updateSelected({ color: "#ffffff" })}>
                            <span className="h-4 w-4 border border-[var(--color-rule-strong)] bg-white" aria-hidden /> White
                          </button>
                          <button type="button" aria-pressed={selected.color === "#111111"} onClick={() => updateSelected({ color: "#111111" })}>
                            <span className="h-4 w-4 bg-[#111111]" aria-hidden /> Black
                          </button>
                        </div>
                        <p className={`mt-2 text-xs font-medium ${exportMode === "secure" ? "text-[var(--color-success)]" : "text-[var(--color-warn)]"}`}>
                          {exportMode === "secure" ? "Permanent in secure flattened output" : "Visual-only in standard output"}
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <p className="truncate text-xs text-[var(--color-ink-faint)]">{images.find((image) => image.id === selected.imageId)?.name ?? "Imported image"}</p>
                        <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
                          Opacity
                          <div className="mt-1 flex items-center gap-3">
                            <input
                              type="range"
                              min={0.1}
                              max={1}
                              step={0.05}
                              value={selected.opacity}
                              onChange={(event) => updateSelected({ opacity: Number(event.target.value) })}
                              className="min-w-0 flex-1"
                            />
                            <span className="tnum w-10 text-right text-xs">{Math.round(selected.opacity * 100)}%</span>
                          </div>
                        </label>
                      </div>
                    )}

                    <div>
                      <p className="text-xs font-semibold text-[var(--color-ink-soft)]">Position and size (%)</p>
                      <div className="mt-1 grid grid-cols-2 gap-2">
                        {([
                          ["Left", "x"],
                          ["Top", "y"],
                          ["Width", "width"],
                          ["Height", "height"],
                        ] as const).map(([label, key]) => (
                          <label key={key} className="text-[0.7rem] text-[var(--color-ink-faint)]">
                            {label}
                            <input
                              type="number"
                              className="input tnum mt-0.5 w-full"
                              min={key === "width" || key === "height" ? 2 : 0}
                              max={100}
                              step={0.1}
                              value={percent(selected[key])}
                              onChange={(event) => updateSelected({ [key]: (Number(event.target.value) || 0) / 100 } as Partial<PdfOverlay>)}
                            />
                          </label>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className="text-xs font-semibold text-[var(--color-ink-soft)]">Layer order</p>
                      <div className="mt-1 grid grid-cols-2 gap-2">
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => reorderSelected("up")}>
                          <ArrowUp className="h-4 w-4" aria-hidden /> Forward
                        </button>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => reorderSelected("down")}>
                          <ArrowDown className="h-4 w-4" aria-hidden /> Backward
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="scroll-thin max-h-[calc(58vh-4.5rem)] overflow-y-auto border-t border-[var(--color-rule)] p-4 lg:max-h-[42rem]">
                {sourceText === null ? (
                  <div className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
                    <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> Checking page text
                  </div>
                ) : sourceText.length === 0 ? (
                  <div>
                    <p className="text-sm font-semibold">Image or scanned page</p>
                    <p className="mt-2 text-xs font-medium text-[var(--color-warn)]">No searchable text · OCR not enabled</p>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">Detected source text</p>
                        <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{sourceText.length} text {sourceText.length === 1 ? "item" : "items"} on this page</p>
                      </div>
                    </div>
                    <ul className="mt-3 divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
                      {sourceText.slice(0, 80).map((item) => (
                        <li key={item.id} className="flex items-start gap-2 py-2">
                          <span className="min-w-0 flex-1 break-words text-xs text-[var(--color-ink-soft)]">{item.text}</span>
                          <button type="button" className="btn btn-sm btn-secondary shrink-0" onClick={() => replaceSourceText(item)} aria-label={`Cover and edit ${item.text}`} title="Cover the original and add editable replacement text">
                            <Type className="h-4 w-4" aria-hidden />
                            Cover &amp; edit
                          </button>
                        </li>
                      ))}
                    </ul>
                    {sourceText.length > 80 ? <p className="mt-2 text-xs text-[var(--color-ink-faint)]">Showing the first 80 items.</p> : null}
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      </section>

      {!mobileInspectorOpen ? (
        <div className="fixed inset-x-3 bottom-3 z-30 lg:hidden">
          <div className="segmented-control grid w-full grid-cols-2 border border-[var(--color-rule-strong)] bg-white p-1 shadow-xl" role="group" aria-label="Open PDF inspector">
            <button
              type="button"
              disabled={!selected}
              onClick={() => {
                setInspectorTab("properties");
                setMobileInspectorOpen(true);
              }}
            >
              <Settings2 className="h-4 w-4" aria-hidden />
              Properties
            </button>
            <button
              type="button"
              onClick={() => {
                setInspectorTab("source");
                setMobileInspectorOpen(true);
              }}
            >
              <Type className="h-4 w-4" aria-hidden />
              Source text
            </button>
          </div>
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void openPdf(file);
        }}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,.png,.jpg,.jpeg"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importImage(file);
        }}
      />
    </div>
  );
}
