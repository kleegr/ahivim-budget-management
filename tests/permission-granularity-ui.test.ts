import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const accessEditor = readFileSync("src/components/settings/user-access-admin.tsx", "utf8");
const documentLibrary = readFileSync("src/components/documents/document-library.tsx", "utf8");
const documentViewer = readFileSync("src/components/documents/document-viewer-workspace.tsx", "utf8");
const employeePage = readFileSync("src/app/(app)/employees/[id]/page.tsx", "utf8");
const transactionsGrid = readFileSync("src/components/transactions/transactions-grid.tsx", "utf8");

describe("permission granularity UI", () => {
  it("offers independent gross/net, Planning read/manage, and document read/edit controls", () => {
    expect(accessEditor).toContain("Can view Planning");
    expect(accessEditor).toContain("Can manage Planning");
    expect(accessEditor).toContain("Can view documents");
    expect(accessEditor).toContain("Can edit PDF documents");
    expect(accessEditor).toContain('key: "canSeeCheckGross", label: "Check gross"');
    expect(accessEditor).toContain('key: "canSeeCheckNet", label: "Check net"');
    expect(accessEditor).toContain("payroll withholding and deduction details");
    expect(accessEditor).not.toContain("gross, net and payroll withholding details");
  });

  it("keeps the document library useful and truthful for a read-only account", () => {
    expect(documentLibrary).toContain("DocumentLibrary({ canEdit }");
    expect(documentLibrary).toContain("View saved PDFs, download copies, and browse recoverable history.");
    expect(documentLibrary).toContain("View only");
    expect(documentLibrary).toContain("canEdit && status === \"active\"");
    expect(documentViewer).toContain("This account cannot restore or change them.");
    expect(documentViewer).toContain("Download");
    expect(documentViewer).toContain("<iframe");
  });

  it("shows Planning data without exposing write controls and gates check gross on its own flag", () => {
    expect(employeePage).toContain("canManage={canManagePlanningProfile}");
    expect(employeePage).toContain("canSeeCheckGross ? <Th numeric>Actual gross</Th>");
    expect(transactionsGrid).toContain('if (column.key === "verifiedCheckGross") return fields.canSeeCheckGross;');
    expect(transactionsGrid).toContain("visibility.canSeeCheckGross ? line(\"Verified check gross\"");
  });
});
