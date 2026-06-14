import { test, expect } from "@playwright/test";

async function fillSchemaField(page: import("@playwright/test").Page, input: import("@playwright/test").Locator, value: string) {
  await input.click({ clickCount: 3 });
  await page.keyboard.type(value);
}

test.describe("view mode switching", () => {
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

    // Create a list with a rating attribute
    await page.getByRole("button", { name: "+ New List" }).first().click();
    await page.locator(".modal .form-field input").first().fill("Movies");

    await page.getByRole("button", { name: "+ Add attribute" }).click();
    await page.waitForSelector(".schema-entry");
    const entry = page.locator(".schema-entry").first();
    await fillSchemaField(page, entry.locator("input").nth(0), "genre");
    await page.keyboard.press("Tab");
    await fillSchemaField(page, entry.locator("input").nth(1), "Genre");
    await page.keyboard.press("Tab");

    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.locator(".page-header h1")).toHaveText("Movies");

    // Add two items
    await page.getByRole("button", { name: "+ Add Item" }).first().click();
    await page.locator(".modal .form-field input").first().fill("Inception");
    await page.locator(".modal .form-field").nth(1).locator("input").fill("sci-fi");
    await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();

    await page.getByRole("button", { name: "+ Add Item" }).first().click();
    await page.locator(".modal .form-field input").first().fill("The Godfather");
    await page.locator(".modal .form-field").nth(1).locator("input").fill("crime");
    await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();

    // Verify items appear in list view by default
    await expect(page.locator(".list-view-item")).toHaveCount(2);
  });

  test("defaults to list view with formatted strings", async ({ page }) => {
    // List tab should be active
    await expect(page.locator(".view-switcher-btn.active")).toHaveText("List");

    // List view should show auto-generated format string including attributes
    await expect(page.locator(".list-view")).toBeVisible();
    await expect(page.locator(".list-view-item")).toHaveCount(2);
    await expect(page.locator(".list-view-item").first()).toContainText("Inception (sci-fi)");
    await expect(page.locator(".list-view-item").nth(1)).toContainText("The Godfather (crime)");

    // Table and card elements should not be present
    await expect(page.locator("table")).toHaveCount(0);
    await expect(page.locator(".card-grid")).toHaveCount(0);
  });

  test("switches to card view", async ({ page }) => {
    // Click the Cards button
    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();

    // Cards tab should now be active
    await expect(page.locator(".view-switcher-btn.active")).toHaveText("Cards");

    // Card grid should appear
    await expect(page.locator(".card-grid")).toBeVisible();
    await expect(page.locator(".item-card:not(.add-card)")).toHaveCount(2);

    // Table should not be present
    await expect(page.locator("table")).toHaveCount(0);

    // Cards should show item titles
    await expect(page.locator(".item-card-title").first()).toContainText("Inception");
    await expect(page.locator(".item-card-title").nth(1)).toContainText("The Godfather");

    // Cards should show attribute values
    await expect(page.locator(".item-card").first()).toContainText("sci-fi");
    await expect(page.locator(".item-card").nth(1)).toContainText("crime");
  });

  test("switches between all three views", async ({ page }) => {
    // Start in list view (default)
    await expect(page.locator(".list-view")).toBeVisible();

    // Switch to table
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();
    await expect(page.locator(".view-switcher-btn.active")).toHaveText("Table");
    await expect(page.locator("table")).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(2);
    await expect(page.locator(".list-view")).toHaveCount(0);

    // Switch to cards
    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
    await expect(page.locator(".view-switcher-btn.active")).toHaveText("Cards");
    await expect(page.locator(".card-grid")).toBeVisible();
    await expect(page.locator("table")).toHaveCount(0);

    // Switch back to list
    await page.locator(".view-switcher-btn", { hasText: "List" }).click();
    await expect(page.locator(".view-switcher-btn.active")).toHaveText("List");
    await expect(page.locator(".list-view")).toBeVisible();
    await expect(page.locator(".card-grid")).toHaveCount(0);
  });

  test("view mode persists after navigation", async ({ page }) => {
    // Switch to card view
    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
    await expect(page.locator(".card-grid")).toBeVisible();

    // Navigate away to dashboard
    await page.locator(".sidebar-header").click();
    await expect(page.locator(".page-header h1")).toHaveText("Lists");

    // Navigate back to the list
    await page.locator(".list-card", { hasText: "Movies" }).click();
    await expect(page.locator(".page-header h1")).toHaveText("Movies");

    // Card view should still be active
    await expect(page.locator(".view-switcher-btn.active")).toHaveText("Cards");
    await expect(page.locator(".card-grid")).toBeVisible();
  });

  test("clicking a list item opens the edit modal", async ({ page }) => {
    // Already in list view (default)
    await page.locator(".list-view-item").first().click();
    await expect(page.locator(".modal h2")).toHaveText("Edit Item");
    await expect(page.locator(".modal .form-field input").first()).toHaveValue("Inception");
  });

  test("clicking a card opens the edit modal", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
    await expect(page.locator(".card-grid")).toBeVisible();

    // Click the first card
    await page.locator(".item-card").first().click();
    await expect(page.locator(".modal h2")).toHaveText("Edit Item");

    // Title should be populated
    await expect(page.locator(".modal .form-field input").first()).toHaveValue("Inception");
  });
});
