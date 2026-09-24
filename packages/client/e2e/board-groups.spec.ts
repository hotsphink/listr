import { test, expect } from "@playwright/test";
import { clearDatabase, setDefaultSyncKey } from "./helpers.js";

test.describe("board groups", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
  });

  test("New Board Group creates a board and appears as its own group, without auto-opening the share dialog", async ({ page }) => {
    await page.locator(".sidebar-item.sidebar-new", { hasText: "+ New Board Group" }).click();
    await expect(page.locator(".modal h2")).toHaveText("New Board Group");

    // The share key field is pre-filled with a freshly generated key.
    const keyField = page.locator(".modal .form-field").filter({ has: page.locator("label", { hasText: "Share Key" }) }).locator("input");
    await expect(keyField).not.toHaveValue("");
    const groupKey = await keyField.inputValue();

    await page.locator(".modal .form-field input").first().fill("Team Trip");
    await page.getByRole("button", { name: "Create" }).click();

    // Creating the group must not auto-open the share dialog — it can be shared later.
    await expect(page.locator(".modal")).toHaveCount(0);

    // It gets its own group heading — named after the board — not lumped into "Shared Boards".
    await expect(page.locator(".sidebar-group-title", { hasText: "Shared Boards" })).toHaveCount(0);
    const teamGroup = page.locator(".sidebar-group").filter({ has: page.locator(".sidebar-group-title", { hasText: "Team Trip" }) });
    await expect(teamGroup.locator(".sidebar-board", { hasText: "Team Trip" })).toBeVisible();

    // The group heading itself is shareable. With no sync server configured at
    // all there is nobody to issue the grant, so the dialog says so.
    await teamGroup.locator(".sidebar-group-share-btn").click();
    await expect(page.locator(".modal h2")).toHaveText('Share "Team Trip"');
    await expect(page.locator(".modal")).toContainText("Sharing needs a sync server");
    await page.getByRole("button", { name: "Cancel" }).click();

    // Sanity: the generated key round-trips onto the board itself (Edit shows the same key).
    await teamGroup.locator(".sidebar-board", { hasText: "Team Trip" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Edit" }).click();
    await expect(page.locator(".modal h2")).toHaveText("Edit Board");
    await expect(keyField).toHaveValue(groupKey);
  });

  test("an ordinary individually-shared board stays in the generic Shared Boards bucket", async ({ page }) => {
    await page.locator(".sidebar-item.sidebar-new.board", { hasText: "+ New Board" }).click();
    await expect(page.locator(".modal h2")).toHaveText("New Board");
    await page.locator(".modal .form-field input").first().fill("Solo Board");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.locator(".sidebar-board", { hasText: "Solo Board" })).toBeVisible();

    // Share it via the per-board context menu — generates+persists its own key, but this
    // is NOT a deliberate group, so it should land in the generic bucket.
    await page.locator(".sidebar-board", { hasText: "Solo Board" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Share" }).click();
    await expect(page.locator(".modal h2")).toHaveText('Share "Solo Board"');
    await expect(page.locator(".modal")).not.toContainText("boards added or removed later stay in sync");
    // Opening the dialog is what mints the board's key, whether or not there is
    // a server to issue a link on, so dismissing it still leaves the key behind.
    await page.getByRole("button", { name: "Cancel" }).click();

    const sharedGroup = page.locator(".sidebar-group").filter({ has: page.locator(".sidebar-group-title", { hasText: "Shared Boards" }) });
    await expect(sharedGroup.locator(".sidebar-board", { hasText: "Solo Board" })).toBeVisible();
    // No standalone "Solo Board" heading, and the generic bucket has no share button.
    await expect(page.locator(".sidebar-group-title", { hasText: "Solo Board" })).toHaveCount(0);
    await expect(sharedGroup.locator(".sidebar-group-share-btn")).toHaveCount(0);
  });

  test("two boards manually sharing the same key without ever being grouped stay in Shared Boards", async ({ page }) => {
    const manualKey = "zippy";

    for (const name of ["Alpha", "Beta"]) {
      await page.locator(".sidebar-item.sidebar-new.board", { hasText: "+ New Board" }).click();
      await page.locator(".modal .form-field input").first().fill(name);
      const keyField = page.locator(".modal .form-field").filter({ has: page.locator("label", { hasText: "Share Key" }) }).locator("input");
      await keyField.fill(manualKey);
      await page.getByRole("button", { name: "Create" }).click();
      await expect(page.locator(".sidebar-board", { hasText: name })).toBeVisible();
    }

    // Sharing the same key by hand (not via "New Board Group" or a received group
    // share) must NOT auto-promote it to its own heading, no matter how many boards
    // end up sharing it.
    await expect(page.locator(".sidebar-group-title", { hasText: "Alpha" })).toHaveCount(0);
    await expect(page.locator(".sidebar-group-title", { hasText: "Beta" })).toHaveCount(0);

    const sharedGroup = page.locator(".sidebar-group").filter({ has: page.locator(".sidebar-group-title", { hasText: "Shared Boards" }) });
    await expect(sharedGroup.locator(".sidebar-board", { hasText: "Alpha" })).toBeVisible();
    await expect(sharedGroup.locator(".sidebar-board", { hasText: "Beta" })).toBeVisible();
    await expect(sharedGroup.locator(".sidebar-group-share-btn")).toHaveCount(0);
  });

  test("My Boards group has no share button until a default sync key is configured", async ({ page }) => {
    const myBoardsHeader = page.locator(".sidebar-group-header", { hasText: "My Boards" });
    await expect(myBoardsHeader.locator(".sidebar-group-share-btn")).toHaveCount(0);

    await setDefaultSyncKey(page, "abcdef1234567890");
    await page.reload();
    await page.waitForSelector(".sidebar");

    await expect(myBoardsHeader.locator(".sidebar-group-share-btn")).toBeVisible();
  });

  test("sharing My Boards opens the share dialog without navigating", async ({ page }) => {
    await setDefaultSyncKey(page, "abcdef1234567890");
    await page.reload();
    await page.waitForSelector(".sidebar");

    const myBoardsHeader = page.locator(".sidebar-group-header", { hasText: "My Boards" });
    await myBoardsHeader.locator(".sidebar-group-share-btn").click();

    // Clicking the share button must not also toggle the group's collapse state.
    await expect(page.locator(".sidebar-group-boards-wrapper").first()).toHaveClass(/expanded/);

    await expect(page.locator(".modal h2")).toHaveText('Share "My Boards"');

    // A share link is a grant issued by the server holding the boards, so with
    // an identity but no live connection there is nothing to issue one on.
    // Say that rather than spinning on a link that can never arrive.
    await expect(page.locator(".modal")).toContainText("needs a live connection");
    await expect(page.getByRole("button", { name: "Check sync" })).toBeVisible();
    await expect(page.locator(".share-url-text")).toHaveCount(0);
  });
});

test.describe("board groups and cloning", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
  });

  test("a clone of a board in a named group joins the group, and a clone of an individually shared board does not", async ({ page }) => {
    await page.locator(".sidebar-item.sidebar-new", { hasText: "+ New Board Group" }).click();
    await page.locator(".modal .form-field input").first().fill("Team Trip");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.locator(".modal")).toHaveCount(0);

    const clone = async (source: string) => {
      await page.locator(".sidebar-board", { hasText: source }).first().click({ button: "right" });
      await page.locator(".context-menu-item", { hasText: "Clone" }).click();
      await page.getByRole("button", { name: "Clone", exact: true }).click();
      await expect(page.locator(".modal")).toHaveCount(0);
    };

    await clone("Team Trip");
    const teamGroup = page.locator(".sidebar-group").filter({ has: page.locator(".sidebar-group-title", { hasText: "Team Trip" }) });
    await expect(teamGroup.locator(".sidebar-board", { hasText: "Clone of Team Trip" })).toBeVisible();

    // An individually shared board has its own key, which the clone must not inherit.
    await page.locator(".sidebar-item.sidebar-new.board", { hasText: "+ New Board" }).click();
    await page.locator(".modal .form-field input").first().fill("Solo Board");
    await page.getByRole("button", { name: "Create" }).click();
    await page.locator(".sidebar-board", { hasText: "Solo Board" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Share" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await clone("Solo Board");
    const sharedGroup = page.locator(".sidebar-group").filter({ has: page.locator(".sidebar-group-title", { hasText: "Shared Boards" }) });
    await expect(page.locator(".sidebar-board", { hasText: "Clone of Solo Board" })).toBeVisible();
    await expect(sharedGroup.locator(".sidebar-board", { hasText: "Clone of Solo Board" })).toHaveCount(0);
  });
});
