import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { Pool } from "pg";
import { REPRESENTATIVE_ACCOUNTS, TEST_DB_URL, passwordFor, type RepresentativeAccount } from "./fixtures";

const owner = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "owner")!;
const planner = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "budget_planner")!;
const staffing = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "staffing_manager")!;

async function signIn(page: Page, account: RepresentativeAccount) {
  await page.context().clearCookies();
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password").fill(passwordFor(account));
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => url.pathname === account.expectedPath);
}

async function post<T>(page: Page, path: string, data: Record<string, unknown>): Promise<T> {
  const response = await page.request.post(path, { data });
  const body = await response.json();
  expect(response.ok(), `${path}: ${JSON.stringify(body)}`).toBe(true);
  expect(body.ok).toBe(true);
  return body.data as T;
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function privateValues(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const location = `${path}.${key}`;
    // Null redaction slots contain no financial facts. Non-null categories,
    // including zero, must be absent from these restricted read models.
    const forbidden = /(?:amount|rate|dollar|gross|netpay|checknet|tax|paymentrecipient|checknumber|deal|settlement)/i.test(key);
    return [
      ...(forbidden && nested !== null && nested !== undefined ? [location] : []),
      ...privateValues(nested, location),
    ];
  });
}

async function metric(scope: Locator, label: string, value: string) {
  await expect(scope.getByText(label, { exact: true }).locator("..").first()).toContainText(value);
}

interface Journey {
  individualId: string;
  employeeId: string;
  programId: string;
  individualName: string;
  employeeName: string;
  programName: string;
  today: string;
  first: string;
  second: string;
  last: string;
  renewal: string;
}

async function setup(page: Page, pool: Pool): Promise<Journey> {
  await signIn(page, owner);
  const suffix = randomUUID().slice(0, 8);
  const today = (await pool.query<{ today: string }>("SELECT CURRENT_DATE::text AS today")).rows[0]!.today;
  const first = addDays(today, 7);
  const individualName = `Operations person ${suffix}`;
  const employeeName = `Operations employee ${suffix}`;
  const programName = `Operations service ${suffix}`;
  const program = await post<{ id: string }>(page, "/api/programs", {
    guidedSetup: true, name: programName, requiredAuthType: "hours",
    paymentRecipient: "agency", consumptionSource: "payroll", renewalPolicy: "individual",
    agencyRate: "25", internalRate: "21", effectiveFrom: addDays(today, -370),
    groupsAllowed: false, allowIndividualRateOverride: false,
  });
  const individual = await post<{ id: string }>(page, "/api/individuals", { displayName: individualName });
  const employee = await post<{ id: string }>(page, "/api/employees", {
    displayName: employeeName, notes: "PRIVATE EMPLOYEE DEAL SENTINEL", externalRef: `PRIVATE-PAYROLL-${suffix}`,
  });
  return {
    individualId: individual.id, employeeId: employee.id, programId: program.id,
    individualName, employeeName, programName, today, first,
    second: addDays(first, 7), last: addDays(first, 14), renewal: addDays(today, 60),
  };
}

async function cleanup(pool: Pool, journey: Journey) {
  // Only these API-created test subjects are removed; golden release fixtures
  // are untouched even when a browser assertion fails midway through a flow.
  await pool.query("DELETE FROM scheduled_sessions WHERE employee_id = $1", [journey.employeeId]);
  await pool.query("DELETE FROM schedule_series WHERE employee_id = $1", [journey.employeeId]);
  await pool.query("DELETE FROM employee_weekly_availability WHERE employee_id = $1", [journey.employeeId]);
  await pool.query("DELETE FROM employee_unavailability WHERE employee_id = $1", [journey.employeeId]);
  await pool.query("DELETE FROM individuals WHERE id = $1", [journey.individualId]);
  await pool.query("DELETE FROM employees WHERE id = $1", [journey.employeeId]);
  await pool.query("DELETE FROM programs WHERE id = $1", [journey.programId]);
}

