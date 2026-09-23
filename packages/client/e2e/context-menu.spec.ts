import { test, expect } from "@playwright/test";
import { addItemToList, clearDatabase, createBoard, createListInBoard } from "./helpers.js";

test.describe("sidebar board context menu", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createBoard(page, "Movies");
    await createListInBoard(page, "Watchlist", "Movies");
    await expect(page.locator(".page-header h1")).toHaveText("Movies");
  });

  test("right-click board shows context menu", async ({ page }) => {
    const boardRow = page.locator(".sidebar-board", { hasText: "Movies" });
    await boardRow.click({ button: "right" });

    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".context-menu-item")).toHaveCount(6);
  });

  test("context menu closes on Escape", async ({ page }) => {
    const boardRow = page.locator(".sidebar-board", { hasText: "Movies" });
    await boardRow.click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".context-menu")).toHaveCount(0);
  });

  test("rename changes the board name", async ({ page }) => {
    const boardRow = page.locator(".sidebar-board", { hasText: "Movies" });
    await boardRow.click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Rename" }).click();

    const input = page.locator(".sidebar-rename-input");
    await expect(input).toBeVisible();
    await input.fill("Films");
    await input.press("Enter");

    await expect(page.locator(".sidebar-board", { hasText: "Films" })).toBeVisible();
  });

  test("delete removes the board", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());
    const boardRow = page.locator(".sidebar-board", { hasText: "Movies" });
    await boardRow.click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Delete" }).click();

    await expect(page.locator(".sidebar-board", { hasText: "Movies" })).toHaveCount(0);
  });
});

test.describe("list column header context menu", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createBoard(page, "Movies");
    await createListInBoard(page, "Watchlist", "Movies");
    await expect(page.locator(".page-header h1")).toHaveText("Movies");
  });

  test("right-click list column shows context menu with edit, import, export, delete", async ({ page }) => {
    const header = page.locator(".multi-list-column-header", { hasText: "Watchlist" });
    await header.click({ button: "right" });

    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();

    const items = menu.locator(".context-menu-item");
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toHaveText("Edit");
    await expect(items.nth(1)).toHaveText("Import");
    await expect(items.nth(2)).toHaveText("Export");
    await expect(items.nth(3)).toHaveText("Delete");
  });

  test("edit renames the list via the settings modal", async ({ page }) => {
    const header = page.locator(".multi-list-column-header", { hasText: "Watchlist" });
    await header.click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Edit" }).click();

    await expect(page.locator(".modal h2")).toHaveText("Edit List");
    const modal = page.locator(".modal");
    await modal.locator(".form-field input").first().fill("Films");
    await modal.getByRole("button", { name: "Save" }).click();

    await expect(page.locator(".multi-list-column-name", { hasText: "Films" })).toBeVisible();
  });

  test("delete removes the list", async ({ page }) => {
    await createListInBoard(page, "Books", "Movies");
    await expect(page.locator(".multi-list-column-name", { hasText: "Books" })).toBeVisible();

    page.on("dialog", (dialog) => dialog.accept());
    const header = page.locator(".multi-list-column-header", { hasText: "Watchlist" });
    await header.click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Delete" }).click();

    await expect(page.locator(".multi-list-column-name", { hasText: "Watchlist" })).toHaveCount(0);
    await expect(page.locator(".multi-list-column-name", { hasText: "Books" })).toBeVisible();
  });
});

test.describe("item context menu", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createBoard(page, "Movies");
    await createListInBoard(page, "Watchlist", "Movies");
    await expect(page.locator(".page-header h1")).toHaveText("Movies");
    await addItemToList(page, "Alien");
  });

  test("Edit Item opens the edit modal for that item", async ({ page }) => {
    const item = page.locator(".list-view-item:not(.inline-add-item)", { hasText: "Alien" });
    await item.click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Edit Item" }).click();

    await expect(page.locator(".modal h2")).toHaveText("Edit Item");
    await expect(page.locator(".modal input").first()).toHaveValue("Alien");
  });
});
