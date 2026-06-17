import { test, expect } from "@playwright/test";
import { clearDatabase, createCategory, createListInCategory } from "./helpers.js";

test.describe("drag handles in list view", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createCategory(page, "Movies");
    await createListInCategory(page, "Watchlist", "Movies");
    await expect(page.locator(".page-header h1")).toHaveText("Watchlist");

    await page.locator(".view-add").last().click();
    await page.locator(".modal .form-field input").first().fill("Inception");
    await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.locator(".list-view-item")).toHaveCount(1);
  });

  test("drag handles are visible on initial load without switching views", async ({ page }) => {
    await expect(page.locator(".list-view-item .drag-handle")).toBeVisible();
  });

  test("drag handles remain visible after switching to table and back to list", async ({ page }) => {
    // Switch to table view and back to list view within the unified ListView
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();
    await expect(page.locator("table")).toBeVisible();

    await page.locator(".view-switcher-btn", { hasText: "List" }).click();
    await expect(page.locator(".list-view-item")).toHaveCount(1);
    await expect(page.locator(".list-view-item .drag-handle")).toBeVisible();
  });
});

test.describe("list mode navigation back to category view", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createCategory(page, "Movies");
    await createListInCategory(page, "Watchlist", "Movies");
  });

  // Regression: after switching to table/card view, clicking "List" should show list mode content.
  test("list button shows list mode content after table view", async ({ page }) => {
    // Switch to table view
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();
    await expect(page.locator("table")).toBeVisible();

    // Click "List" — should switch back to list mode within CategoryView
    await page.locator(".view-switcher-btn", { hasText: "List" }).click();
    await expect(page.locator(".multi-list-view")).toBeVisible();
    await expect(page.locator("table")).toHaveCount(0);
  });

  test("list button shows list mode content after card view", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
    await expect(page.locator(".card-grid")).toBeVisible();

    await page.locator(".view-switcher-btn", { hasText: "List" }).click();
    await expect(page.locator(".multi-list-view")).toBeVisible();
    await expect(page.locator(".card-grid")).toHaveCount(0);
  });
});
