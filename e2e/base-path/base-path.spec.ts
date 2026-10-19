import { test, expect } from "@playwright/test";
import { BASE_PATH } from "../../playwright.config";

/**
 * A second real `portal-web`, mounted under `--base-path` and serving a UI built with the same
 * prefix. Everything the app reaches has to stay under it: assets, the API, the event stream and
 * the session cookie. Serial: the first test claims the installation.
 */
test.describe.configure({ mode: "serial" });

const OWNER_PASSWORD = "e2e base path owner";

test("everything is served under the prefix, and nothing at the root", async ({ request }) => {
  expect((await request.get(`${BASE_PATH}/health/live`)).ok()).toBe(true);
  expect((await request.get(`${BASE_PATH}/`)).ok()).toBe(true);
  expect((await request.get("/api/v1/session")).status()).toBe(404);
});

test("the app signs in and reaches the connection gate under the prefix", async ({ page, context }) => {
  const outside: string[] = [];
  page.on("request", (r) => {
    const { pathname } = new URL(r.url());
    if (!pathname.startsWith(`${BASE_PATH}/`)) outside.push(pathname);
  });

  await page.goto(`${BASE_PATH}/`);
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/#/login$`));
  await page.getByRole("textbox", { name: "New password", exact: true }).fill(OWNER_PASSWORD);
  await page.getByRole("textbox", { name: "Confirm password", exact: true }).fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Set password and continue" }).click();

  // The presets come from the API, so this is a round trip through the prefixed routes.
  await expect(page).toHaveURL(/#\/connect$/);
  await expect(page.getByText("Portal signet")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose your backend" })).toBeVisible();

  const [cookie] = await context.cookies();
  expect(cookie.path).toBe(BASE_PATH);
  expect(outside).toEqual([]);
});
