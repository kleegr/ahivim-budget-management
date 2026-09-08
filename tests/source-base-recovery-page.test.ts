import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as money from "@/lib/money";
import * as navigation from "@/lib/nav/review-actions";

const mocks = { requireUser: vi.fn(), withDb: vi.fn(), counts: vi.fn(), rates: vi.fn(), aliases: vi.fn(),
  imports: vi.fn(), duplicates: vi.fn(), preview: vi.fn(), panel: vi.fn() };
const connection = { query: vi.fn(), connect: vi.fn() };
const nodeRequire = createRequire(import.meta.url);
const loaded = { exports: {} };
const compiled = transformSync(readFileSync("src/app/(app)/exceptions/page.tsx", "utf8"), {
  loader: "tsx", format: "cjs", jsx: "automatic", tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
}).code;
function Container({ children }: { children?: React.ReactNode }) { return React.createElement("div", null, children); }
new Function("require", "module", "exports", compiled)((name: string) => {
  if (name === "next/link") return Container;
  if (name === "@/lib/auth/session") return { requireUser: mocks.requireUser };
  if (name === "@/lib/data/pool") return { withDb: mocks.withDb };
  if (name === "@/lib/data/queries") return { exceptionCounts: mocks.counts };
  if (name === "@/lib/data/app-queries") return {
    ACTIONABLE_IMPORT_WARNING_CATEGORIES: [], listActionableImportWarnings: mocks.imports,
    listCommittedDuplicateWarnings: mocks.duplicates, listPendingAliases: mocks.aliases, listRateExceptions: mocks.rates,
  };
  if (name === "@/lib/sheets/base-recovery") return { listSourceBaseRecoveryReview: mocks.preview };
  if (name === "@/components/source-base-recovery-panel") return function Panel(props: unknown) { mocks.panel(props); return null; };
  if (name === "@/components/ui") return new Proxy({}, { get: () => Container });
  if (name.startsWith("@/components/exceptions/")) return Container;
  if (name === "@/lib/money") return money;
  if (name === "@/lib/nav/review-actions") return navigation;
  return nodeRequire(name);
}, loaded, loaded.exports);
const Page = (loaded.exports as { default: (props: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactNode> }).default;
const review = { sourceHash: "a".repeat(64), candidates: [], history: [] };

describe("Employee base review server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ role: "manager", actorId: "synthetic-actor" });
    mocks.withDb.mockImplementation(async fn => ({ ok: true, data: await fn(connection) }));
    mocks.counts.mockResolvedValue({ rateExceptions: 0, unknownPrograms: 0, unmatchedNames: 0,
      pendingAliases: 0, duplicateCandidates: 0, groupReviewIssues: 0, reconciliationDifferences: 0, overAuthorization: 0 });
    for (const mock of [mocks.rates, mocks.imports, mocks.duplicates]) mock.mockResolvedValue({ rows: [], total: 0 });
    mocks.aliases.mockResolvedValue([]);
    mocks.preview.mockResolvedValue(review);
  });

  it.each(["signed out", "planner", "collector", "external user", "owner viewing restricted target"])(
    "stops %s before accessing global source amounts", async () => {
      const redirect = new Error("Synthetic permission redirect");
      mocks.requireUser.mockRejectedValue(redirect);
      await expect(Page({ searchParams: Promise.resolve({ kind: "rate" }) })).rejects.toBe(redirect);
      expect(mocks.requireUser).toHaveBeenCalledExactlyOnceWith("manager");
      expect(mocks.withDb).not.toHaveBeenCalled();
      expect(mocks.preview).not.toHaveBeenCalled();
      expect(mocks.panel).not.toHaveBeenCalled();
    });

  it("reads the source preview after manager authorization and preserves blocked rows for presentation", async () => {
    const unavailable = { sourceHash: null, candidates: [{ eligible: false, reviewReason: "Source unavailable" }], history: [] };
    mocks.preview.mockResolvedValue(unavailable);
    renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ kind: "rate" }) }));
    expect(mocks.requireUser.mock.invocationCallOrder[0]).toBeLessThan(mocks.preview.mock.invocationCallOrder[0]);
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(connection);
    expect(mocks.panel).toHaveBeenCalledExactlyOnceWith({ review: unavailable });
  });

  it("does not fetch financial source data for an unrelated exception queue", async () => {
    renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ kind: "unmatched_name" }) }));
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.panel).not.toHaveBeenCalled();
  });

  it("does not render correction controls after the data read fails", async () => {
    mocks.withDb.mockResolvedValue({ ok: false, error: "Data unavailable" });
    renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ kind: "rate" }) }));
    expect(mocks.panel).not.toHaveBeenCalled();
  });
});
