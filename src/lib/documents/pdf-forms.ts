import {
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFStream,
  PDFString,
  PDFTextField,
  StandardFonts,
  type PDFFont,
  type PDFField,
  type PDFForm,
  type PDFPage,
  type PDFRef,
  type PDFWidgetAnnotation,
} from "pdf-lib";

export type PdfFormFieldKind =
  | "text"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "listbox"
  | "signature"
  | "button"
  | "unsupported";

export type PdfFormValue = string | string[] | boolean;

export interface PdfFormRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfFormWidgetDescriptor {
  page: number | null;
  rectangle: PdfFormRectangle;
  pageBox: PdfFormRectangle | null;
  pageRotation: number;
}

export interface PdfFormAppearanceDescriptor {
  fontName: string | null;
  fontResourceName: string | null;
  editStrategy: "standard-font" | "helvetica-fallback" | "not-applicable";
}

export interface PdfFormFieldDescriptor {
  name: string;
  kind: PdfFormFieldKind;
  value: PdfFormValue;
  options: string[];
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  multiselect: boolean;
  maxLength: number | null;
  widgets: PdfFormWidgetDescriptor[];
  appearance: PdfFormAppearanceDescriptor;
}

export interface ApplyPdfFormValuesOptions {
  /** Flatten paints field appearances and removes their interactive widgets. */
  flatten?: boolean;
}

const TEXT_FONT_PATTERN = /\/([^\0\t\n\f\r ]+)[\0\t\n\f\r ]+(?:\d*\.\d+|\d+)[\0\t\n\f\r ]+Tf/g;
const STANDARD_FONT_NAMES = new Map<string, StandardFonts>(
  Object.values(StandardFonts).map((font) => [font, font]),
);

function sameReference(left: PDFRef | undefined, right: PDFRef): boolean {
  return left === right || left?.toString() === right.toString();
}

function pageForWidget(document: PDFDocument, widget: PDFWidgetAnnotation): PDFPage | null {
  const pages = document.getPages();
  const pageRef = widget.P();
  if (pageRef) {
    const directPage = pages.find((page) => sameReference(pageRef, page.ref));
    if (directPage) return directPage;
  }

  const widgetRef = document.context.getObjectRef(widget.dict);
  if (!widgetRef) return null;
  return pages.find((page) => page.node.Annots()?.asArray().some((annotation) => (
    annotation === widgetRef || annotation.toString() === widgetRef.toString()
  ))) ?? null;
}

function describeWidgets(document: PDFDocument, field: PDFField): PdfFormWidgetDescriptor[] {
  const pages = document.getPages();
  return field.acroField.getWidgets().map((widget) => {
    const page = pageForWidget(document, widget);
    return {
      page: page ? pages.indexOf(page) + 1 : null,
      rectangle: widget.getRectangle(),
      pageBox: page?.getCropBox() ?? null,
      pageRotation: page?.getRotation().angle ?? 0,
    };
  });
}

function decodedString(value: PDFString | PDFHexString | undefined): string | undefined {
  if (value instanceof PDFHexString) return value.decodeText();
  return value?.asString();
}

function lastFontResourceName(defaultAppearance: string | undefined): string | null {
  if (!defaultAppearance) return null;
  let lastMatch: RegExpExecArray | null = null;
  TEXT_FONT_PATTERN.lastIndex = 0;
  for (let match = TEXT_FONT_PATTERN.exec(defaultAppearance); match; match = TEXT_FONT_PATTERN.exec(defaultAppearance)) {
    lastMatch = match;
  }
  return lastMatch?.[1] ?? null;
}

function resourceDictionaries(form: PDFForm, field: PDFField): PDFDict[] {
  const dictionaries: PDFDict[] = [];
  for (const widget of field.acroField.getWidgets()) {
    const normal = widget.getAppearances()?.normal;
    if (normal instanceof PDFStream) {
      const resources = normal.dict.lookupMaybe(PDFName.Resources, PDFDict);
      if (resources) dictionaries.push(resources);
    }
    const widgetResources = widget.dict.lookupMaybe(PDFName.Resources, PDFDict);
    if (widgetResources) dictionaries.push(widgetResources);
  }

  const fieldResources = field.acroField.dict.lookupMaybe(PDFName.of("DR"), PDFDict);
  if (fieldResources) dictionaries.push(fieldResources);
  const formResources = form.acroForm.dict.lookupMaybe(PDFName.of("DR"), PDFDict);
  if (formResources) dictionaries.push(formResources);
  return dictionaries;
}

