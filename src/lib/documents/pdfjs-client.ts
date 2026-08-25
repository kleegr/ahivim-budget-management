import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

let pdfJsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

export interface PdfSourceTextItem {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

export function loadPdfJs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfJsPromise) {
    pdfJsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return pdfjs;
    });
  }
  return pdfJsPromise;
}

export async function inspectPdfPageText(
  document: PDFDocumentProxy,
  pageNumber: number,
  rotation = 0,
): Promise<PdfSourceTextItem[]> {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation + 360) % 360 });
  const content = await page.getTextContent();

  return content.items.flatMap((item, index) => {
    if (!("str" in item) || !item.str.trim()) return [];
    const [viewportX, baselineY] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const fontHeight = Math.max(6, Math.hypot(item.transform[2], item.transform[3]));
    const width = Math.max(fontHeight, item.width);
    return [{
      id: `${pageNumber}-${index}`,
      text: item.str,
      x: Math.max(0, Math.min(0.98, viewportX / viewport.width)),
      y: Math.max(0, Math.min(0.98, (baselineY - fontHeight) / viewport.height)),
      width: Math.max(0.04, Math.min(0.9, width / viewport.width)),
      height: Math.max(0.025, Math.min(0.2, (fontHeight * 1.3) / viewport.height)),
      fontSize: Math.max(6, Math.min(72, Math.round(fontHeight))),
    }];
  });
}
