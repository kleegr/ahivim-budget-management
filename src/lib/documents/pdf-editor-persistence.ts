import type { PdfOverlay, PdfOverlayBase } from "./pdf-editor";
import type { PdfExportMode } from "./pdf-export-mode";
import type { PdfFormValue } from "./pdf-forms";

export const MAX_PDF_EDITOR_ASSET_BYTES = 900 * 1024;
export const MAX_PDF_EDITOR_ASSET_TOTAL_BYTES = 1_200 * 1024;

const MAX_PDF_EDITOR_PAGES = 10_000;
const MAX_PDF_EDITOR_OVERLAYS = 5_000;
const MAX_PDF_EDITOR_FORM_FIELDS = 5_000;
const MAX_PDF_EDITOR_ASSETS = 1_000;
const MAX_PDF_EDITOR_INK_POINTS = 20_000;
const MAX_PDF_EDITOR_ID_LENGTH = 200;
const MAX_PDF_EDITOR_NAME_LENGTH = 512;
const MAX_PDF_EDITOR_TEXT_LENGTH = 250_000;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export type PdfEditorFontMimeType = "font/ttf" | "font/otf";

export interface PdfEditorFontAssetSource {
  id: string;
  name: string;
  bytes: Uint8Array | null;
  mimeType?: PdfEditorFontMimeType;
  source: "document" | "imported";
}

export interface PdfEditorImageAssetSource {
  id: string;
  name: string;
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
}

interface PersistedPdfEditorAsset {
  id: string;
  name: string;
  mimeType: string;
  data: string;
}

export interface PdfEditorManifest {
  schemaVersion: 2;
  overlays: PdfOverlay[];
  pageOrder: number[];
  pageRotations: Record<number, number>;
  formValues: Record<string, PdfFormValue>;
  exportMode: PdfExportMode;
  assets: {
    fonts: Array<PersistedPdfEditorAsset & { mimeType: PdfEditorFontMimeType }>;
    images: Array<PersistedPdfEditorAsset & { mimeType: "image/png" | "image/jpeg" }>;
  };
}

