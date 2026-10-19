import { test, expect, field } from "../support/fixtures";
import { OWNER_PASSWORD } from "../support/fake-portal";

test.describe("signing in", () => {
  test("a fresh install asks for an owner password, then continues to the connection gate", async ({
    page,
    portal,
  }) => {
    portal.state.hasOwner = false;
    portal.state.authenticated = false;
    portal.state.wallet = null;

    await page.goto("/");
    await expect(page).toHaveURL(/#\/login$/);
    const submit = page.getByRole("button", { name: "Set password and continue" });

    await field(page, "New password").fill(OWNER_PASSWORD);
    await field(page, "Confirm password").fill("something else");
    await expect(page.getByText("Passwords don't match.")).toBeVisible();
    await expect(submit).toBeDisabled();

    await field(page, "Confirm password").fill(OWNER_PASSWORD);
    await submit.click();
    await expect(page).toHaveURL(/#\/connect$/);
    expect(portal.state.hasOwner).toBe(true);
  });

  test("a wrong password is reported and a right one signs in", async ({ page, portal }) => {
    portal.state.authenticated = false;
    portal.state.wallet = null;

    await page.goto("/#/");
    await expect(page).toHaveURL(/#\/login$/);

    await field(page, "Password").fill("not it");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("login failed")).toBeVisible();

    await field(page, "Password").fill(OWNER_PASSWORD);
    await field(page, "Password").press("Enter");
    await expect(page).toHaveURL(/#\/connect$/);
  });

  test("a session that expires mid-use returns to the login screen", async ({ page, portal }) => {
    await page.goto("/#/");
    await expect(page.getByText(/Last synced/)).toBeVisible();

    portal.state.authenticated = false;
    // Whichever reaches the server first, this click or one of the page's own polls, gets the
    // 401; a poll that wins removes the button before the click lands.
    await page.getByRole("button", { name: "Sync wallet" }).click({ timeout: 2_000 }).catch(() => {});
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page).toHaveURL(/#\/login$/);
  });

  test("an API that is down shows the unreachable screen, not a password prompt", async ({
    page,
    portal: _portal,
  }) => {
    // Registered after the fake, so it wins: the session probe fails at the network.
    await page.route("**/api/v1/session", (route) => route.abort("connectionrefused"));
    await page.goto("/#/");

    await expect(page.getByText("Can't reach")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);

    await page.unroute("**/api/v1/session");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText(/Last synced/)).toBeVisible();
  });
});
