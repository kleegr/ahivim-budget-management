import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("shared actionable feedback", () => {
  const uiSource = readFileSync("src/components/ui.tsx", "utf8");
  const clientSource = readFileSync("src/components/ui-client.tsx", "utf8");

  it("passes load errors through the plain-language guard", () => {
    expect(uiSource).toContain('friendlyActionError(children, "This page could not load. Try again.")');
  });

  it("offers retry by default while allowing a specific recovery action", () => {
    expect(uiSource).toContain("action={action ?? <ReloadButton />}");
    expect(clientSource).toContain("window.location.reload()");
    expect(clientSource).toContain('label = "Try again"');
  });
});

describe("shared action controls", () => {
  const manageSource = readFileSync("src/components/manage/client.tsx", "utf8");
  const styles = readFileSync("src/app/globals.css", "utf8");
  const budgetSource = readFileSync("src/components/individuals/program-budget-workspace.tsx", "utf8");
  const calendarSource = readFileSync("src/components/schedule/calendar.tsx", "utf8");
  const calculationsSource = readFileSync("src/components/calculations/calculations-grid.tsx", "utf8");

  it("uses the app button system for create and write actions", () => {
    expect(manageSource).toContain('className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""}`}');
    expect(manageSource).toContain("aria-busy={busy}");
  });

  it("gives buttons visible pressed feedback without replacing positioned transforms", () => {
    expect(styles).toContain(":where(button:not(:disabled), a[href], [role=\"button\"]):active");
    expect(styles).not.toContain("transform: translateY(0.5px)");
  });

  it("links an empty program catalog to the exact setup section", () => {
    expect(budgetSource).toContain('href="/settings#programs"');
    expect(budgetSource).toContain("Add a program first");
  });

  it("makes schedule load failures and warning counts actionable", () => {
    expect(calendarSource).toContain('onClick={() => void load()}');
    expect(calendarSource).toContain("setSummaryRetryKey((value) => value + 1)");
    expect(calendarSource).toContain("Open the first session that needs review");
  });

  it("lets a user retry calculation details and reports failed rate saves", () => {
    expect(calculationsSource).toContain("failedRate ? void saveRate(failedRate.programId, failedRate.value) : void load()");
    expect(calculationsSource).toContain('failedRate ? "Retry save" : "Try again"');
    expect(calculationsSource).toContain("Could not save this rate. Try again.");
    expect(calculationsSource).toContain("This rate was not saved.");
  });
});
