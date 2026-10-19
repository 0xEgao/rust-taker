import { test, expect, field } from "../support/fixtures";
import { PHRASE, ROUTER_ID, fail } from "../support/fake-portal";

test("the fleet lists each router with its state", async ({ page }) => {
  await page.goto("/#/router");
  const card = page.getByRole("article").filter({ hasText: ROUTER_ID });
  await expect(card.getByRole("heading", { name: "E2E router" })).toBeVisible();
  await expect(card.getByText("running", { exact: true })).toBeVisible();

  await card.getByRole("link", { name: "Manage" }).click();
  await expect(page).toHaveURL(new RegExp(`#/router/${ROUTER_ID}$`));
});

test("a router can be stopped and started from its workspace", async ({ page, portal }) => {
  await page.goto(`/#/router/${ROUTER_ID}`);
  await expect(page.getByRole("heading", { name: "E2E router", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Stop router" }).click();
  await expect(page.getByRole("button", { name: "Start router" })).toBeVisible();
  expect(portal.callsTo("stop_maker")).toEqual([{ routerId: ROUTER_ID }]);
});

test("the workspace tabs render", async ({ page }) => {
  await page.goto(`/#/router/${ROUTER_ID}`);
  for (const tab of ["Tx", "Logs", "Settings", "Overview"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.getByRole("heading", { name: "E2E router", level: 1 })).toBeVisible();
  }
});

test("adding a router validates the form, then registers it and shows its phrase", async ({
  page,
  portal,
}) => {
  portal.on("get_router_recovery_phrase", (args) =>
    args.routerId === "router-02" && portal.callsTo("confirm_router_recovery_phrase_saved").length === 0
      ? PHRASE
      : null,
  );
  await page.goto("/#/router/new");
  const create = page.getByRole("button", { name: "Create router" });
  await expect(create).toBeDisabled();

  await field(page, "Router ID").fill("router-02");
  await field(page, "Wallet password").fill("router-pass-1");
  await field(page, "Confirm wallet password").fill("router-pass-2");
  await expect(create).toBeDisabled();

  await field(page, "Confirm wallet password").fill("router-pass-1");
  await create.click();

  await expect(page.getByRole("heading", { name: "Save your recovery phrase" })).toBeVisible();
  await page.getByRole("button", { name: "Reveal words" }).click();
  await page.getByRole("checkbox", { name: "I have written these words down." }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(/#\/router\/router-02\/setup$/);
  await expect(page.getByRole("button", { name: "Unlock & start router" })).toBeVisible();
  expect(portal.callsTo("init_maker")[0]).toMatchObject({
    config: { routerId: "router-02", walletPassword: "router-pass-1" },
  });
  expect(portal.callsTo("confirm_router_recovery_phrase_saved")).toEqual([
    { routerId: "router-02", id: PHRASE.id },
  ]);
});

test.describe("a stopped router", () => {
  test.beforeEach(({ portal }) => {
    Object.assign(portal.state.routerStatus[ROUTER_ID], { phase: { phase: "stopped" }, running: false });
  });

  test("starts with its wallet password", async ({ page, portal }) => {
    await page.goto(`/#/router/${ROUTER_ID}`);
    await page.getByRole("button", { name: "Start router" }).click();

    const dialog = page.getByRole("dialog", { name: `Start ${ROUTER_ID}` });
    await expect(dialog.getByRole("button", { name: "Start router" })).toBeDisabled();
    await field(page, "Wallet password").fill("router-wallet-password");
    await dialog.getByRole("button", { name: "Start router" }).click();

    await expect(page.getByRole("button", { name: "Stop router" })).toBeVisible();
    expect(portal.callsTo("start_maker")).toEqual([
      { routerId: ROUTER_ID, walletPassword: "router-wallet-password" },
    ]);
  });

  test("refusing the password keeps the prompt open", async ({ page, portal }) => {
    portal.on("start_maker", () => {
      throw fail("WALLET_WRONG_PASSWORD", "wrong router wallet password");
    });
    await page.goto(`/#/router/${ROUTER_ID}`);
    await page.getByRole("button", { name: "Start router" }).click();
    await field(page, "Wallet password").fill("wrong");
    const dialog = page.getByRole("dialog", { name: `Start ${ROUTER_ID}` });
    await dialog.getByRole("button", { name: "Start router" }).click();

    await expect(dialog.getByText("Wrong password for this router's wallet.")).toBeVisible();
    expect(portal.state.routerStatus[ROUTER_ID].running).toBe(false);
  });

  test("starts from its setup page", async ({ page, portal }) => {
    await page.goto(`/#/router/${ROUTER_ID}/setup`);
    const start = page.getByRole("button", { name: "Unlock & start router" });
    await expect(start).toBeDisabled();
    await field(page, "Router wallet password").fill("router-wallet-password");
    await start.click();

    await expect.poll(() => portal.callsTo("start_maker")).toEqual([
      { routerId: ROUTER_ID, walletPassword: "router-wallet-password" },
    ]);
  });

  test("saves edited settings", async ({ page, portal }) => {
    await page.goto(`/#/router/${ROUTER_ID}?tab=settings`);
    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();

    await page.getByRole("button", { name: /^100sats Edit$/ }).click();
    await page.locator("input:focus").fill("250");
    await page.locator("input:focus").press("Enter");
    await expect(page.getByRole("button", { name: /^250sats Edit$/ })).toBeVisible();

    await save.click();
    const confirm = page.getByRole("dialog");
    await confirm.getByRole("button", { name: /Save/ }).click();

    await expect(page.getByText("Router settings saved to config.toml.")).toBeVisible();
    expect(portal.callsTo("update_maker_settings")).toEqual([
      { routerId: ROUTER_ID, settings: expect.objectContaining({ routerId: ROUTER_ID, baseFee: 250 }) },
    ]);
  });

  test("settings the router would refuse cannot be saved", async ({ page, portal }) => {
    portal.on("check_router_config", (args) =>
      (args.settings as { baseFee: number }).baseFee > 1_000 ? "base fee is above the protocol maximum" : null,
    );
    await page.goto(`/#/router/${ROUTER_ID}?tab=settings`);
    await page.getByRole("button", { name: /^100sats Edit$/ }).click();
    await page.locator("input:focus").fill("5000");
    await page.locator("input:focus").press("Enter");

    await expect(page.getByText("base fee is above the protocol maximum")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(portal.callsTo("update_maker_settings")).toEqual([]);
  });
});
