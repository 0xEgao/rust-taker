import { test, expect, field } from "../support/fixtures";
import { PHRASE, WALLET_NAME, WALLET_PASSWORD } from "../support/fake-portal";

test.describe("connection gate", () => {
  test.beforeEach(({ portal }) => {
    portal.state.connected = false;
    portal.state.wallet = null;
  });

  test("probes the backend and Tor, then continues to the role picker", async ({ page, portal }) => {
    await page.goto("/#/");
    await expect(page).toHaveURL(/#\/connect$/);
    await expect(page.getByText("signet · block 250,000")).toBeVisible();
    await expect(page.getByText("Bootstrap complete")).toBeVisible();

    await page.getByRole("button", { name: "Next" }).click();
    await expect(page).toHaveURL(/#\/launch$/);
    expect(portal.callsTo("set_chain_backend")).toHaveLength(1);
  });

  test("holds Next until Tor finishes bootstrapping", async ({ page, portal }) => {
    portal.state.tor = { ...portal.state.tor, bootstrapProgress: 45, bootstrapSummary: "Loading relay descriptors" };
    await page.goto("/#/connect");

    await expect(page.getByText("Waiting for Tor to finish…")).toBeVisible();
    await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();

    portal.state.tor = { ...portal.state.tor, bootstrapProgress: 100, bootstrapSummary: "Done" };
    await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  test("reports a backend that does not answer", async ({ page, portal }) => {
    portal.on("check_backend", { reachable: false, synced: false, error: "connection refused" });
    await page.goto("/#/connect");

    await expect(page.getByText("connection refused")).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page).toHaveURL(/#\/connect$/);
    expect(portal.callsTo("set_chain_backend")).toHaveLength(0);
  });
});

test.describe("wallet setup", () => {
  test.beforeEach(({ portal }) => {
    portal.state.wallet = null;
  });

  test("the role picker leads to the wallet picker", async ({ page }) => {
    await page.goto("/#/launch");
    await page.getByRole("link", { name: /^Wallet/ }).click();
    await expect(page.getByRole("heading", { name: "Unlock your wallet" })).toBeVisible();
  });

  test("unlocking an existing wallet rejects a wrong password, then opens it", async ({ page, portal }) => {
    await page.goto("/#/setup");
    await expect(page.getByText(WALLET_NAME)).toBeVisible();

    const password = field(page, "Password");
    await password.fill("wrong");
    await page.getByRole("button", { name: "Unlock" }).click();
    const retry = page.getByRole("dialog", { name: "Couldn't unlock wallet" });
    await expect(retry.getByText("Incorrect password. Try again.")).toBeVisible();
    expect(portal.state.wallet).toBeNull();

    await field(page, "Password").fill(WALLET_PASSWORD);
    await retry.getByRole("button", { name: "Retry" }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByText(/Last synced/)).toBeVisible();
    await expect(page.getByText(WALLET_NAME)).toBeVisible();
  });

  test("a new wallet shows its recovery phrase before anything else", async ({ page, portal }) => {
    await page.goto("/#/setup");
    await page.getByRole("button", { name: "Create new wallet" }).click();

    await field(page, "Wallet name").fill("fresh-wallet");
    await field(page, "Password").fill("new-wallet-password");
    await field(page, "Confirm password").fill("new-wallet-password");
    await page.getByRole("button", { name: "Create & continue" }).click();

    await expect(page.getByRole("heading", { name: "Save your recovery phrase" })).toBeVisible();
    const proceed = page.getByRole("button", { name: "Continue" });
    const written = page.getByRole("checkbox", { name: "I have written these words down." });
    await expect(proceed).toBeDisabled();
    await expect(written).toBeDisabled();

    await page.getByRole("button", { name: "Reveal words" }).click();
    for (const word of PHRASE.words.split(" ")) {
      await expect(page.getByRole("listitem").filter({ hasText: word }).first()).toBeVisible();
    }
    await written.check();
    await proceed.click();

    await expect(page.getByText(/Last synced/)).toBeVisible();
    expect(portal.callsTo("confirm_recovery_phrase_saved")).toEqual([{ id: PHRASE.id }]);
    expect(portal.callsTo("init_taker")[0]).toMatchObject({
      config: { walletName: "fresh-wallet", walletPassword: "new-wallet-password" },
    });
  });

  test("a phrase still unsaved after a reload is asked for again", async ({ page, portal }) => {
    portal.state.wallet = { name: WALLET_NAME, dataDir: "/data" };
    portal.state.pendingPhrase = PHRASE;
    await page.goto("/#/send");
    await expect(page.getByRole("heading", { name: "Save your recovery phrase" })).toBeVisible();
  });
});
