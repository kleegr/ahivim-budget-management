import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  canManageHourAuthorizations,
  containsFinancialAuthorizationFields,
  redactHourAuthorizationResult,
} from "@/lib/auth/hour-authorization-access";

const AUTHORIZATION_ID = "00000000-0000-4000-8000-000000000001";
const PERIOD_ID = "00000000-0000-4000-8000-000000000002";
const PROGRAM_ID = "00000000-0000-4000-8000-000000000003";
const INDIVIDUAL_ID = "00000000-0000-4000-8000-000000000004";

const mocks = vi.hoisted(() => ({
  getHourAuthorizationOperator: vi.fn(),
  canCreateHourProgramBudget: vi.fn(),
  canCreateHourAuthorization: vi.fn(),
  canChangeHourAuthorization: vi.fn(),
  createProgramBudget: vi.fn(),
  createAuthorization: vi.fn(),
  reviseAuthorization: vi.fn(),
  cancelAuthorization: vi.fn(),
  apiUser: vi.fn(),
  getPool: vi.fn(),
  listProgramBudgets: vi.fn(),
}));

vi.mock("@/lib/auth/hour-authorization-access", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth/hour-authorization-access")>(),
  getHourAuthorizationOperator: mocks.getHourAuthorizationOperator,
  canCreateHourProgramBudget: mocks.canCreateHourProgramBudget,
  canCreateHourAuthorization: mocks.canCreateHourAuthorization,
  canChangeHourAuthorization: mocks.canChangeHourAuthorization,
}));
vi.mock("@/lib/manage/program-budgets", () => ({ createProgramBudget: mocks.createProgramBudget }));
vi.mock("@/lib/manage/authorizations", () => ({
  createAuthorization: mocks.createAuthorization,
  reviseAuthorization: mocks.reviseAuthorization,
  cancelAuthorization: mocks.cancelAuthorization,
}));
vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/data/program-budgets", () => ({ listProgramBudgets: mocks.listProgramBudgets }));

import { POST as createProgramBudget } from "@/app/api/program-budgets/route";
import { POST as createAuthorization } from "@/app/api/authorizations/route";
import { PATCH as changeAuthorization } from "@/app/api/authorizations/[id]/route";

