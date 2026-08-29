import { test, expect } from "@playwright/test";
import { clearDatabase } from "./helpers.js";

// The join screen needs a live sync server for everything past "resolve which
// endpoint": peek_grant, redeem_grant, and the resulting `ok` all require a
// real WebSocket round trip. Those live in guest-link.spec.ts, which starts a
// throwaway server (syncServer.ts). What is covered here is what is genuinely
// client-only, and so needs no server at all: a malformed link is rejected
// before any connection is attempted.

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

  // A credentials segment of just "." never reaches JoinPage at all: the
  // router resolves it as the relative "this directory" segment and matches no
  // route. Use a grant id with an empty secret instead, which is a segment the
  // router delivers and parseJoinPath rejects.
  test("a join link with an empty secret shows 'Invalid join link'", async ({ page }) => {
    await page.goto("/#/join/AbC123/grant-id.");
    await expect(page.locator(".receive-card h2")).toHaveText("Invalid join link");
  });
});