async function createAuthorization(page: Page, journey: Journey) {
  await page.goto(`/individuals/${journey.individualId}?view=budget`);
  await page.getByRole("button", { name: "New authorization", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New program authorization" });
  await dialog.getByRole("combobox", { name: "Program", exact: true }).selectOption(journey.programId);
  await dialog.getByLabel("Period label").fill("Operations acceptance authorization");
  await dialog.getByLabel("Renewal date").fill(journey.renewal);
  await dialog.getByLabel("Authorized hours").fill("12");
  await expect(dialog.getByLabel(/rate|amount/i)).toHaveCount(0);
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/program-budgets") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  expect(privateValues(await response.json())).toEqual([]);
  await expect(dialog).toHaveCount(0);
  await metric(page.locator("#main"), "Hours authorized", "12");
}

async function assignAndSetHours(page: Page, journey: Journey, canSeeBudgets: boolean) {
  await page.goto("/schedule?view=future");
  await page.getByRole("button", { name: "New assignment", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "New assignment" });
  await dialog.getByRole("combobox", { name: "Employee", exact: true }).selectOption(journey.employeeId);
  await dialog.getByRole("combobox", { name: "Individual", exact: true }).selectOption(journey.individualId);
  await dialog.getByRole("combobox", { name: "Program", exact: true }).selectOption(journey.programId);
  await dialog.getByLabel("Starts", { exact: true }).fill(journey.today);
  await dialog.getByLabel("Ends", { exact: true }).fill(journey.last);
  if (canSeeBudgets) await dialog.getByLabel("Allowed hours").fill("12");
  else {
    // Staffing can set an assignment's hours cap. That operational field does
    // not grant access to the individual's program budget or authorization.
    await expect(dialog.getByLabel("Allowed hours")).toHaveValue("");
    expect((await page.request.get(`/api/program-budgets?individualId=${journey.individualId}`)).status()).toBe(403);
  }
  await dialog.getByRole("button", { name: "Save assignment" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: journey.individualName })).toContainText(journey.employeeName);

  await page.goto(`/schedule?view=availability&employeeId=${journey.employeeId}`);
  await page.getByRole("button", { name: "Add hours", exact: true }).click();
  dialog = page.getByRole("dialog", { name: `Add weekly hours for ${journey.employeeName}` });
  await dialog.getByRole("combobox", { name: "Day", exact: true }).selectOption(String(new Date(`${journey.first}T00:00:00Z`).getUTCDay()));
  await dialog.getByLabel("Starts", { exact: true }).fill(journey.today);
  await dialog.getByLabel("Ends", { exact: false }).fill(journey.last);
  await dialog.getByRole("button", { name: "Save hours" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "hours saved" })).toBeVisible();
}

async function sessions(page: Page, journey: Journey) {
  const response = await page.request.get(`/api/schedule/sessions?from=${journey.first}&to=${journey.last}&employeeId=${journey.employeeId}`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(privateValues(body)).toEqual([]);
  return body.data.sessions as Array<{ id: string; seriesId: string; sessionDate: string; startTime: string; durationHours: string; status: string }>;
}

async function createSchedule(page: Page, journey: Journey) {
  await page.goto(`/schedule?view=schedules&employeeId=${journey.employeeId}&individualId=${journey.individualId}&programId=${journey.programId}`);
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New service schedule" });
  await dialog.locator('input[type="date"]').nth(0).fill(journey.first);
  await dialog.locator('input[type="date"]').nth(1).fill(journey.last);
  await dialog.locator('input[type="time"]').nth(0).fill("09:00");
  await dialog.locator('input[type="time"]').nth(1).fill("11:00");
  await expect(dialog.getByText("3 visits · 6 h per individual", { exact: true })).toBeVisible();
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/schedule/series") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Create schedule", exact: true }).click();
  expect((await saved).status()).toBe(201);
  await expect(dialog).toHaveCount(0);
  const result = await sessions(page, journey);
  expect(result).toHaveLength(3);
  expect(result.map((session) => session.sessionDate).sort()).toEqual([journey.first, journey.second, journey.last]);
  return result;
}

