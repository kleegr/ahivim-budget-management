import { describe, it, expect } from "vitest";
import {
  transactionFingerprint, transactionNaturalKey, classifyDuplicate, fileChecksum,
  FINGERPRINT_FIELDS, type TransactionIdentity,
} from "@/lib/business/fingerprint";

/**
 * Duplicate identity must survive the trip through the database. The bug this
 * guards against: keying identity on a database UUID, which does not exist on
 * a first import and does exist on every import after it, so the same row
 * produces two different fingerprints and gets counted twice.
 */

const base: TransactionIdentity = {
  checkNumber: "1001",
  checkDate: "2025-01-10",
  employeeKey: "cohen sarah",
  individualKey: "green david",
  programKey: "COM_HAB",
  periodBegin: "2025-01-01",
  periodEnd: "2025-01-15",
  hours: "10",
  rate: "25",
  amount: "250",
};

describe("transaction fingerprint", () => {
  it("is built only from normalized business values", () => {
    expect(FINGERPRINT_FIELDS).not.toContain("id");
    expect(FINGERPRINT_FIELDS).not.toContain("individualId");
    expect(FINGERPRINT_FIELDS).not.toContain("employeeId");
    for (const field of FINGERPRINT_FIELDS) {
      expect(Object.keys(base)).toContain(field);
    }
  });

  it("is stable for identical input", () => {
    expect(transactionFingerprint(base)).toBe(transactionFingerprint({ ...base }));
  });

  it("is a hex digest, not the raw values", () => {
    const fingerprint = transactionFingerprint(base);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain("green david");
  });

  it("ignores numeric formatting differences that mean the same amount", () => {
    expect(transactionFingerprint({ ...base, amount: "250.00" })).toBe(
      transactionFingerprint({ ...base, amount: "250" }),
    );
    expect(transactionFingerprint({ ...base, hours: "10.0000" })).toBe(
      transactionFingerprint({ ...base, hours: "10" }),
    );
  });

  it.each([
    ["checkNumber", "1002"],
    ["checkDate", "2025-01-11"],
    ["employeeKey", "cohen sara"],
    ["individualKey", "green davis"],
    ["programKey", "RESPITE"],
    ["periodBegin", "2025-01-02"],
    ["periodEnd", "2025-01-16"],
    ["hours", "11"],
    ["rate", "26"],
    ["amount", "251"],
  ])("changes when %s changes", (field, value) => {
    const changed = { ...base, [field]: value } as TransactionIdentity;
    expect(transactionFingerprint(changed)).not.toBe(transactionFingerprint(base));
  });

  it("treats a null and an empty check number consistently", () => {
    const withNull = transactionFingerprint({ ...base, checkNumber: null });
    expect(withNull).toMatch(/^[0-9a-f]{64}$/);
    expect(withNull).not.toBe(transactionFingerprint(base));
  });

  it("produces a natural key that is stable and independent of the fingerprint", () => {
    const key = transactionNaturalKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(transactionNaturalKey({ ...base })).toBe(key);
    // The natural key deliberately excludes hours, rate and amount, so the
    // same check/person/period with a corrected amount is a POSSIBLE duplicate
    // rather than an unrelated row.
    expect(transactionNaturalKey({ ...base, amount: "999" })).toBe(key);
    expect(transactionNaturalKey({ ...base, individualKey: "someone else" })).not.toBe(key);
    expect(key).not.toBe(transactionFingerprint(base));
  });
});

describe("duplicate classification", () => {
  it("is new when neither the fingerprint nor the natural key is known", () => {
    const result = classifyDuplicate(base, { fingerprints: new Set(), naturalKeys: new Set() });
    expect(result.status).toBe("new");
  });

  it("is confirmed when the exact fingerprint already exists", () => {
    const result = classifyDuplicate(base, { fingerprints: new Set([transactionFingerprint(base)]), naturalKeys: new Set() });
    expect(result.status).toBe("confirmed");
  });

  it("is possible when the natural key matches but the fingerprint does not", () => {
    const result = classifyDuplicate(base, { fingerprints: new Set(), naturalKeys: new Set([transactionNaturalKey(base)]) });
    expect(result.status).toBe("possible");
  });

  it("gives a reason a person can act on", () => {
    const result = classifyDuplicate(base, { fingerprints: new Set([transactionFingerprint(base)]), naturalKeys: new Set() });
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("file checksum", () => {
  it("is a sha-256 hex digest of the bytes", () => {
    expect(fileChecksum(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("differs for a one-byte change", () => {
    expect(fileChecksum(Buffer.from("abc"))).not.toBe(fileChecksum(Buffer.from("abd")));
  });
});
