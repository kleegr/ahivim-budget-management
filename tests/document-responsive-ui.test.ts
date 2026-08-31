import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const library = readFileSync("src/components/documents/document-library.tsx", "utf8");
const editor = readFileSync("src/components/documents/pdf-editor-workspace.tsx", "utf8");

describe("document mobile width containment", () => {
  it("uses a phone-specific document list and keeps the wide table above the phone breakpoint", () => {
    expect(library).toContain("data-document-mobile-list");
    expect(library).toMatch(/<ul className="[^"]*sm:hidden" data-document-mobile-list>/);
    expect(library).toContain("data-document-desktop-table");
    expect(library).toMatch(/hidden max-w-full overflow-x-auto sm:block[^>]*data-document-desktop-table/);
    expect(library).toContain("overflow-x-clip");
    expect(library).toContain("min-h-11 min-w-0 flex-1");
    expect(library).toContain("btn btn-ghost btn-icon h-11 w-11");
  });

  it("contains wide editor tools, the PDF canvas, and thumbnails inside their own scrollers", () => {
    expect(editor).toContain("max-w-full space-y-4 overflow-x-hidden");
    expect(editor.match(/\[contain:inline-size\]/g)).toHaveLength(3);
    expect(editor).toMatch(/aria-label="PDF editing tools"/);
    expect(editor).toContain("overflow-auto overscroll-contain");
    expect(editor).toContain("overflow-x-auto border-b");
  });
});
