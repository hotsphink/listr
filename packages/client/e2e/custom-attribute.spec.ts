import { test, expect } from "@playwright/test";

async function fillSchemaField(page: import("@playwright/test").Page, input: import("@playwright/test").Locator, value: string) {
  await input.click({ clickCount: 3 });
  await page.keyboard.type(value);
}

test.describe("custom attributes", () => {
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
  });

  test("create a list with a custom attribute, add an item, and verify display", async ({ page }) => {
    // Open the "New List" modal from the dashboard
    await page.getByRole("button", { name: "+ New List" }).first().click();
    await expect(page.locator(".modal h2")).toHaveText("New List");

    // Fill in list name
    await page.locator(".modal .form-field input").first().fill("Movies");

    // Add a custom attribute: "rating" of type Rating
    await page.getByRole("button", { name: "+ Add attribute" }).click();
    await page.waitForSelector(".schema-entry");

    const schemaEntry = page.locator(".schema-entry").first();
    await fillSchemaField(page, schemaEntry.locator("input").nth(0), "rating");
    await page.keyboard.press("Tab");
    await fillSchemaField(page, schemaEntry.locator("input").nth(1), "Rating");
    await page.keyboard.press("Tab");
    await schemaEntry.locator("select").selectOption("rating");

    // Add a second attribute: "genre" of type Text
    await page.getByRole("button", { name: "+ Add attribute" }).click();
    const secondEntry = page.locator(".schema-entry").nth(1);
    await fillSchemaField(page, secondEntry.locator("input").nth(0), "genre");
    await page.keyboard.press("Tab");
    await fillSchemaField(page, secondEntry.locator("input").nth(1), "Genre");
    await page.keyboard.press("Tab");

    // Submit the list
    await page.getByRole("button", { name: "Create" }).click();

    // Should navigate to the list view
    await expect(page.locator(".page-header h1")).toHaveText("Movies");

    // Switch to table view to see attribute columns
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();

    // Click "+ Add Item"
    await page.getByRole("button", { name: "+ Add Item" }).first().click();
    await expect(page.locator(".modal h2")).toHaveText("New Item");

    // The modal should have fields for our custom attributes
    const labels = page.locator(".modal .form-field label");
    await expect(labels.nth(0)).toHaveText("Title");
    await expect(labels.nth(1)).toHaveText("Rating");
    await expect(labels.nth(2)).toHaveText("Genre");

    // Fill in the item
    await page.locator(".modal .form-field input").first().fill("Inception");
    // Click 4 stars for rating
    await page.locator(".modal .stars span").nth(3).click();
    // Fill genre
    await page.locator(".modal .form-field").nth(2).locator("input").fill("sci-fi");

    // Submit
    await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();

    // Verify the item appears in the table
    await expect(page.locator("tbody tr")).toHaveCount(1);

    const firstRow = page.locator("tbody tr").first();
    await expect(firstRow.locator("td").nth(1)).toContainText("Inception");
    await expect(firstRow.locator("td .stars")).toContainText("★★★★☆");
    await expect(firstRow.locator("td").nth(3)).toContainText("sci-fi");

    // Verify column headers (nth(0) is the drag handle column)
    await expect(page.locator("thead th").nth(1)).toHaveText("Title");
    await expect(page.locator("thead th").nth(2)).toHaveText("Rating");
    await expect(page.locator("thead th").nth(3)).toHaveText("Genre");
  });

  test("custom attribute appears in item edit modal", async ({ page }) => {
    // Create a list with a "director" text attribute
    await page.getByRole("button", { name: "+ New List" }).first().click();
    await page.locator(".modal .form-field input").first().fill("Films");
    await page.getByRole("button", { name: "+ Add attribute" }).click();
    await page.waitForSelector(".schema-entry");

    const entry = page.locator(".schema-entry").first();
    await fillSchemaField(page, entry.locator("input").nth(0), "director");
    await page.keyboard.press("Tab");
    await fillSchemaField(page, entry.locator("input").nth(1), "Director");
    await page.keyboard.press("Tab");

    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.locator(".page-header h1")).toHaveText("Films");

    // Switch to table view
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();

    // Add an item
    await page.getByRole("button", { name: "+ Add Item" }).first().click();
    await page.locator(".modal .form-field input").first().fill("Blade Runner");
    await page.locator(".modal .form-field").nth(1).locator("input").fill("Ridley Scott");
    await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();

    // Verify it shows in the table
    const row = page.locator("tbody tr").first();
    await expect(row.locator("td").nth(1)).toContainText("Blade Runner");
    await expect(row.locator("td").nth(2)).toContainText("Ridley Scott");

    // Click the row to open edit modal
    await row.click();
    await expect(page.locator(".modal h2")).toHaveText("Edit Item");

    // Verify the director field is populated
    const directorInput = page.locator(".modal .form-field").nth(1).locator("input");
    await expect(directorInput).toHaveValue("Ridley Scott");
  });

  test("list format string uses custom attribute in display", async ({ page }) => {
    // Create list with format string referencing a custom attribute
    await page.getByRole("button", { name: "+ New List" }).first().click();
    await page.locator(".modal .form-field input").first().fill("Rated Movies");

    // Add "year" number attribute
    await page.getByRole("button", { name: "+ Add attribute" }).click();
    await page.waitForSelector(".schema-entry");

    const entry = page.locator(".schema-entry").first();
    await fillSchemaField(page, entry.locator("input").nth(0), "year");
    await page.keyboard.press("Tab");
    await fillSchemaField(page, entry.locator("input").nth(1), "Year");
    await page.keyboard.press("Tab");
    await entry.locator("select").selectOption("number");

    // Set format string to include year
    const formatInput = page.locator(".modal .form-field input").nth(1);
    await formatInput.fill("{title} ({year})");

    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.locator(".page-header h1")).toHaveText("Rated Movies");

    // Switch to table view
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();

    // Add item with year
    await page.getByRole("button", { name: "+ Add Item" }).first().click();
    await page.locator(".modal .form-field input").first().fill("Alien");
    await page.locator(".modal .form-field").nth(1).locator("input").fill("1979");
    await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();

    // The title column should show the formatted string (td[0] is drag handle)
    const titleCell = page.locator("tbody tr").first().locator("td").nth(1);
    await expect(titleCell).toContainText("Alien (1979)");
  });
});
