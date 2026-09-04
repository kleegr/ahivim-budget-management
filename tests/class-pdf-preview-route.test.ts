import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  accessibleClassInvoice: vi.fn(),
  buildClassInvoicePdf: vi.fn(),
}));

vi.mock("@/lib/class-route-helpers", () => ({
  accessibleClassInvoice: mocks.accessibleClassInvoice,
}));

vi.mock("@/lib/documents/class-invoice-pdf", () => ({
  buildClassInvoicePdf: mocks.buildClassInvoicePdf,
}));

import { GET } from "@/app/api/classes/invoices/[id]/pdf/route";

const ID = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id: ID }) };

function request(query = "") {
  return new NextRequest(`http://localhost/api/classes/invoices/${ID}/pdf${query}`);
}

function invoice(status: "draft" | "issued" | "void") {
  return { id: ID, invoiceNumber: "8514", status };
}

describe("class invoice PDF preview route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildClassInvoicePdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  });

  it("renders a draft only as a management-only inline preview", async () => {
    const draft = invoice("draft");
    mocks.accessibleClassInvoice.mockResolvedValue({ invoice: draft, access: {} });

    const response = await GET(request("?preview=1"), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(mocks.accessibleClassInvoice).toHaveBeenCalledWith(ID, "manage");
    expect(mocks.buildClassInvoicePdf).toHaveBeenCalledWith(draft, { draft: true });
  });

  it("keeps ordinary draft downloads blocked", async () => {
    mocks.accessibleClassInvoice.mockResolvedValue({ invoice: invoice("draft"), access: {} });

    const response = await GET(request(), context);

    expect(response.status).toBe(409);
    expect(mocks.accessibleClassInvoice).toHaveBeenCalledWith(ID, "view");
    expect(mocks.buildClassInvoicePdf).not.toHaveBeenCalled();
  });

  it("keeps issued downloads available and rejects voided records", async () => {
    mocks.accessibleClassInvoice.mockResolvedValueOnce({ invoice: invoice("issued"), access: {} });
    const issued = await GET(request(), context);
    expect(issued.status).toBe(200);
    expect(issued.headers.get("content-disposition")).toContain("attachment");

    mocks.accessibleClassInvoice.mockResolvedValueOnce({ invoice: invoice("void"), access: {} });
    const voided = await GET(request("?preview=1"), context);
    expect(voided.status).toBe(409);
  });
});
