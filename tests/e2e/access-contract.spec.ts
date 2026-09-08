import { expect, test, type APIResponse } from "@playwright/test";
import { ACCESS_CONTRACT } from "./access-contract";
import { REPRESENTATIVE_ACCOUNTS, passwordFor, UNLINKED_EMPLOYEE_ID, UNLINKED_INDIVIDUAL_ID } from "./fixtures";

async function verifyDecision(response: APIResponse, allowed: boolean) {
  expect(response.status(), `${response.url()} expected ${allowed ? "allowed" : "denied"}`).toBe(allowed ? 200 : 403);
  if (!allowed) {
    expect(response.headers()["content-disposition"]).toBeUndefined();
    expect(await response.text()).not.toContain("E2E-PRIVATE");
  }
}

test.describe("13-preset server route/action/field contract", () => {
  for (const account of REPRESENTATIVE_ACCOUNTS) {
    test(`${account.preset} direct-login requests enforce its server contract`, async ({ page }) => {
      const contract = ACCESS_CONTRACT[account.preset];
      await page.goto("/signin");
      await page.getByLabel("Email address").fill(account.email);
      await page.getByLabel("Password", { exact: true }).fill(passwordFor(account));
      await page.getByRole("button", { name: /^sign in$/i }).click();
      await page.waitForURL(url => url.pathname === account.expectedPath);
      const api = page.request;

      await verifyDecision(await api.get("/api/admin/users"), contract.users);
      await verifyDecision(await api.get("/api/agency-financials/export?month=2026-09&format=csv"), contract.ownerExport);
      const classResponse = await api.get("/api/classes/invoices");
      await verifyDecision(classResponse, contract.classInvoices);
      if (contract.classInvoices) expect((await classResponse.json()).data.length).toBeGreaterThan(0);

      // This exporter serializes only client-supplied data, but still requires
      // the transaction capability. No business mutation occurs.
      await verifyDecision(await api.post("/api/transactions/export", {
        headers: { origin: new URL(page.url()).origin },
        data: { format: "csv", columns: [{ key: "value", header: "Value", type: "text" }], rows: [{ value: "D2-EXPORT-CAPABILITY-SENTINEL" }] },
      }), contract.transactionExport);

      if (contract.safeEmployeeRoster) {
        const response = await api.get("/api/employees?includeArchived=true");
        expect(response.status()).toBe(200);
        const employees = (await response.json()).data;
        expect(employees.length).toBeGreaterThan(0);
        for (const employee of employees) {
          expect(Object.keys(employee).sort()).toEqual(["archivedAt", "displayName", "id", "status"]);
        }
        const programs = await api.get("/api/programs");
        expect(programs.status()).toBe(200);
        for (const program of (await programs.json()).data) {
          expect(program.agencyRate).toBeNull();
          expect(program.internalRate).toBeNull();
        }
      }

      if (account.external || account.preset === "custom_access") {
        for (const path of [`/api/individuals/${UNLINKED_INDIVIDUAL_ID}`, `/api/employees/${UNLINKED_EMPLOYEE_ID}`]) {
          const response = await api.get(path);
          expect(response.status()).toBe(404);
          expect(await response.text()).not.toContain("Private Unlinked");
        }
      }

      if (!contract.users) {
        // A denied authority change must never reach the database write path.
        const attempt = await api.patch(`/api/admin/users/00000000-0000-4000-8000-000000000099`, {
          headers: { origin: new URL(page.url()).origin },
          data: { role: "admin", preset: "owner", reason: "D2 forbidden authority injection" },
        });
        expect(attempt.status()).toBe(403);
      }

      await page.reload();
      expect(new URL(page.url()).pathname).toBe(account.expectedPath);
      await api.post("/api/auth/logout", { headers: { origin: new URL(page.url()).origin } });
      expect((await api.get("/api/admin/users")).status()).toBe(401);
    });
  }
});
