import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiClassFinancialUser: vi.fn(),
}));

vi.mock("@/lib/auth/class-financial-access", () => ({
  apiClassFinancialUser: mocks.apiClassFinancialUser,
  canAccessClassIndividual: vi.fn(() => false),
}));

import { GET as listActivities, POST as createActivity } from "@/app/api/classes/activities/route";
import { PATCH as updateActivity } from "@/app/api/classes/activities/[id]/route";
import { GET as listBudgets, POST as createBudget } from "@/app/api/classes/budgets/route";
import { GET as getBudget, PATCH as updateBudget } from "@/app/api/classes/budgets/[id]/route";
import { GET as listInvoices, POST as createInvoice } from "@/app/api/classes/invoices/route";
import { DELETE as discardInvoice, GET as getInvoice, PATCH as updateInvoice } from "@/app/api/classes/invoices/[id]/route";
import { POST as issueInvoice } from "@/app/api/classes/invoices/[id]/issue/route";
import { POST as voidInvoice } from "@/app/api/classes/invoices/[id]/void/route";
import { GET as downloadInvoicePdf } from "@/app/api/classes/invoices/[id]/pdf/route";
import { GET as downloadCoverSheet, POST as finalizeCoverSheet } from "@/app/api/classes/invoices/[id]/cover-sheet/route";
import { GET as generateDates } from "@/app/api/classes/invoices/dates/route";
import { GET as getProfile, PATCH as updateProfile } from "@/app/api/classes/profiles/[individualId]/route";

const ID = "00000000-0000-4000-8000-000000000001";
const params = { params: Promise.resolve({ id: ID }) };
const profileParams = { params: Promise.resolve({ individualId: ID }) };

function request(path: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET"): NextRequest {
  return new NextRequest(`http://localhost${path}`, method === "GET" ? undefined : {
    method,
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

describe("class financial API authorization boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiClassFinancialUser.mockResolvedValue(null);
  });

  const cases: Array<[string, () => Promise<Response>]> = [
    ["list activities", () => listActivities(request("/api/classes/activities"))],
    ["create activity", () => createActivity(request("/api/classes/activities", "POST"))],
    ["update activity", () => updateActivity(request(`/api/classes/activities/${ID}`, "PATCH"), params)],
    ["list budgets", () => listBudgets(request("/api/classes/budgets"))],
    ["create budget", () => createBudget(request("/api/classes/budgets", "POST"))],
    ["read budget", () => getBudget(request(`/api/classes/budgets/${ID}`), params)],
    ["update budget", () => updateBudget(request(`/api/classes/budgets/${ID}`, "PATCH"), params)],
    ["list invoices", () => listInvoices(request("/api/classes/invoices"))],
    ["create invoice", () => createInvoice(request("/api/classes/invoices", "POST"))],
    ["read invoice", () => getInvoice(request(`/api/classes/invoices/${ID}`), params)],
    ["update invoice", () => updateInvoice(request(`/api/classes/invoices/${ID}`, "PATCH"), params)],
    ["discard invoice draft", () => discardInvoice(request(`/api/classes/invoices/${ID}`, "DELETE"), params)],
    ["issue invoice", () => issueInvoice(request(`/api/classes/invoices/${ID}/issue`, "POST"), params)],
    ["void invoice", () => voidInvoice(request(`/api/classes/invoices/${ID}/void`, "POST"), params)],
    ["download invoice PDF", () => downloadInvoicePdf(request(`/api/classes/invoices/${ID}/pdf`), params)],
    ["download reimbursement cover sheet", () => downloadCoverSheet(request(`/api/classes/invoices/${ID}/cover-sheet`), params)],
    ["finalize reimbursement cover sheet", () => finalizeCoverSheet(request(`/api/classes/invoices/${ID}/cover-sheet`, "POST"), params)],
    ["generate dates", () => generateDates(request("/api/classes/invoices/dates?month=2026-07"))],
    ["read reimbursement profile", () => getProfile(request(`/api/classes/profiles/${ID}`), profileParams)],
    ["update reimbursement profile", () => updateProfile(request(`/api/classes/profiles/${ID}`, "PATCH"), profileParams)],
  ];

  it.each(cases)("denies %s before any class query runs", async (_label, invoke) => {
    const response = await invoke();
    expect(response.status).toBe(403);
    expect(mocks.apiClassFinancialUser).toHaveBeenCalled();
  });

  it("requires management access for sensitive reimbursement details", async () => {
    await getProfile(request(`/api/classes/profiles/${ID}`), profileParams);
    expect(mocks.apiClassFinancialUser).toHaveBeenLastCalledWith("manage");
    await downloadCoverSheet(request(`/api/classes/invoices/${ID}/cover-sheet`), params);
    expect(mocks.apiClassFinancialUser).toHaveBeenLastCalledWith("manage");
  });
});
