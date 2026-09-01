import { gvizCsvUrl, type SheetSyncConfig } from "./config";
import {
  googleSheetsAccessToken,
  googleSheetsCredentials,
  type GoogleServiceAccountCredentials,
} from "./google-auth";

/**
 * SERVER-SIDE SHEET FETCH
 * =======================
 *
 * Fetches the Google Sheet from the deployed server. When a service account is
 * configured, the private Sheets API returns the same displayed values users
 * see in the workbook. The public gviz CSV endpoint remains a legacy, read-only
 * fallback only while credentials are absent. This runs only on the server.
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

export interface SheetFetchOptions {
  /** Undefined reads production env; null explicitly exercises legacy fallback. */
  credentials?: GoogleServiceAccountCredentials | null;
  request?: typeof fetch;
}

function csvCell(value: unknown): string {
  const text = typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
  return `"${text.replace(/"/g, '""')}"`;
}

/** Preserve every returned row, including interior blank rows, as RFC 4180 CSV. */
export function sheetValuesToCsv(values: readonly (readonly unknown[])[]): string {
  return values.map((row) => row.map(csvCell).join(",")).join("\n");
}

async function fetchAuthenticatedSheetCsv(
  cfg: SheetSyncConfig,
  credentials: GoogleServiceAccountCredentials,
  request: typeof fetch,
): Promise<string> {
  let token: string;
  try {
    token = await googleSheetsAccessToken(credentials, request);
  } catch {
    throw new SheetFetchError(
      "Google Sheets authorization failed. Confirm the service-account credentials and Sheets API access.",
    );
  }

  const range = `'${cfg.sheetName.replace(/'/g, "''")}'!A:S`;
  const query = new URLSearchParams({
    majorDimension: "ROWS",
    valueRenderOption: "FORMATTED_VALUE",
  });
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.sheetId)}` +
    `/values/${encodeURIComponent(range)}?${query}`;

  let response: Response;
  try {
    response = await request(url, {
      method: "GET",
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch {
    throw new SheetFetchError("Could not reach the private Google Sheet. Try again.");
  }
  if (!response.ok) {
    throw new SheetFetchError(
      `The private Google Sheet responded with HTTP ${response.status}. Confirm the service account can view this Sheet and tab.`,
    );
  }

  let body: { majorDimension?: unknown; values?: unknown };
  try {
    body = (await response.json()) as { majorDimension?: unknown; values?: unknown };
  } catch {
    throw new SheetFetchError("The private Google Sheet returned an unreadable response.");
  }
  if (body.majorDimension !== undefined && body.majorDimension !== "ROWS") {
    throw new SheetFetchError("The private Google Sheet returned an unexpected row layout.");
  }
  if (!Array.isArray(body.values) || !body.values.every(Array.isArray)) {
    throw new SheetFetchError("The private Google Sheet returned no usable rows.");
  }
  const csv = sheetValuesToCsv(body.values);
  if (!csv.trim()) {
    throw new SheetFetchError("The private Google Sheet returned an empty response.");
  }
  return csv;
}

async function fetchLegacySheetCsv(
  cfg: SheetSyncConfig,
  request: typeof fetch,
): Promise<string> {
  const url = gvizCsvUrl(cfg);

  let response: Response;
  try {
    response = await request(url, {
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

export async function fetchSheetCsv(
  cfg: SheetSyncConfig,
  options: SheetFetchOptions = {},
): Promise<string> {
  const request = options.request ?? fetch;
  const credentials = options.credentials === undefined
    ? googleSheetsCredentials()
    : options.credentials;
  return credentials
    ? fetchAuthenticatedSheetCsv(cfg, credentials, request)
    : fetchLegacySheetCsv(cfg, request);
}
