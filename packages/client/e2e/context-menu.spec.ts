import { test, expect } from "@playwright/test";
import { clearDatabase, createBoard, createListInBoard } from "./helpers.js";

test.describe("sidebar board chevron", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createBoard(page, "Movies");
    await createListInBoard(page, "Watchlist", "Movies");
    // createListInBoard expands the board, so lists are visible after setup.
    await expect(page.locator(".page-header h1")).toHaveText("Movies");
  });

  test("clicking chevron collapses and re-expands the board without navigating", async ({ page }) => {
    const boardSection = page.locator(".sidebar-board").filter({
      has: page.locator(".sidebar-board-header", { hasText: "Movies" }),
    });
    const chevron = boardSection.locator(".sidebar-board-chevron");
    const listItem = boardSection.locator(".sidebar-item", { hasText: "Watchlist" });

    // Regression: clicking the chevron used to act like clicking the board name
    // (navigating) because sidebar-board-name's hit area overlapped the chevron
    // due to the negative margin on .sidebar-board-chevron.

    const wrapper = boardSection.locator(".sidebar-board-lists-wrapper");
    await expect(wrapper).toHaveClass(/expanded/);

    await chevron.click();
    await expect(wrapper).not.toHaveClass(/expanded/);
    // Must still be on the board page, not navigated away.
    await expect(page.locator(".page-header h1")).toHaveText("Movies");

    await chevron.click();
    await expect(wrapper).toHaveClass(/expanded/);
    await expect(page.locator(".page-header h1")).toHaveText("Movies");
  });
});

test.describe("sidebar context menu", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createBoard(page, "Movies");
    await createListInBoard(page, "Watchlist", "Movies");
    // Board multi-column model: header shows the board name.
    await expect(page.locator(".page-header h1")).toHaveText("Movies");
  });

  test("right-click list shows context menu with rename, configure, delete", async ({ page }) => {
    const sidebarItem = page.locator(".sidebar-item", { hasText: "Watchlist" });
    await sidebarItem.click({ button: "right" });

    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();

    const items = menu.locator(".context-menu-item");
    await expect(items).toHaveCount(5);
    await expect(items.nth(0)).toHaveText("Rename");
    await expect(items.nth(1)).toHaveText("Edit");
    await expect(items.nth(2)).toHaveText("Import");
    await expect(items.nth(3)).toHaveText("Export");
    await expect(items.nth(4)).toHaveText("Delete");
  });

  test("right-click board shows context menu", async ({ page }) => {
    const catHeader = page.locator(".sidebar-board-header", { hasText: "Movies" });
    await catHeader.click({ button: "right" });

    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".context-menu-item")).toHaveCount(6);
  });

  test("context menu closes on Escape", async ({ page }) => {
    const sidebarItem = page.locator(".sidebar-item", { hasText: "Watchlist" });
    await sidebarItem.click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".context-menu")).toHaveCount(0);
  });

  test("rename changes the list name", async ({ page }) => {
    const sidebarItem = page.locator(".sidebar-item", { hasText: "Watchlist" });
    await sidebarItem.click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Rename" }).click();

    const input = page.locator(".sidebar-rename-input");
    await expect(input).toBeVisible();
    await input.fill("Films");
    await input.press("Enter");

    await expect(page.locator(".sidebar-item", { hasText: "Films" })).toBeVisible();
    // The list's column header reflects the new name (the page header stays the board name).
    await expect(page.locator(".multi-list-column-name", { hasText: "Films" })).toBeVisible();
  });

  test("rename can be cancelled with Escape", async ({ page }) => {
    const sidebarItem = page.locator(".sidebar-item", { hasText: "Watchlist" });
    await sidebarItem.click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Rename" }).click();

    const input = page.locator(".sidebar-rename-input");
    await input.fill("Something Else");
    await page.keyboard.press("Escape");

    await expect(page.locator(".sidebar-item", { hasText: "Watchlist" })).toBeVisible();
  });

  test("configure opens the list settings modal", async ({ page }) => {
    const sidebarItem = page.locator(".sidebar-item", { hasText: "Watchlist" });
    await sidebarItem.click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Edit" }).click();
    await expect(page.locator(".modal h2")).toHaveText("Edit List");
  });

  test("delete removes the list", async ({ page }) => {
    await createListInBoard(page, "Books", "Movies");
    await expect(page.locator(".multi-list-column-name", { hasText: "Books" })).toBeVisible();

    page.on("dialog", (dialog) => dialog.accept());
    const watchlistItem = page.locator(".sidebar-item", { hasText: "Watchlist" });
    await watchlistItem.click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Delete" }).click();

    await expect(page.locator(".sidebar-item", { hasText: "Watchlist" })).toHaveCount(0);
    await expect(page.locator(".sidebar-item", { hasText: "Books" })).toBeVisible();
  });
});
