import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ExcelJS runtime self-check.
 *
 * Exists because of a production incident: an `overrides` block pinned uuid and
 * archiver to ESM-only majors, and ExcelJS loads them with CommonJS `require`,
 * so `/api/imports` threw ERR_REQUIRE_ESM at parse time. It was invisible
 * locally (Node >= 22 allows require-of-ESM) and only failed in the serverless
 * runtime.
 *
 * This endpoint exercises the exact require chain — construct a workbook
 * (pulls archiver / the xform tree), write it to a buffer, and read it back
 * (pulls uuid via cf-rule-ext) — so a deployment check can confirm over a plain
 * GET that the upload engine loads and round-trips in the deployed runtime,
 * without needing an authenticated multipart upload. It returns no secret and
 * touches no database.
 */
export async function GET() {
  const started = Date.now();
  try {
    const ExcelJS = (await import("exceljs")).default;

    const out = new ExcelJS.Workbook();
    const sheet = out.addWorksheet("HealthCheck");
    sheet.addRow(["a", "b"]);
    sheet.addRow([1, 2]);
    // writeBuffer() returns ExcelJS's own Buffer type; the round-trip and the
    // byte count both go through it directly. The cast bridges @types/node's
    // generic Buffer and ExcelJS's non-generic Buffer parameter.
    const written = await out.xlsx.writeBuffer();
    const wroteBytes = (written as { byteLength?: number }).byteLength ?? 0;

    const back = new ExcelJS.Workbook();
    // `written` is a Node Buffer at runtime; the cast only bridges a mismatch
    // between @types/node's now-generic Buffer and ExcelJS's Buffer parameter.
    await back.xlsx.load(written as never);
    const rows = back.getWorksheet("HealthCheck")?.rowCount ?? 0;

    return NextResponse.json({
      ok: true,
      engine: "exceljs",
      wroteBytes,
      readBackRows: rows,
      latencyMs: Date.now() - started,
    });
  } catch (error) {
    // A require-of-ESM regression lands here as ERR_REQUIRE_ESM.
    const err = error as { code?: string; message?: string };
    return NextResponse.json(
      {
        ok: false,
        engine: "exceljs",
        code: err.code ?? null,
        reason: (err.message ?? "ExcelJS failed to load").split("\n")[0].slice(0, 300),
      },
      { status: 500 },
    );
  }
}
