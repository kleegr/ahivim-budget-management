import { describe, expect, it, vi } from "vitest";
import { creationDocumentContext } from "@/lib/manage/document-policy";
import { fullAccess } from "@/lib/auth/access";
import type { DocumentAccess } from "@/lib/auth/document-access";

const INVOICE = "00000000-0000-4000-8000-000000000001";
const PERSON = "00000000-0000-4000-8000-000000000011";
function access(options: { allowed?: boolean; external?: boolean; version?: number; owner?: boolean } = {}) {
  const scope = { ...fullAccess("creator", options.owner ? "admin" : "viewer"), full: Boolean(options.owner), allIndividuals: false, grantedIndividualIds: options.allowed === false ? [] : [PERSON] };
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ individual_id: PERSON, status: "void" }] })
    .mockResolvedValue({ rows: options.version === undefined ? [] : [{ version: options.version }] });
  return { value: { user: { id: "creator", role: scope.role }, pool: { query }, scope, external: Boolean(options.external) } as unknown as DocumentAccess, query };
}

describe("finalized cover source saved to Documents", () => {
  it("accepts an authorized frozen VOID cover version and retains its exact provenance privately", async () => {
    const source = access({ version: 2 });
    const result = await creationDocumentContext(source.value, `/api/classes/invoices/${INVOICE}/cover-sheet?version=2`);
    expect(result).toMatchObject({ ok: true, data: { kind: "private", individualId: PERSON, sourceInvoiceId: INVOICE, sourceCoverVersion: 2 } });
    expect(source.query.mock.calls[1]?.[1]).toEqual([INVOICE, 2]);
    expect(source.query.mock.calls[0]?.[0]).not.toContain("status <> 'void'");
  });

  it("keeps owner scope and rejects missing, malformed or forged versions", async () => {
    expect(await creationDocumentContext(access({ owner: true, version: 1 }).value, `/api/classes/invoices/${INVOICE}/cover-sheet?version=1`)).toMatchObject({ ok: true, data: { kind: "owner", sourceCoverVersion: 1 } });
    expect(await creationDocumentContext(access().value, `/api/classes/invoices/${INVOICE}/cover-sheet?version=9`)).toMatchObject({ ok: false, code: "not_found" });
    for (const suffix of ["pdf?version=2", "cover-sheet?version=0", "cover-sheet?version=-1", "cover-sheet?version=2147483648", "cover-sheet?version=2&individualId=forged"]) {
      expect(await creationDocumentContext(access().value, `/api/classes/invoices/${INVOICE}/${suffix}`)).toMatchObject({ ok: false, code: "validation" });
    }
  });

  it("retains subject and external-account restrictions for historical outputs", async () => {
    for (const options of [{ allowed: false }, { external: true }]) {
      const source = access({ ...options, version: 2 });
      expect(await creationDocumentContext(source.value, `/api/classes/invoices/${INVOICE}/cover-sheet?version=2`)).toMatchObject({ ok: false, code: "not_found" });
      expect(source.query).toHaveBeenCalledOnce();
    }
  });
});
