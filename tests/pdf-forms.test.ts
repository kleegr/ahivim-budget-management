import { describe, expect, it } from "vitest";
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFStream,
  StandardFonts,
} from "pdf-lib";
import {
  applyPdfFormValues,
  inspectPdfForm,
  pdfFormValues,
  pdfFormValuesEqual,
} from "@/lib/documents/pdf-forms";
import { pdfFormWidgetCanvasRectangle } from "@/lib/documents/pdf-form-geometry";

function normalAppearance(document: PDFDocument, fieldName: string): PDFStream {
  const normal = document.getForm().getField(fieldName).acroField.getWidgets()[0]?.getAppearances()?.normal;
  if (!(normal instanceof PDFStream)) throw new Error(`Missing appearance stream for ${fieldName}`);
  return normal;
}

function appearanceBaseFont(document: PDFDocument, fieldName: string): string | null {
  const appearance = normalAppearance(document, fieldName);
  const resources = appearance.dict.lookupMaybe(PDFName.Resources, PDFDict);
  const fonts = resources?.lookupMaybe(PDFName.Font, PDFDict);
  const fontKey = fonts?.keys()[0];
  if (!fonts || !fontKey) return null;
  const font = fonts.lookupMaybe(fontKey, PDFDict);
  return font?.lookupMaybe(PDFName.of("BaseFont"), PDFName)?.decodeText() ?? null;
}

async function createFormPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const secondPage = document.addPage([612, 792]);
  const form = document.getForm();
  const times = await document.embedFont(StandardFonts.TimesRoman);
  const courier = await document.embedFont(StandardFonts.Courier);

  const name = form.createTextField("contact.name");
  name.setText("Original name");
  name.addToPage(page, { x: 40, y: 700, width: 220, height: 24, font: times });
  name.updateAppearances(times);

  const locked = form.createTextField("reference.locked");
  locked.setText("KEEP");
  locked.addToPage(secondPage, { x: 300, y: 700, width: 120, height: 24, font: courier });
  locked.updateAppearances(courier);
  locked.enableReadOnly();

  const unchanged = form.createTextField("contact.unchanged");
  unchanged.setText("Leave alone");
  unchanged.addToPage(secondPage, { x: 40, y: 650, width: 220, height: 24, font: courier });
  unchanged.updateAppearances(courier);

  const approved = form.createCheckBox("approved");
  approved.check();
  approved.addToPage(page, { x: 40, y: 650, width: 18, height: 18 });

  const delivery = form.createRadioGroup("delivery");
  delivery.addOptionToPage("Email", page, { x: 40, y: 610, width: 18, height: 18 });
  delivery.addOptionToPage("Mail", page, { x: 100, y: 610, width: 18, height: 18 });
  delivery.select("Email");

  const department = form.createDropdown("department");
  department.addOptions(["Classes", "Finance"]);
  department.select("Classes");
  department.addToPage(page, { x: 40, y: 560, width: 180, height: 24 });

  const services = form.createOptionList("services");
  services.addOptions(["Art", "Exercise", "Music"]);
  services.enableMultiselect();
  services.select(["Art", "Music"]);
  services.addToPage(page, { x: 40, y: 450, width: 180, height: 80 });

  return document.save();
}

describe("PDF AcroForm editing", () => {
  it("discovers canonical field types, options, values, and access flags", async () => {
    const fields = await inspectPdfForm(await createFormPdf());

    expect(fields.map((field) => field.kind)).toEqual([
      "text",
      "text",
      "text",
      "checkbox",
      "radio",
      "dropdown",
      "listbox",
    ]);
    expect(fields.find((field) => field.name === "contact.name")).toMatchObject({
      value: "Original name",
      readOnly: false,
      appearance: {
        fontName: "Times-Roman",
        editStrategy: "standard-font",
      },
    });
    expect(fields.find((field) => field.name === "reference.locked")).toMatchObject({
      value: "KEEP",
      readOnly: true,
    });
    const nameWidget = fields.find((field) => field.name === "contact.name")?.widgets[0];
    const lockedWidget = fields.find((field) => field.name === "reference.locked")?.widgets[0];
    expect(nameWidget).toMatchObject({
      page: 1,
      pageBox: { x: 0, y: 0, width: 612, height: 792 },
    });
    expect(nameWidget?.rectangle.x).toBeCloseTo(39.5);
    expect(nameWidget?.rectangle.y).toBeCloseTo(699.5);
    expect(lockedWidget?.page).toBe(2);
    const canvasRectangle = nameWidget ? pdfFormWidgetCanvasRectangle(nameWidget) : null;
    expect(canvasRectangle?.x).toBeCloseTo(39.5 / 612);
    expect(canvasRectangle?.y).toBeCloseTo(1 - (699.5 + 25) / 792);
    expect(fields.find((field) => field.name === "delivery")).toMatchObject({
      value: "Email",
      options: ["Email", "Mail"],
    });
    expect(fields.find((field) => field.name === "services")).toMatchObject({
      value: ["Art", "Music"],
      multiselect: true,
    });
  });

  it("updates real fields while preserving interactivity and the source buffer", async () => {
    const source = await createFormPdf();
    const snapshot = source.slice();
    const originalDocument = await PDFDocument.load(source);
    const untouchedAppearance = normalAppearance(originalDocument, "contact.unchanged").getContents().slice();
    const output = await applyPdfFormValues(source, {
      "contact.name": "Updated name",
      "contact.unchanged": "Leave alone",
      "reference.locked": "CHANGED",
      approved: false,
      delivery: "Mail",
      department: ["Finance"],
      services: ["Exercise", "Music"],
    });

    expect(source).toEqual(snapshot);
    const written = await PDFDocument.load(output);
    const form = written.getForm();
    expect(form.getTextField("contact.name").getText()).toBe("Updated name");
    expect(form.getTextField("reference.locked").getText()).toBe("KEEP");
    expect(form.getCheckBox("approved").isChecked()).toBe(false);
    expect(form.getRadioGroup("delivery").getSelected()).toBe("Mail");
    expect(form.getDropdown("department").getSelected()).toEqual(["Finance"]);
    expect(form.getOptionList("services").getSelected()).toEqual(["Exercise", "Music"]);
    expect(form.getFields()).toHaveLength(7);
    expect(appearanceBaseFont(written, "contact.name")).toBe("Times-Roman");
    expect(appearanceBaseFont(written, "contact.unchanged")).toBe("Courier");
    expect(normalAppearance(written, "contact.unchanged").getContents()).toEqual(untouchedAppearance);
  });

  it("flattens completed fields for sanitized export", async () => {
    const output = await applyPdfFormValues(await createFormPdf(), {
      "contact.name": "Final name",
      approved: false,
    }, { flatten: true });
    const flattened = await PDFDocument.load(output);

    expect(flattened.getForm().getFields()).toEqual([]);
    expect(flattened.getPage(0).node.Contents()).toBeDefined();
  });

  it("compares form snapshots without treating equal arrays as edits", async () => {
    const values = pdfFormValues(await inspectPdfForm(await createFormPdf()));
    expect(pdfFormValuesEqual(values, { ...values, services: ["Art", "Music"] })).toBe(true);
    expect(pdfFormValuesEqual(values, { ...values, services: ["Music"] })).toBe(false);
  });
});
