import { test, expect } from "@playwright/test";
import { clearDatabase, createCategory, createListInCategory } from "./helpers.js";

test.describe("view mode switching", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);

    await createCategory(page, "Movies", [
      { key: "genre", label: "Genre" },
    ]);
    await createListInCategory(page, "My Movies", "Movies");
    await expect(page.locator(".page-header h1")).toHaveText("My Movies");

    // Add two items
    await page.locator(".view-add").click();
    await page.locator(".modal .form-field input").first().fill("Inception");
    await page.locator(".modal .form-field").nth(1).locator("input").fill("sci-fi");
    await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();

    await page.locator(".view-add").click();
    await page.locator(".modal .form-field input").first().fill("The Godfather");
    await page.locator(".modal .form-field").nth(1).locator("input").fill("crime");
    await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();

    await expect(page.locator(".list-view-item")).toHaveCount(2);
  });

  test("defaults to list view with formatted strings", async ({ page }) => {
    await expect(page.locator(".view-switcher-btn.active")).toHaveText("List");
    await expect(page.locator(".list-view")).toBeVisible();
    await expect(page.locator(".list-view-item")).toHaveCount(2);
    await expect(page.locator(".list-view-item").first()).toContainText("Inception");
    await expect(page.locator(".list-view-item").first()).toContainText("sci-fi");
    await expect(page.locator("table")).toHaveCount(0);
    await expect(page.locator(".card-grid")).toHaveCount(0);
  });

  test("switches to card view", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
    await expect(page.locator(".view-switcher-btn.active")).toHaveText("Cards");
    await expect(page.locator(".card-grid")).toBeVisible();
    await expect(page.locator(".card.item")).toHaveCount(2);
    await expect(page.locator("table")).toHaveCount(0);
    await expect(page.locator(".card-title").first()).toContainText("Inception");
    await expect(page.locator(".card.item").first()).toContainText("sci-fi");
  });

  test("switches between all views", async ({ page }) => {
    await expect(page.locator(".list-view")).toBeVisible();

    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();
    await expect(page.locator("table")).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(2);
    await expect(page.locator(".list-view")).toHaveCount(0);

    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
    await expect(page.locator(".card-grid")).toBeVisible();
    await expect(page.locator("table")).toHaveCount(0);

    await page.locator(".view-switcher-btn", { hasText: "List" }).click();
    await expect(page.locator(".list-view")).toBeVisible();
    await expect(page.locator(".card-grid")).toHaveCount(0);
  });

  test("view mode persists after navigation", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
    await expect(page.locator(".card-grid")).toBeVisible();

    await page.locator(".sidebar-header").click();
    await expect(page.locator(".page-header h1")).toHaveText("Lists");

    await page.locator(".card.list", { hasText: "My Movies" }).click();
    await expect(page.locator(".page-header h1")).toHaveText("My Movies");
    await expect(page.locator(".view-switcher-btn.active")).toHaveText("Cards");
    await expect(page.locator(".card-grid")).toBeVisible();
  });

  test("clicking a list item opens the edit modal", async ({ page }) => {
    await page.locator(".list-view-item").first().click();
    await expect(page.locator(".modal h2")).toHaveText("Edit Item");
    await expect(page.locator(".modal .form-field input").first()).toHaveValue("Inception");
  });

  test("clicking a card opens the edit modal", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
    await expect(page.locator(".card-grid")).toBeVisible();
    await page.locator(".card.item").first().click();
    await expect(page.locator(".modal h2")).toHaveText("Edit Item");
    await expect(page.locator(".modal .form-field input").first()).toHaveValue("Inception");
  });

  test("search filters items", async ({ page }) => {
    await page.locator(".search-input").fill("godfather");
    await expect(page.locator(".list-view-item")).toHaveCount(1);
    await expect(page.locator(".list-view-item").first()).toContainText("The Godfather");

    await page.locator(".search-input").fill("");
    await expect(page.locator(".list-view-item")).toHaveCount(2);
  });
});
