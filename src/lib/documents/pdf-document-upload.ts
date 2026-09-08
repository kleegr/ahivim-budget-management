import { createPdfEditorManifest, MAX_PDF_EDITOR_PAGES } from "./pdf-editor-persistence";

/** Read actual source pages before reserving an upload or declaring an editor manifest. */
export async function prepareOriginalPdfUpload(bytes: Uint8Array) {
  const { PDFDocument } = await import("pdf-lib");
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const pageCount = document.getPageCount();
  if (pageCount < 1 || pageCount > MAX_PDF_EDITOR_PAGES) {
    throw new Error(`Choose a PDF with between 1 and ${MAX_PDF_EDITOR_PAGES.toLocaleString("en-US")} pages.`);
  }
  const editorState = createPdfEditorManifest({
    overlays: [],
    pageOrder: Array.from({ length: pageCount }, (_, index) => index + 1),
    pageRotations: {},
    formValues: {},
    exportMode: "standard",
  });
  return { pageCount, editorSchemaVersion: editorState.schemaVersion, editorState };
}
