import { readFileSync } from "node:fs";
import { test, expect, field, openWallet } from "../support/fixtures";
import { BACKUP_PASSWORD, PHRASE, ROUTER_ID } from "../support/fake-portal";

const BACKUP_FILE = { name: "portal-wallet-backup.json", mimeType: "application/json", buffer: Buffer.from('{"e2e":"backup"}') };

test.describe("restoring a wallet", () => {
  test.beforeEach(({ portal }) => {
    portal.state.wallet = null;
  });

  test("from a recovery phrase pasted into one box", async ({ page, portal }) => {
    await page.goto("/#/setup");
    await page.getByRole("button", { name: "Restore from seed phrase" }).click();
    const restore = page.getByRole("button", { name: "Restore & continue" });

    await field(page, "New wallet name").fill("restored-from-words");
    await field(page, "Word 1").fill(PHRASE.words);
    await expect(page.getByText(/12 of 12 words/)).toBeVisible();
    await expect(field(page, "Word 12")).toHaveValue(PHRASE.words.split(" ")[11]);

    await field(page, "New wallet password").fill("restored-password");
    await field(page, "Confirm password").fill("not the same");
    await expect(restore).toBeDisabled();
    await field(page, "Confirm password").fill("restored-password");
    await restore.click();

    await expect(page.getByText(/Last synced/)).toBeVisible();
    expect(portal.callsTo("restore_wallet_from_mnemonic")).toEqual([
      expect.objectContaining({ walletName: "restored-from-words", mnemonic: PHRASE.words, password: "restored-password" }),
    ]);
    // Opened with the password just chosen, after the restore wrote it.
    expect(portal.callsTo("init_taker").at(-1)).toMatchObject({
      config: { walletName: "restored-from-words", walletPassword: "restored-password" },
    });
  });

  test("from an encrypted backup file", async ({ page, portal }) => {
    await page.goto("/#/setup");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Restore backup" }).click();
    await (await chooser).setFiles(BACKUP_FILE);

    await expect(page.getByRole("heading", { name: "Restore an encrypted backup" })).toBeVisible();
    await expect(page.getByText("portal-wallet-backup.json")).toBeVisible();
    // The browser hands over the file's bytes, never a path.
    expect(portal.postedTo("/uploads")).toEqual(['{"e2e":"backup"}']);

    await field(page, "New wallet name").fill("restored-from-file");
    await field(page, "Backup password").fill(BACKUP_PASSWORD);
    await page.getByRole("button", { name: "Restore & continue" }).click();

    await expect(page.getByText(/Last synced/)).toBeVisible();
    expect(portal.callsTo("restore_wallet")).toEqual([
      expect.objectContaining({ walletName: "restored-from-file", selectionId: "upload-1", password: BACKUP_PASSWORD }),
    ]);
  });

  test("with the wrong backup password asks again", async ({ page, portal }) => {
    await page.goto("/#/setup");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Restore backup" }).click();
    await (await chooser).setFiles(BACKUP_FILE);

    await field(page, "Backup password").fill("wrong");
    await page.getByRole("button", { name: "Restore & continue" }).click();
    await expect(page.getByText("Incorrect backup password. Try again.")).toBeVisible();
    expect(portal.state.wallet).toBeNull();
  });
});

test.describe("creating a backup", () => {
  test("of the wallet downloads an encrypted file", async ({ page, portal }) => {
    await openWallet(page);
    await page.getByRole("button", { name: "Create backup" }).click();

    const create = page.getByRole("button", { name: "Confirm & create backup" });
    await field(page, "Backup Password").fill("a backup password");
    await field(page, "Confirm Password").fill("a different one");
    await create.click();
    await expect(page.getByText("Passwords do not match.")).toBeVisible();
    expect(portal.postedTo("/backups")).toEqual([]);
    await field(page, "Confirm Password").fill("a backup password");

    const download = page.waitForEvent("download");
    await create.click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^portal-wallet-backup-\d+\.json$/);
    expect(readFileSync(await file.path(), "utf8")).toBe('{"e2e":"backup"}');
    expect(portal.postedTo("/backups")).toEqual([expect.objectContaining({ password: "a backup password" })]);
  });

  test("of a router names the router", async ({ page, portal }) => {
    await page.goto(`/#/router/${ROUTER_ID}`);
    await page.getByRole("button", { name: "Create backup" }).click();
    await field(page, "Backup Password").fill("a backup password");
    await field(page, "Confirm Password").fill("a backup password");

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Confirm & create backup" }).click();
    expect((await download).suggestedFilename()).toMatch(new RegExp(`^portal-router-${ROUTER_ID}-backup-\\d+\\.json$`));
    expect(portal.postedTo("/backups")).toEqual([
      expect.objectContaining({ password: "a backup password", routerId: ROUTER_ID }),
    ]);
  });
});