function request(path: string, method: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

function resultRecord() {
  return {
    authorizationId: AUTHORIZATION_ID,
    id: AUTHORIZATION_ID,
    budgetPeriodId: PERIOD_ID,
    individualId: INDIVIDUAL_ID,
    programId: PROGRAM_ID,
    authorizedHours: "120.0000",
    authorizedDollars: "3000.0000",
    consumedDollars: "200.0000",
    remainingDollars: "2800.0000",
    internalRate: "21.0000",
    agencyRate: "25.0000",
    individualRateOverride: "23.0000",
  };
}

describe("budget planner hour-authorization capability", () => {
  it("requires planning-management, full-roster, and hour-budget visibility", () => {
    expect(canManageHourAuthorizations({
      canPlan: true,
      canManagePlanning: false,
      canSeeHours: true,
      canSeeBudgets: true,
      full: false,
      allIndividuals: true,
      allEmployees: true,
    })).toBe(false);
    expect(canManageHourAuthorizations({
      canPlan: true,
      canManagePlanning: true,
      canSeeHours: true,
      canSeeBudgets: true,
      full: false,
      allIndividuals: true,
      allEmployees: true,
    })).toBe(true);
    expect(canManageHourAuthorizations({
      canPlan: true,
      canManagePlanning: true,
      canSeeHours: true,
      canSeeBudgets: false,
      full: false,
      allIndividuals: true,
      allEmployees: true,
    })).toBe(false);
    expect(canManageHourAuthorizations({
      canPlan: true,
      canManagePlanning: true,
      canSeeHours: true,
      canSeeBudgets: true,
      full: false,
      allEmployees: false,
      allIndividuals: true,
    })).toBe(false);
  });

  it("recognizes every financial authorization input and scrubs every amount response", () => {
    for (const field of [
      "authorizedDollars",
      "internalRate",
      "agencyRate",
      "individualRateOverride",
    ]) {
      expect(containsFinancialAuthorizationFields({ [field]: null }), field).toBe(true);
    }
    const redacted = redactHourAuthorizationResult(resultRecord());
    expect(redacted).toMatchObject({
      authorizedHours: "120.0000",
      authorizedDollars: null,
      consumedDollars: null,
      remainingDollars: null,
      internalRate: null,
      agencyRate: null,
      individualRateOverride: null,
    });
    expect(JSON.stringify(redacted)).not.toMatch(/3000|2800|21\.0000|25\.0000|23\.0000/);
  });
});

describe("budget planner authorization routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const pool = { query: vi.fn() };
    mocks.getHourAuthorizationOperator.mockResolvedValue({
      mode: "hours_only",
      user: { id: "planner", role: "viewer" },
      scope: { planner: true },
      pool,
    });
    mocks.canCreateHourProgramBudget.mockResolvedValue(true);
    mocks.canCreateHourAuthorization.mockResolvedValue(true);
    mocks.canChangeHourAuthorization.mockResolvedValue(true);
    mocks.createProgramBudget.mockResolvedValue({ ok: true, data: resultRecord() });
    mocks.createAuthorization.mockResolvedValue({ ok: true, data: resultRecord() });
    mocks.reviseAuthorization.mockResolvedValue({ ok: true, data: resultRecord() });
    mocks.cancelAuthorization.mockResolvedValue({ ok: true, data: resultRecord() });
  });

  it("denies hour-authorization mutations when Planning is read-only", async () => {
    mocks.getHourAuthorizationOperator.mockResolvedValue(null);

    const createPeriodResponse = await createProgramBudget(request("/api/program-budgets", "POST", {
      individualId: INDIVIDUAL_ID,
      programId: PROGRAM_ID,
      authorizedHours: "120",
    }));
    const createAuthorizationResponse = await createAuthorization(request("/api/authorizations", "POST", {
      budgetPeriodId: PERIOD_ID,
      programId: PROGRAM_ID,
      authorizedHours: "80",
    }));
    const changeAuthorizationResponse = await changeAuthorization(
      request(`/api/authorizations/${AUTHORIZATION_ID}`, "PATCH", { authorizedHours: "140" }),
      { params: Promise.resolve({ id: AUTHORIZATION_ID }) },
    );

    expect(createPeriodResponse.status).toBe(403);
    expect(createAuthorizationResponse.status).toBe(403);
    expect(changeAuthorizationResponse.status).toBe(403);
    expect(mocks.createProgramBudget).not.toHaveBeenCalled();
    expect(mocks.createAuthorization).not.toHaveBeenCalled();
    expect(mocks.reviseAuthorization).not.toHaveBeenCalled();
  });

  it("creates an hours-only program authorization and redacts its server response", async () => {
    const response = await createProgramBudget(request("/api/program-budgets", "POST", {
      individualId: INDIVIDUAL_ID,
      programId: PROGRAM_ID,
      authorizedHours: "120",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mocks.canCreateHourProgramBudget).toHaveBeenCalled();
    expect(mocks.createProgramBudget).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ rateBasis: expect.anything(), source: expect.anything() }),
      "planner",
      null,
    );
    expect(body.data).toMatchObject({ authorizedHours: "120.0000", internalRate: null, agencyRate: null });
    expect(JSON.stringify(body)).not.toMatch(/3000|2800|21\.0000|25\.0000|23\.0000/);
  });

  it("rejects a planner's dollar or rate fields before any write", async () => {
    const response = await createProgramBudget(request("/api/program-budgets", "POST", {
      individualId: INDIVIDUAL_ID,
      programId: PROGRAM_ID,
      authorizedHours: "120",
      agencyRate: null,
    }));

    expect(response.status).toBe(403);
    expect(mocks.canCreateHourProgramBudget).not.toHaveBeenCalled();
    expect(mocks.createProgramBudget).not.toHaveBeenCalled();
  });

  it("denies dollar and mixed programs at the server lookup", async () => {
    mocks.canCreateHourProgramBudget.mockResolvedValue(false);
    const response = await createProgramBudget(request("/api/program-budgets", "POST", {
      individualId: INDIVIDUAL_ID,
      programId: PROGRAM_ID,
      authorizedHours: "120",
    }));

    expect(response.status).toBe(404);
    expect(mocks.createProgramBudget).not.toHaveBeenCalled();
  });

  it("allows direct hour authorization creation without returning financial snapshots", async () => {
    const response = await createAuthorization(request("/api/authorizations", "POST", {
      budgetPeriodId: PERIOD_ID,
      programId: PROGRAM_ID,
      authorizedHours: "80",
      rateBasis: "dollars",
      source: "forged",
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mocks.createAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      {
        budgetPeriodId: PERIOD_ID,
        programId: PROGRAM_ID,
        authorizedHours: "80",
        notes: null,
      },
      "planner",
      null,
    );
    expect(body.data.internalRate).toBeNull();
    expect(body.data.authorizedDollars).toBeNull();
  });

  it("revises or cancels an hour authorization but rejects financial revisions", async () => {
    const revised = await changeAuthorization(
      request(`/api/authorizations/${AUTHORIZATION_ID}`, "PATCH", {
        authorizedHours: "140",
        reason: "Hours renewed",
        rateBasis: "dollars",
      }),
      { params: Promise.resolve({ id: AUTHORIZATION_ID }) },
    );
    expect(revised.status).toBe(200);
    expect(mocks.reviseAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      AUTHORIZATION_ID,
      { authorizedHours: "140" },
      "planner",
      "Hours renewed",
    );

    const blocked = await changeAuthorization(
      request(`/api/authorizations/${AUTHORIZATION_ID}`, "PATCH", {
        authorizedHours: "140",
        authorizedDollars: "1",
        reason: "Try dollars",
      }),
      { params: Promise.resolve({ id: AUTHORIZATION_ID }) },
    );
    expect(blocked.status).toBe(403);

    const cancelled = await changeAuthorization(
      request(`/api/authorizations/${AUTHORIZATION_ID}`, "PATCH", {
        action: "cancel",
        reason: "No longer authorized",
      }),
      { params: Promise.resolve({ id: AUTHORIZATION_ID }) },
    );
    expect(cancelled.status).toBe(200);
    expect(mocks.cancelAuthorization).toHaveBeenCalled();
  });

  it("preserves full manager behavior for mixed and dollar authorizations", async () => {
    mocks.getHourAuthorizationOperator.mockResolvedValue({
      mode: "full",
      user: { id: "manager", role: "manager" },
      scope: { full: true },
      pool: { query: vi.fn() },
    });
    const response = await createProgramBudget(request("/api/program-budgets", "POST", {
      individualId: INDIVIDUAL_ID,
      programId: PROGRAM_ID,
      authorizedHours: "120",
      authorizedDollars: "3000",
      agencyRate: "25",
    }));

    expect(response.status).toBe(201);
    expect(mocks.canCreateHourProgramBudget).not.toHaveBeenCalled();
    expect(mocks.createProgramBudget).toHaveBeenCalled();
    expect((await response.json()).data.agencyRate).toBe("25.0000");
  });
});
