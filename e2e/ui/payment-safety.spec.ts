import { test, expect, field, nav, openWallet } from "../support/fixtures";
import type { Page } from "@playwright/test";
import type { UnresolvedOperation } from "../../src/api/host-contract";

/**
 * The web host answers a money-moving command with a 202 and a journal record, so the outcome
 * survives the tab or the connection going away. These pin down what the page does when the
 * answer is slow, lost, or unknown. The rule throughout: never resubmit a payment blind, and
 * never report one that may have happened as a failure.
 */

const RECIPIENT = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";
const SENT_TOAST = /Broadcast\. The payment is in the mempool/;

async function sendPayment(page: Page) {
  await field(page, "Recipient Address").fill(RECIPIENT);
  await field(page, "Amount").fill("50000");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("dialog", { name: "Confirm this payment" }).getByRole("button", { name: "Broadcast" }).click();
}

/** Every POST the page made for `command`, whether or not the server ever saw it. */
function countSubmissions(page: Page, command: string) {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(`/commands/${command}`)) seen.push(r.url());
  });
  return seen;
}

const unconfirmed = (overrides: Partial<UnresolvedOperation> = {}): UnresolvedOperation => ({
  operationId: "op-1",
  kind: "send_to_address",
  createdAt: Math.floor(Date.now() / 1000) - 120,
  request: { address: RECIPIENT, amountSats: 75_000 },
  result: { txid: "aa".repeat(32) },
  ...overrides,
});

test.describe("a send's outcome", () => {
  test.beforeEach(async ({ page }) => {
    await openWallet(page);
    await nav(page, "Tx").click();
  });

  test("still running when accepted is followed until it settles", async ({ page, portal }) => {
    portal.deliver("send_to_address", { kind: "durable", pending: 3 });
    await sendPayment(page);

    await expect(page.getByRole("status").getByText(SENT_TOAST)).toBeVisible();
    const [record] = portal.journal.values();
    expect(record).toMatchObject({ state: "succeeded", pending: 0 });
  });

  test("whose response is lost after acceptance is recovered, not resent", async ({ page, portal }) => {
    const submissions = countSubmissions(page, "send_to_address");
    portal.deliver("send_to_address", { kind: "lost-after-accept" });
    await sendPayment(page);

    await expect(page.getByRole("status").getByText(SENT_TOAST)).toBeVisible();
    expect(submissions).toHaveLength(1);
    expect(portal.callsTo("send_to_address")).toHaveLength(1);
  });

  test("that never reached the server is reported, not resent", async ({ page, portal }) => {
    const submissions = countSubmissions(page, "send_to_address");
    portal.deliver("send_to_address", { kind: "lost-before-accept" });
    await sendPayment(page);

    await expect(page.getByRole("status").filter({ hasText: SENT_TOAST })).toHaveCount(0);
    await expect(field(page, "Recipient Address")).toHaveValue(RECIPIENT);
    // Given time to try again on its own, which it must not.
    await page.waitForTimeout(1_000);
    expect(submissions).toHaveLength(1);
    expect(portal.callsTo("send_to_address")).toHaveLength(0);
  });

  test("the server cannot confirm is not shown as a plain failure", async ({ page, portal }) => {
    portal.deliver("send_to_address", {
      kind: "durable",
      settle: "indeterminate",
      error: { code: "INTERNAL", message: "The broadcast may have reached the network." },
    });
    await sendPayment(page);

    await expect(page.getByText("The broadcast may have reached the network.").first()).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: SENT_TOAST })).toHaveCount(0);
  });
});

test.describe("an earlier payment with an unknown outcome", () => {
  test("pauses sending and swapping, and asks the server to recheck it", async ({ page, portal }) => {
    portal.state.blocking = [unconfirmed()];
    await openWallet(page);

    await nav(page, "Tx").click();
    await expect(page.getByText(/An earlier payment is\s+still unconfirmed, so sending is paused/)).toBeVisible();
    await expect(page.getByText("This clears itself once the transaction confirms.")).toBeVisible();
    await field(page, "Recipient Address").fill(RECIPIENT);
    await field(page, "Amount").fill("50000");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await expect.poll(() => portal.postedTo("/operations/reconcile")).toContain("op-1");

    await nav(page, "Swap").click();
    await expect(page.getByText(/still unconfirmed, so swapping is paused/)).toBeVisible();
    await field(page, "Amount").fill("200000");
    await expect(page.getByRole("button", { name: "Start Swap" })).toBeDisabled();
  });

  test("with no transaction id can be released by the owner", async ({ page, portal }) => {
    portal.state.blocking = [unconfirmed({ result: undefined })];
    await openWallet(page);
    await nav(page, "Tx").click();

    await page.getByRole("button", { name: "It didn't go through — let me send again" }).click();
    await expect(page.getByText(/so sending is paused/)).toHaveCount(0);
    expect(portal.postedTo("/operations/acknowledge")).toEqual(["op-1"]);
    expect(portal.postedTo("/operations/reconcile")).toEqual([]);

    await field(page, "Recipient Address").fill(RECIPIENT);
    await field(page, "Amount").fill("50000");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  });

  test("pauses spending while the journal cannot be read", async ({ page, portal }) => {
    // Known bug: `operations.blocking()` in `src/api/web.ts` answers an error status with `[]`,
    // which the store records as checked and empty, so spending is not paused. Only a network
    // failure pauses it today. Remove this line with the fix.
    test.fail();
    portal.state.journalReadable = false;
    await openWallet(page);
    await nav(page, "Tx").click();

    // The refresh runs on mount; once the page has settled there is nothing more to wait for.
    await expect(page.getByText(/cannot currently tell whether an earlier payment is still unconfirmed/)).toBeVisible({
      timeout: 3_000,
    });
  });
});
