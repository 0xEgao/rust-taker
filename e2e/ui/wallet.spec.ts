import { test, expect, nav, openWallet } from "../support/fixtures";
import { SWAP_ID } from "../support/fake-portal";

/** Every wallet-side page, reached the way a user reaches it, rendering without errors. */
const PAGES: { link: string; heading: string }[] = [
  { link: "Market", heading: "Market" },
  { link: "Tx", heading: "Send & Receive" },
  { link: "Swap", heading: "Initiate Swap" },
  { link: "Router Console", heading: "Router fleet" },
];

test("the wallet page shows balances, coins and history", async ({ page }) => {
  await openWallet(page);
  const main = page.getByRole("main");
  await expect(main).toContainText(/Total balance\s*1,550,000 satoshis/);
  await expect(main.getByRole("heading", { name: "UTXOs" })).toBeVisible();
  await expect(main.getByText("2 total")).toBeVisible();

  await main.getByRole("button", { name: "Received" }).click();
  await expect(main.getByRole("button", { name: /0{63}1/ })).toBeVisible();
  await expect(main.getByRole("button", { name: /0{63}2/ })).toHaveCount(0);
});

for (const { link, heading } of PAGES) {
  test(`navigates to ${link}`, async ({ page }) => {
    await openWallet(page);
    await nav(page, link).click();
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
  });
}

test("logs, reports and recovery open from their links", async ({ page }) => {
  await openWallet(page);
  await page.getByRole("link", { name: "Logs" }).click();
  await expect(page.getByText("e2e log line")).toBeVisible();

  await page.goto("/#/swap/reports");
  await page.getByRole("link", { name: new RegExp(SWAP_ID) }).click();
  await expect(page.getByRole("heading", { name: SWAP_ID })).toBeVisible();
  await expect(page.getByRole("main")).toContainText(/Total fee\s*1,800 satoshis/);

  await page.goto("/#/swap/recovery");
  await expect(page.getByText("Nothing to recover")).toBeVisible();
});

test("signing out closes the wallet and returns to the role picker", async ({ page, portal }) => {
  await openWallet(page);
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page).toHaveURL(/#\/launch$/);
  await expect(page.getByText("Choose how you want to use it.")).toBeVisible();
  expect(portal.callsTo("shutdown_taker")).toHaveLength(1);
});

test("the market lists router offers and can drop one", async ({ page, portal }) => {
  await openWallet(page);
  await nav(page, "Market").click();
  await expect(page.getByText("3 good offers").first()).toBeVisible();

  await page.getByRole("button", { name: "Remove" }).first().click();
  const confirm = page.getByRole("dialog", { name: "Remove router?" });
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(confirm).toHaveCount(0);
  await expect.poll(() => portal.callsTo("remove_maker")).toEqual([
    { address: expect.stringMatching(/^router1/) },
  ]);
});
