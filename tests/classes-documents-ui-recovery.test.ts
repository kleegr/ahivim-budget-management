import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const classesWorkspace = readFileSync("src/components/classes/classes-workspace.tsx", "utf8");
const documentLibrary = readFileSync("src/components/documents/document-library.tsx", "utf8");

describe("Classes and Documents first-click recovery affordances", () => {
  it("announces and disables invoice issue while the request is running", () => {
    expect(classesWorkspace.match(/aria-busy=\{busyId === current\.id\}/g)).toHaveLength(2);
    expect(classesWorkspace.match(/\? "Issuing\.\.\." : "Issue"/g)).toHaveLength(2);
  });

  it("guards archive and restore from duplicate requests while keeping retry text visible", () => {
    expect(documentLibrary).toContain("if (!canEdit || updatingId !== null) return;");
    expect(documentLibrary).toContain('setUpdatingId(document.id)');
    expect(documentLibrary).toContain('"Archiving..."');
    expect(documentLibrary).toContain('"Restoring..."');
    expect(documentLibrary).toContain('aria-busy={updatingId === document.id}');
  });

  it("offers an explicit load retry and ignores stale filtered results", () => {
    expect(documentLibrary).toContain('setLoadFailed(true)');
    expect(documentLibrary).toContain('loading ? "Retrying..." : "Retry"');
    expect(documentLibrary).toContain("sequence === loadSequenceRef.current");
  });

  it("exposes both responsive action popovers as menus", () => {
    expect(documentLibrary.match(/role="menu"/g)).toHaveLength(2);
    expect(documentLibrary.match(/aria-haspopup="menu"/g)).toHaveLength(2);
    expect(documentLibrary.match(/role="menuitem"/g)).toHaveLength(4);
  });
});
