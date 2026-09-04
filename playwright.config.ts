import { defineConfig } from "@playwright/test";
import path from "node:path";
import {
  BASE_URL,
  shouldUseE2eWsProxy,
  TEST_DB_URL,
  WS_PROXY_PORT,
} from "./tests/e2e/fixtures";

/**
 * End-to-end (smoke) suite. Boots the REAL production build against an
 * explicitly disposable PostgreSQL database and exercises the key public and
 * authenticated flows through a real browser.
 *
 * The application uses the Neon serverless driver, which speaks the Postgres
 * wire protocol over a WebSocket and cannot open a socket to a local server.
 * `scripts/ws-proxy.ts` bridges the two only for a local database. A remote
 * Neon endpoint keeps its native secure transport and bypasses that proxy (see
 * docs/deployment.md, "Running against a local PostgreSQL").
 *
 * A managed Playwright browser is used by default. Set PW_CHROMIUM_PATH only
 * when the runtime provides a pre-installed browser in a nonstandard location.
 *
 * Specs are named *.spec.ts and live in tests/e2e/, so vitest (which only
 * collects tests/ ** /*.test.ts) never picks them up.
 */

const CHROMIUM_PATH = process.env.PW_CHROMIUM_PATH?.trim();
const browserLaunchOptions = CHROMIUM_PATH
  ? { executablePath: CHROMIUM_PATH }
  : undefined;

const useWsProxy = shouldUseE2eWsProxy(TEST_DB_URL);
const proxyServer = {
  command: "npm run dev:ws-proxy",
  port: WS_PROXY_PORT,
  reuseExistingServer: false,
  timeout: 30_000,
  env: { WS_PROXY_PORT: String(WS_PROXY_PORT) },
} as const;
const appServer = {
  command: "node --import tsx tests/e2e/seed.ts && npm run build && npm run start",
  url: BASE_URL,
  reuseExistingServer: false,
  timeout: 300_000,
  stdout: "pipe",
  stderr: "pipe",
  env: {
    DATABASE_URL: TEST_DB_URL,
    TEST_DATABASE_URL: TEST_DB_URL,
    ...(useWsProxy ? { NEON_WS_PROXY: `127.0.0.1:${WS_PROXY_PORT}` } : {}),
    AUTH_SECRET: "test-e2e-secret-0123456789",
    PORT: "3000",
  },
} as const;

export default defineConfig({
  testDir: path.join(__dirname, "tests", "e2e"),
  testMatch: /.*\.spec\.ts$/,

  // A boot-the-real-app smoke suite: keep it serial and deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(browserLaunchOptions ? { launchOptions: browserLaunchOptions } : {}),
  },

  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        ...(browserLaunchOptions ? { launchOptions: browserLaunchOptions } : {}),
      },
    },
  ],

  webServer: useWsProxy ? [proxyServer, appServer] : [appServer],
});
