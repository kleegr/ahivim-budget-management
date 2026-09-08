import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHEET_GID,
  DEFAULT_SYNC_CONFIG,
  LEGACY_TRANSPORT_SHEET_ID,
  getSyncConfig,
  type SheetSyncConfig,
} from "@/lib/sheets/config";
import type { PgLikePool } from "@/lib/import/commit";
import {
  fetchSheetCsv,
  sheetValuesToCsv,
} from "@/lib/sheets/fetch";
import type { GoogleSheetsReadCredentials } from "@/lib/sheets/google-auth";
import { parseCsv, parseSheetCsv } from "@/lib/sheets/parse-csv";

const CONFIG: SheetSyncConfig = {
  enabled: true,
  sheetId: "private-sheet-1",
  sheetName: "O'Brien Payroll",
  scheduleHourUtc: 8,
  minIntervalMinutes: 60,
};

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CREDENTIALS: GoogleSheetsReadCredentials = {
  clientEmail: "sheet-reader@example.test",
  privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

function sheetRows(): unknown[][] {
  const totals = new Array(19).fill("");
  totals[15] = "$210.00";
  totals[16] = "$250.00";
  const header = new Array(19).fill("");
  header[0] = "Pay to";
  header[3] = "Code";
  header[10] = "Paid CC2 Description";
  header[11] = "Paid CC3 Description";
  header[12] = "Employee Memo";
  header[13] = "Paid";
  const row = new Array(19).fill("");
  row[0] = "Excellent Staffing";
  row[1] = "5/25/2023";
  row[2] = "1001";
  row[3] = "RG";
  row[4] = "10";
  row[5] = "25";
  row[6] = "250";
  row[8] = "5/1/2023";
  row[9] = "5/15/2023";
  row[10] = "Com Hab";
  row[11] = "Test Individual";
  row[12] = "Test Employee";
  row[13] = "Paid";
  return [totals, header, [], row];
}

describe("authenticated Google Sheet reads", () => {
  it("uses the private values API with formatted rows and preserves physical blank rows", async () => {
    vi.stubEnv("GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON", JSON.stringify({
      client_email: CREDENTIALS.clientEmail,
      private_key: CREDENTIALS.privateKey,
    }));
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        range: "'O''Brien Payroll'!A1:S4",
        majorDimension: "ROWS",
        values: sheetRows(),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    const csv = await fetchSheetCsv(CONFIG, { request });
    const parsed = parseSheetCsv(csv);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
    const tokenBody = request.mock.calls[0]?.[1]?.body;
    expect(tokenBody).toBeInstanceOf(URLSearchParams);
    const assertion = (tokenBody as URLSearchParams).get("assertion");
    const claims = JSON.parse(
      Buffer.from(assertion!.split(".")[1]!, "base64url").toString("utf8"),
    ) as { scope?: string };
    expect(claims.scope).toBe("https://www.googleapis.com/auth/spreadsheets.readonly");
    const readUrl = new URL(String(request.mock.calls[1]?.[0]));
    expect(decodeURIComponent(readUrl.pathname)).toContain(
      "/spreadsheets/private-sheet-1/values/'O''Brien Payroll'!A:S",
    );
    expect(readUrl.searchParams.get("majorDimension")).toBe("ROWS");
    expect(readUrl.searchParams.get("valueRenderOption")).toBe("UNFORMATTED_VALUE");
    expect(readUrl.searchParams.get("dateTimeRenderOption")).toBe("SERIAL_NUMBER");
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      headers: { Authorization: "Bearer access-token", Accept: "application/json" },
    });
    expect(parsed.headerRowIndex).toBe(1);
    expect(parsed.ahivimRows).toHaveLength(1);
    expect(parsed.ahivimRows[0]?.sourceRowNumber).toBe(4);
    expect(parsed.ahivimRows[0]?.parsed).toMatchObject({
      checkDate: "2023-05-25",
      amount: "250",
      paid: "Paid",
    });
  });

  it("serializes displayed values losslessly as CSV", () => {
    const csv = sheetValuesToCsv([
      ["$1,234.50", "said \"hello\"", true, 12.5],
      [],
      ["line one\nline two"],
    ]);
    expect(parseCsv(csv)).toEqual([
      ["$1,234.50", "said \"hello\"", "true", "12.5"],
      [""],
      ["line one\nline two"],
    ]);
  });

  it("does not fall back to the public URL when private authorization fails", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("credential diagnostic that must stay private", { status: 401 }),
    );

    await expect(fetchSheetCsv(CONFIG, { credentials: CREDENTIALS, request })).rejects.toThrow(
      "Google Sheets authorization failed",
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
  });

  it("redacts private API error bodies and credential material", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "private-access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: "private diagnostic and row contents" } }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ));

    let message = "";
    try {
      await fetchSheetCsv(CONFIG, { credentials: CREDENTIALS, request });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("HTTP 403");
    expect(message).not.toContain("private diagnostic");
    expect(message).not.toContain("private-access-token");
    expect(message).not.toContain(CREDENTIALS.clientEmail);
    expect(message).not.toContain("BEGIN PRIVATE KEY");
  });
});

describe("strict read-only public source", () => {
  it("uses the pinned authoritative gid without credentials or cookies", async () => {
    const csv = sheetValuesToCsv(sheetRows());
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(csv, { status: 200, headers: { "Content-Type": "text/csv" } }),
    );

    const result = await fetchSheetCsv(DEFAULT_SYNC_CONFIG, { credentials: null, request });

    expect(result).toBe(csv);
    expect(request).toHaveBeenCalledOnce();
    const url = new URL(String(request.mock.calls[0]?.[0]));
    expect(url.hostname).toBe("docs.google.com");
    expect(url.pathname).toContain(`/spreadsheets/d/${DEFAULT_SYNC_CONFIG.sheetId}/export`);
    expect(url.searchParams.get("format")).toBe("csv");
    expect(url.searchParams.get("gid")).toBe(DEFAULT_SHEET_GID);
    expect(url.searchParams.has("sheet")).toBe(false);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "omit",
    });
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
  });

  it("fails closed before any request for a custom source without Viewer credentials", async () => {
    const request = vi.fn<typeof fetch>();

    await expect(fetchSheetCsv(CONFIG, { credentials: null, request })).rejects.toThrow(
      "Viewer-only Google Sheets credentials are required",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an access page or unexpected CSV structure before staging", async () => {
    const accessPage = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("<!doctype html><html><head></head><body>Sign in</body></html>", { status: 200 }),
    );
    await expect(fetchSheetCsv(DEFAULT_SYNC_CONFIG, {
      credentials: null,
      request: accessPage,
    })).rejects.toThrow("access page");

    const wrongCsv = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("not,the,transaction,source", { status: 200 }),
    );
    await expect(fetchSheetCsv(DEFAULT_SYNC_CONFIG, {
      credentials: null,
      request: wrongCsv,
    })).rejects.toThrow("expected A:S transaction structure");
  });

  it("maps the verified legacy transport configuration to the authoritative source", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{
          value: {
            ...DEFAULT_SYNC_CONFIG,
            sheetId: LEGACY_TRANSPORT_SHEET_ID,
          },
        }],
      })),
    } as unknown as PgLikePool;

    await expect(getSyncConfig(pool)).resolves.toMatchObject({
      sheetId: DEFAULT_SYNC_CONFIG.sheetId,
      sheetName: DEFAULT_SYNC_CONFIG.sheetName,
    });
  });
});