export interface DecodedPdfEditorAssets {
  fonts: Array<{
    id: string;
    name: string;
    mimeType: PdfEditorFontMimeType;
    bytes: Uint8Array;
  }>;
  images: Array<{
    id: string;
    name: string;
    mimeType: "image/png" | "image/jpeg";
    bytes: Uint8Array;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(
  value: unknown,
  maximum: number,
  minimum = 0,
): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isFiniteBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

function isSafeIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ByteLength(value: string): number | null {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function persistedAsset(
  source: { id: string; name: string; mimeType: string; bytes: Uint8Array },
): PersistedPdfEditorAsset {
  return {
    id: source.id,
    name: source.name,
    mimeType: source.mimeType,
    data: bytesToBase64(source.bytes),
  };
}

export function pdfEditorAssetCapacityError(
  existingBytes: number,
  additionalBytes: number,
  label: "image" | "font",
): string | null {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes <= 0) {
    return `That ${label} is empty or unreadable.`;
  }
  if (additionalBytes > MAX_PDF_EDITOR_ASSET_BYTES) {
    return `That ${label} is too large to keep editable. Choose one smaller than 900 KB.`;
  }
  if (existingBytes + additionalBytes > MAX_PDF_EDITOR_ASSET_TOTAL_BYTES) {
    return "Editable image and font assets are limited to 1.2 MB per PDF. Remove an imported asset or choose a smaller file.";
  }
  return null;
}

export function pdfEditorAssetSourceBytes(
  fonts: PdfEditorFontAssetSource[],
  images: PdfEditorImageAssetSource[],
): number {
  return images.reduce((total, image) => total + image.bytes.byteLength, 0)
    + fonts.reduce((total, font) => total + (font.source === "imported" ? font.bytes?.byteLength ?? 0 : 0), 0);
}

export function createPdfEditorManifest({
  overlays,
  pageOrder,
  pageRotations,
  formValues,
  exportMode,
  fonts = [],
  images = [],
}: {
  overlays: PdfOverlay[];
  pageOrder: number[];
  pageRotations: Record<number, number>;
  formValues: Record<string, PdfFormValue>;
  exportMode: PdfExportMode;
  fonts?: PdfEditorFontAssetSource[];
  images?: PdfEditorImageAssetSource[];
}): PdfEditorManifest {
  const referencedFontIds = new Set(
    overlays.filter((overlay) => overlay.kind === "text").map((overlay) => overlay.fontId),
  );
  const referencedImageIds = new Set(
    overlays.filter((overlay) => overlay.kind === "image").map((overlay) => overlay.imageId),
  );
  const persistedFonts = fonts.flatMap((font) => (
    font.source === "imported" && font.bytes && referencedFontIds.has(font.id)
      ? [persistedAsset({
          id: font.id,
          name: font.name,
          mimeType: font.mimeType ?? "font/ttf",
          bytes: font.bytes,
        }) as PersistedPdfEditorAsset & { mimeType: PdfEditorFontMimeType }]
      : []
  ));
  const persistedImages = images.flatMap((image) => (
    referencedImageIds.has(image.id)
      ? [persistedAsset(image) as PersistedPdfEditorAsset & { mimeType: "image/png" | "image/jpeg" }]
      : []
  ));
  const assetBytes = [...persistedFonts, ...persistedImages].reduce(
    (total, asset) => total + (base64ByteLength(asset.data) ?? 0),
    0,
  );
  if (assetBytes > MAX_PDF_EDITOR_ASSET_TOTAL_BYTES) {
    throw new Error("Editable image and font assets exceed the 1.2 MB persistence limit.");
  }

  return {
    schemaVersion: 2,
    overlays,
    pageOrder,
    pageRotations,
    formValues,
    exportMode,
    assets: { fonts: persistedFonts, images: persistedImages },
  };
}

function parseAssets(value: unknown): PdfEditorManifest["assets"] | null {
  if (!isRecord(value)
    || !Array.isArray(value.fonts) || value.fonts.length > MAX_PDF_EDITOR_ASSETS
    || !Array.isArray(value.images) || value.images.length > MAX_PDF_EDITOR_ASSETS) return null;
  let totalBytes = 0;
  const assetIds = new Set<string>();
  const parseAsset = <MimeType extends string>(
    asset: unknown,
    mimeTypes: readonly MimeType[],
  ): (PersistedPdfEditorAsset & { mimeType: MimeType }) | null => {
    if (!isRecord(asset)
      || !isBoundedString(asset.id, MAX_PDF_EDITOR_ID_LENGTH, 1)
      || assetIds.has(asset.id)
      || !isBoundedString(asset.name, MAX_PDF_EDITOR_NAME_LENGTH, 1)
      || typeof asset.mimeType !== "string" || !mimeTypes.includes(asset.mimeType as MimeType)
      || typeof asset.data !== "string") return null;
    const byteLength = base64ByteLength(asset.data);
    if (byteLength === null || byteLength <= 0 || byteLength > MAX_PDF_EDITOR_ASSET_BYTES) return null;
    totalBytes += byteLength;
    if (totalBytes > MAX_PDF_EDITOR_ASSET_TOTAL_BYTES) return null;
    assetIds.add(asset.id);
    return {
      id: asset.id,
      name: asset.name,
      mimeType: asset.mimeType as MimeType,
      data: asset.data,
    };
  };

  const fonts = value.fonts.map((asset) => parseAsset(asset, ["font/ttf", "font/otf"] as const));
  if (fonts.some((asset) => asset === null)) return null;
  const images = value.images.map((asset) => parseAsset(asset, ["image/png", "image/jpeg"] as const));
  if (images.some((asset) => asset === null)) return null;
  return {
    fonts: fonts as PdfEditorManifest["assets"]["fonts"],
    images: images as PdfEditorManifest["assets"]["images"],
  };
}

function parsePageOrder(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PDF_EDITOR_PAGES) return null;
  if (!value.every((page) => isSafeIntegerBetween(page, 1, MAX_PDF_EDITOR_PAGES))) return null;
  // A source page may intentionally appear more than once when the user duplicates a page.
  return [...value];
}

function parsePageRotations(value: unknown, logicalPageCount: number): Record<number, number> | null {
  if (!isRecord(value) || Object.keys(value).length > logicalPageCount) return null;
  const rotations: Record<number, number> = {};
  for (const [key, rotation] of Object.entries(value)) {
    if (!/^[1-9]\d*$/.test(key)) return null;
    const page = Number(key);
    if (!isSafeIntegerBetween(page, 1, logicalPageCount)
      || (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270)) return null;
    rotations[page] = rotation;
  }
  return rotations;
}

function parseFormValues(value: unknown): Record<string, PdfFormValue> | null {
  if (!isRecord(value) || Object.keys(value).length > MAX_PDF_EDITOR_FORM_FIELDS) return null;
  const formValues: Array<[string, PdfFormValue]> = [];
  for (const [name, formValue] of Object.entries(value)) {
    if (!isBoundedString(name, MAX_PDF_EDITOR_NAME_LENGTH, 1)) return null;
    if (typeof formValue === "boolean") {
      formValues.push([name, formValue]);
    } else if (isBoundedString(formValue, MAX_PDF_EDITOR_TEXT_LENGTH)) {
      formValues.push([name, formValue]);
    } else if (Array.isArray(formValue)
      && formValue.length <= 1_000
      && formValue.every((item) => isBoundedString(item, MAX_PDF_EDITOR_TEXT_LENGTH))) {
      formValues.push([name, [...formValue]]);
    } else {
      return null;
    }
  }
  return Object.fromEntries(formValues);
}

function parseOverlayBase(value: Record<string, unknown>, logicalPageCount: number): PdfOverlayBase | null {
  if (!isBoundedString(value.id, MAX_PDF_EDITOR_ID_LENGTH, 1)
    || !isSafeIntegerBetween(value.page, 1, logicalPageCount)
    || !isFiniteBetween(value.x, 0, 1)
    || !isFiniteBetween(value.y, 0, 1)
    || !isFiniteBetween(value.width, Number.EPSILON, 1)
    || !isFiniteBetween(value.height, Number.EPSILON, 1)
    || value.x + value.width > 1.000001
    || value.y + value.height > 1.000001
    || !isFiniteBetween(value.rotation, 0, 359.999999)) return null;
  return {
    id: value.id,
    page: value.page,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    rotation: value.rotation,
  };
}

function parseOverlay(value: unknown, logicalPageCount: number): PdfOverlay | null {
  if (!isRecord(value)) return null;
  const base = parseOverlayBase(value, logicalPageCount);
  if (!base) return null;

  if (value.kind === "text") {
    if (!isBoundedString(value.text, MAX_PDF_EDITOR_TEXT_LENGTH)
      || !isBoundedString(value.fontId, MAX_PDF_EDITOR_ID_LENGTH, 1)
      || !isFiniteBetween(value.fontSize, 1, 1_000)
      || !isColor(value.color)
      || (value.alignment !== "left" && value.alignment !== "center" && value.alignment !== "right")
      || (value.fontWeight !== 400 && value.fontWeight !== 700)
      || (value.fontStyle !== "normal" && value.fontStyle !== "italic")
      || !isFiniteBetween(value.opacity, 0, 1)
      || !isFiniteBetween(value.lineHeight, 0.1, 10)
      || !isFiniteBetween(value.letterSpacing, -100, 100)
      || (value.direction !== "ltr" && value.direction !== "rtl")
      || (value.sourceFontName !== undefined
        && !isBoundedString(value.sourceFontName, MAX_PDF_EDITOR_NAME_LENGTH, 1))) return null;
    return {
      ...base,
      kind: "text",
      text: value.text,
      fontId: value.fontId,
      fontSize: value.fontSize,
      color: value.color,
      alignment: value.alignment,
      fontWeight: value.fontWeight,
      fontStyle: value.fontStyle,
      opacity: value.opacity,
      lineHeight: value.lineHeight,
      letterSpacing: value.letterSpacing,
      direction: value.direction,
      ...(value.sourceFontName ? { sourceFontName: value.sourceFontName } : {}),
    };
  }

  if (value.kind === "cover") {
    if (!isColor(value.color)) return null;
    return { ...base, kind: "cover", color: value.color };
  }

  if (value.kind === "image") {
    if (!isBoundedString(value.imageId, MAX_PDF_EDITOR_ID_LENGTH, 1)
      || !isFiniteBetween(value.opacity, 0, 1)) return null;
    return { ...base, kind: "image", imageId: value.imageId, opacity: value.opacity };
  }

  if (value.kind === "shape") {
    if ((value.shape !== "highlight" && value.shape !== "rectangle"
        && value.shape !== "ellipse" && value.shape !== "line")
      || !isColor(value.fillColor)
      || !isColor(value.strokeColor)
      || !isFiniteBetween(value.strokeWidth, 0, 100)
      || !isFiniteBetween(value.opacity, 0, 1)) return null;
    return {
      ...base,
      kind: "shape",
      shape: value.shape,
      fillColor: value.fillColor,
      strokeColor: value.strokeColor,
      strokeWidth: value.strokeWidth,
      opacity: value.opacity,
    };
  }

  if (value.kind === "ink") {
    if (!Array.isArray(value.points)
      || value.points.length < 2 || value.points.length > MAX_PDF_EDITOR_INK_POINTS
      || !value.points.every((point) => isRecord(point)
        && isFiniteBetween(point.x, 0, 1)
        && isFiniteBetween(point.y, 0, 1))
      || !isColor(value.color)
      || !isFiniteBetween(value.strokeWidth, Number.EPSILON, 100)
      || !isFiniteBetween(value.opacity, 0, 1)) return null;
    return {
      ...base,
      kind: "ink",
      points: value.points.map((point) => ({
        x: (point as Record<string, number>).x,
        y: (point as Record<string, number>).y,
      })),
      color: value.color,
      strokeWidth: value.strokeWidth,
      opacity: value.opacity,
    };
  }

  return null;
}

function parseOverlays(value: unknown, logicalPageCount: number): PdfOverlay[] | null {
  if (!Array.isArray(value) || value.length > MAX_PDF_EDITOR_OVERLAYS) return null;
  const overlays: PdfOverlay[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const overlay = parseOverlay(candidate, logicalPageCount);
    if (!overlay || ids.has(overlay.id)) return null;
    ids.add(overlay.id);
    overlays.push(overlay);
  }
  return overlays;
}

function hasCompleteAssetReferences(
  schemaVersion: 1 | 2,
  overlays: PdfOverlay[],
  assets: PdfEditorManifest["assets"],
): boolean {
  const referencedImageIds = new Set(overlays.flatMap((overlay) => (
    overlay.kind === "image" ? [overlay.imageId] : []
  )));
  const referencedFontIds = new Set(overlays.flatMap((overlay) => (
    overlay.kind === "text" ? [overlay.fontId] : []
  )));
  const customFontIds = new Set([...referencedFontIds].filter((id) => id.startsWith("custom-")));
  const imageAssetIds = new Set(assets.images.map((asset) => asset.id));
  const fontAssetIds = new Set(assets.fonts.map((asset) => asset.id));

  if (schemaVersion === 1 && (referencedImageIds.size > 0 || customFontIds.size > 0)) return false;
  return [...referencedImageIds].every((id) => imageAssetIds.has(id))
    && [...imageAssetIds].every((id) => referencedImageIds.has(id))
    && [...customFontIds].every((id) => fontAssetIds.has(id))
    && [...fontAssetIds].every((id) => referencedFontIds.has(id));
}

export function parsePdfEditorManifest(value: Record<string, unknown>): PdfEditorManifest | null {
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) return null;
  const pageOrder = parsePageOrder(value.pageOrder);
  if (!pageOrder) return null;
  const overlays = parseOverlays(value.overlays, pageOrder.length);
  const pageRotations = parsePageRotations(value.pageRotations, pageOrder.length);
  const formValues = parseFormValues(value.formValues);
  if (!overlays || !pageRotations || !formValues
    || (value.exportMode !== "standard" && value.exportMode !== "secure")) return null;
  const assets = value.schemaVersion === 1
    ? { fonts: [], images: [] }
    : parseAssets(value.assets);
  if (!assets || !hasCompleteAssetReferences(value.schemaVersion, overlays, assets)) return null;
  return {
    schemaVersion: 2,
    overlays,
    pageOrder,
    pageRotations,
    formValues,
    exportMode: value.exportMode,
    assets,
  };
}

export function decodePdfEditorAssets(manifest: PdfEditorManifest): DecodedPdfEditorAssets {
  return {
    fonts: manifest.assets.fonts.map(({ data, ...font }) => ({ ...font, bytes: base64ToBytes(data) })),
    images: manifest.assets.images.map(({ data, ...image }) => ({ ...image, bytes: base64ToBytes(data) })),
  };
}
