import { test, expect } from "@playwright/test";
import { clearDatabase, setDefaultSyncKey } from "./helpers.js";

test.describe("board groups", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
  });

  test("New Board Group creates a board and immediately opens its share link", async ({ page }) => {
    await page.locator(".sidebar-item.sidebar-new", { hasText: "+ New Board Group" }).click();
    await expect(page.locator(".modal h2")).toHaveText("New Board Group");

    // The share key field is pre-filled with a freshly generated key.
    const keyField = page.locator(".modal .form-field").filter({ has: page.locator("label", { hasText: "Share Key" }) }).locator("input");
    await expect(keyField).not.toHaveValue("");
    const groupKey = await keyField.inputValue();

    await page.locator(".modal .form-field input").first().fill("Team Trip");
    await page.getByRole("button", { name: "Create" }).click();

    // Board creation immediately hands off into the share modal for that board.
    await expect(page.locator(".modal h2")).toHaveText('Share "Team Trip"');
    await expect(page.locator(".share-url-text")).toContainText("#/receive/");

    await page.getByRole("button", { name: "Done" }).click();

    // A non-default key puts the new board in the "Shared Boards" group, not "My Boards".
    const sharedGroup = page.locator(".sidebar-group").filter({ has: page.locator(".sidebar-group-title", { hasText: "Shared Boards" }) });
    await expect(sharedGroup.locator(".sidebar-board", { hasText: "Team Trip" })).toBeVisible();

    // Sanity: the generated key round-trips onto the board itself (Edit shows the same key).
    await sharedGroup.locator(".sidebar-board", { hasText: "Team Trip" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Edit" }).click();
    await expect(page.locator(".modal h2")).toHaveText("Edit Board");
    await expect(keyField).toHaveValue(groupKey);
  });

  test("My Boards group has no share button until a default sync key is configured", async ({ page }) => {
    const myBoardsHeader = page.locator(".sidebar-group-header", { hasText: "My Boards" });
    await expect(myBoardsHeader.locator(".sidebar-group-share-btn")).toHaveCount(0);

    await setDefaultSyncKey(page, "abcdef1234567890");
    await page.reload();
    await page.waitForSelector(".sidebar");

    await expect(myBoardsHeader.locator(".sidebar-group-share-btn")).toBeVisible();
  });

  test("sharing My Boards opens a group share link without navigating", async ({ page }) => {
    await setDefaultSyncKey(page, "abcdef1234567890");
    await page.reload();
    await page.waitForSelector(".sidebar");

    const myBoardsHeader = page.locator(".sidebar-group-header", { hasText: "My Boards" });
    await myBoardsHeader.locator(".sidebar-group-share-btn").click();

    // Clicking the share button must not also toggle the group's collapse state.
    await expect(page.locator(".sidebar-group-boards-wrapper").first()).toHaveClass(/expanded/);

    await expect(page.locator(".modal h2")).toHaveText('Share "My Boards"');
    await expect(page.locator(".modal")).toContainText("boards added or removed later stay in sync");
    await expect(page.locator(".share-url-text")).toContainText("#/receive/");
  });
});
