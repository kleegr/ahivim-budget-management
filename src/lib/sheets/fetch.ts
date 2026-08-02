import { gvizCsvUrl, type SheetSyncConfig } from "./config";

/**
 * SERVER-SIDE SHEET FETCH
 * =======================
 *
 * Fetches the Google Sheet as CSV from the deployed server. The sheet is shared
 * "anyone with the link can view", so the gviz CSV endpoint returns the data
 * without authentication. This runs only on the server (the sync engine and the
 * cron endpoint); it is never called from the browser.
 *
 * The fetch is defensive: a non-2xx response, an HTML body (which Google returns
 * for a sign-in wall or a bad id), or an empty body are turned into a clear
 * error the sync run records, so a temporary sheet outage is visible and
 * retryable rather than silently importing nothing.
 */

export type CsvFetcher = (cfg: SheetSyncConfig) => Promise<string>;

export class SheetFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetFetchError";
  }
}

const looksLikeHtml = (body: string): boolean => {
  const head = body.slice(0, 400).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<head>");
};

export async function fetchSheetCsv(cfg: SheetSyncConfig): Promise<string> {
  const url = gvizCsvUrl(cfg);

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      headers: { Accept: "text/csv,text/plain,*/*" },
    });
  } catch (error) {
    throw new SheetFetchError(
      `Could not reach the Google Sheet: ${error instanceof Error ? error.message : "network error"}.`,
    );
  }

  if (!response.ok) {
    throw new SheetFetchError(
      `The Google Sheet responded with HTTP ${response.status}. Confirm the sheet id is correct and that ` +
        `link sharing is set to "anyone with the link can view".`,
    );
  }

  const body = await response.text();
  if (!body || body.trim() === "") {
    throw new SheetFetchError("The Google Sheet returned an empty response.");
  }
  if (looksLikeHtml(body)) {
    throw new SheetFetchError(
      "The Google Sheet returned an HTML page instead of CSV. This usually means the sheet is not " +
        'shared as "anyone with the link can view", or the sheet id/tab name is wrong.',
    );
  }
  return body;
}