function baseFontName(resources: PDFDict[], resourceName: string | null): string | null {
  for (const resourceDictionary of resources) {
    const fonts = resourceDictionary.lookupMaybe(PDFName.Font, PDFDict);
    if (!fonts) continue;
    const fontKeys = resourceName ? [PDFName.of(resourceName)] : fonts.keys();
    if (!resourceName && fontKeys.length !== 1) continue;
    for (const fontKey of fontKeys) {
      const font = fonts.lookupMaybe(fontKey, PDFDict);
      const baseFont = font?.lookupMaybe(PDFName.of("BaseFont"), PDFName);
      if (baseFont) return baseFont.decodeText();
    }
  }
  return null;
}

function fieldDefaultAppearance(form: PDFForm, field: PDFField): string | undefined {
  const widgetAppearance = field.acroField.getWidgets()
    .map((widget) => widget.getDefaultAppearance())
    .find(Boolean);
  if (widgetAppearance) return widgetAppearance;
  const fieldAppearance = field.acroField.getDefaultAppearance();
  if (fieldAppearance) return fieldAppearance;
  return decodedString(form.acroForm.dict.lookupMaybe(
    PDFName.of("DA"),
    PDFString,
    PDFHexString,
  ));
}

function usesTextAppearance(field: PDFField): field is PDFTextField | PDFDropdown | PDFOptionList {
  return field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList;
}

function describeAppearance(form: PDFForm, field: PDFField): PdfFormAppearanceDescriptor {
  if (!usesTextAppearance(field)) {
    return { fontName: null, fontResourceName: null, editStrategy: "not-applicable" };
  }
  const fontResourceName = lastFontResourceName(fieldDefaultAppearance(form, field));
  const fontName = baseFontName(resourceDictionaries(form, field), fontResourceName)
    ?? fontResourceName;
  return {
    fontName,
    fontResourceName,
    editStrategy: fontName && STANDARD_FONT_NAMES.has(fontName)
      ? "standard-font"
      : "helvetica-fallback",
  };
}

function describeField(
  document: PDFDocument,
  form: PDFForm,
  field: PDFField,
): PdfFormFieldDescriptor {
  const base = {
    name: field.getName(),
    readOnly: field.isReadOnly(),
    required: field.isRequired(),
    options: [] as string[],
    multiline: false,
    multiselect: false,
    maxLength: null as number | null,
    widgets: describeWidgets(document, field),
    appearance: describeAppearance(form, field),
  };

  if (field instanceof PDFTextField) {
    return {
      ...base,
      kind: "text",
      value: field.getText() ?? "",
      multiline: field.isMultiline(),
      maxLength: field.getMaxLength() ?? null,
    };
  }
  if (field instanceof PDFCheckBox) {
    return { ...base, kind: "checkbox", value: field.isChecked() };
  }
  if (field instanceof PDFRadioGroup) {
    return {
      ...base,
      kind: "radio",
      value: field.getSelected() ?? "",
      options: field.getOptions(),
    };
  }
  if (field instanceof PDFDropdown) {
    return {
      ...base,
      kind: "dropdown",
      value: field.getSelected(),
      options: field.getOptions(),
      multiselect: field.isMultiselect(),
    };
  }
  if (field instanceof PDFOptionList) {
    return {
      ...base,
      kind: "listbox",
      value: field.getSelected(),
      options: field.getOptions(),
      multiselect: field.isMultiselect(),
    };
  }
  if (field instanceof PDFSignature) {
    return { ...base, kind: "signature", value: "" };
  }
  if (field instanceof PDFButton) {
    return { ...base, kind: "button", value: "" };
  }
  return { ...base, kind: "unsupported", value: "" };
}

/** Reads the canonical AcroForm field tree without mutating the source bytes. */
export async function inspectPdfForm(source: Uint8Array): Promise<PdfFormFieldDescriptor[]> {
  const document = await PDFDocument.load(source.slice(), { updateMetadata: false });
  const form = document.getForm();
  return form.getFields().map((field) => describeField(document, form, field));
}

