import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkbook } from "./support/workbook";

/**
 * PRODUCTION UPLOAD REGRESSION TEST
 * =================================
 *
 * The workbook upload runs in a Node server function on Vercel, where ExcelJS
 * is an external (unbundled) package loaded with CommonJS `require`. ExcelJS
 * does `require('uuid')` and `require('archiver')`. A production incident was
 * caused by an `overrides` block that forced those onto ESM-only majors
 * (uuid@14, archiver@8): every ESM-only version makes ExcelJS's `require`
 * throw ERR_REQUIRE_ESM at runtime, and the whole /api/imports route 500s.
 *
 * It slipped through because Node >= 22 allows `require()` of an ES module by
 * default, so the failure was invisible in local dev and in a normal vitest
 * run. This test reproduces the stricter runtime by spawning Node with
 * `--no-experimental-require-module`, which disables require-of-ESM, and then
 * loading and PARSING a real workbook through ExcelJS. If any package in
 * ExcelJS's require chain is ESM-only again, this fails with ERR_REQUIRE_ESM —
 * exactly as production did — instead of shipping the break.
 */

const FLAG = "--no-experimental-require-module";
const flagSupported = process.allowedNodeEnvironmentFlags?.has(FLAG) ?? false;

const suite = flagSupported ? describe : describe.skip;

suite("ExcelJS loads and parses under a strict CommonJS runtime", () => {
  let fixture: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "exceljs-cjs-"));
    fixture = join(dir, "fixture.xlsx");
    writeFileSync(fixture, await buildWorkbook());
  });

  afterAll(() => {
    try {
      unlinkSync(fixture);
    } catch {
      /* best effort */
    }
  });

  function runStrictCjs(script: string): string {
    // execFileSync throws on a non-zero exit, surfacing the child's stderr
    // (which is where ERR_REQUIRE_ESM would appear) in the test failure.
    return execFileSync(process.execPath, [FLAG, "-e", script], {
      cwd: process.cwd(), // resolve `require('exceljs')` from the repo
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  it("require('exceljs') succeeds with require-of-ESM disabled", () => {
    const out = runStrictCjs(
      "const E = require('exceljs'); new E.Workbook(); process.stdout.write('LOADED');",
    );
    expect(out).toContain("LOADED");
  });

  it("parses a real .xlsx end to end without ERR_REQUIRE_ESM", () => {
    const script = `
      const E = require('exceljs');
      const fs = require('fs');
      (async () => {
        const wb = new E.Workbook();
        await wb.xlsx.load(fs.readFileSync(process.argv[1]));
        const ah = wb.getWorksheet('Ahivim');
        if (!ah || ah.rowCount < 2) throw new Error('workbook did not parse');
        process.stdout.write('ROWS:' + ah.rowCount);
      })().catch((e) => { process.stderr.write(String(e.code || '') + ' ' + e.message); process.exit(1); });
    `;
    const out = execFileSync(process.execPath, [FLAG, "-e", script, fixture], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toMatch(/ROWS:\d+/);
  });

  it("resolves ExcelJS's uuid and archiver to CommonJS builds", () => {
    // A direct assertion on the resolved dependency shapes, so the reason the
    // test above passes is legible: both must be requireable CommonJS.
    const out = runStrictCjs(`
      const path = require.resolve('uuid', { paths: [require.resolve('exceljs')] });
      const uuidPkg = require('uuid/package.json');
      const archiverPkg = require('archiver/package.json');
      if (uuidPkg.type === 'module') throw new Error('uuid is ESM-only: ' + uuidPkg.version);
      if (archiverPkg.type === 'module') throw new Error('archiver is ESM-only: ' + archiverPkg.version);
      const { v4 } = require('uuid');
      if (typeof v4 !== 'function') throw new Error('uuid.v4 missing');
      process.stdout.write('uuid@' + uuidPkg.version + ' archiver@' + archiverPkg.version);
    `);
    expect(out).toMatch(/uuid@\d+/);
    expect(out).toMatch(/archiver@\d+/);
  });
});
