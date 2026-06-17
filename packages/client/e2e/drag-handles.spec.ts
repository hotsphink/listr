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

  test("drag handles remain visible after navigating away and returning via category view", async ({ page }) => {
    // "List" navigates to category view; double-click the column to return to list view
    await page.locator(".view-switcher-btn", { hasText: "List" }).click();
    await expect(page.locator(".multi-list-view")).toBeVisible();

    await page.locator(".multi-list-column-header", { hasText: "Watchlist" }).dblclick();
    await expect(page.locator(".page-header h1")).toHaveText("Watchlist");
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

  // Regression: after navigating from category view to table/card/board view,
  // clicking "List" should return to the multi-list category view rather than
  // switching to single-list list mode and leaving the user stuck there.
  test("list button navigates back to category view from table view", async ({ page }) => {
    // Switch to table view within ListView (currently at /list/:id from createListInCategory)
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();
    await expect(page.locator("table")).toBeVisible();

    // Click "List" — should navigate to the category view (multi-list), not stay in single-list mode
    await page.locator(".view-switcher-btn", { hasText: "List" }).click();
    await expect(page.locator(".multi-list-view")).toBeVisible();
    await expect(page.locator(".page-header h1")).toHaveText("Movies");
  });

  test("list button navigates back to category view from card view", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
    await expect(page.locator(".card-grid")).toBeVisible();

    await page.locator(".view-switcher-btn", { hasText: "List" }).click();
    await expect(page.locator(".multi-list-view")).toBeVisible();
    await expect(page.locator(".page-header h1")).toHaveText("Movies");
  });
});
