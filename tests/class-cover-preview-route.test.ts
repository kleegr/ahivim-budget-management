import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  accessibleClassInvoice: vi.fn(),
  getClassCoverSheetSnapshot: vi.fn(),
  getClassReimbursementProfile: vi.fn(),
  buildClassCoverSheetPdf: vi.fn(),
}));

vi.mock("@/lib/class-route-helpers", () => ({
  accessibleClassInvoice: mocks.accessibleClassInvoice,
}));
vi.mock("@/lib/data/class-reimbursement-profiles", () => ({
  getClassCoverSheetSnapshot: mocks.getClassCoverSheetSnapshot,
  getClassReimbursementProfile: mocks.getClassReimbursementProfile,
}));
vi.mock("@/lib/documents/class-cover-sheet-pdf", () => ({
  buildClassCoverSheetPdf: mocks.buildClassCoverSheetPdf,
}));
vi.mock("@/lib/manage/class-reimbursement-profiles", () => ({
  createClassCoverSheetSnapshot: vi.fn(),
}));

import { GET } from "@/app/api/classes/invoices/[id]/cover-sheet/route";

const ID = "00000000-0000-4000-8000-000000000001";
const INDIVIDUAL_ID = "00000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({ id: ID }) };
const invoice = { id: ID, individualId: INDIVIDUAL_ID, invoiceNumber: "8514", status: "issued" };
const profile = { individualId: INDIVIDUAL_ID, mailingName: "Sample Individual" };

describe("class cover-sheet preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accessibleClassInvoice.mockResolvedValue({ invoice, access: { pool: {} } });
    mocks.buildClassCoverSheetPdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  });

  it("renders the current saved profile inline without freezing a snapshot", async () => {
    mocks.getClassReimbursementProfile.mockResolvedValue(profile);
    const request = new NextRequest(`http://localhost/api/classes/invoices/${ID}/cover-sheet?preview=1`);

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(mocks.getClassReimbursementProfile).toHaveBeenCalledWith({}, INDIVIDUAL_ID);
    expect(mocks.getClassCoverSheetSnapshot).not.toHaveBeenCalled();
    expect(mocks.buildClassCoverSheetPdf).toHaveBeenCalledWith(invoice, profile);
  });

  it("keeps the ordinary download tied to the frozen snapshot", async () => {
    mocks.getClassCoverSheetSnapshot.mockResolvedValue(profile);
    const request = new NextRequest(`http://localhost/api/classes/invoices/${ID}/cover-sheet`);

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(mocks.getClassCoverSheetSnapshot).toHaveBeenCalledWith({}, ID);
    expect(mocks.getClassReimbursementProfile).not.toHaveBeenCalled();
  });
});
