import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3100;
const BASE_PATH_PORT = 3101;
export const BASE_PATH = "/portal";
const CI = !!process.env.CI;

// A fresh home per server and run: no owner, no wallets, nothing from the developer's own Portal.
// A home rather than `--data-root`, which the server refuses unless it matches the crate's own
// path under the home. Set once in the runner so the workers, which re-read this file, inherit it.
process.env.PORTAL_E2E_HOME ??= mkdtempSync(join(tmpdir(), "portal-e2e-"));
process.env.PORTAL_E2E_BASE_HOME ??= mkdtempSync(join(tmpdir(), "portal-e2e-base-"));

/**
 * Built, then run with the swapped home: under `cargo run` cargo itself would look for its
 * toolchain there. Both servers build; the second waits on cargo's lock and finds nothing to do.
 */
const server = (home: string, port: number, args: string) => ({
  command:
    `cargo build --quiet -p portal-web && HOME="${home}" target/debug/portal-web ` +
    `--bind 127.0.0.1:${port} --access-profile development-loopback ${args}`,
  // A cold build compiles the server first.
  timeout: 15 * 60_000,
  reuseExistingServer: false,
  stdout: "ignore" as const,
  stderr: "pipe" as const,
});

/**
 * Three suites against the real `portal-web`:
 *
 * - `server` talks to its real API: sign-in, sessions, CSRF, the connection gate.
 * - `ui` intercepts the API with `e2e/support/fake-portal.ts`, so every screen can be put in an
 *   exact state without a chain or Tor.
 * - `base-path` runs a second server under `--base-path`, serving a build made for that prefix.
 *
 * The UI has to be built first, twice: `npm run test:e2e` does it.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // The intro sequences honour it, and skipping them keeps every test off a timer.
    contextOptions: { reducedMotion: "reduce" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "server",
      testDir: "e2e/server",
      // A retry replays the serial group from its first test, which claims an installation the
      // first attempt already claimed.
      retries: 0,
      use: { ...devices["Desktop Chrome"] },
    },
    { name: "ui", testDir: "e2e/ui", use: { ...devices["Desktop Chrome"] } },
    {
      name: "base-path",
      testDir: "e2e/base-path",
      retries: 0,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${BASE_PATH_PORT}` },
    },
  ],
  webServer: [
    {
      ...server(process.env.PORTAL_E2E_HOME, PORT, "--assets-dir dist/web"),
      url: `http://127.0.0.1:${PORT}/health/live`,
    },
    {
      ...server(
        process.env.PORTAL_E2E_BASE_HOME,
        BASE_PATH_PORT,
        `--assets-dir dist/web-base --base-path ${BASE_PATH}`,
      ),
      url: `http://127.0.0.1:${BASE_PATH_PORT}${BASE_PATH}/health/live`,
    },
  ],
});
