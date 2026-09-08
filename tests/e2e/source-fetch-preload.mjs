// Loaded only by Playwright's explicit disposable-app start command. It is not
// imported by application code, the production build, or npm start.
import { readFileSync } from "node:fs";
import { assertSyntheticSourceEnvironment, assertSyntheticSourceRequest } from "./source-preload-guard.ts";

assertSyntheticSourceEnvironment(process.env);
const originalFetch = globalThis.fetch;
const syntheticCsv = new URL("./source-base.csv", import.meta.url);
globalThis.fetch = async function syntheticSourceFetch(input, init) {
  const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const url = new URL(raw);
  if (url.hostname === "docs.google.com" || url.hostname === "sheets.googleapis.com") {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    assertSyntheticSourceRequest(raw, method);
    return new Response(readFileSync(syntheticCsv, "utf8"), {
      status: 200, headers: { "Content-Type": "text/csv", "Cache-Control": "no-store" },
    });
  }
  return originalFetch(input, init);
};
