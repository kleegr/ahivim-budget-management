import { createSign } from "node:crypto";
import type { PgLikePool } from "@/lib/import/commit";
import type { SheetSyncConfig } from "./config";
import { fetchSheetCsv, type CsvFetcher } from "./fetch";
import { parseSheetCsv } from "./parse-csv";
import { sheetSourceIdentity, sheetSourceIdentityKey } from "./identity";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleServiceAccountCredentials {
  clientEmail: string;
  privateKey: string;
}

export interface SheetCellUpdate {
  range: string;
  value: string;
}

export interface SheetCellWriter {
  write(cells: readonly SheetCellUpdate[], config: SheetSyncConfig): Promise<void>;
}

export interface SynchronizedPaidTransaction {
  transactionId: string;
  isPaid: boolean;
}

export interface SheetWritebackResult {
  status: "success" | "partial" | "not_configured" | "failed";
  eligible: number;
  updated: number;
  skipped: number;
  error: string | null;
  /** Internal acknowledgement set. API routes must not expose these values. */
  synchronizedTransactions: SynchronizedPaidTransaction[];
}

interface TrackedPaidRow {
  payroll_transaction_id: string;
  source_row_number: number | null;
  identity: Record<string, unknown> | null;
  is_paid: boolean;
}

function decodeJsonCredential(raw: string): Record<string, unknown> | null {
  const candidates = [raw];
  try {
    candidates.push(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    // The raw form may already be JSON.
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Try the next supported form.
    }
  }
  return null;
}

/** Supports either one service-account JSON secret or the familiar two fields. */
export function googleSheetsCredentials(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GoogleServiceAccountCredentials | null {
  const jsonSecret = env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON?.trim();
  if (jsonSecret) {
    const parsed = decodeJsonCredential(jsonSecret);
    const clientEmail = typeof parsed?.client_email === "string" ? parsed.client_email.trim() : "";
    const privateKey = typeof parsed?.private_key === "string" ? parsed.private_key : "";
    if (clientEmail && privateKey) {
      return { clientEmail, privateKey: privateKey.replace(/\\n/g, "\n") };
    }
  }

  const clientEmail = env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL?.trim() ?? "";
  const privateKey = env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";
  return clientEmail && privateKey ? { clientEmail, privateKey } : null;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

async function accessToken(
  credentials: GoogleServiceAccountCredentials,
  request: typeof fetch,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: credentials.clientEmail,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${base64url(signer.sign(credentials.privateKey))}`;

  const response = await request(TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error("Google Sheets authorization was not accepted.");
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("Google Sheets did not return an access token.");
  }
  return body.access_token;
}

export function googleSheetsWriter(
  credentials: GoogleServiceAccountCredentials,
  request: typeof fetch = fetch,
): SheetCellWriter {
  return {
    async write(cells, config) {
      if (cells.length === 0) return;
      const token = await accessToken(credentials, request);
      const chunks = Array.from({ length: Math.ceil(cells.length / 500) }, (_, index) =>
        cells.slice(index * 500, index * 500 + 500),
      );
      for (const chunk of chunks) {
        const response = await request(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheetId)}/values:batchUpdate`,
          {
            method: "POST",
            signal: AbortSignal.timeout(20_000),
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              valueInputOption: "RAW",
              includeValuesInResponse: false,
              data: chunk.map((cell) => ({ range: cell.range, values: [[cell.value]] })),
            }),
          },
        );
        if (!response.ok) throw new Error("Google Sheets did not accept the update.");
      }
    },
  };
}

function columnName(index: number): string {
  let value = index;
  let out = "";
  while (value > 0) {
    value--;
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26);
  }
  return out;
}

function quotedSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function paidBaseline(identity: Record<string, unknown> | null): boolean | null {
  return typeof identity?.sourcePaid === "boolean" ? identity.sourcePaid : null;
}

