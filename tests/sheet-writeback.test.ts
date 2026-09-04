import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { PgLikePool } from "@/lib/import/commit";
import type { SheetSyncConfig } from "@/lib/sheets/config";
import { setTransactionsPaid } from "@/lib/manage/transactions";
import { runSheetRoundTrip, sheetRoundTripSucceeded } from "@/lib/sheets/round-trip";
import type { SyncRunSummary } from "@/lib/sheets/sync";
import {
  acknowledgePaidWriteback,
  googleSheetsCredentials,
  googleSheetsWriter,
  pushPaidChangesToSheet,
  type SheetCellUpdate,
  type SheetCellWriter,
} from "@/lib/sheets/writeback";

const CONFIG: SheetSyncConfig = {
  enabled: true,
  sheetId: "sheet-1",
  sheetName: "Ahivim",
  scheduleHourUtc: 8,
  minIntervalMinutes: 60,
};

function csv(paid = ""): string {
  const totals = new Array(20).fill("");
  totals[16] = "250";
  const header = new Array(20).fill("");
  header[0] = "Pay to";
  header[1] = "Check Date";
  header[2] = "Check Number";
  header[3] = "Code";
  header[4] = "Hours";
  header[5] = "Rate";
  header[6] = "Amount";
  header[8] = "Period Begin";
  header[9] = "Period End";
  header[10] = "Paid CC2 Description";
  header[11] = "Paid CC3 Description";
  header[12] = "Employee Memo";
  header[13] = "Paid";
  const row = new Array(20).fill("");
  row[0] = "Excellent Staffing";
  row[1] = "05/25/2023";
  row[2] = "1001";
  row[3] = "RG";
  row[4] = "10";
  row[5] = "25";
  row[6] = "250";
  row[8] = "05/01/2023";
  row[9] = "05/15/2023";
  row[10] = "Com Hab";
  row[11] = "Aaron Tester";
  row[12] = "Zed Worker";
  row[13] = paid;
  return [totals, header, row]
    .map((cells) => cells.map((cell) => `"${cell}"`).join(","))
    .join("\n");
}

const identity = {
  checkNumber: "1001",
  checkDate: "2023-05-25",
  program: "Com Hab",
  individual: "Aaron Tester",
  employee: "Zed Worker",
  periodBegin: "2023-05-01",
  periodEnd: "2023-05-15",
  hours: "10.0000",
  rate: "25.0000",
  amount: "250.0000",
  sourcePaid: false,
};

function poolWith(rows: unknown[]): PgLikePool {
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length })) } as unknown as PgLikePool;
}

