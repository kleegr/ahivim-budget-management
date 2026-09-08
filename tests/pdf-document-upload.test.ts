import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { prepareOriginalPdfUpload } from "@/lib/documents/pdf-document-upload";
import { parsePdfEditorManifest } from "@/lib/documents/pdf-editor-persistence";

describe("original PDF library upload state", () => {
  it("records every actual source page in a canonical editable manifest", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]); pdf.addPage([792, 612]);
    const prepared = await prepareOriginalPdfUpload(await pdf.save());
    expect(prepared).toMatchObject({ pageCount: 2, editorSchemaVersion: 2, editorState: { pageOrder: [1, 2], assets: { fonts: [], images: [] } } });
    expect(parsePdfEditorManifest(prepared.editorState as unknown as Record<string, unknown>)).toEqual(prepared.editorState);
  });

  it("rejects unreadable or empty PDFs before creating an upload record", async () => {
    await expect(prepareOriginalPdfUpload(new TextEncoder().encode("not a PDF"))).rejects.toThrow();
    const empty = await PDFDocument.create();
    await expect(prepareOriginalPdfUpload(await empty.save({ addDefaultPage: false }))).rejects.toThrow("between 1 and 10,000 pages");
  });
});
