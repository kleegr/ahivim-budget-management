import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type PdfBrandAsset = "ahivim-cover.png" | "xcellent-staffing.png";

const cache = new Map<PdfBrandAsset, Promise<Uint8Array>>();

/** Load the approved marks captured from the agency's supplied source documents. */
export function loadPdfBrandAsset(name: PdfBrandAsset): Promise<Uint8Array> {
  let bytes = cache.get(name);
  if (!bytes) {
    bytes = readFile(join(process.cwd(), "assets", "branding", name));
    cache.set(name, bytes);
  }
  return bytes;
}