describe("Google Sheet paid-marker write-back", () => {
  it("marks in-app payment edits as pending for the next write-back", async () => {
    const query = vi.fn(async (statement: string) => ({
      rows: [],
      rowCount: statement.startsWith("UPDATE payroll_transactions") ? 1 : 0,
    }));
    const release = vi.fn();
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as PgLikePool;
    const result = await setTransactionsPaid(
      pool,
      { ids: ["00000000-0000-4000-8000-000000000001"], paid: true },
      null,
    );

    expect(result).toEqual({ ok: true, data: { updated: 1 } });
    expect(query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(query.mock.calls[2]?.[0]).toContain("appPaidDirty");
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("stays pull-only when no service account is configured", async () => {
    const pool = poolWith([]);
    const result = await pushPaidChangesToSheet(pool, CONFIG, { writer: null });
    expect(result.status).toBe("not_configured");
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("writes only a locally changed Paid cell", async () => {
    const writes: SheetCellUpdate[][] = [];
    const writer: SheetCellWriter = {
      write: vi.fn(async (cells) => { writes.push([...cells]); }),
    };
    const result = await pushPaidChangesToSheet(
      poolWith([{ payroll_transaction_id: "txn-1", source_row_number: 3, identity, is_paid: true }]),
      CONFIG,
      { writer, fetcher: async () => csv("") },
    );

    expect(result).toMatchObject({ status: "success", eligible: 1, updated: 1, skipped: 0 });
    expect(writes).toEqual([[{ range: "'Ahivim'!N3", value: "Paid" }]]);
  });

  it("keeps the physical Google row number when the sheet contains blank rows", async () => {
    const writes: SheetCellUpdate[][] = [];
    const writer: SheetCellWriter = {
      write: vi.fn(async (cells) => { writes.push([...cells]); }),
    };
    const lines = csv("").split("\n");
    lines.splice(2, 0, new Array(20).fill('""').join(","));
    await pushPaidChangesToSheet(
      poolWith([{ payroll_transaction_id: "txn-1", source_row_number: 4, identity, is_paid: true }]),
      CONFIG,
      { writer, fetcher: async () => lines.join("\n") },
    );

    expect(writes).toEqual([[{ range: "'Ahivim'!N4", value: "Paid" }]]);
  });

  it("writes Paid consistently to every exact source occurrence of one canonical transaction", async () => {
    const writes: SheetCellUpdate[][] = [];
    const writer: SheetCellWriter = {
      write: vi.fn(async (cells) => { writes.push([...cells]); }),
    };
    const source = csv("");
    const lines = source.split("\n");
    lines.push(lines[2]!);

    const result = await pushPaidChangesToSheet(
      poolWith([{ payroll_transaction_id: "txn-1", source_row_number: 3, identity, is_paid: true }]),
      CONFIG,
      { writer, fetcher: async () => lines.join("\n") },
    );

    expect(result).toMatchObject({ status: "success", eligible: 1, updated: 2, skipped: 0 });
    expect(writes).toEqual([[
      { range: "'Ahivim'!N3", value: "Paid" },
      { range: "'Ahivim'!N4", value: "Paid" },
    ]]);
  });

  it("refuses to guess when several tracked transactions share one exact source identity", async () => {
    const writer: SheetCellWriter = { write: vi.fn(async () => undefined) };
    const result = await pushPaidChangesToSheet(
      poolWith([
        { payroll_transaction_id: "txn-1", source_row_number: 3, identity, is_paid: true },
        { payroll_transaction_id: "txn-2", source_row_number: 4, identity, is_paid: true },
      ]),
      CONFIG,
      { writer, fetcher: async () => csv("") },
    );

    expect(result).toMatchObject({ status: "partial", eligible: 2, updated: 0, skipped: 2 });
    expect(writer.write).toHaveBeenCalledWith([], CONFIG);
  });

  it("refuses an ambiguous exact identity even when only one tracked transaction is dirty", async () => {
    const writer: SheetCellWriter = { write: vi.fn(async () => undefined) };
    const result = await pushPaidChangesToSheet(
      poolWith([
        {
          payroll_transaction_id: "txn-1",
          source_row_number: 3,
          identity: { ...identity, appPaidDirty: true },
          is_paid: true,
        },
        { payroll_transaction_id: "txn-2", source_row_number: 4, identity, is_paid: false },
      ]),
      CONFIG,
      { writer, fetcher: async () => csv("") },
    );

    expect(result).toMatchObject({ status: "partial", eligible: 1, updated: 0, skipped: 1 });
    expect(writer.write).toHaveBeenCalledWith([], CONFIG);
  });

  it("does not write when the app has not changed the last pulled value", async () => {
    const writer: SheetCellWriter = { write: vi.fn(async () => undefined) };
    const fetcher = vi.fn(async () => csv(""));
    const result = await pushPaidChangesToSheet(
      poolWith([{ payroll_transaction_id: "txn-1", source_row_number: 3, identity, is_paid: false }]),
      CONFIG,
      { writer, fetcher },
    );

    expect(result).toMatchObject({ status: "success", eligible: 0, updated: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
  });

  it("sends an explicitly pending app edit even for legacy tracking metadata", async () => {
    const writer: SheetCellWriter = { write: vi.fn(async () => undefined) };
    const legacyIdentity = { ...identity, sourcePaid: undefined, appPaidDirty: true };
    const result = await pushPaidChangesToSheet(
      poolWith([{
        payroll_transaction_id: "txn-1",
        source_row_number: 3,
        identity: legacyIdentity,
        is_paid: true,
      }]),
      CONFIG,
      { writer, fetcher: async () => csv("") },
    );

    expect(result).toMatchObject({ status: "success", eligible: 1, updated: 1 });
    expect(writer.write).toHaveBeenCalledWith(
      [{ range: "'Ahivim'!N3", value: "Paid" }],
      CONFIG,
    );
  });

  it("keeps a pending app edit when Google rejects the write", async () => {
    const pool = poolWith([{
      payroll_transaction_id: "txn-1",
      source_row_number: 3,
      identity: { ...identity, appPaidDirty: true },
      is_paid: true,
    }]);
    const result = await pushPaidChangesToSheet(pool, CONFIG, {
      writer: { write: vi.fn(async () => { throw new Error("unavailable"); }) },
      fetcher: async () => csv(""),
    });

    expect(result.status).toBe("failed");
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("reports an unmatched pending Paid marker as incomplete", async () => {
    const writer: SheetCellWriter = { write: vi.fn(async () => undefined) };
    const result = await pushPaidChangesToSheet(
      poolWith([{
        payroll_transaction_id: "txn-1",
        source_row_number: 99,
        identity: { ...identity, checkNumber: "missing", appPaidDirty: true },
        is_paid: true,
      }]),
      CONFIG,
      { writer, fetcher: async () => csv("") },
    );

    expect(result).toMatchObject({ status: "partial", eligible: 1, updated: 0, skipped: 1 });
    expect(writer.write).toHaveBeenCalledWith([], CONFIG);
  });

  it("acknowledges only the exact Paid value that was sent", async () => {
    const query = vi.fn(async (statement: string, params?: unknown[]) => {
      void statement;
      void params;
      return { rows: [], rowCount: 0 };
    });
    const pool = { query } as unknown as PgLikePool;

    await acknowledgePaidWriteback(pool, [
      { transactionId: "00000000-0000-4000-8000-000000000001", isPaid: true },
      { transactionId: "00000000-0000-4000-8000-000000000002", isPaid: false },
    ]);

    expect(query.mock.calls[0]?.[0]).toContain("t.is_paid = sent.is_paid");
    expect(query.mock.calls[0]?.[1]).toEqual([
      ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
      [true, false],
    ]);
  });

  it("accepts a base64 service-account JSON secret without exposing it", () => {
    const secret = Buffer.from(JSON.stringify({
      client_email: "sync@example.test",
      private_key: "line-1\\nline-2",
    })).toString("base64");
    expect(googleSheetsCredentials({ GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: secret })).toEqual({
      clientEmail: "sync@example.test",
      privateKey: "line-1\nline-2",
    });
  });

  it("uses Google's service-account token flow and values batch update endpoint", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const writer = googleSheetsWriter({
      clientEmail: "sync@example.test",
      privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    }, request);

    await writer.write([{ range: "'Ahivim'!N3", value: "Paid" }], CONFIG);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
    expect(String(request.mock.calls[0]?.[1]?.body)).toContain("grant_type=");
    expect(request.mock.calls[1]?.[0]).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet-1/values:batchUpdate",
    );
    const apiBody = JSON.parse(String(request.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(apiBody).toMatchObject({
      valueInputOption: "RAW",
      data: [{ range: "'Ahivim'!N3", values: [["Paid"]] }],
    });
  });

  it("keeps the pending marker through pull and acknowledges it afterward", async () => {
    const events: string[] = [];
    const summary: SyncRunSummary = {
      runId: "run-1",
      status: "success",
      trigger: "manual",
      sourceRows: 1,
      added: 0,
      updated: 0,
      skipped: 1,
      flagged: 0,
      failed: 0,
      changed: 0,
      missing: 0,
      importBatchId: null,
      reconciliation: null,
      error: null,
      note: "Up to date.",
    };
    const result = await runSheetRoundTrip(poolWith([]), {
      userId: null,
      config: CONFIG,
      push: async () => {
        events.push("push");
        return {
          status: "success",
          eligible: 1,
          updated: 1,
          skipped: 0,
          error: null,
          synchronizedTransactions: [{ transactionId: "txn-1", isPaid: true }],
        };
      },
      pull: async () => {
        events.push("pull");
        return summary;
      },
      protect: async (_pool, transactions) => {
        events.push(`protect:${transactions.map((transaction) => transaction.transactionId).join(",")}`);
      },
      acknowledge: async (_pool, transactions) => {
        events.push(`ack:${transactions.map((transaction) => transaction.transactionId).join(",")}`);
      },
    });

    expect(events).toEqual(["push", "protect:txn-1", "pull", "ack:txn-1"]);
    expect(sheetRoundTripSucceeded(result)).toBe(true);
  });

  it("does not acknowledge or report success when Google rejects write-back", async () => {
    const acknowledge = vi.fn(async () => undefined);
    const result = await runSheetRoundTrip(poolWith([]), {
      userId: null,
      config: CONFIG,
      push: async () => ({
        status: "failed",
        eligible: 1,
        updated: 0,
        skipped: 0,
        error: "Write-back failed.",
        synchronizedTransactions: [],
      }),
      pull: async () => ({
        runId: "run-1",
        status: "success",
        trigger: "manual",
        sourceRows: 1,
        added: 0,
        updated: 0,
        skipped: 1,
        flagged: 0,
        failed: 0,
        changed: 0,
        missing: 0,
        importBatchId: null,
        reconciliation: null,
        error: null,
        note: "Pulled.",
      }),
      acknowledge,
      protect: async () => {
        throw new Error("A rejected write must not be protected as sent.");
      },
    });

    expect(acknowledge).not.toHaveBeenCalled();
    expect(sheetRoundTripSucceeded(result)).toBe(false);
  });

  it("does not report success when any eligible Paid marker was skipped", async () => {
    const result = await runSheetRoundTrip(poolWith([]), {
      userId: null,
      config: CONFIG,
      push: async () => ({
        status: "partial",
        eligible: 2,
        updated: 1,
        skipped: 1,
        error: "One marker could not be matched.",
        synchronizedTransactions: [{ transactionId: "txn-1", isPaid: true }],
      }),
      pull: async () => ({
        runId: "run-1",
        status: "success",
        trigger: "manual",
        sourceRows: 1,
        added: 0,
        updated: 0,
        skipped: 1,
        flagged: 0,
        failed: 0,
        changed: 0,
        missing: 0,
        importBatchId: null,
        reconciliation: null,
        error: null,
        note: "Pulled.",
      }),
      protect: async () => undefined,
      acknowledge: async () => undefined,
    });

    expect(sheetRoundTripSucceeded(result)).toBe(false);
  });
});