async function timeOffAndRevision(page: Page, journey: Journey) {
  await page.goto(`/schedule?view=availability&employeeId=${journey.employeeId}`);
  await page.getByRole("button", { name: "Add time off", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: `Add time off for ${journey.employeeName}` });
  await dialog.getByLabel("Starts", { exact: true }).fill(journey.second);
  await dialog.getByLabel("Full day").uncheck();
  await dialog.getByLabel("Start", { exact: true }).fill("09:00");
  await dialog.getByLabel("End", { exact: true }).fill("11:00");
  await dialog.getByRole("button", { name: "Save time off" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Schedule review needed" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review session", exact: true })).toHaveCount(1);
  await page.getByRole("link", { name: "Review session", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Session", exact: true })).toBeVisible();

  // Apply a future revision to the last two visits. The first occurrence must
  // retain its original series and hours, while time off stops conflicting.
  await page.goto(`/schedule?view=schedules&employeeId=${journey.employeeId}`);
  await page.getByRole("button", { name: `Edit schedule for ${journey.individualName}`, exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Edit service schedule" });
  await dialog.getByLabel("Apply changes from").fill(journey.second);
  await dialog.getByLabel("Start", { exact: true }).fill("13:00");
  await dialog.getByLabel("End", { exact: true }).fill("15:00");
  await dialog.getByLabel("Change reason", { exact: false }).fill("Move later visits after the employee's time off");
  await dialog.getByRole("button", { name: "Save schedule", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const result = (await sessions(page, journey)).filter((session) => session.status === "pending");
  expect(result).toHaveLength(3);
  expect(result.find((session) => session.sessionDate === journey.first)!.startTime).toMatch(/^09:00/);
  expect(result.filter((session) => session.sessionDate >= journey.second).every((session) => /^13:00/.test(session.startTime))).toBe(true);
  expect(new Set(result.map((session) => session.seriesId)).size).toBe(2);

  await page.goto(`/schedule?view=availability&employeeId=${journey.employeeId}`);
  await expect(page.getByRole("button", { name: "Add time off", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedule review needed" })).toHaveCount(0);
  return result;
}

for (const account of [planner, staffing]) {
  test(`${account.displayName} completes assignment, hours, recurrence, time off and future revision without finance`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const pool = new Pool({ connectionString: TEST_DB_URL });
    let journey: Journey | undefined;
    try {
      journey = await setup(page, pool);
      if (account.preset === "staffing_manager") {
        await post(page, "/api/program-budgets", {
          individualId: journey.individualId, programId: journey.programId,
          authorizedHours: "12", renewalDate: journey.renewal, periodType: "rolling",
        });
      }
      await signIn(page, account);
      if (account.preset === "budget_planner") await createAuthorization(page, journey);
      const profile = await page.request.get(`/api/employees/${journey.employeeId}`);
      expect(profile.status()).toBe(200);
      expect(Object.keys((await profile.json()).data).sort()).toEqual(["archivedAt", "displayName", "id", "status"]);
      await page.goto(`/employees/${journey.employeeId}`);
      await expect(page.getByRole("heading", { level: 1, name: journey.employeeName })).toBeVisible();
      await expect(page.getByText(/PRIVATE EMPLOYEE DEAL SENTINEL|PRIVATE-PAYROLL/)).toHaveCount(0);
      await assignAndSetHours(page, journey, account.preset === "budget_planner");
      const initial = await createSchedule(page, journey);
      await testInfo.attach(`${account.preset}-desktop-recurrence`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

      // Conflict protection must reject the actual save, independently of any
      // debounced preview. The rejection must leave the three visits intact.
      const conflict = await page.request.post("/api/schedule/sessions", { data: {
        employeeId: journey.employeeId, individualIds: [journey.individualId], programId: journey.programId,
        sessionDate: journey.first, startTime: "10:00", endTime: "12:00", durationHours: "2",
      } });
      expect(conflict.status()).toBe(400);
      expect(await conflict.text()).toMatch(/override reason/i);
      expect(await sessions(page, journey)).toHaveLength(3);
      await page.setViewportSize({ width: 390, height: 844 });
      const revised = await timeOffAndRevision(page, journey);
      expect(revised.find((session) => session.sessionDate === journey.first)!.id).toBe(initial.find((session) => session.sessionDate === journey.first)!.id);

      await page.goto(`/schedule?view=schedules&employeeId=${journey.employeeId}`);
      await testInfo.attach(`${account.preset}-phone-future-revision`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      await page.getByRole("button", { name: `Edit upcoming for ${journey.individualName}`, exact: true }).first().click();
      let dialog = page.getByRole("dialog", { name: "Edit service schedule" });
      await dialog.getByLabel("Change reason", { exact: false }).fill("End the upcoming schedule after revision acceptance");
      await dialog.getByRole("button", { name: "End schedule", exact: true }).click();
      await dialog.getByRole("button", { name: "Confirm end", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const remaining = (await sessions(page, journey)).filter((session) => session.status === "pending");
      expect(remaining.map((session) => session.id)).toEqual([initial.find((session) => session.sessionDate === journey!.first)!.id]);

      if (account.preset === "budget_planner") {
        await page.goto(`/individuals/${journey.individualId}?view=budget`);
        await metric(page.locator("#main"), "Hours used", "0");
        await metric(page.locator("#main"), "Scheduled", "2");
        await metric(page.locator("#main"), "Remaining now", "12");
        await metric(page.locator("#main"), "After schedule", "10");
        await page.getByRole("button", { name: "Revise", exact: true }).click();
        dialog = page.getByRole("dialog", { name: `Revise authorization - ${journey.programName}` });
        await dialog.getByLabel("Authorized hours").fill("16");
        await dialog.getByLabel("Change reason").fill("Four additional authorized hours approved");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await metric(page.locator("#main"), "Hours authorized", "16");
        await page.getByText("Authorization revisions", { exact: false }).click();
        const history = page.locator("details").filter({ has: page.locator("summary", { hasText: "Authorization revisions" }) });
        await expect(history.getByRole("row").filter({ hasText: "Superseded" })).toContainText("12");
        await expect(history.getByRole("row").filter({ hasText: "Active" })).toContainText("16");
        await page.getByText("Monthly authorization trend", { exact: false }).click();
        await expect(page.locator("details[open]").filter({ has: page.locator("summary", { hasText: "Monthly authorization trend" }) }).getByRole("table")).toBeVisible();
        await page.getByRole("button", { name: "Cancel authorization", exact: true }).click();
        dialog = page.getByRole("dialog", { name: "Cancel authorization - reason" });
        await dialog.getByLabel("Reason for this change").fill("End the acceptance authorization after history review");
        await dialog.getByRole("button", { name: "Cancel authorization", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        const revisions = await pool.query<{ status: string; hours: string }>("SELECT status, authorized_hours::text AS hours FROM budget_authorizations WHERE individual_id = $1 ORDER BY revision", [journey.individualId]);
        expect(revisions.rows.map((revision) => revision.status)).toEqual(["superseded", "cancelled"]);
        expect(revisions.rows.map((revision) => Number(revision.hours))).toEqual([12, 16]);
      } else {
        await expect(page.getByRole("tab", { name: "Budget tracking", exact: true })).toHaveCount(0);
        expect((await page.request.post("/api/program-budgets", { data: {
          individualId: journey.individualId, programId: journey.programId, authorizedHours: "999", renewalDate: journey.renewal,
        } })).status()).toBe(403);
      }
    } finally {
      if (journey) await cleanup(pool, journey);
      await pool.end();
    }
  });
}
