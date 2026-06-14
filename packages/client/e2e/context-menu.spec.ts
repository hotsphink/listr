import { test, expect } from "@playwright/test";
import { clearDatabase, createCategory, createListInCategory } from "./helpers.js";

test.describe("sidebar context menu", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createCategory(page, "Movies");
    await createListInCategory(page, "Watchlist", "Movies");
    await expect(page.locator(".page-header h1")).toHaveText("Watchlist");
  });

  test("right-click list shows context menu with rename, configure, delete", async ({ page }) => {
    const sidebarItem = page.locator(".sidebar-item", { hasText: "Watchlist" });
    await sidebarItem.click({ button: "right" });

    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();

    const items = menu.locator(".context-menu-item");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toHaveText("Rename");
    await expect(items.nth(1)).toHaveText("Configure");
    await expect(items.nth(2)).toHaveText("Delete");
  });

  test("right-click category shows context menu", async ({ page }) => {
    const catHeader = page.locator(".sidebar-category-header", { hasText: "Movies" });
    await catHeader.click({ button: "right" });

    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".context-menu-item")).toHaveCount(3);
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
    await expect(page.locator(".page-header h1")).toHaveText("Films");
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
    await page.locator(".context-menu-item", { hasText: "Configure" }).click();
    await expect(page.locator(".modal h2")).toHaveText("Edit List");
  });

  test("delete removes the list", async ({ page }) => {
    await page.locator(".sidebar-header").click();
    await createListInCategory(page, "Books", "Movies");
    await expect(page.locator(".page-header h1")).toHaveText("Books");

    page.on("dialog", (dialog) => dialog.accept());
    const watchlistItem = page.locator(".sidebar-item", { hasText: "Watchlist" });
    await watchlistItem.click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Delete" }).click();

    await expect(page.locator(".sidebar-item", { hasText: "Watchlist" })).toHaveCount(0);
    await expect(page.locator(".sidebar-item", { hasText: "Books" })).toBeVisible();
  });
});
