import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCsv, type ExportTable } from "@/lib/export/tabular";

describe("tabular CSV export safety", () => {
  it("keeps formula-like text literal while preserving typed negative numbers", () => {
    const table: ExportTable = {
      columns: [
        { key: "name", header: "Name", type: "text" },
        { key: "amount", header: "Amount", type: "money" },
      ],
      rows: [
        { name: "=2+3", amount: "-12.5" },
        { name: "+cmd", amount: "1" },
        { name: "-reference", amount: "2" },
        { name: "@SUM(A1:A2)", amount: "3" },
        { name: "\t=1+1", amount: "4" },
        { name: "\r=1+1", amount: "5" },
        { name: "\n=1+1", amount: "6" },
      ],
    };

    const csv = buildCsv([table]);
    expect(csv).toContain("'=2+3,-12.50");
    expect(csv).toContain("'+cmd,1.00");
    expect(csv).toContain("'-reference,2.00");
    expect(csv).toContain("'@SUM(A1:A2),3.00");
    expect(csv).toContain("'\t=1+1,4.00");
    expect(csv).toContain("\"'\r=1+1\",5.00");
    expect(csv).toContain("\"'\n=1+1\",6.00");
  });

  it("uses the shared text safeguard in every CSV exporter", () => {
    const reportRoute = readFileSync("src/app/api/reports/[report]/export/route.ts", "utf8");
    const portalStatement = readFileSync("src/lib/export/portal-individual-statement.ts", "utf8");

    expect(reportRoute).toContain('import { safeSpreadsheetText } from "@/lib/export/tabular"');
    expect(reportRoute).toContain('c.type === "text" ? safeSpreadsheetText(value) : value');
    expect(portalStatement).toContain('import { safeSpreadsheetText } from "@/lib/export/tabular"');
    expect(portalStatement).toContain("const safe = safeSpreadsheetText(value)");
  });
});
