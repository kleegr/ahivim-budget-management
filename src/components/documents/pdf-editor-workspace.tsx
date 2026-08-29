"use client";

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bold,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  Copy,
  Download,
  Eraser,
  FileText,
  Highlighter,
  ImagePlus,
  Italic,
  ListChecks,
  LoaderCircle,
  LocateFixed,
  Maximize2,
  MousePointer2,
  PenTool,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  ScanText,
  Search,
  Settings2,
  Square,
  Trash2,
  Type,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { upload } from "@vercel/blob/client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { PdfPageCanvas, PdfThumbnailCanvas } from "./pdf-page-canvas";
import {
  EMPTY_PDF_HISTORY,
  commitPdfHistory,
  createCoverOverlay,
  createImageOverlay,
  createInkOverlay,
  createOverlayId,
  createShapeOverlay,
  createSourceTextReplacement,
  createTextOverlay,
  deleteOverlay,
  duplicateOverlay,
  hasPdfEditorChanges,
  moveOverlay,
  normalizeOverlay,
  redoPdfHistory,
  replaceOverlay,
  resizeOverlay,
  rotateOverlayPosition,
  undoPdfHistory,
  type PdfEditorHistory,
  type PdfInkPoint,
  type PdfOverlay,
  type PdfTextOverlay,
} from "@/lib/documents/pdf-editor";
import type { PdfImageSource } from "@/lib/documents/pdf-export";
import type {
  PdfFormFieldDescriptor,
  PdfFormValue,
} from "@/lib/documents/pdf-forms";
import { pdfFormWidgetCanvasRectangle } from "@/lib/documents/pdf-form-geometry";
import {
  resolvePdfExportMode,
  type PdfExportMode,
} from "@/lib/documents/pdf-export-mode";
import {
  inspectPdfPage,
  loadPdfJs,
  type PdfDetectedFont,
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

interface EditorFont {
  id: string;
  name: string;
  bytes: Uint8Array | null;
  cssFamily: string;
  objectUrl?: string;
  face?: FontFace;
  source: "document" | "imported";
}

interface EditorImage extends PdfImageSource {
  name: string;
  objectUrl: string;
}

interface StoredDocument {
  id: string;
  title: string;
  description: string | null;
  category: string;
  status: "uploading" | "active" | "archived";
  originalVersionId: string | null;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  currentFilename: string | null;
  currentByteSize: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredDocumentVersion {
  id: string;
  documentId: string;
  versionNumber: number;
  versionKind: "original" | "saved" | "restored";
  parentVersionId: string | null;
  restoredFromVersionId: string | null;
  exportMode: "source" | "standard" | "secure";
  editorSchemaVersion: number;
  editorState: Record<string, unknown>;
  pageCount: number | null;
  changeSummary: string | null;
  filename: string;
  byteSize: number;
  createdBy: string;
  createdAt: string;
}

interface StoredDocumentDraft {
  baseVersionId: string;
  revision: number;
  editorSchemaVersion: number;
  editorState: Record<string, unknown>;
  updatedAt: string;
}

interface StoredDocumentDetail {
  document: StoredDocument;
  versions: StoredDocumentVersion[];
  draft: StoredDocumentDraft | null;
}

interface UploadReservation {
  intentId: string;
  pathname: string;
  handleUploadUrl: string;
  maximumSizeInBytes: number;
  expiresAt: string;
}

interface DocumentCreationReservation {
  document: StoredDocument;
  upload: UploadReservation;
}

interface PdfEditorManifest {
  schemaVersion: 1;
  overlays: PdfOverlay[];
  pageOrder: number[];
  pageRotations: Record<number, number>;
  formValues: Record<string, PdfFormValue>;
  exportMode: PdfExportMode;
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string | { message?: string };
}

async function documentApi<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers, cache: "no-store" });
  const body = await response.json().catch(() => ({})) as ApiEnvelope<T>;
  if (!response.ok || !body.ok || body.data === undefined) {
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(message || "The document request could not be completed.");
  }
  return body.data;
}

function bytesAsArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function editorManifest(
  overlays: PdfOverlay[],
  pageOrder: number[],
  pageRotations: Record<number, number>,
  formValues: Record<string, PdfFormValue>,
  exportMode: PdfExportMode,
): PdfEditorManifest {
  return { schemaVersion: 1, overlays, pageOrder, pageRotations, formValues, exportMode };
}

function parseEditorManifest(value: Record<string, unknown>): PdfEditorManifest | null {
  if (value.schemaVersion !== 1 || !Array.isArray(value.overlays) || !Array.isArray(value.pageOrder)) return null;
  if (!value.pageRotations || typeof value.pageRotations !== "object") return null;
  if (!value.formValues || typeof value.formValues !== "object") return null;
  if (value.exportMode !== "standard" && value.exportMode !== "secure") return null;
  return value as unknown as PdfEditorManifest;
}

function formatStoredBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function formatStoredDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function downloadName(sourceName: string, secure: boolean): string {
  const base = sourceName
    .replace(/\.pdf$/i, "")
    .replace(/(?:-edited(?:-secure)?)+$/i, "") || "document";
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

function fontCss(fontId: string, customFonts: EditorFont[]): string {
  return customFonts.find((font) => font.id === fontId)?.cssFamily
    ?? STANDARD_FONTS.find((font) => font.id === fontId)?.css
    ?? STANDARD_FONTS[0].css;
}

type PdfEditorTool = "select" | "edit-text" | "ink";

function itemLabel(overlay: PdfOverlay): string {
  if (overlay.kind === "text") return "Text box";
  if (overlay.kind === "image") return "Image / signature";
  if (overlay.kind === "cover") return "Background repair / redaction";
  if (overlay.kind === "ink") return "Drawing / signature";
  return overlay.shape === "highlight" ? "Highlight" : `${overlay.shape[0]?.toUpperCase()}${overlay.shape.slice(1)}`;
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
  initialDocumentId = null,
}: {
  initialSourcePath?: string | null;
  initialDocumentId?: string | null;
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
  const [nativeSourceText, setNativeSourceText] = useState<PdfSourceTextItem[] | null>(null);
  const [ocrTextByPage, setOcrTextByPage] = useState<Record<number, PdfSourceTextItem[]>>({});
  const [ocrProgress, setOcrProgress] = useState<{ status: string; progress: number } | null>(null);
  const [sourceQuery, setSourceQuery] = useState("");
  const [inspectorTab, setInspectorTab] = useState<"properties" | "source" | "form">("properties");
  const [customFonts, setCustomFonts] = useState<EditorFont[]>([]);
  const [images, setImages] = useState<EditorImage[]>([]);
  const [formFields, setFormFields] = useState<PdfFormFieldDescriptor[]>([]);
  const [formValues, setFormValues] = useState<Record<string, PdfFormValue>>({});
  const [initialFormValues, setInitialFormValues] = useState<Record<string, PdfFormValue>>({});
  const [selectedFormWidget, setSelectedFormWidget] = useState<{ fieldName: string; widgetIndex: number } | null>(null);
  const [pageOrder, setPageOrder] = useState<number[]>([]);
  const [pageRotations, setPageRotations] = useState<Record<number, number>>({});
  const [exportMode, setExportMode] = useState<PdfExportMode>("standard");
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<PdfEditorTool>("select");
  const [inkDraft, setInkDraft] = useState<PdfInkPoint[] | null>(null);
  const [inlineEditingId, setInlineEditingId] = useState<string | null>(null);
  const [storedDocument, setStoredDocument] = useState<StoredDocument | null>(null);
  const [versions, setVersions] = useState<StoredDocumentVersion[]>([]);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [draftStatus, setDraftStatus] = useState<"idle" | "saving" | "saved" | "save-needed">("idle");
  const [savingVersion, setSavingVersion] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const inlineTextAreaRef = useRef<HTMLTextAreaElement>(null);
  const pageViewportRef = useRef<HTMLDivElement>(null);
  const pageSurfaceRef = useRef<HTMLDivElement>(null);
  const customFontsRef = useRef<EditorFont[]>([]);
  const imagesRef = useRef<EditorImage[]>([]);
  const loadedDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const mountedRef = useRef(true);
  const initialSourceLoadedRef = useRef<string | null>(null);
  const initialDocumentLoadedRef = useRef<string | null>(null);
  const lastDraftSignatureRef = useRef<string | null>(null);
  const draftRevisionRef = useRef<number | null>(null);
  const currentEditorSignatureRef = useRef("");
  const draftSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const inlineCancelHistoryRef = useRef<PdfEditorHistory | null>(null);
  const inlineChangedRef = useRef(false);
  const detectedFontIdsRef = useRef(new Set<string>());
  const displayOverlays = draft ?? history.present;
  const selected = displayOverlays.find((overlay) => overlay.id === selectedId) ?? null;
  const pageRotation = pageRotations[pageNumber] ?? 0;
  const pageCount = loaded ? pageOrder.length || loaded.document.numPages : 0;
  const sourcePageNumber = pageOrder[pageNumber - 1] ?? pageNumber;
  const pageOrderChanged = Boolean(loaded) && (
    pageOrder.length !== loaded?.document.numPages
    || pageOrder.some((sourcePage, index) => sourcePage !== index + 1)
  );
  const exportModeResolution = resolvePdfExportMode(exportMode, {
    hasPageRotation: Object.values(pageRotations).some((rotation) => rotation % 360 !== 0),
    hasRotatedOverlay: history.present.some((overlay) => overlay.rotation % 360 !== 0),
    pageOrderChanged,
    hasFormFields: formFields.length > 0,
  });
  const selectedFormField = selectedFormWidget
    ? formFields.find((field) => field.name === selectedFormWidget.fieldName) ?? null
    : null;
  const activeFormWidget = selectedFormField?.widgets[selectedFormWidget?.widgetIndex ?? -1] ?? null;
  const formWidgetHighlight = activeFormWidget?.page === sourcePageNumber
    ? pdfFormWidgetCanvasRectangle(activeFormWidget, pageRotation)
    : null;
  const hasFormChanges = JSON.stringify(formValues) !== JSON.stringify(initialFormValues);
  const hasChanges = hasPdfEditorChanges(history.present, pageRotations) || pageOrderChanged || hasFormChanges;
  const unsavedWorkAtRisk = hasChanges && (!storedDocument || draftStatus !== "saved");
  const currentEditorManifest = useMemo(() => editorManifest(
    displayOverlays,
    pageOrder,
    pageRotations,
    formValues,
    exportModeResolution.mode,
  ), [displayOverlays, exportModeResolution.mode, formValues, pageOrder, pageRotations]);
  const currentEditorSignature = useMemo(
    () => JSON.stringify(currentEditorManifest),
    [currentEditorManifest],
  );
  const draftNeedsVersionSave = history.present.some((overlay) => overlay.kind === "image")
    || customFonts.some((font) => font.source === "imported");
  const sourceText = nativeSourceText && nativeSourceText.length > 0
    ? nativeSourceText
    : ocrTextByPage[pageNumber] ?? nativeSourceText;
  const filteredSourceText = (sourceText ?? []).filter((item) => (
    !sourceQuery.trim() || item.text.toLocaleLowerCase().includes(sourceQuery.trim().toLocaleLowerCase())
  ));

  useEffect(() => {
    draftRevisionRef.current = draftRevision;
  }, [draftRevision]);

  useEffect(() => {
    currentEditorSignatureRef.current = currentEditorSignature;
  }, [currentEditorSignature]);

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

  const registerDetectedFonts = useCallback(async (fonts: PdfDetectedFont[]) => {
    for (const detected of fonts) {
      if (!detected.id.startsWith("document-") || detectedFontIdsRef.current.has(detected.id)) continue;
      detectedFontIdsRef.current.add(detected.id);
      let face: FontFace | undefined;
      let objectUrl: string | undefined;
      let cssFamily = detected.cssFamily;
      if (detected.bytes) {
        try {
          cssFamily = `AhivimDocumentFont-${detected.id.replace(/[^a-z0-9-]/gi, "-")}`;
          objectUrl = URL.createObjectURL(new Blob([detected.bytes.slice()], { type: "font/otf" }));
          face = new FontFace(cssFamily, `url(${objectUrl})`, {
            weight: String(detected.fontWeight),
            style: detected.fontStyle,
          });
          await face.load();
          document.fonts.add(face);
        } catch {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          face = undefined;
          objectUrl = undefined;
          cssFamily = detected.cssFamily;
        }
      }
      if (!mountedRef.current) {
        if (face) document.fonts.delete(face);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return;
      }
      const editorFont: EditorFont = {
        id: detected.id,
        name: detected.name,
        bytes: detected.bytes,
        cssFamily,
        objectUrl,
        face,
        source: "document",
      };
      setCustomFonts((current) => current.some((font) => font.id === editorFont.id)
        ? current
        : [...current, editorFont]);
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    let active = true;
    setNativeSourceText(null);
    setSourceQuery("");
    void inspectPdfPage(loaded.document, sourcePageNumber, pageRotation)
      .then(async (inspection) => {
        if (!active) return;
        setNativeSourceText(inspection.items);
        await registerDetectedFonts(inspection.fonts);
      })
      .catch(() => {
        if (active) setNativeSourceText([]);
      });
    return () => {
      active = false;
    };
  }, [loaded, pageRotation, registerDetectedFonts, sourcePageNumber]);

  useEffect(() => {
    if (selectedId && !history.present.some((overlay) => overlay.id === selectedId)) {
      setSelectedId(null);
    }
  }, [history.present, selectedId]);

  useEffect(() => {
    if (!inlineEditingId) return;
    const frame = window.requestAnimationFrame(() => {
      inlineTextAreaRef.current?.focus();
      inlineTextAreaRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
      inlineTextAreaRef.current?.setSelectionRange(
        inlineTextAreaRef.current.value.length,
        inlineTextAreaRef.current.value.length,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [inlineEditingId]);

  useEffect(() => {
    if (!unsavedWorkAtRisk) return;
    const protectWork = (event: BeforeUnloadEvent) => event.preventDefault();
    const protectClientNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin || destination.href === window.location.href) return;
      if (destination.pathname.includes("/versions/") && destination.pathname.endsWith("/file")) return;
      if (window.confirm("Leave this PDF and discard changes that are not safely stored?")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("beforeunload", protectWork);
    document.addEventListener("click", protectClientNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", protectWork);
      document.removeEventListener("click", protectClientNavigation, true);
    };
  }, [unsavedWorkAtRisk]);

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
        if (font.face) document.fonts.delete(font.face);
        if (font.objectUrl) URL.revokeObjectURL(font.objectUrl);
      }
      for (const image of imagesRef.current) URL.revokeObjectURL(image.objectUrl);
      void import("@/lib/documents/pdf-ocr-client")
        .then(({ terminatePdfOcrWorker }) => terminatePdfOcrWorker());
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

  const duplicateSelected = useCallback(() => {
    const current = history.present.find((overlay) => overlay.id === selectedId);
    if (!current) return;
    const duplicate = duplicateOverlay(current);
    commit([...history.present, duplicate]);
    setSelectedId(duplicate.id);
  }, [commit, history.present, selectedId]);

  const nudgeSelected = useCallback((deltaX: number, deltaY: number) => {
    const current = history.present.find((overlay) => overlay.id === selectedId);
    if (!current) return;
    commit(replaceOverlay(history.present, moveOverlay(current, deltaX, deltaY)));
  }, [commit, history.present, selectedId]);

  const beginInlineEdit = useCallback((id: string) => {
    const overlay = history.present.find((item) => item.id === id);
    if (!overlay || overlay.kind !== "text") return;
    setSelectedId(id);
    setInlineEditingId(id);
    inlineCancelHistoryRef.current = null;
    inlineChangedRef.current = false;
    setInspectorTab("properties");
    setMobileInspectorOpen(false);
    setActiveTool("select");
  }, [history.present]);

  const updateInlineText = useCallback((id: string, text: string) => {
    const overlay = history.present.find((item) => item.id === id);
    if (!overlay || overlay.kind !== "text") return;
    if (overlay.text !== text) inlineChangedRef.current = true;
    setDraft(replaceOverlay(history.present, { ...overlay, text }));
  }, [history.present]);

  const finishInlineEdit = useCallback(() => {
    if (!inlineEditingId) return;
    if (!inlineChangedRef.current && inlineCancelHistoryRef.current) {
      setHistory(inlineCancelHistoryRef.current);
      setDraft(null);
      setSelectedId(null);
    } else if (draft) {
      commit(draft);
    }
    inlineCancelHistoryRef.current = null;
    inlineChangedRef.current = false;
    setInlineEditingId(null);
  }, [commit, draft, inlineEditingId]);

  const cancelInlineEdit = useCallback(() => {
    if (!inlineEditingId) return;
    if (inlineCancelHistoryRef.current) {
      setHistory(inlineCancelHistoryRef.current);
      setSelectedId(null);
    }
    setDraft(null);
    inlineCancelHistoryRef.current = null;
    inlineChangedRef.current = false;
    setInlineEditingId(null);
  }, [inlineEditingId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const editingText = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement;
      const interactiveTarget = target instanceof Element
        && Boolean(target.closest("button, a, [contenteditable='true']"));
      const canvasTarget = target instanceof Element
        && Boolean(target.closest("[data-pdf-page-surface='true']"));
      if ((event.metaKey || event.ctrlKey) && !editingText && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if ((event.metaKey || event.ctrlKey) && !editingText && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if ((event.metaKey || event.ctrlKey) && !editingText && !interactiveTarget && canvasTarget && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelected();
      } else if (!editingText && !interactiveTarget && canvasTarget && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        removeSelected();
      } else if (!editingText && !interactiveTarget && canvasTarget && selectedId && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        const distance = event.shiftKey ? 0.01 : 0.002;
        nudgeSelected(
          event.key === "ArrowLeft" ? -distance : event.key === "ArrowRight" ? distance : 0,
          event.key === "ArrowUp" ? -distance : event.key === "ArrowDown" ? distance : 0,
        );
      } else if (event.key === "Escape") {
        if (inlineEditingId) cancelInlineEdit();
        else {
          setSelectedId(null);
          setActiveTool("select");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelInlineEdit, duplicateSelected, inlineEditingId, nudgeSelected, redo, removeSelected, selectedId, undo]);

  const clearCustomFonts = useCallback(() => {
    setCustomFonts((fonts) => {
      for (const font of fonts) {
        if (font.face) document.fonts.delete(font.face);
        if (font.objectUrl) URL.revokeObjectURL(font.objectUrl);
      }
      detectedFontIdsRef.current.clear();
      return [];
    });
  }, []);

  const clearImages = useCallback(() => {
    setImages((current) => {
      for (const image of current) URL.revokeObjectURL(image.objectUrl);
      return [];
    });
  }, []);

  const openPdf = useCallback(async (
    file: File,
    skipDiscardConfirmation = false,
    retainStoredDocument = false,
  ) => {
    setError(null);
    setNotice(null);
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      setError("Choose a PDF file.");
      return false;
    }
    if (file.size > MAX_PDF_BYTES) {
      setError("This PDF is larger than 100 MB.");
      return false;
    }
    if (
      !skipDiscardConfirmation
      && loaded
      && hasChanges
      && !window.confirm("Open a new PDF and discard the current edits?")
    ) {
      return false;
    }

    setOpening(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pdfjs = await loadPdfJs();
      const loadingTask = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
      const [pdfDocument, inspectedFormFields] = await Promise.all([
        loadingTask.promise,
        import("@/lib/documents/pdf-forms")
          .then(({ inspectPdfForm }) => inspectPdfForm(bytes))
          .catch(() => [] as PdfFormFieldDescriptor[]),
      ]);
      if (!mountedRef.current) {
        void pdfDocument.destroy();
        return false;
      }
      const previousDocument = loadedDocumentRef.current;
      loadedDocumentRef.current = pdfDocument;
      setLoaded({ name: file.name, bytes, document: pdfDocument });
      setHistory(EMPTY_PDF_HISTORY);
      setDraft(null);
      setSelectedId(null);
      setPageNumber(1);
      setFitPage(true);
      setPageOrder(Array.from({ length: pdfDocument.numPages }, (_, index) => index + 1));
      setPageRotations({});
      setExportMode("standard");
      setInspectorTab("properties");
      setMobileInspectorOpen(false);
      setNativeSourceText(null);
      setOcrTextByPage({});
      setOcrProgress(null);
      setSourceQuery("");
      const nextFormValues = Object.fromEntries(inspectedFormFields.map((field) => [field.name, field.value]));
      setFormFields(inspectedFormFields);
      setFormValues(nextFormValues);
      setInitialFormValues(nextFormValues);
      setSelectedFormWidget(null);
      setActiveTool("select");
      setInkDraft(null);
      setInlineEditingId(null);
      inlineCancelHistoryRef.current = null;
      inlineChangedRef.current = false;
      if (!retainStoredDocument) {
        setStoredDocument(null);
        setVersions([]);
        setDraftRevision(null);
        setDraftStatus("idle");
        lastDraftSignatureRef.current = null;
        initialDocumentLoadedRef.current = initialDocumentId;
        if (initialDocumentId) window.history.replaceState(null, "", "/documents/pdf-editor");
      }
      clearCustomFonts();
      clearImages();
      void previousDocument?.destroy();
      return true;
    } catch (openError) {
      setError(errorMessage(openError));
      return false;
    } finally {
      setOpening(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [clearCustomFonts, clearImages, hasChanges, initialDocumentId, loaded]);

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
        if (!await openPdf(file, true)) return;
        initialSourceLoadedRef.current = initialSourcePath;
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

  const loadStoredDocument = useCallback(async (
    documentId: string,
    options: { includeDraft?: boolean; signal?: AbortSignal } = {},
  ) => {
    const detail = await documentApi<StoredDocumentDetail>(`/api/documents/${documentId}`, {
      signal: options.signal,
    });
    const currentVersion = detail.versions.find((version) => version.id === detail.document.currentVersionId);
    if (!currentVersion) throw new Error("This document does not have a saved PDF version yet.");
    const response = await fetch(`/api/documents/${documentId}/versions/${currentVersion.id}/file`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: options.signal,
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/pdf")) {
      throw new Error("The saved PDF could not be opened.");
    }
    const file = new File([await response.blob()], currentVersion.filename, { type: "application/pdf" });
    if (!await openPdf(file, true, true)) {
      throw new Error("The saved PDF could not be parsed. The previously open document was left unchanged.");
    }

    setStoredDocument(detail.document);
    setVersions(detail.versions);
    setDraftRevision(null);
    setDraftStatus("idle");
    lastDraftSignatureRef.current = null;

    const savedDraft = options.includeDraft !== false
      && detail.draft?.baseVersionId === currentVersion.id
      ? parseEditorManifest(detail.draft.editorState)
      : null;
    if (options.includeDraft !== false && detail.draft && detail.draft.baseVersionId !== currentVersion.id) {
      try {
        await documentApi<{ discarded: boolean }>(`/api/documents/${documentId}/draft`, { method: "DELETE" });
        setNotice("An older autosave was cleared because this document has a newer saved version.");
      } catch (draftError) {
        setDraftStatus("save-needed");
        setError(`An older autosave could not be cleared. ${errorMessage(draftError)}`);
      }
    }
    if (savedDraft && detail.draft) {
      const recoverableOverlays = savedDraft.overlays
        .filter((overlay) => overlay.kind !== "image")
        .map((overlay) => normalizeOverlay(overlay));
      setHistory({ past: [], present: recoverableOverlays, future: [] });
      if (savedDraft.pageOrder.length > 0) setPageOrder(savedDraft.pageOrder);
      setPageRotations(savedDraft.pageRotations);
      setFormValues(savedDraft.formValues);
      setExportMode(savedDraft.exportMode);
      setDraftRevision(detail.draft.revision);
      setDraftStatus("saved");
      lastDraftSignatureRef.current = JSON.stringify({ ...savedDraft, overlays: recoverableOverlays });
      if (recoverableOverlays.length !== savedDraft.overlays.length) {
        setNotice("Text and layout changes were recovered. Save versions after adding images so their source files stay attached.");
      } else {
        setNotice("Your autosaved changes were recovered.");
      }
    }
    return { ...detail, currentVersion, file };
  }, [openPdf]);

  useEffect(() => {
    if (!initialDocumentId || initialDocumentLoadedRef.current === initialDocumentId) return;
    const controller = new AbortController();
    let active = true;
    initialDocumentLoadedRef.current = initialDocumentId;
    setOpening(true);
    setError(null);
    void loadStoredDocument(initialDocumentId, { signal: controller.signal })
      .then(() => undefined)
      .catch((documentError: unknown) => {
        if (active && !(documentError instanceof DOMException && documentError.name === "AbortError")) {
          setError(errorMessage(documentError));
        }
      })
      .finally(() => {
        if (active) setOpening(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [initialDocumentId, loadStoredDocument]);

  useEffect(() => {
    const documentId = storedDocument?.id;
    const baseVersionId = storedDocument?.currentVersionId;
    if (!documentId || !baseVersionId || opening || savingVersion) return;

    if (!hasChanges) {
      if (draftRevisionRef.current === null) {
        setDraftStatus("idle");
        return;
      }
      const timeout = window.setTimeout(() => {
        draftSaveChainRef.current = draftSaveChainRef.current.then(async () => {
          await documentApi<{ discarded: boolean }>(`/api/documents/${documentId}/draft`, { method: "DELETE" });
          draftRevisionRef.current = null;
          setDraftRevision(null);
          lastDraftSignatureRef.current = null;
          setDraftStatus("idle");
        }).catch((draftError: unknown) => {
          setDraftStatus("save-needed");
          setError(`Autosave could not clear the old draft. ${errorMessage(draftError)}`);
        });
      }, 900);
      return () => window.clearTimeout(timeout);
    }

    if (draftNeedsVersionSave) {
      setDraftStatus("save-needed");
      return;
    }
    if (lastDraftSignatureRef.current === currentEditorSignature) {
      setDraftStatus("saved");
      return;
    }

    setDraftStatus("saving");
    const manifest = currentEditorManifest;
    const signature = currentEditorSignature;
    const timeout = window.setTimeout(() => {
      draftSaveChainRef.current = draftSaveChainRef.current.then(async () => {
        const savedDraft = await documentApi<StoredDocumentDraft>(`/api/documents/${documentId}/draft`, {
          method: "PUT",
          body: JSON.stringify({
            baseVersionId,
            expectedRevision: draftRevisionRef.current,
            editorSchemaVersion: 1,
            editorState: manifest,
          }),
        });
        draftRevisionRef.current = savedDraft.revision;
        setDraftRevision(savedDraft.revision);
        lastDraftSignatureRef.current = signature;
        if (currentEditorSignatureRef.current === signature) setDraftStatus("saved");
      }).catch((draftError: unknown) => {
        setDraftStatus("save-needed");
        setError(`Autosave paused. ${errorMessage(draftError)}`);
      });
    }, 1_200);
    return () => window.clearTimeout(timeout);
  }, [
    currentEditorManifest,
    currentEditorSignature,
    draftNeedsVersionSave,
    hasChanges,
    opening,
    savingVersion,
    storedDocument?.currentVersionId,
    storedDocument?.id,
  ]);

  const addText = (source?: PdfSourceTextItem) => {
    const overlay = createTextOverlay(pageNumber, source ? {
      text: source.text,
      x: source.x,
      y: source.y,
      width: Math.min(1 - source.x, Math.max(0.12, source.width)),
      height: Math.min(1 - source.y, Math.max(0.04, source.height)),
      fontSize: source.fontSize,
      fontId: source.fontId,
      sourceFontName: source.fontName,
      fontWeight: source.fontWeight,
      fontStyle: source.fontStyle,
      color: source.color,
      alignment: source.alignment,
      opacity: source.opacity,
      lineHeight: source.lineHeight,
      letterSpacing: source.letterSpacing,
      rotation: source.rotation,
      direction: source.direction,
    } : {});
    inlineCancelHistoryRef.current = history;
    inlineChangedRef.current = false;
    commit([...history.present, overlay]);
    setSelectedId(overlay.id);
    setInspectorTab("properties");
    setMobileInspectorOpen(false);
    setInlineEditingId(overlay.id);
    setActiveTool("select");
  };

  const replaceSourceText = (source: PdfSourceTextItem) => {
    const [cover, text] = createSourceTextReplacement(pageNumber, source);
    inlineCancelHistoryRef.current = history;
    inlineChangedRef.current = false;
    commit([...history.present, cover, text]);
    setSelectedId(text.id);
    setInspectorTab("properties");
    setMobileInspectorOpen(false);
    setInlineEditingId(text.id);
    setActiveTool("select");
  };

  const addCover = () => {
    const overlay = createCoverOverlay(pageNumber);
    commit([...history.present, overlay]);
    setSelectedId(overlay.id);
    setInspectorTab("properties");
    setMobileInspectorOpen(true);
  };

  const addShape = (shape: "highlight" | "rectangle" | "ellipse") => {
    const overlay = createShapeOverlay(pageNumber, shape);
    commit([...history.present, overlay]);
    setSelectedId(overlay.id);
    setInspectorTab("properties");
    setMobileInspectorOpen(true);
    setActiveTool("select");
  };

  const recognizeCurrentPage = useCallback(async () => {
    if (!loaded || ocrProgress) return;
    setError(null);
    setNotice(null);
    setOcrProgress({ status: "Preparing local text recognition", progress: 0 });
    try {
      const { recognizePdfPage } = await import("@/lib/documents/pdf-ocr-client");
      const items = await recognizePdfPage({
        document: loaded.document,
        pageNumber: sourcePageNumber,
        rotation: pageRotation,
        onProgress: (progress) => setOcrProgress(progress),
      });
      setOcrTextByPage((current) => ({ ...current, [pageNumber]: items }));
      setInspectorTab("source");
      setMobileInspectorOpen(true);
      setNotice(items.length > 0
        ? `${items.length} editable text regions recognized locally on this page.`
        : "No readable text was found on this page.");
    } catch (ocrError) {
      setError(`Text recognition could not finish. ${errorMessage(ocrError)}`);
    } finally {
      setOcrProgress(null);
    }
  }, [loaded, ocrProgress, pageNumber, pageRotation, sourcePageNumber]);

  useEffect(() => {
    if (
      activeTool === "edit-text"
      && nativeSourceText?.length === 0
      && ocrTextByPage[pageNumber] === undefined
      && !ocrProgress
    ) {
      void recognizeCurrentPage();
    }
  }, [activeTool, nativeSourceText, ocrProgress, ocrTextByPage, pageNumber, recognizeCurrentPage]);

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
    setOcrTextByPage((current) => {
      const next = { ...current };
      delete next[pageNumber];
      return next;
    });
    setNativeSourceText(null);
  };

  const movePage = (direction: "back" | "forward") => {
    const target = direction === "back" ? pageNumber - 1 : pageNumber + 1;
    if (target < 1 || target > pageCount) return;
    setPageOrder((current) => {
      const next = [...current];
      [next[pageNumber - 1], next[target - 1]] = [next[target - 1]!, next[pageNumber - 1]!];
      return next;
    });
    const swapPage = (page: number) => page === pageNumber ? target : page === target ? pageNumber : page;
    const transform = (snapshot: PdfOverlay[]) => snapshot.map((overlay) => ({ ...overlay, page: swapPage(overlay.page) }));
    setHistory((current) => ({
      past: current.past.map(transform),
      present: transform(current.present),
      future: current.future.map(transform),
    }));
    setPageRotations((current) => {
      const next = { ...current };
      next[pageNumber] = current[target] ?? 0;
      next[target] = current[pageNumber] ?? 0;
      return next;
    });
    setOcrTextByPage((current) => {
      const next = { ...current };
      if (current[target]) next[pageNumber] = current[target];
      else delete next[pageNumber];
      if (current[pageNumber]) next[target] = current[pageNumber];
      else delete next[target];
      return next;
    });
    setDraft(null);
    setSelectedId(null);
    setPageNumber(target);
    setNotice(`Page moved ${direction === "back" ? "earlier" : "later"} in this working copy.`);
  };

  const duplicatePage = () => {
    const insertionPage = pageNumber + 1;
    setPageOrder((current) => {
      const next = [...current];
      next.splice(pageNumber, 0, sourcePageNumber);
      return next;
    });
    const shifted = history.present.map((overlay) => overlay.page > pageNumber
      ? { ...overlay, page: overlay.page + 1 }
      : overlay);
    const copies = history.present
      .filter((overlay) => overlay.page === pageNumber)
      .map((overlay) => ({ ...overlay, id: createOverlayId(), page: insertionPage }));
    setHistory({ past: [], present: [...shifted, ...copies], future: [] });
    setPageRotations((current) => Object.fromEntries(
      Object.entries(current).flatMap(([key, value]) => {
        const page = Number(key);
        if (page > pageNumber) return [[page + 1, value]];
        if (page === pageNumber) return [[page, value], [insertionPage, value]];
        return [[page, value]];
      }),
    ));
    setOcrTextByPage((current) => Object.fromEntries(
      Object.entries(current).flatMap(([key, value]) => {
        const page = Number(key);
        if (page > pageNumber) return [[page + 1, value]];
        if (page === pageNumber) {
          const copy = value.map((item) => ({ ...item, id: `${item.id}-copy-${insertionPage}` }));
          return [[page, value], [insertionPage, copy]];
        }
        return [[page, value]];
      }),
    ));
    setDraft(null);
    setSelectedId(null);
    setPageNumber(insertionPage);
    setNotice("Page duplicated with its edits. Overlay undo history was restarted after the page operation.");
  };

  const deletePage = () => {
    if (pageCount <= 1 || !window.confirm(`Delete page ${pageNumber} from this working copy?`)) return;
    setPageOrder((current) => current.filter((_, index) => index !== pageNumber - 1));
    const nextOverlays = history.present.flatMap((overlay): PdfOverlay[] => {
      if (overlay.page === pageNumber) return [];
      return [overlay.page > pageNumber ? { ...overlay, page: overlay.page - 1 } : overlay];
    });
    setHistory({ past: [], present: nextOverlays, future: [] });
    setPageRotations((current) => Object.fromEntries(
      Object.entries(current).flatMap(([key, value]) => {
        const page = Number(key);
        if (page === pageNumber) return [];
        return [[page > pageNumber ? page - 1 : page, value]];
      }),
    ));
    setOcrTextByPage((current) => Object.fromEntries(
      Object.entries(current).flatMap(([key, value]) => {
        const page = Number(key);
        if (page === pageNumber) return [];
        return [[page > pageNumber ? page - 1 : page, value]];
      }),
    ));
    setDraft(null);
    setSelectedId(null);
    setPageNumber(Math.min(pageNumber, pageCount - 1));
    setNotice("Page deleted from this working copy. The original PDF is unchanged.");
  };

  const updateSelected = (patch: Partial<PdfOverlay>) => {
    const current = displayOverlays.find((overlay) => overlay.id === selectedId);
    if (!current) return;
    commit(replaceOverlay(displayOverlays, normalizeOverlay({ ...current, ...patch } as PdfOverlay)));
  };

  const updateFormValue = (name: string, value: PdfFormValue) => {
    setFormValues((current) => ({ ...current, [name]: value }));
    setNotice(null);
  };

  const locateFormField = (field: PdfFormFieldDescriptor) => {
    if (field.widgets.length === 0) return;
    const nextWidgetIndex = selectedFormWidget?.fieldName === field.name
      ? (selectedFormWidget.widgetIndex + 1) % field.widgets.length
      : 0;
    const widget = field.widgets[nextWidgetIndex]!;
    setSelectedFormWidget({ fieldName: field.name, widgetIndex: nextWidgetIndex });
    if (widget.page !== null) {
      const logicalPageIndex = pageOrder.indexOf(widget.page);
      if (logicalPageIndex >= 0) setPageNumber(logicalPageIndex + 1);
    }
  };

  const reorderSelected = (direction: "up" | "down") => {
    const index = history.present.findIndex((overlay) => overlay.id === selectedId);
    if (index < 0) return;
    const pageIndexes = history.present
      .map((overlay, overlayIndex) => overlay.page === pageNumber ? overlayIndex : -1)
      .filter((overlayIndex) => overlayIndex >= 0);
    const pageIndex = pageIndexes.indexOf(index);
    const targetPageIndex = direction === "up" ? pageIndex + 1 : pageIndex - 1;
    const target = pageIndexes[targetPageIndex];
    if (pageIndex < 0 || target === undefined) return;
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

  const startInkGesture = (event: React.PointerEvent) => {
    if (activeTool !== "ink" || event.button !== 0 || !pageSurfaceRef.current) return;
    event.preventDefault();
    const bounds = pageSurfaceRef.current.getBoundingClientRect();
    const points: PdfInkPoint[] = [];
    const record = (clientX: number, clientY: number) => {
      const point = {
        x: Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)),
        y: Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height)),
      };
      const previous = points.at(-1);
      if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > 0.0015) points.push(point);
      setInkDraft([...points]);
    };
    record(event.clientX, event.clientY);
    const move = (moveEvent: PointerEvent) => record(moveEvent.clientX, moveEvent.clientY);
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      setInkDraft(null);
      if (points.length > 1) {
        const overlay = createInkOverlay(pageNumber, points);
        commit([...history.present, overlay]);
        setSelectedId(overlay.id);
        setInspectorTab("properties");
        setMobileInspectorOpen(true);
      }
      setActiveTool("select");
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
      const font: EditorFont = {
        id,
        name: file.name.replace(/\.(?:ttf|otf)$/i, ""),
        bytes,
        cssFamily,
        objectUrl,
        face,
        source: "imported",
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

  const buildPdfOutput = async (): Promise<{ output: Uint8Array; secure: boolean }> => {
    if (!loaded) throw new Error("Open a PDF before exporting it.");
    let temporaryDocument: PDFDocumentProxy | null = null;
    try {
      const secureExport = await import("@/lib/documents/pdf-secure-export");
      const secure = exportModeResolution.mode === "secure";
      const fontFamilies = Object.fromEntries([
        ...STANDARD_FONTS.map((font) => [font.id, font.css]),
        ...customFonts.map((font) => [font.id, font.cssFamily]),
      ]);
      const formSource = formFields.length > 0 && hasFormChanges
        ? await (await import("@/lib/documents/pdf-forms")).applyPdfFormValues(
            loaded.bytes,
            formValues,
          )
        : loaded.bytes;
      let exportDocument = loaded.document;
      if (secure && formFields.length > 0 && hasFormChanges) {
        const pdfjs = await loadPdfJs();
        temporaryDocument = await pdfjs.getDocument({
          data: formSource.slice(),
          isEvalSupported: false,
        }).promise;
        exportDocument = temporaryDocument;
      }
      if (secure) setExportProgress({ completed: 0, total: pageCount });
      const output = secure
        ? await secureExport.exportSecureRasterizedPdf({
            document: exportDocument,
            overlays: displayOverlays,
            pageRotations,
            pageOrder,
            fontFamilies,
            images,
            onProgress: (completed, total) => setExportProgress({ completed, total }),
          })
        : await (await import("@/lib/documents/pdf-export")).exportPdfWithOverlays(
            formSource,
            displayOverlays,
            customFonts.flatMap(({ id, bytes }) => bytes ? [{ id, bytes }] : []),
            images,
            pageOrder,
          );
      return { output, secure };
    } finally {
      void temporaryDocument?.destroy();
    }
  };

  const uploadPdf = async (reservation: UploadReservation, file: File) => {
    await upload(reservation.pathname, file, {
      access: "private",
      handleUploadUrl: reservation.handleUploadUrl,
      clientPayload: JSON.stringify({ intentId: reservation.intentId }),
      multipart: true,
    });
  };

  const downloadPdf = async () => {
    if (!loaded) return;
    setExporting(true);
    setError(null);
    setNotice(null);
    try {
      const { output, secure } = await buildPdfOutput();
      const url = URL.createObjectURL(new Blob([bytesAsArrayBuffer(output)], { type: "application/pdf" }));
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

  const finalizeUploadedVersion = async ({
    documentId,
    reservation,
    baseVersionId,
    manifest,
    exportMode: savedExportMode,
    changeSummary,
    pageCount: savedPageCount,
  }: {
    documentId: string;
    reservation: UploadReservation;
    baseVersionId: string | null;
    manifest: PdfEditorManifest;
    exportMode: "source" | "standard" | "secure";
    changeSummary: string;
    pageCount: number;
  }) => {
    const requestBody = JSON.stringify({
      intentId: reservation.intentId,
      idempotencyKey: crypto.randomUUID(),
      baseVersionId,
      exportMode: savedExportMode,
      editorSchemaVersion: 1,
      editorState: manifest,
      pageCount: savedPageCount,
      changeSummary,
    });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await documentApi<StoredDocumentVersion>(`/api/documents/${documentId}/versions`, {
          method: "POST",
          body: requestBody,
        });
      } catch (finalizeError) {
        if (!/upload has not completed/i.test(errorMessage(finalizeError)) || attempt === 7) throw finalizeError;
        await new Promise((resolve) => window.setTimeout(resolve, 300 + attempt * 250));
      }
    }
    throw new Error("The uploaded PDF could not be finalized.");
  };

  const saveToLibrary = async () => {
    if (!loaded || savingVersion) return;
    setSavingVersion(true);
    setDraftStatus("saving");
    setError(null);
    setNotice(null);
    try {
      const manifest = currentEditorManifest;
      const edited = hasChanges;
      const built = edited ? await buildPdfOutput() : null;
      const sourceFile = new File([bytesAsArrayBuffer(loaded.bytes)], loaded.name, { type: "application/pdf" });
      const creation = await documentApi<DocumentCreationReservation>("/api/documents", {
        method: "POST",
        body: JSON.stringify({
          title: loaded.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim() || "Untitled PDF",
          filename: sourceFile.name,
          byteSize: sourceFile.size,
          category: "general",
        }),
      });
      const documentId = creation.document.id;
      await uploadPdf(creation.upload, sourceFile);
      const originalManifest = editorManifest(
        [],
        Array.from({ length: loaded.document.numPages }, (_, index) => index + 1),
        {},
        initialFormValues,
        "standard",
      );
      const originalVersion = await finalizeUploadedVersion({
        documentId,
        reservation: creation.upload,
        baseVersionId: null,
        manifest: originalManifest,
        exportMode: "source",
        changeSummary: "Original uploaded",
        pageCount: loaded.document.numPages,
      });

      if (built) {
        const editedName = downloadName(loaded.name, built.secure);
        const editedFile = new File([bytesAsArrayBuffer(built.output)], editedName, { type: "application/pdf" });
        const versionReservation = await documentApi<UploadReservation>(`/api/documents/${documentId}/uploads`, {
          method: "POST",
          body: JSON.stringify({
            filename: editedFile.name,
            byteSize: editedFile.size,
            baseVersionId: originalVersion.id,
          }),
        });
        await uploadPdf(versionReservation, editedFile);
        await finalizeUploadedVersion({
          documentId,
          reservation: versionReservation,
          baseVersionId: originalVersion.id,
          manifest,
          exportMode: built.secure ? "secure" : "standard",
          changeSummary: "Saved edits",
          pageCount,
        });
      }

      window.history.replaceState(null, "", `/documents/pdf-editor?document=${documentId}`);
      initialDocumentLoadedRef.current = initialDocumentId ?? documentId;
      await loadStoredDocument(documentId, { includeDraft: false });
      setDraftStatus("saved");
      setNotice(edited ? "Saved to the library with the original and edited version." : "Original saved to the document library.");
    } catch (saveError) {
      setDraftStatus("save-needed");
      setError(`The PDF could not be saved. ${errorMessage(saveError)}`);
    } finally {
      setSavingVersion(false);
      setExportProgress(null);
    }
  };

  const saveNewVersion = async () => {
    if (!loaded || !storedDocument?.currentVersionId || savingVersion) return;
    setSavingVersion(true);
    setDraftStatus("saving");
    setError(null);
    setNotice(null);
    try {
      const manifest = currentEditorManifest;
      const { output, secure } = await buildPdfOutput();
      const filename = downloadName(storedDocument.currentFilename ?? loaded.name, secure);
      const file = new File([bytesAsArrayBuffer(output)], filename, { type: "application/pdf" });
      const reservation = await documentApi<UploadReservation>(`/api/documents/${storedDocument.id}/uploads`, {
        method: "POST",
        body: JSON.stringify({
          filename: file.name,
          byteSize: file.size,
          baseVersionId: storedDocument.currentVersionId,
        }),
      });
      await uploadPdf(reservation, file);
      await finalizeUploadedVersion({
        documentId: storedDocument.id,
        reservation,
        baseVersionId: storedDocument.currentVersionId,
        manifest,
        exportMode: secure ? "secure" : "standard",
        changeSummary: hasChanges ? "Saved edits" : "Saved checkpoint",
        pageCount,
      });
      await documentApi<{ discarded: boolean }>(`/api/documents/${storedDocument.id}/draft`, { method: "DELETE" })
        .catch(() => ({ discarded: false }));
      draftRevisionRef.current = null;
      lastDraftSignatureRef.current = null;
      await loadStoredDocument(storedDocument.id, { includeDraft: false });
      setDraftStatus("saved");
      setNotice("A new version was saved. Earlier versions remain available in history.");
    } catch (saveError) {
      setDraftStatus("save-needed");
      setError(`The new version could not be saved. ${errorMessage(saveError)}`);
    } finally {
      setSavingVersion(false);
      setExportProgress(null);
    }
  };

  const restoreVersion = async (version: StoredDocumentVersion) => {
    if (!storedDocument?.currentVersionId || restoringVersionId) return;
    if (hasChanges) {
      setHistoryOpen(false);
      setError("Save the current work as a version before restoring an earlier version.");
      return;
    }
    if (!window.confirm(`Restore version ${version.versionNumber}? The current version will remain in history.`)) return;
    setRestoringVersionId(version.id);
    setError(null);
    try {
      await documentApi<StoredDocumentVersion>(`/api/documents/${storedDocument.id}/versions/${version.id}/restore`, {
        method: "POST",
        body: JSON.stringify({
          expectedCurrentVersionId: storedDocument.currentVersionId,
          idempotencyKey: crypto.randomUUID(),
          reason: `Restored version ${version.versionNumber}`,
        }),
      });
      await loadStoredDocument(storedDocument.id, { includeDraft: false });
      setNotice(`Version ${version.versionNumber} was restored as a new version.`);
    } catch (restoreError) {
      setError(`That version could not be restored. ${errorMessage(restoreError)}`);
    } finally {
      setRestoringVersionId(null);
    }
  };

  if (!loaded) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow">Documents</p>
            <h1 className="display mt-1 text-2xl text-[var(--color-ink)] sm:text-3xl">PDF editor</h1>
          </div>
          <Link href="/documents" className="btn btn-secondary">
            <ArrowLeft className="h-4 w-4" aria-hidden /> Document library
          </Link>
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
            <h2 className="mt-5 text-lg font-semibold">{opening && initialDocumentId ? "Opening saved PDF" : "Open a PDF"}</h2>
            <p className="mt-2 text-xs text-[var(--color-ink-faint)]">PDF · 100 MB maximum · Save it to the library when ready</p>
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
      ? sourceText.some((item) => item.origin === "ocr") ? "Text recognized locally" : "Selectable source text"
      : "Image or scan";

  return (
    <div className="space-y-4 pb-16 lg:pb-0">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link href="/documents" className="eyebrow inline-flex items-center gap-1 hover:text-[var(--color-primary)]">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Documents
          </Link>
          <h1 className="display mt-1 truncate text-2xl text-[var(--color-ink)]">{storedDocument?.title ?? loaded.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-faint)]">
            {storedDocument ? <><span className="font-semibold text-[var(--color-ink-soft)]">v{storedDocument.currentVersionNumber ?? 1}</span><span aria-hidden>·</span></> : null}
            <span>{pageCount} {pageCount === 1 ? "page" : "pages"}</span>
            <span aria-hidden>·</span>
            <span>{textSourceState}</span>
            {formFields.length > 0 ? (
              <><span aria-hidden>·</span><span>{formFields.length} form {formFields.length === 1 ? "field" : "fields"}</span></>
            ) : null}
            <span aria-hidden>·</span>
            <span>{storedDocument ? "Original preserved in library" : "Not saved to library"}</span>
            {storedDocument ? (
              <><span aria-hidden>·</span><span className="inline-flex items-center gap-1 font-medium">
                <Clock3 className="h-3.5 w-3.5" aria-hidden />
                {draftStatus === "saving" ? "Saving draft" : draftStatus === "saved" ? "Changes autosaved" : draftStatus === "save-needed" ? "Save a version" : "Saved"}
              </span></>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {storedDocument ? (
            <button type="button" className="btn btn-secondary" onClick={() => setHistoryOpen(true)}>
              <Clock3 className="h-4 w-4" aria-hidden /> History
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={savingVersion || exporting || opening}
            onClick={() => void (storedDocument ? saveNewVersion() : saveToLibrary())}
          >
            {savingVersion ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
            {savingVersion ? "Saving" : storedDocument ? "Save version" : "Save to library"}
          </button>
          <label className="sr-only" htmlFor="pdf-export-mode">Export mode</label>
          <select
            id="pdf-export-mode"
            className="select"
            value={exportModeResolution.mode}
            onChange={(event) => setExportMode(event.target.value as PdfExportMode)}
            title={exportModeResolution.reason
              ?? "High-fidelity preserves the original page quality. Sanitized permanently flattens the final appearance."}
          >
            <option value="standard" disabled={exportModeResolution.forced}>High-fidelity PDF</option>
            <option value="secure">Sanitized flattened PDF</option>
          </select>
          <button type="button" className="btn btn-secondary" disabled={opening || exporting || savingVersion} onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-4 w-4" aria-hidden />
            Open another
          </button>
          <button type="button" className="btn btn-secondary" disabled={exporting || opening || savingVersion} onClick={() => void downloadPdf()}>
            {exporting ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
            {exportProgress ? `Flattening ${exportProgress.completed}/${exportProgress.total}` : "Download"}
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
      {exportModeResolution.forced ? (
        <div className="rounded-lg border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn)]" role="status">
          Sanitized output is required for this working copy. {exportModeResolution.reason}
        </div>
      ) : null}
      {ocrProgress ? (
        <div className="rounded-lg border border-[var(--color-primary)] bg-[var(--color-primary-tint)] px-4 py-3" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-sm font-medium text-[var(--color-primary)]">
            <span className="flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> {ocrProgress.status}</span>
            <span className="tnum">{Math.round(ocrProgress.progress * 100)}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white" aria-hidden>
            <div className="h-full bg-[var(--color-primary)] transition-[width]" style={{ width: `${Math.round(ocrProgress.progress * 100)}%` }} />
          </div>
        </div>
      ) : null}
      {exportModeResolution.mode === "standard" && history.present.some((overlay) => overlay.kind === "cover") ? (
        <div className="rounded-lg border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn)]" role="status">
          High-fidelity output preserves every original pixel beneath repaired areas. Use sanitized output when the hidden original must be permanently removed.
        </div>
      ) : null}
      {formFields.some((field) => field.kind === "signature") ? (
        <div className="rounded-lg border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-4 py-3 text-sm text-[var(--color-warn)]" role="status">
          Exporting an edited copy can invalidate an existing digital signature. Its visible appearance is retained, but certification may no longer verify.
        </div>
      ) : null}

      <section className="card overflow-hidden">
        <div
          className="scroll-thin flex min-h-14 touch-pan-x items-center gap-1 overflow-x-auto overscroll-x-contain border-b border-[var(--color-rule)] px-2 py-2 sm:px-3"
          role="toolbar"
          aria-label="PDF editing tools"
        >
          <div className="flex shrink-0 items-center gap-1 border-r border-[var(--color-rule)] pr-2">
            <ToolButton label="Select and move items" active={activeTool === "select"} onClick={() => setActiveTool("select")}>
              <MousePointer2 className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton
              label="Replace visible text"
              active={activeTool === "edit-text"}
              disabled={ocrProgress !== null}
              onClick={() => {
                setActiveTool("edit-text");
                setInspectorTab("source");
                setMobileInspectorOpen(true);
              }}
            >
              <ScanText className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Add text" onClick={() => addText()}>
              <Type className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Repair background or redact" onClick={addCover}>
              <Eraser className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Highlight" onClick={() => addShape("highlight")}>
              <Highlighter className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Add rectangle" onClick={() => addShape("rectangle")}>
              <Square className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Add ellipse" onClick={() => addShape("ellipse")}>
              <Circle className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Draw or sign" active={activeTool === "ink"} onClick={() => setActiveTool(activeTool === "ink" ? "select" : "ink")}>
              <PenTool className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Add image or signature" onClick={() => imageInputRef.current?.click()}>
              <ImagePlus className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton
              label="Fill PDF form fields"
              disabled={formFields.length === 0}
              active={inspectorTab === "form"}
              onClick={() => {
                setActiveTool("select");
                setInspectorTab("form");
                setMobileInspectorOpen(true);
              }}
            >
              <ListChecks className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
          </div>
          <div className="flex shrink-0 items-center gap-1 border-r border-[var(--color-rule)] px-2">
            <ToolButton label="Undo" disabled={history.past.length === 0} onClick={undo}>
              <Undo2 className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Redo" disabled={history.future.length === 0} onClick={redo}>
              <Redo2 className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Delete selected item" disabled={!selected} onClick={removeSelected}>
              <Trash2 className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Duplicate selected item" disabled={!selected} onClick={duplicateSelected}>
              <Copy className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
          </div>
          <div className="flex shrink-0 items-center gap-1 px-2">
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
          <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
            <ToolButton label="Move page earlier" disabled={pageNumber <= 1} onClick={() => movePage("back")}>
              <ArrowLeft className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Move page later" disabled={pageNumber >= pageCount} onClick={() => movePage("forward")}>
              <ArrowRight className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Duplicate page" onClick={duplicatePage}>
              <Copy className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
            <ToolButton label="Delete page" disabled={pageCount <= 1} onClick={deletePage}>
              <Trash2 className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
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
                max={pageCount}
                value={pageNumber}
                onChange={(event) => setPageNumber(Math.max(1, Math.min(pageCount, Number(event.target.value) || 1)))}
              />
              <span>of {pageCount}</span>
            </label>
            <ToolButton label="Next page" disabled={pageNumber >= pageCount} onClick={() => setPageNumber((page) => page + 1)}>
              <ChevronRight className="h-[1.1rem] w-[1.1rem]" aria-hidden />
            </ToolButton>
          </div>
        </div>

        <div className="grid min-h-[42rem] min-w-0 grid-cols-1 lg:grid-cols-[19rem_minmax(0,1fr)_9rem]">
          <aside
            aria-label="PDF inspector"
            className={`${mobileInspectorOpen ? "fixed" : "hidden"} inset-x-2 bottom-2 z-40 min-w-0 max-h-[58vh] overflow-hidden rounded-lg border border-[var(--color-rule-strong)] bg-white shadow-2xl lg:order-1 lg:static lg:inset-auto lg:z-auto lg:block lg:max-h-none lg:rounded-none lg:border-y-0 lg:border-l-0 lg:border-r lg:shadow-none`}
          >
            <div className="flex items-center gap-2 p-3">
              <div className="segmented-control grid min-w-0 flex-1 grid-cols-3" role="group" aria-label="Inspector view">
                <button type="button" aria-pressed={inspectorTab === "properties"} onClick={() => setInspectorTab("properties")}>Properties</button>
                <button type="button" aria-pressed={inspectorTab === "source"} onClick={() => { setInspectorTab("source"); setActiveTool("edit-text"); }}>Source text</button>
                <button type="button" disabled={formFields.length === 0} aria-pressed={inspectorTab === "form"} onClick={() => { setInspectorTab("form"); setActiveTool("select"); }}>Form</button>
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
                        <p className="mt-1 text-sm font-semibold">{itemLabel(selected)}</p>
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
                            <optgroup label="Built-in fonts">
                              {STANDARD_FONTS.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}
                            </optgroup>
                            {customFonts.some((font) => font.source === "document") ? (
                              <optgroup label="Fonts recovered from this PDF">
                                {customFonts.filter((font) => font.source === "document").map((font) => <option key={font.id} value={font.id}>{font.name}</option>)}
                              </optgroup>
                            ) : null}
                            {customFonts.some((font) => font.source === "imported") ? (
                              <optgroup label="Imported fonts">
                                {customFonts.filter((font) => font.source === "imported").map((font) => <option key={font.id} value={font.id}>{font.name}</option>)}
                              </optgroup>
                            ) : null}
                          </select>
                        </label>
                        {selected.sourceFontName ? (
                          <p className="rounded-md bg-[var(--color-surface-muted)] px-2.5 py-2 text-xs text-[var(--color-ink-soft)]">
                            Appearance match: <strong>{selected.sourceFontName}</strong>. Scanned documents contain no recoverable font file, so use font import when an exact licensed font is required.
                          </p>
                        ) : null}
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

                        <div className="segmented-control grid w-full grid-cols-2" role="group" aria-label="Font style">
                          <button
                            type="button"
                            aria-label="Bold"
                            title="Bold"
                            aria-pressed={selected.fontWeight === 700}
                            onClick={() => updateSelected({ fontWeight: selected.fontWeight === 700 ? 400 : 700 } as Partial<PdfTextOverlay>)}
                            className="justify-center"
                          >
                            <Bold className="h-4 w-4" aria-hidden />
                          </button>
                          <button
                            type="button"
                            aria-label="Italic"
                            title="Italic"
                            aria-pressed={selected.fontStyle === "italic"}
                            onClick={() => updateSelected({ fontStyle: selected.fontStyle === "italic" ? "normal" : "italic" } as Partial<PdfTextOverlay>)}
                            className="justify-center"
                          >
                            <Italic className="h-4 w-4" aria-hidden />
                          </button>
                        </div>

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

                        <div className="grid grid-cols-2 gap-3">
                          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
                            Line spacing
                            <input
                              className="input tnum mt-1 w-full"
                              type="number"
                              min={0.8}
                              max={3}
                              step={0.05}
                              value={selected.lineHeight}
                              onChange={(event) => updateSelected({ lineHeight: Math.max(0.8, Math.min(3, Number(event.target.value) || 1)) } as Partial<PdfTextOverlay>)}
                            />
                          </label>
                          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
                            Letter spacing
                            <input
                              className="input tnum mt-1 w-full"
                              type="number"
                              min={-5}
                              max={20}
                              step={0.1}
                              value={selected.letterSpacing}
                              onChange={(event) => updateSelected({ letterSpacing: Math.max(-5, Math.min(20, Number(event.target.value) || 0)) } as Partial<PdfTextOverlay>)}
                            />
                          </label>
                          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
                            Opacity
                            <input
                              className="input tnum mt-1 w-full"
                              type="number"
                              min={10}
                              max={100}
                              step={5}
                              value={Math.round(selected.opacity * 100)}
                              onChange={(event) => updateSelected({ opacity: Math.max(0.1, Math.min(1, Number(event.target.value) / 100 || 0.1)) } as Partial<PdfTextOverlay>)}
                            />
                          </label>
                          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
                            Rotation
                            <input
                              className="input tnum mt-1 w-full"
                              type="number"
                              min={-359}
                              max={359}
                              step={1}
                              value={selected.rotation}
                              onChange={(event) => updateSelected({ rotation: Number(event.target.value) || 0 } as Partial<PdfTextOverlay>)}
                            />
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
                      <div className="space-y-3">
                        <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
                          Background color
                          <span className="mt-1 flex min-h-9 items-center gap-2 rounded-lg border border-[var(--color-rule-strong)] px-2">
                            <input
                              type="color"
                              className="h-6 w-8 cursor-pointer border-0 bg-transparent p-0"
                              value={selected.color}
                              onChange={(event) => updateSelected({ color: event.target.value })}
                              aria-label="Background repair color"
                            />
                            <span className="tnum text-xs font-normal">{selected.color.toUpperCase()}</span>
                          </span>
                        </label>
                        <div className="segmented-control grid w-full grid-cols-2" role="group" aria-label="Common repair colors">
                          <button type="button" aria-pressed={selected.color === "#ffffff"} onClick={() => updateSelected({ color: "#ffffff" })}>White</button>
                          <button type="button" aria-pressed={selected.color === "#111111"} onClick={() => updateSelected({ color: "#111111" })}>Black</button>
                        </div>
                        <p className={`mt-2 text-xs font-medium ${exportModeResolution.mode === "secure" ? "text-[var(--color-success)]" : "text-[var(--color-warn)]"}`}>
                          {exportModeResolution.mode === "secure" ? "Permanently removed in sanitized output" : "Original quality preserved beneath this repair"}
                        </p>
                      </div>
                    ) : selected.kind === "image" ? (
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
                    ) : selected.kind === "shape" ? (
                      <div className="space-y-3">
                        <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
                          Shape
                          <select className="select mt-1 w-full" value={selected.shape} onChange={(event) => updateSelected({ shape: event.target.value as typeof selected.shape })}>
                            <option value="highlight">Highlight</option>
                            <option value="rectangle">Rectangle</option>
                            <option value="ellipse">Ellipse</option>
                            <option value="line">Line</option>
                          </select>
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
                            Fill
                            <input type="color" className="input mt-1 h-9 w-full p-1" value={selected.fillColor} onChange={(event) => updateSelected({ fillColor: event.target.value })} />
                          </label>
                          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
                            Border
                            <input type="color" className="input mt-1 h-9 w-full p-1" value={selected.strokeColor} onChange={(event) => updateSelected({ strokeColor: event.target.value })} />
                          </label>
                          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
                            Border width
                            <input type="number" className="input tnum mt-1 w-full" min={0} max={20} step={0.5} value={selected.strokeWidth} onChange={(event) => updateSelected({ strokeWidth: Math.max(0, Math.min(20, Number(event.target.value) || 0)) })} />
                          </label>
                          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
                            Opacity
                            <input type="number" className="input tnum mt-1 w-full" min={5} max={100} step={5} value={Math.round(selected.opacity * 100)} onChange={(event) => updateSelected({ opacity: Math.max(0.05, Math.min(1, Number(event.target.value) / 100 || 0.05)) })} />
                          </label>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <label className="block text-xs font-semibold text-[var(--color-ink-soft)]">
                          Ink color
                          <input type="color" className="input mt-1 h-9 w-full p-1" value={selected.color} onChange={(event) => updateSelected({ color: event.target.value })} />
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
                            Stroke width
                            <input type="number" className="input tnum mt-1 w-full" min={0.5} max={20} step={0.5} value={selected.strokeWidth} onChange={(event) => updateSelected({ strokeWidth: Math.max(0.5, Math.min(20, Number(event.target.value) || 0.5)) })} />
                          </label>
                          <label className="text-xs font-semibold text-[var(--color-ink-soft)]">
                            Opacity
                            <input type="number" className="input tnum mt-1 w-full" min={5} max={100} step={5} value={Math.round(selected.opacity * 100)} onChange={(event) => updateSelected({ opacity: Math.max(0.05, Math.min(1, Number(event.target.value) / 100 || 0.05)) })} />
                          </label>
                        </div>
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
                      {selected.kind !== "text" ? (
                        <label className="mt-2 block text-[0.7rem] text-[var(--color-ink-faint)]">
                          Rotation (degrees)
                          <input
                            type="number"
                            className="input tnum mt-0.5 w-full"
                            min={-359}
                            max={359}
                            step={1}
                            value={selected.rotation}
                            onChange={(event) => updateSelected({ rotation: Number(event.target.value) || 0 } as Partial<PdfOverlay>)}
                          />
                        </label>
                      ) : null}
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
                      <button type="button" className="btn btn-sm btn-secondary mt-2 w-full" onClick={duplicateSelected}>
                        <Copy className="h-4 w-4" aria-hidden /> Duplicate
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : inspectorTab === "source" ? (
              <div className="scroll-thin max-h-[calc(58vh-4.5rem)] overflow-y-auto border-t border-[var(--color-rule)] p-4 lg:max-h-[42rem]">
                {sourceText === null ? (
                  <div className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
                    <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> Checking page text
                  </div>
                ) : sourceText.length === 0 ? (
                  <div className="py-3">
                    <p className="text-sm font-semibold">Image or scanned page</p>
                    <p className="mt-2 text-xs text-[var(--color-ink-soft)]">Recognize the visible wording locally, then select it directly on the page. The PDF is not uploaded.</p>
                    <button type="button" className="btn btn-sm btn-primary mt-4 w-full" disabled={ocrProgress !== null} onClick={() => void recognizeCurrentPage()}>
                      {ocrProgress ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <ScanText className="h-4 w-4" aria-hidden />}
                      Recognize text on this page
                    </button>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">Replace page text</p>
                        <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{sourceText.length} {sourceText.length === 1 ? "region" : "regions"} · click a box on the page or choose Replace below</p>
                        <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Replacement paints a background cover and a new text layer. It does not reflow the source PDF text.</p>
                      </div>
                    </div>
                    <label className="relative mt-3 block">
                      <span className="sr-only">Search page text</span>
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]" aria-hidden />
                      <input
                        type="search"
                        className="input w-full pl-9"
                        value={sourceQuery}
                        onChange={(event) => setSourceQuery(event.target.value)}
                        placeholder="Search this page"
                      />
                    </label>
                    <ul className="mt-3 divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
                      {filteredSourceText.map((item) => (
                        <li key={item.id} className="flex items-start gap-2 py-2.5">
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-xs text-[var(--color-ink-soft)]">{item.text}</span>
                            <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[0.68rem] text-[var(--color-ink-faint)]">
                              <span>{item.fontName}</span>
                              <span aria-hidden>·</span>
                              <span>{Math.round(item.fontSize * 10) / 10} pt</span>
                              {item.confidence === undefined ? null : <><span aria-hidden>·</span><span>{Math.round(item.confidence)}% confidence</span></>}
                              <span className="h-3 w-3 border border-[var(--color-rule-strong)]" style={{ background: item.backgroundColor }} title={`Sampled background ${item.backgroundColor}`} aria-hidden />
                            </span>
                          </span>
                          <button type="button" className="btn btn-sm btn-secondary shrink-0" onClick={() => replaceSourceText(item)} aria-label={`Replace ${item.text}`} title="Cover the original area and add matched replacement text">
                            <Type className="h-4 w-4" aria-hidden />
                            Replace
                          </button>
                        </li>
                      ))}
                    </ul>
                    {filteredSourceText.length === 0 ? <p className="py-6 text-center text-xs text-[var(--color-ink-faint)]">No page text matches that search.</p> : null}
                    {sourceText.some((item) => item.origin === "ocr") ? (
                      <button type="button" className="btn btn-sm btn-ghost mt-3 w-full" disabled={ocrProgress !== null} onClick={() => void recognizeCurrentPage()}>
                        <ScanText className="h-4 w-4" aria-hidden /> Recognize this page again
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            ) : (
              <div className="scroll-thin max-h-[calc(58vh-4.5rem)] overflow-y-auto border-t border-[var(--color-rule)] p-4 lg:max-h-[42rem]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">PDF form fields</p>
                    <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Interactive in high-fidelity output · flattened in sanitized output</p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={!hasFormChanges}
                    onClick={() => setFormValues({ ...initialFormValues })}
                  >
                    Reset
                  </button>
                </div>
                <ul className="mt-4 divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
                  {formFields.map((field) => {
                    const value = formValues[field.name] ?? field.value;
                    const selections = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
                    const firstWidgetPage = field.widgets.find((widget) => widget.page !== null)?.page ?? null;
                    const isLocated = selectedFormWidget?.fieldName === field.name;
                    return (
                      <li key={field.name} className="py-3">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <label className="min-w-0 break-words text-xs font-semibold text-[var(--color-ink-soft)]" htmlFor={`pdf-form-${field.name}`}>
                            {field.name}{field.required ? " *" : ""}
                          </label>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {field.readOnly ? <span className="badge bg-[var(--color-surface-muted)] text-[var(--color-ink-faint)]">Read only</span> : null}
                            {field.widgets.length > 0 ? (
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost btn-icon"
                                aria-label={`Show ${field.name} on page ${firstWidgetPage ?? "unknown"}`}
                                aria-pressed={isLocated}
                                title={field.widgets.length > 1 ? "Show next field location" : "Show field on page"}
                                onClick={() => locateFormField(field)}
                              >
                                <LocateFixed className="h-4 w-4" aria-hidden />
                              </button>
                            ) : null}
                          </span>
                        </div>
                        {field.kind === "text" ? field.multiline ? (
                          <textarea
                            id={`pdf-form-${field.name}`}
                            className="input min-h-24 w-full resize-y"
                            value={typeof value === "string" ? value : ""}
                            maxLength={field.maxLength ?? undefined}
                            disabled={field.readOnly}
                            onFocus={() => locateFormField(field)}
                            onChange={(event) => updateFormValue(field.name, event.target.value)}
                          />
                        ) : (
                          <input
                            id={`pdf-form-${field.name}`}
                            type="text"
                            className="input w-full"
                            value={typeof value === "string" ? value : ""}
                            maxLength={field.maxLength ?? undefined}
                            disabled={field.readOnly}
                            onFocus={() => locateFormField(field)}
                            onChange={(event) => updateFormValue(field.name, event.target.value)}
                          />
                        ) : field.kind === "checkbox" ? (
                          <label className="flex min-h-10 items-center gap-3 text-sm text-[var(--color-ink-soft)]" htmlFor={`pdf-form-${field.name}`}>
                            <input
                              id={`pdf-form-${field.name}`}
                              type="checkbox"
                              checked={value === true}
                              disabled={field.readOnly}
                              onFocus={() => locateFormField(field)}
                              onChange={(event) => updateFormValue(field.name, event.target.checked)}
                            />
                            Checked
                          </label>
                        ) : field.kind === "radio" || field.kind === "dropdown" || field.kind === "listbox" ? (
                          <select
                            id={`pdf-form-${field.name}`}
                            className="select w-full"
                            multiple={field.multiselect}
                            size={field.kind === "listbox" ? Math.min(6, Math.max(2, field.options.length)) : undefined}
                            value={field.multiselect ? selections : selections[0] ?? ""}
                            disabled={field.readOnly}
                            onFocus={() => locateFormField(field)}
                            onChange={(event) => updateFormValue(
                              field.name,
                              field.multiselect
                                ? Array.from(event.target.selectedOptions, (option) => option.value)
                                : field.kind === "radio"
                                  ? event.target.value
                                  : event.target.value ? [event.target.value] : [],
                            )}
                          >
                            {!field.required && !field.multiselect ? <option value="">None</option> : null}
                            {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        ) : (
                          <p className="rounded-md bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-ink-soft)]">
                            {field.kind === "signature" ? "Digital signature field · editing can invalidate certification" : field.kind === "button" ? "Form action preserved" : "Unsupported field preserved"}
                          </p>
                        )}
                        {field.appearance.editStrategy === "standard-font" ? (
                          <p className="mt-1.5 text-[0.68rem] text-[var(--color-ink-faint)]">
                            Appearance font preserved: {field.appearance.fontName}
                          </p>
                        ) : field.appearance.editStrategy === "helvetica-fallback" ? (
                          <p className="mt-1.5 text-[0.68rem] text-[var(--color-warn)]">
                            Appearance fallback on edit: Helvetica. {field.appearance.fontName ? `The ${field.appearance.fontName} font resource` : "The original font"} cannot be safely reused by this editor.
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </aside>

          <div
            ref={pageViewportRef}
            className="scroll-thin min-w-0 overflow-auto bg-[var(--color-surface-strong)] p-3 sm:p-5 lg:order-2"
          >
            <div
              ref={pageSurfaceRef}
              onPointerDown={(event) => {
                if (activeTool === "ink") startInkGesture(event);
                else setSelectedId(null);
              }}
              className={`relative mx-auto bg-white shadow-md ${activeTool === "ink" ? "cursor-crosshair" : activeTool === "edit-text" ? "cursor-text" : "cursor-default"}`}
              data-pdf-page-surface="true"
              style={{
                width: pageSize.width * effectiveScale,
                height: pageSize.height * effectiveScale,
              }}
              role="region"
              aria-label={`Editing page ${pageNumber}`}
            >
              <PdfPageCanvas
                document={loaded.document}
                pageNumber={sourcePageNumber}
                scale={effectiveScale}
                rotation={pageRotation}
                onBaseSize={setBasePageSize}
                className="block"
              />
              {formWidgetHighlight && selectedFormField ? (
                <div
                  className="pointer-events-none absolute z-[190] border-2 border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] outline outline-2 outline-offset-2 outline-white"
                  style={{
                    left: `${formWidgetHighlight.x * 100}%`,
                    top: `${formWidgetHighlight.y * 100}%`,
                    width: `${formWidgetHighlight.width * 100}%`,
                    height: `${formWidgetHighlight.height * 100}%`,
                  }}
                  title={`Form field ${selectedFormField.name}`}
                  aria-hidden
                />
              ) : null}
              {activeTool === "edit-text" ? filteredSourceText.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-label={`Visually replace detected text: ${item.text}`}
                  title={`${item.origin === "ocr" ? "Recognized" : "Document"} text · ${item.fontName}${item.confidence === undefined ? "" : ` · ${Math.round(item.confidence)}% confidence`}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => replaceSourceText(item)}
                  className="absolute z-[200] border border-dashed border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] opacity-50 transition-opacity hover:opacity-100 focus:opacity-100 focus:outline focus:outline-2 focus:outline-[var(--color-accent)]"
                  style={{
                    left: `${item.x * 100}%`,
                    top: `${item.y * 100}%`,
                    width: `${item.width * 100}%`,
                    height: `${item.height * 100}%`,
                    transform: `rotate(${item.rotation}deg)`,
                    transformOrigin: "left top",
                  }}
                />
              )) : null}
              {inkDraft && inkDraft.length > 0 ? (
                <svg className="pointer-events-none absolute inset-0 z-[220] h-full w-full" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden>
                  <polyline
                    points={inkDraft.map((point) => `${point.x * 1000},${point.y * 1000}`).join(" ")}
                    fill="none"
                    stroke="#17212b"
                    strokeWidth={Math.max(2, 2 / Math.max(0.1, effectiveScale))}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              ) : null}
              {pageOverlays.map((overlay, index) => {
                const isSelected = overlay.id === selectedId;
                return (
                  <div
                    key={overlay.id}
                    role="group"
                    tabIndex={0}
                    aria-label={overlay.kind === "text" ? `Text: ${overlay.text}` : itemLabel(overlay)}
                    onPointerDown={(event) => {
                      if (inlineEditingId === overlay.id) event.stopPropagation();
                      else startGesture(event, overlay, "move");
                    }}
                    onDoubleClick={(event) => {
                      if (overlay.kind !== "text") return;
                      event.preventDefault();
                      event.stopPropagation();
                      beginInlineEdit(overlay.id);
                    }}
                    onFocus={() => {
                      setSelectedId(overlay.id);
                      setInspectorTab("properties");
                      setMobileInspectorOpen(true);
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
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
                      transform: `rotate(${overlay.rotation}deg)`,
                      transformOrigin: "left top",
                      color: overlay.kind === "text" ? overlay.color : undefined,
                      fontFamily: overlay.kind === "text" ? fontCss(overlay.fontId, customFonts) : undefined,
                      fontSize: overlay.kind === "text" ? `${overlay.fontSize * effectiveScale}px` : undefined,
                      fontWeight: overlay.kind === "text" ? overlay.fontWeight : undefined,
                      fontStyle: overlay.kind === "text" ? overlay.fontStyle : undefined,
                      lineHeight: overlay.kind === "text" ? overlay.lineHeight : undefined,
                      letterSpacing: overlay.kind === "text" ? `${overlay.letterSpacing * effectiveScale}px` : undefined,
                      textAlign: overlay.kind === "text" ? overlay.alignment : undefined,
                      direction: overlay.kind === "text" ? overlay.direction : undefined,
                      opacity: overlay.kind === "text" ? overlay.opacity : undefined,
                      whiteSpace: overlay.kind === "text" ? "pre-wrap" : undefined,
                    }}
                  >
                    {isSelected && overlay.kind === "text" ? (
                      <div
                        className="absolute bottom-[calc(100%+0.45rem)] left-0 z-[260] flex h-9 min-w-max items-center gap-0.5 rounded-md border border-[var(--color-rule-strong)] bg-white p-1 text-[var(--color-ink)] shadow-lg"
                        role="toolbar"
                        aria-label="Selected text formatting"
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon h-7 w-7"
                          aria-label="Edit text in place"
                          title="Edit text in place"
                          onClick={() => beginInlineEdit(overlay.id)}
                        >
                          <Type className="h-3.5 w-3.5" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon h-7 w-7"
                          aria-label="Bold"
                          aria-pressed={overlay.fontWeight === 700}
                          title="Bold"
                          onClick={() => updateSelected({ fontWeight: overlay.fontWeight === 700 ? 400 : 700 } as Partial<PdfTextOverlay>)}
                        >
                          <Bold className="h-3.5 w-3.5" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon h-7 w-7"
                          aria-label="Italic"
                          aria-pressed={overlay.fontStyle === "italic"}
                          title="Italic"
                          onClick={() => updateSelected({ fontStyle: overlay.fontStyle === "italic" ? "normal" : "italic" } as Partial<PdfTextOverlay>)}
                        >
                          <Italic className="h-3.5 w-3.5" aria-hidden />
                        </button>
                        <label className="flex h-7 items-center gap-1 border-l border-[var(--color-rule)] pl-1 text-[0.65rem] font-medium">
                          <span className="sr-only">Font size</span>
                          <input
                            type="number"
                            min={6}
                            max={144}
                            value={overlay.fontSize}
                            onChange={(event) => updateSelected({ fontSize: Math.max(6, Math.min(144, Number(event.target.value) || 6)) } as Partial<PdfTextOverlay>)}
                            className="h-7 w-12 border-0 bg-transparent px-1 text-center outline-none"
                            title="Font size"
                          />
                        </label>
                        <label className="grid h-7 w-7 cursor-pointer place-items-center" title="Text color">
                          <span className="sr-only">Text color</span>
                          <input
                            type="color"
                            value={overlay.color}
                            onChange={(event) => updateSelected({ color: event.target.value } as Partial<PdfTextOverlay>)}
                            className="h-4 w-4 cursor-pointer border-0 bg-transparent p-0"
                          />
                        </label>
                      </div>
                    ) : null}
                    <div
                      className={`h-full w-full ${overlay.kind === "text" && inlineEditingId === overlay.id ? "overflow-visible" : "overflow-hidden"}`}
                      style={{ background: overlay.kind === "cover" ? overlay.color : "transparent" }}
                    >
                      {overlay.kind === "text" && inlineEditingId === overlay.id ? (
                        <textarea
                          ref={inlineTextAreaRef}
                          value={overlay.text}
                          onChange={(event) => updateInlineText(overlay.id, event.target.value)}
                          onBlur={finishInlineEdit}
                          onPointerDown={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                              event.preventDefault();
                              finishInlineEdit();
                            }
                          }}
                          aria-label="Edit selected PDF text"
                          className="h-full w-full resize-none overflow-auto border-0 bg-transparent p-0 text-inherit outline-none"
                          style={{
                            color: "inherit",
                            font: "inherit",
                            lineHeight: "inherit",
                            letterSpacing: "inherit",
                            textAlign: "inherit",
                            direction: "inherit",
                          }}
                        />
                      ) : overlay.kind === "text" ? overlay.text : null}
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
                      {overlay.kind === "shape" && overlay.shape === "line" ? (
                        <svg className="block h-full w-full overflow-visible" aria-hidden>
                          <line
                            x1="0"
                            y1="0"
                            x2="100%"
                            y2="100%"
                            stroke={overlay.strokeColor}
                            strokeWidth={Math.max(1, overlay.strokeWidth * effectiveScale)}
                            strokeOpacity={overlay.opacity}
                            vectorEffect="non-scaling-stroke"
                          />
                        </svg>
                      ) : null}
                      {overlay.kind === "shape" && overlay.shape !== "line" ? (
                        <span
                          className="block h-full w-full"
                          style={{
                            background: overlay.fillColor,
                            border: overlay.strokeWidth > 0 ? `${Math.max(1, overlay.strokeWidth * effectiveScale)}px solid ${overlay.strokeColor}` : undefined,
                            borderRadius: overlay.shape === "ellipse" ? "50%" : undefined,
                            opacity: overlay.opacity,
                          }}
                        />
                      ) : null}
                      {overlay.kind === "ink" ? (
                        <svg className="block h-full w-full overflow-visible" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden>
                          <polyline
                            points={overlay.points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(" ")}
                            fill="none"
                            stroke={overlay.color}
                            strokeWidth={Math.max(1, overlay.strokeWidth * effectiveScale)}
                            strokeOpacity={overlay.opacity}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        </svg>
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

          <aside className="scroll-thin flex gap-2 overflow-x-auto border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] p-2 lg:order-3 lg:block lg:space-y-3 lg:overflow-x-hidden lg:overflow-y-auto lg:border-b-0 lg:border-l">
            {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
              <button
                key={page}
                type="button"
                onClick={() => setPageNumber(page)}
                aria-current={page === pageNumber ? "page" : undefined}
                aria-label={`Open page ${page}`}
                className={`w-24 shrink-0 rounded-md border p-1.5 text-left transition-colors lg:w-full ${page === pageNumber ? "border-[var(--color-primary)] bg-[var(--color-primary-tint)]" : "border-transparent hover:border-[var(--color-rule-strong)]"}`}
              >
                <PdfThumbnailCanvas document={loaded.document} pageNumber={pageOrder[page - 1] ?? page} rotation={pageRotations[page] ?? 0} />
                <span className="mt-1 block text-center text-[0.7rem] font-medium text-[var(--color-ink-soft)]">Page {page}</span>
              </button>
            ))}
          </aside>
        </div>
      </section>

      {historyOpen && storedDocument ? (
        <div className="fixed inset-0 z-[400] flex justify-end" role="dialog" aria-modal="true" aria-labelledby="pdf-history-title">
          <button
            type="button"
            className="absolute inset-0 cursor-default bg-black/25"
            aria-label="Close version history"
            onClick={() => setHistoryOpen(false)}
          />
          <aside className="relative flex h-full w-full max-w-md flex-col border-l border-[var(--color-rule-strong)] bg-white shadow-2xl">
            <header className="flex items-start justify-between gap-4 border-b border-[var(--color-rule)] px-5 py-4">
              <div>
                <p className="eyebrow">Saved document</p>
                <h2 id="pdf-history-title" className="mt-1 text-lg font-semibold">Version history</h2>
                <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Restoring creates a new version. Nothing in this list is overwritten.</p>
              </div>
              <button type="button" className="btn btn-ghost btn-icon" aria-label="Close version history" title="Close" onClick={() => setHistoryOpen(false)}>
                <span className="text-xl leading-none" aria-hidden>×</span>
              </button>
            </header>
            <div className="scroll-thin flex-1 overflow-y-auto px-5 py-2">
              <ol className="divide-y divide-[var(--color-rule)]">
                {versions.map((version) => {
                  const current = version.id === storedDocument.currentVersionId;
                  return (
                    <li key={version.id} className="py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="tnum font-semibold text-[var(--color-ink)]">Version {version.versionNumber}</span>
                            {current ? <span className="badge bg-[var(--color-primary-tint)] text-[var(--color-primary)]">Current</span> : null}
                            {version.versionKind === "original" ? <span className="badge bg-[var(--color-surface-muted)] text-[var(--color-ink-soft)]">Original</span> : null}
                            {version.versionKind === "restored" ? <span className="badge bg-[var(--color-surface-muted)] text-[var(--color-ink-soft)]">Restored</span> : null}
                          </div>
                          <p className="mt-1 truncate text-sm text-[var(--color-ink-soft)]">{version.changeSummary ?? version.filename}</p>
                          <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{formatStoredDate(version.createdAt)} · {version.createdBy} · {formatStoredBytes(version.byteSize)}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <a
                            href={`/api/documents/${storedDocument.id}/versions/${version.id}/file?download=1`}
                            className="btn btn-ghost btn-icon h-8 w-8"
                            aria-label={`Download version ${version.versionNumber}`}
                            title="Download this version"
                          >
                            <Download className="h-4 w-4" aria-hidden />
                          </a>
                          {!current ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-icon h-8 w-8"
                              disabled={restoringVersionId !== null}
                              aria-label={`Restore version ${version.versionNumber}`}
                              title="Restore as a new version"
                              onClick={() => void restoreVersion(version)}
                            >
                              {restoringVersionId === version.id ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </aside>
        </div>
      ) : null}

      {!mobileInspectorOpen ? (
        <div className="fixed inset-x-3 bottom-3 z-30 lg:hidden">
          <div className="segmented-control grid w-full grid-cols-3 border border-[var(--color-rule-strong)] bg-white p-1 shadow-xl" role="group" aria-label="Open PDF inspector">
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
                setActiveTool("edit-text");
                setMobileInspectorOpen(true);
              }}
            >
              <Type className="h-4 w-4" aria-hidden />
              Source text
            </button>
            <button
              type="button"
              disabled={formFields.length === 0}
              onClick={() => {
                setInspectorTab("form");
                setActiveTool("select");
                setMobileInspectorOpen(true);
              }}
            >
              <ListChecks className="h-4 w-4" aria-hidden />
              Form
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
