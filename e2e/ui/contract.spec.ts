import { test, expect } from "@playwright/test";
import { CONTRACT, FakePortal, NOT_COMMAND_ROUTES } from "../support/fake-portal";

/**
 * The UI suites are only as honest as the fake behind them. An operation added to the web host
 * without a fake answer would make every screen that calls it fail with "unhandled", so this
 * names the gap directly instead.
 */
test("the fake answers every operation the web host exposes", () => {
  const fake = new FakePortal();
  const missing = CONTRACT
    .filter((op) => op.web && !NOT_COMMAND_ROUTES.includes(op.name))
    .map((op) => op.name)
    .filter((name) => !fake.handles(name));
  expect(missing).toEqual([]);
});
