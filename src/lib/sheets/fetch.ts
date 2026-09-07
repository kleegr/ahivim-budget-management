import { authoritativeSheetExportUrl, type SheetSyncConfig } from "./config";
import {
  googleSheetsReadAccessToken,
  googleSheetsReadCredentials,
  type GoogleSheetsReadCredentials,
} from "./google-auth";
import { parseSheetCsv } from "./parse-csv";

/**
 * SERVER-SIDE SHEET FETCH
 * =======================
 *
 * Fetches the full configured A:S range through the authenticated Google Sheets
 * Values API when Viewer-only credentials are configured. The fixed public
 * source can also use its pinned-gid CSV export, which is read-only and ignores
 * the Sheet's saved display filter. This runs only on the server.
 *
 * The fetch is defensive: a non-2xx response, HTML/access page, invalid row
 * layout, or empty body becomes a clear recorded sync error instead of silently
 * importing a partial view.
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
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<head");
};

export interface SheetFetchOptions {
  /** Undefined reads production env; null explicitly exercises credentialless source rules. */
  credentials?: GoogleSheetsReadCredentials | null;
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
  credentials: GoogleSheetsReadCredentials,
  request: typeof fetch,
): Promise<string> {
  let token: string;
  try {
    token = await googleSheetsReadAccessToken(credentials, request);
  } catch {
    throw new SheetFetchError(
      "Google Sheets authorization failed. Confirm the service-account credentials and Sheets API access.",
    );
  }

  const range = `'${cfg.sheetName.replace(/'/g, "''")}'!A:S`;
  const query = new URLSearchParams({
    majorDimension: "ROWS",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
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

async function fetchPublicAuthoritativeSheetCsv(
  cfg: SheetSyncConfig,
  request: typeof fetch,
): Promise<string> {
  const url = authoritativeSheetExportUrl(cfg);
  if (!url) {
    throw new SheetFetchError(
      "Viewer-only Google Sheets credentials are required for a custom or private source.",
    );
  }

  let response: Response;
  try {
    response = await request(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "text/csv,text/plain" },
    });
  } catch {
    throw new SheetFetchError("Could not reach the authoritative Google Sheet.");
  }
  if (!response.ok) {
    throw new SheetFetchError(
      `The authoritative Google Sheet export responded with HTTP ${response.status}.`,
    );
  }
  const body = await response.text();
  if (!body || body.trim() === "") {
    throw new SheetFetchError("The authoritative Google Sheet returned an empty export.");
  }
  if (looksLikeHtml(body)) {
    throw new SheetFetchError(
      "The authoritative Google Sheet returned an access page instead of its read-only CSV export.",
    );
  }
  const parsed = parseSheetCsv(body);
  const header = parsed.headerRowIndex === null ? null : parsed.grid[parsed.headerRowIndex];
  if (!header || header.length < 19 || parsed.ahivimRows.length === 0) {
    throw new SheetFetchError(
      "The authoritative Google Sheet export did not contain the expected A:S transaction structure.",
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
    ? googleSheetsReadCredentials()
    : options.credentials;
  return credentials
    ? fetchAuthenticatedSheetCsv(cfg, credentials, request)
    : fetchPublicAuthoritativeSheetCsv(cfg, request);
}
