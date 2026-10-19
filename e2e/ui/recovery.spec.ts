import { test, expect, field, nav, openWallet } from "../support/fixtures";
import type { RecoveryStatus, RecoverySummary } from "../../src/api/types";
import { SWAP_ID, fail } from "../support/fake-portal";

const now = () => Math.floor(Date.now() / 1000);

const summary = (): RecoverySummary => ({
  swapId: SWAP_ID,
  phase: "swapcoins_persisted",
  failureReason: "router 2 went offline",
  failedAtPhase: "contracts_exchanged",
  routerCount: 2,
  sendAmountSats: 200_000,
  resolvedCount: 1,
  active: true,
  updatedAt: now(),
  recoveryTypes: [],
  recoveryTxids: [],
});

const status = (): RecoveryStatus => ({
  active: true,
  recoveryRunning: true,
  swapId: SWAP_ID,
  phase: "swapcoins_persisted",
  failureReason: "router 2 went offline",
  failedAtPhase: "contracts_exchanged",
  routerCount: 2,
  sendAmountSats: 200_000,
  swapReceived: false,
  pending: [
    {
      outpoint: { txid: "ab".repeat(32), vout: 0 },
      amountSats: 200_000,
      claimPath: "timelock",
      confirmations: 5,
      routerOwed: false,
      blocksRemaining: 15,
      lockBlocks: 20,
    },
  ],
  resolved: [{ contractTxid: "cd".repeat(32), leg: "incoming", resolution: "hashlock", spendingTxid: "ef".repeat(32) }],
  blocksRemaining: 15,
  lockedSats: 200_000,
  routerOwedSats: 0,
  updatedAt: now(),
});

async function startSwap(page: import("@playwright/test").Page) {
  await openWallet(page);
  await nav(page, "Swap").click();
  await field(page, "Amount").fill("200000");
  await page.getByRole("button", { name: "Start Swap" }).click();
  await page.getByRole("button", { name: "Start swap" }).click();
  await expect(page.getByRole("img", { name: /Swap circuit/ })).toBeVisible();
}

test("a swap that stops mid-way hands over to recovery", async ({ page, portal }) => {
  await startSwap(page);

  portal.state.recovery = status();
  portal.state.recoveries = [summary()];
  portal.finishSwap("failed");

  await expect(page).toHaveURL(/#\/swap\/recovery$/);
  await expect(page.getByText("The swap stopped. Recovering your funds — see Recovery.")).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(SWAP_ID) })).toBeVisible();
});

test("a swap that fails with nothing to recover says so and links its report", async ({ page, portal }) => {
  await startSwap(page);
  portal.finishSwap("failed");

  await expect(page.getByRole("heading", { name: "Swap Failed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "View Report" })).toBeVisible();
  await expect(page).toHaveURL(/#\/swap$/);
});

test("a recovering swap shows where its funds are and can be nudged", async ({ page, portal }) => {
  portal.state.recovery = status();
  portal.state.recoveries = [summary()];
  await page.goto("/#/swap/recovery");

  const main = page.getByRole("main");
  await expect(main).toContainText(/Swaps recovering\s*1/);
  await expect(main).toContainText(/Still in contracts\s*200,000 satoshis/);
  await page.getByRole("link", { name: new RegExp(SWAP_ID) }).click();

  await expect(page).toHaveURL(new RegExp(`#/swap/recovery/${SWAP_ID}$`));
  await expect(page.getByRole("heading", { name: "Your funds are safe" })).toBeVisible();
  await expect(main).toContainText(/Yours, in contracts\s*200,000 satoshis/);
  await expect(main).toContainText(/Refund lock progress\s*5 \/ 20 blocks/);
  await expect(main).toContainText("Claimed into your wallet");

  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByText("Recovery restarted.")).toBeVisible();
  expect(portal.callsTo("recover_swap")).toHaveLength(1);
});

test("a failed nudge is reported", async ({ page, portal }) => {
  portal.state.recovery = status();
  portal.on("recover_swap", () => {
    throw fail("SWAP_IN_PROGRESS", "A swap is running; recovery waits for it.", 409);
  });
  await page.goto(`/#/swap/recovery/${SWAP_ID}`);
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByText("A swap is running; recovery waits for it.")).toBeVisible();
});
