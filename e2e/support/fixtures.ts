import { test as base, expect, type Page } from "@playwright/test";
import { FakePortal } from "./fake-portal";

/** Console noise that says nothing about the page under test. */
const IGNORED_CONSOLE = [
  // EventSource reconnecting to the fake's finished stream.
  /EventSource/,
  // Deliberate failures a test asked the fake for surface as failed fetches.
  /Failed to load resource/,
];

export const test = base.extend<{ portal: FakePortal; errors: string[] }>({
  // Collected for every test, failing it on any uncaught exception or console error: a page
  // that renders while throwing is the regression these suites exist to catch.
  errors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !IGNORED_CONSOLE.some((re) => re.test(m.text()))) {
        errors.push(`console: ${m.text()}`);
      }
    });
    await use(errors);
    expect(errors, "the page logged errors").toEqual([]);
  },
  // Automatic, so no UI test can reach the real server by forgetting to ask for the fake.
  portal: [
    async ({ page, errors: _errors }, use) => {
      const portal = new FakePortal();
      await portal.install(page);
      await use(portal);
      expect(portal.unhandled, "the UI called commands the fake does not answer").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Lands on the wallet page and waits out its first sync. Spending stays disabled until a sync
 * succeeds, and only the wallet page (or unlocking) starts one, so flows that spend begin here
 * and navigate on, as a user would.
 */
export async function openWallet(page: Page) {
  await page.goto("/#/");
  await expect(page.getByText(/Last synced/)).toBeVisible();
}

/** By role: a required field's label also carries its asterisk. */
export const field = (page: Page, name: string) => page.getByRole("textbox", { name, exact: true });

export const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name, exact: true });
