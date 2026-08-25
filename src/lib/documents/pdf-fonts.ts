import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StandardFonts, type PDFDocument, type PDFFont } from "pdf-lib";

export interface DocumentFonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

let fontBytesPromise: Promise<Uint8Array> | null = null;

function documentFontBytes(): Promise<Uint8Array> {
  if (!fontBytesPromise) {
    const directory = join(process.cwd(), "assets", "fonts");
    fontBytesPromise = readFile(join(directory, "NotoSansHebrew-Regular.ttf"));
  }
  return fontBytesPromise;
}

/** Use fast base fonts unless dynamic text needs the bundled Unicode font. */
export async function embedDocumentFonts(
  document: PDFDocument,
  dynamicText: Iterable<unknown> = [],
): Promise<DocumentFonts> {
  const needsUnicode = [...dynamicText].some((value) => (
    typeof value === "string" && /[^\u0020-\u007e]/.test(value)
  ));
  if (!needsUnicode) {
    const [regular, bold, italic] = await Promise.all([
      document.embedFont(StandardFonts.Helvetica),
      document.embedFont(StandardFonts.HelveticaBold),
      document.embedFont(StandardFonts.HelveticaOblique),
    ]);
    return { regular, bold, italic };
  }
  document.registerFontkit(fontkit);
  const regular = await document.embedFont(await documentFontBytes(), { subset: true });
  return { regular, bold: regular, italic: regular };
}

export function cleanPdfText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
}

/** Shrink dynamic text, then ellipsize it if even the minimum size cannot fit. */
export function fitPdfText(
  value: string,
  font: PDFFont,
  startSize: number,
  width: number,
  minimumSize = 4.5,
): { text: string; size: number } {
  let size = startSize;
  while (size > minimumSize && font.widthOfTextAtSize(value, size) > width) size -= 0.25;
  if (font.widthOfTextAtSize(value, size) <= width) return { text: value, size };

  const suffix = "...";
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${value.slice(0, middle).trimEnd()}${suffix}`;
    if (font.widthOfTextAtSize(candidate, size) <= width) low = middle;
    else high = middle - 1;
  }
  return { text: `${value.slice(0, low).trimEnd()}${suffix}`, size };
}
