import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/sheets/parse-csv";

describe("inbound CSV structural integrity", () => {
  it("rejects a truncated quoted field instead of hiding subsequent records", () => {
    expect(() => parseCsv('"complete","row"\n"truncated,field\nnext,row'))
      .toThrow("unterminated quoted field");
  });

  it("rejects an escaped quote that is not followed by the closing delimiter", () => {
    expect(() => parseCsv('"complete","row"\n"truncated""'))
      .toThrow("unterminated quoted field");
  });

  it("continues to accept quoted newlines, escaped quotes, and a final row without a newline", () => {
    expect(parseCsv('"line one\nline two","a""b"\r\n"last","row"')).toEqual([
      ["line one\nline two", 'a"b'],
      ["last", "row"],
    ]);
  });
});
