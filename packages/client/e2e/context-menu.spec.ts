import { test, expect } from "@playwright/test";

test.describe("sidebar context menu", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      return new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase("listr");
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
    await page.reload();
    await page.waitForSelector(".page-header");

    // Create a list
    await page.getByRole("button", { name: "+ New List" }).first().click();
    await page.locator(".modal .form-field input").first().fill("Movies");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.locator(".page-header h1")).toHaveText("Movies");
  });

  test("right-click shows context menu with rename, configure, delete", async ({ page }) => {
    const sidebarItem = page.locator(".sidebar-item", { hasText: "Movies" });
    await sidebarItem.click({ button: "right" });

    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();

    const items = menu.locator(".context-menu-item");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toHaveText("Rename");
    await expect(items.nth(1)).toHaveText("Configure");
    await expect(items.nth(2)).toHaveText("Delete");
  });

  test("context menu closes on click outside", async ({ page }) => {
    const sidebarItem = page.locator(".sidebar-item", { hasText: "Movies" });
    await sidebarItem.click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible();

    // Click outside the menu
    await page.locator(".main").click();
    await expect(page.locator(".context-menu")).toHaveCount(0);
  });

  test("context menu closes on Escape", async ({ page }) => {
    const sidebarItem = page.locator(".sidebar-item", { hasText: "Movies" });
    await sidebarItem.click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(".context-menu")).toHaveCount(0);
  });

  test("rename changes the list name", async ({ page }) => {
    const sidebarItem = page.locator(".sidebar-item", { hasText: "Movies" });
    await sidebarItem.click({ button: "right" });

    await page.locator(".context-menu-item", { hasText: "Rename" }).click();

    // Input should appear with the current name selected
    const input = page.locator(".sidebar-rename-input");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();

    // Clear and type a new name
    await input.fill("Films");
    await input.press("Enter");

    // The sidebar and page header should update
    await expect(page.locator(".sidebar-item", { hasText: "Films" })).toBeVisible();
    await expect(page.locator(".page-header h1")).toHaveText("Films");
  });

  test("rename can be cancelled with Escape", async ({ page }) => {
    const sidebarItem = page.locator(".sidebar-item", { hasText: "Movies" });
    await sidebarItem.click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Rename" }).click();

    const input = page.locator(".sidebar-rename-input");
    await input.fill("Something Else");
    await page.keyboard.press("Escape");

    // Name should remain unchanged
    await expect(page.locator(".sidebar-item", { hasText: "Movies" })).toBeVisible();
    await expect(page.locator(".sidebar-rename-input")).toHaveCount(0);
  });

  test("configure opens the list settings modal", async ({ page }) => {
    const sidebarItem = page.locator(".sidebar-item", { hasText: "Movies" });
    await sidebarItem.click({ button: "right" });

    await page.locator(".context-menu-item", { hasText: "Configure" }).click();

    // Settings modal should open
    await expect(page.locator(".modal h2")).toHaveText("Edit List");
  });

  test("delete removes the list", async ({ page }) => {
    // Create a second list so we have something after deletion
    await page.locator(".sidebar-header").click();
    await page.getByRole("button", { name: "+ New List" }).first().click();
    await page.locator(".modal .form-field input").first().fill("Books");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.locator(".page-header h1")).toHaveText("Books");

    // Right-click Movies in sidebar
    page.on("dialog", (dialog) => dialog.accept());
    const moviesItem = page.locator(".sidebar-item", { hasText: "Movies" });
    await moviesItem.click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Delete" }).click();

    // Movies should be gone from sidebar
    await expect(page.locator(".sidebar-item", { hasText: "Movies" })).toHaveCount(0);
    await expect(page.locator(".sidebar-item", { hasText: "Books" })).toBeVisible();
  });
});
