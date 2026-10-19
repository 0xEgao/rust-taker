import { test, expect, field, nav, openWallet } from "../support/fixtures";
import { fail } from "../support/fake-portal";

const RECIPIENT = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";

test.describe("send", () => {
  test.beforeEach(async ({ page }) => {
    await openWallet(page);
    await nav(page, "Tx").click();
  });

  test("rejects an invalid address before anything is sent", async ({ page, portal }) => {
    await field(page, "Recipient Address").fill("not-an-address");
    await field(page, "Amount").fill("50000");
    await expect(page.getByText("not a valid address")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    expect(portal.callsTo("send_to_address")).toHaveLength(0);
  });

  test("confirms, broadcasts and resets the form", async ({ page, portal }) => {
    await field(page, "Recipient Address").fill(RECIPIENT);
    await field(page, "Amount").fill("50000");
    await page.getByRole("button", { name: "Medium 6 s/vB" }).click();
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Confirm this payment" });
    await expect(dialog).toContainText(/Amount\s*50,000 satoshis/);
    await expect(dialog).toContainText(/Fee rate\s*6 s\/vB/);
    await dialog.getByRole("button", { name: "Broadcast" }).click();

    await expect(page.getByRole("status").getByText(/Broadcast\./)).toBeVisible();
    await expect(field(page, "Recipient Address")).toHaveValue("");
    expect(portal.callsTo("send_to_address")).toEqual([
      expect.objectContaining({ address: RECIPIENT, amountSats: 50_000, feeRate: 6 }),
    ]);
  });

  test("cancelling the confirmation sends nothing", async ({ page, portal }) => {
    await field(page, "Recipient Address").fill(RECIPIENT);
    await field(page, "Amount").fill("50000");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(field(page, "Recipient Address")).toHaveValue(RECIPIENT);
    expect(portal.callsTo("send_to_address")).toHaveLength(0);
  });

  test("a failed broadcast is shown and keeps the form", async ({ page, portal }) => {
    portal.on("send_to_address", () => {
      throw fail("INSUFFICIENT_FUNDS", "Not enough funds for this payment and its fee.");
    });
    await field(page, "Recipient Address").fill(RECIPIENT);
    await field(page, "Amount").fill("50000");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Broadcast" }).click();

    await expect(page.getByText("Not enough funds for this payment and its fee.").first()).toBeVisible();
    await expect(field(page, "Recipient Address")).toHaveValue(RECIPIENT);
  });
});

test.describe("swap", () => {
  test.beforeEach(async ({ page }) => {
    await openWallet(page);
    await nav(page, "Swap").click();
  });

  test("quotes, starts and follows a swap to completion", async ({ page, portal }) => {
    await field(page, "Amount").fill("200000");
    await page.getByRole("button", { name: "Start Swap" }).click();

    await expect(page.getByRole("heading", { name: "Review your swap" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText(/You receive at least\s*198,200 satoshis/);
    expect(portal.callsTo("prepare_swap")[0]).toMatchObject({
      request: { amountSats: 200_000, protocol: "taproot", routerCount: 2 },
    });

    await page.getByRole("button", { name: "Start swap" }).click();
    await expect(page.getByRole("img", { name: /Swap circuit/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Swap Failed" })).toHaveCount(0);
    expect(portal.callsTo("start_swap")).toHaveLength(1);

    portal.finishSwap();
    await expect(page.getByRole("heading", { name: "Swap Complete" })).toBeVisible();
  });

  test("cancelling the review starts nothing", async ({ page, portal }) => {
    await field(page, "Amount").fill("200000");
    await page.getByRole("button", { name: "Start Swap" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByRole("heading", { name: "Initiate Swap" })).toBeVisible();
    expect(portal.callsTo("start_swap")).toHaveLength(0);
  });

  test("a route that cannot be built is reported", async ({ page, portal }) => {
    portal.on("prepare_swap", () => {
      throw fail("NOT_ENOUGH_ROUTERS", "Only 1 router can take this amount; the route needs 2.");
    });
    await field(page, "Amount").fill("200000");
    await page.getByRole("button", { name: "Start Swap" }).click();

    await expect(page.getByText(/Only 1 router can take this amount/).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Review your swap" })).toHaveCount(0);
  });
});