export async function pushPaidChangesToSheet(
  pool: PgLikePool,
  config: SheetSyncConfig,
  options: {
    writer?: SheetCellWriter | null;
    fetcher?: CsvFetcher;
  } = {},
): Promise<SheetWritebackResult> {
  const credentials = options.writer === undefined ? googleSheetsCredentials() : null;
  const writer = options.writer === undefined
    ? credentials ? googleSheetsWriter(credentials) : null
    : options.writer;
  if (!writer) {
    return {
      status: "not_configured",
      eligible: 0,
      updated: 0,
      skipped: 0,
      error: null,
      synchronizedTransactions: [],
    };
  }

  try {
    const { rows } = await pool.query<TrackedPaidRow>(
      `SELECT r.payroll_transaction_id, r.source_row_number, r.identity, t.is_paid
         FROM sheet_sync_rows r
         JOIN payroll_transactions t ON t.id = r.payroll_transaction_id
        WHERE r.state = 'active' AND r.payroll_transaction_id IS NOT NULL`,
    );
    const eligible = rows.filter((row) => {
      const baseline = paidBaseline(row.identity);
      return row.identity?.appPaidDirty === true || (baseline !== null && baseline !== row.is_paid);
    });
    if (eligible.length === 0) {
      return {
        status: "success",
        eligible: 0,
        updated: 0,
        skipped: 0,
        error: null,
        synchronizedTransactions: [],
      };
    }

    const csv = await (options.fetcher ?? fetchSheetCsv)(config);
    const parsed = parseSheetCsv(csv);
    const currentByKey = new Map<string, { rowNumber: number; paid: boolean }[]>();
    for (const row of parsed.ahivimRows) {
      if (!row.parsed) continue;
      const identity = sheetSourceIdentity(row);
      const key = sheetSourceIdentityKey(identity as unknown as Record<string, unknown>);
      if (!key || !("sourcePaid" in identity)) continue;
      const list = currentByKey.get(key) ?? [];
      list.push({ rowNumber: row.sourceRowNumber, paid: identity.sourcePaid });
      currentByKey.set(key, list);
    }

    const paidColumn = columnName(parsed.columnMap.paid);
    const usedRows = new Set<number>();
    const cells: SheetCellUpdate[] = [];
    const synchronizedTransactions: SynchronizedPaidTransaction[] = [];
    let skipped = 0;
    for (const tracked of eligible) {
      const key = tracked.identity ? sheetSourceIdentityKey(tracked.identity) : null;
      const candidates = key ? currentByKey.get(key) ?? [] : [];
      const direct = candidates.find((candidate) =>
        candidate.rowNumber === tracked.source_row_number && !usedRows.has(candidate.rowNumber),
      );
      const remaining = candidates.filter((candidate) => !usedRows.has(candidate.rowNumber));
      const current = direct ?? (remaining.length === 1 ? remaining[0] : null);
      if (!current) {
        skipped++;
        continue;
      }
      usedRows.add(current.rowNumber);
      synchronizedTransactions.push({
        transactionId: tracked.payroll_transaction_id,
        isPaid: tracked.is_paid,
      });
      if (current.paid !== tracked.is_paid) {
        cells.push({
          range: `${quotedSheetName(config.sheetName)}!${paidColumn}${current.rowNumber}`,
          value: tracked.is_paid ? "Paid" : "",
        });
      }
    }

    await writer.write(cells, config);
    return {
      status: skipped > 0 ? "partial" : "success",
      eligible: eligible.length,
      updated: cells.length,
      skipped,
      error: skipped > 0 ? "Some Paid markers could not be matched safely in the Google Sheet." : null,
      synchronizedTransactions,
    };
  } catch {
    return {
      status: "failed",
      eligible: 0,
      updated: 0,
      skipped: 0,
      error: "The Google Sheet write-back could not be completed.",
      synchronizedTransactions: [],
    };
  }
}

/** Clear pending markers only after the subsequent pull has completed. */
export async function acknowledgePaidWriteback(
  pool: PgLikePool,
  transactions: readonly SynchronizedPaidTransaction[],
): Promise<void> {
  if (transactions.length === 0) return;
  await pool.query(
    `UPDATE sheet_sync_rows r
        SET identity = COALESCE(r.identity, '{}'::jsonb) - 'appPaidDirty',
            updated_at = now()
       FROM unnest($1::uuid[], $2::boolean[]) AS sent(transaction_id, is_paid)
       JOIN payroll_transactions t
         ON t.id = sent.transaction_id
        AND t.is_paid = sent.is_paid
      WHERE r.payroll_transaction_id = sent.transaction_id`,
    [
      transactions.map((transaction) => transaction.transactionId),
      transactions.map((transaction) => transaction.isPaid),
    ],
  );
}

/** Ensure any outbound value remains authoritative during the following pull. */
export async function protectPaidWriteback(
  pool: PgLikePool,
  transactions: readonly SynchronizedPaidTransaction[],
): Promise<void> {
  if (transactions.length === 0) return;
  await pool.query(
    `UPDATE sheet_sync_rows
        SET identity = COALESCE(identity, '{}'::jsonb) || '{"appPaidDirty":true}'::jsonb,
            updated_at = now()
      WHERE payroll_transaction_id = ANY($1::uuid[])`,
    [transactions.map((transaction) => transaction.transactionId)],
  );
}
