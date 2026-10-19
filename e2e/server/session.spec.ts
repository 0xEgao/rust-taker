import { test, expect, type Page } from "@playwright/test";

/**
 * Against the real `portal-web`, started on a fresh home by `playwright.config.ts`. Serial: the
 * first test claims the installation and the rest depend on that owner existing.
 *
 * Stops at the connection gate. Past it every page needs a bootstrapped Tor and a chain backend,
 * which the `ui` suite fakes instead.
 */
test.describe.configure({ mode: "serial" });

const OWNER_PASSWORD = "e2e owner password";

const field = (page: Page, name: string) => page.getByRole("textbox", { name, exact: true });

async function signIn(page: Page, password = OWNER_PASSWORD) {
  await page.goto("/");
  await expect(page).toHaveURL(/#\/login$/);
  await field(page, "Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("the server is live and serves the app", async ({ request, page }) => {
  expect((await request.get("/health/live")).ok()).toBe(true);
  await page.goto("/");
  await expect(page).toHaveTitle(/Portal/);
});

test("the first visitor claims the installation", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.getByText("Portal has no password yet.")).toBeVisible();

  await field(page, "New password").fill(OWNER_PASSWORD);
  await field(page, "Confirm password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Set password and continue" }).click();

  // The connection gate, served by the real backend: its own presets and its own Tor.
  await expect(page).toHaveURL(/#\/connect$/);
  await expect(page.getByRole("heading", { name: "Choose your backend" })).toBeVisible();
  await expect(page.getByText("Portal signet")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tor connection" })).toBeVisible();

  // A reload keeps the session: the cookie, and the CSRF token kept in localStorage.
  await page.reload();
  await expect(page).toHaveURL(/#\/connect$/);
  await expect(page.getByRole("heading", { name: "Choose your backend" })).toBeVisible();
});

test("a second claim is refused", async ({ request }) => {
  const response = await request.post("/api/v1/auth/claim", { data: { password: "another password" } });
  expect(response.status()).toBe(403);
  expect((await response.json()).error.message).toBe("this installation already has an owner");
});

test("a new browser signs in with the owner password", async ({ page }) => {
  await signIn(page, "not the password");
  await expect(page.getByText("login failed")).toBeVisible();

  await signIn(page);
  await expect(page).toHaveURL(/#\/connect$/);
});

test("commands need a session", async ({ request }) => {
  const response = await request.post("/api/v1/commands/get_session_state", { data: {} });
  expect(response.status()).toBe(401);
  expect((await response.json()).error.details.hasOwner).toBe(true);
});

test("commands that change state need the session's CSRF token", async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/#\/connect$/);
  const csrf = await page.evaluate(() => localStorage.getItem("portal.csrf"));
  expect(csrf).toBeTruthy();

  // `page.request` carries the browser's session cookie. `shutdown_taker` mutates, and with no
  // wallet open it changes nothing.
  const call = (headers: Record<string, string>) =>
    page.request.post("/api/v1/commands/shutdown_taker", { data: {}, headers });

  expect((await call({})).status()).toBe(403);
  expect((await call({ "X-CSRF-Token": "stale" })).status()).toBe(403);
  expect((await call({ "X-CSRF-Token": csrf! })).status()).toBe(200);

  // Reads are not a forgery target and go through on the cookie alone.
  const read = await page.request.post("/api/v1/commands/get_session_state", { data: {} });
  expect(read.status()).toBe(200);
  expect(await read.json()).toMatchObject({ initialized: false, walletName: null });
});

test("requests from another origin are refused", async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/#\/connect$/);
  const csrf = await page.evaluate(() => localStorage.getItem("portal.csrf"));

  const response = await page.request.post("/api/v1/auth/login", {
    data: { password: OWNER_PASSWORD },
    headers: { Origin: "https://evil.example", "X-CSRF-Token": csrf! },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).error.message).toBe("cross-origin request refused");
});

test("routes outside the app's are not answered with the app", async ({ request }) => {
  const response = await request.get("/api/v1/no-such-route");
  expect(response.status()).toBe(404);
});
