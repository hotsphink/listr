import { test, expect } from "@playwright/test";
import { clearDatabase } from "./helpers.js";

// The join screen needs a live sync server for everything past "resolve which
// endpoint": peek_grant, redeem_grant, and the resulting `ok` all require a
// real WebSocket round trip, and this harness runs no server (see helpers.ts's
// module doc and CLAUDE.md). What is covered here is what is genuinely
// client-only: a malformed link is rejected before any connection is
// attempted.

test.describe("join screen: client-only coverage", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
  });

  test("a join link with no dot separating grant id and secret shows 'Invalid join link'", async ({ page }) => {
    await page.goto("/#/join/AbC123/grant-id-with-no-secret");
    await expect(page.locator(".receive-card h2")).toHaveText("Invalid join link");
    await page.getByRole("button", { name: "Go home" }).click();
    await expect(page).toHaveURL(/#\/$|#$/);
  });

  test("a join link with an empty grant id and secret shows 'Invalid join link'", async ({ page }) => {
    await page.goto("/#/join/AbC123/.");
    await expect(page.locator(".receive-card h2")).toHaveText("Invalid join link");
  });
});
