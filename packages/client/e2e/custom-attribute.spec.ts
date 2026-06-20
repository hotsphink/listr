import { test, expect } from "@playwright/test";
import { clearDatabase, createBoard, createListInBoard } from "./helpers.js";

test.describe("custom attributes", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
  });

  test("create a list with a custom attribute, add an item, and verify display", async ({ page }) => {
    // Create a board with attributes
    await createBoard(page, "Movies", [
      { key: "rating", label: "Rating", type: "number" },
      { key: "genre", label: "Genre" },
    ]);

    // Create a list in that board
    await createListInBoard(page, "My Movies", "Movies");
    await expect(page.locator(".page-header h1")).toHaveText("My Movies");

    // Switch to table view to see attribute columns
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();

    // Add an item via the table's add row
    await page.locator(".view-add").last().click();
    await expect(page.locator(".modal h2")).toHaveText("New Item");

    const labels = page.locator(".modal .form-field label");
    await expect(labels.nth(0)).toHaveText("Title");
    await expect(labels.nth(1)).toHaveText("Rating");
    await expect(labels.nth(2)).toHaveText("Genre");

    await page.locator(".modal .form-field input").first().fill("Inception");
    await page.locator(".modal .form-field").nth(1).locator("input").fill("4");
    await page.locator(".modal .form-field").nth(2).locator("input").fill("sci-fi");

    await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();

    await expect(page.locator("tbody tr")).toHaveCount(1);
    const firstRow = page.locator("tbody tr").first();
    await expect(firstRow.locator("td").nth(1)).toContainText("Inception");
    await expect(firstRow.locator("td").nth(2)).toContainText("4");
    await expect(firstRow.locator("td").nth(3)).toContainText("sci-fi");

    await expect(page.locator("thead th").nth(1)).toHaveText("Title");
    await expect(page.locator("thead th").nth(2)).toHaveText("Rating");
    await expect(page.locator("thead th").nth(3)).toHaveText("Genre");
  });

  test("custom attribute appears in item edit modal", async ({ page }) => {
    await createBoard(page, "Films", [
      { key: "director", label: "Director" },
    ]);
    await createListInBoard(page, "My Films", "Films");
    await expect(page.locator(".page-header h1")).toHaveText("My Films");

    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();

    await page.locator(".view-add").last().click();
    await page.locator(".modal .form-field input").first().fill("Blade Runner");
    await page.locator(".modal .form-field").nth(1).locator("input").fill("Ridley Scott");
    await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();

    const row = page.locator("tbody tr").first();
    await expect(row.locator("td").nth(1)).toContainText("Blade Runner");
    await expect(row.locator("td").nth(2)).toContainText("Ridley Scott");

    await row.dblclick();
    await expect(page.locator(".modal h2")).toHaveText("Edit Item");
    const directorInput = page.locator(".modal .form-field").nth(1).locator("input");
    await expect(directorInput).toHaveValue("Ridley Scott");
  });

  test("board format string is used in list display", async ({ page }) => {
    await createBoard(page, "Rated Movies", [
      { key: "year", label: "Year", type: "number" },
    ], "{title} ({year})");
    await createListInBoard(page, "Watchlist", "Rated Movies");
    await expect(page.locator(".page-header h1")).toHaveText("Watchlist");

    // Default is list view — add an item
    await page.locator(".view-add").last().click();
    await page.locator(".modal .form-field input").first().fill("Alien");
    await page.locator(".modal .form-field").nth(1).locator("input").fill("1979");
    await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();

    // List view should show the formatted string from the board
    await expect(page.locator(".list-view-item").first()).toContainText("Alien (1979)");
  });
});