function normalizeSelection(value: PdfFormValue): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value ? [value] : [];
  return [];
}

function currentFieldValue(field: PDFField): PdfFormValue | undefined {
  if (field instanceof PDFTextField) return field.getText() ?? "";
  if (field instanceof PDFCheckBox) return field.isChecked();
  if (field instanceof PDFRadioGroup) return field.getSelected() ?? "";
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return field.getSelected();
  return undefined;
}

function formValueEqual(left: PdfFormValue | undefined, right: PdfFormValue | undefined): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    const leftItems = Array.isArray(left) ? left : [];
    const rightItems = Array.isArray(right) ? right : [];
    return leftItems.length === rightItems.length
      && leftItems.every((value, index) => value === rightItems[index]);
  }
  return left === right;
}

function hasCompleteWidgetAppearances(field: PDFField): boolean {
  const widgets = field.acroField.getWidgets();
  return widgets.length > 0 && widgets.every((widget) => Boolean(widget.getAppearances()?.normal));
}

async function appearanceFont(
  document: PDFDocument,
  appearance: PdfFormAppearanceDescriptor,
  cache: Map<StandardFonts, PDFFont>,
): Promise<PDFFont> {
  const standardFont = appearance.fontName
    ? STANDARD_FONT_NAMES.get(appearance.fontName)
    : undefined;
  const fontName = standardFont ?? StandardFonts.Helvetica;
  const cached = cache.get(fontName);
  if (cached) return cached;
  const font = await document.embedFont(fontName);
  cache.set(fontName, font);
  return font;
}

/**
 * Writes only changed AcroForm values. Untouched appearance streams stay byte
 * for byte intact. Changed textual fields reuse their exact Base-14 font when
 * it can be resolved; other embedded fonts use the documented Helvetica
 * fallback because pdf-lib cannot reliably reuse an arbitrary subset font.
 */
export async function applyPdfFormValues(
  source: Uint8Array,
  values: Record<string, PdfFormValue>,
  options: ApplyPdfFormValuesOptions = {},
): Promise<Uint8Array> {
  const document = await PDFDocument.load(source.slice(), { updateMetadata: false });
  const form = document.getForm();
  const fields = new Map(form.getFields().map((field) => [field.getName(), field]));
  const fontCache = new Map<StandardFonts, PDFFont>();

  for (const [name, value] of Object.entries(values)) {
    const field = fields.get(name);
    if (!field || field.isReadOnly() || formValueEqual(currentFieldValue(field), value)) continue;
    const originalAppearance = describeAppearance(form, field);

    if (field instanceof PDFTextField) {
      if (typeof value !== "string") continue;
      field.setText(value);
      field.updateAppearances(await appearanceFont(document, originalAppearance, fontCache));
    } else if (field instanceof PDFCheckBox) {
      if (value === true) field.check();
      else if (value === false) field.uncheck();
      else continue;
      if (hasCompleteWidgetAppearances(field)) form.markFieldAsClean(field.ref);
      else field.updateAppearances();
    } else if (field instanceof PDFRadioGroup) {
      if (typeof value !== "string") continue;
      if (value) field.select(value);
      else field.clear();
      if (hasCompleteWidgetAppearances(field)) form.markFieldAsClean(field.ref);
      else field.updateAppearances();
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      const selection = normalizeSelection(value);
      if (selection.length > 0) field.select(field.isMultiselect() ? selection : selection[0]!);
      else field.clear();
      field.updateAppearances(await appearanceFont(document, originalAppearance, fontCache));
    }
  }

  if (options.flatten) form.flatten({ updateFieldAppearances: false });
  return document.save({ updateFieldAppearances: false });
}

export function pdfFormValues(fields: PdfFormFieldDescriptor[]): Record<string, PdfFormValue> {
  return Object.fromEntries(fields.map((field) => [field.name, field.value]));
}

export function pdfFormValuesEqual(
  left: Record<string, PdfFormValue>,
  right: Record<string, PdfFormValue>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!formValueEqual(left[key], right[key])) return false;
  }
  return true;
}
