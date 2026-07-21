import { test, expect } from "@playwright/test";
import { clearDatabase, createBoard, createListInBoard } from "./helpers.js";

test.describe("drag handles in list view", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createBoard(page, "Movies");
    await createListInBoard(page, "Watchlist", "Movies");
    // Board multi-column model: header shows the board name.
    await expect(page.locator(".page-header h1")).toHaveText("Movies");

    await page.locator(".view-add").last().click();
    await page.locator(".modal .form-field input").first().fill("Inception");
    await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.locator(".list-view-item")).toHaveCount(1);
  });

  test("drag handles are visible on initial load without switching views", async ({ page }) => {
    await expect(page.locator(".list-view-item .drag-handle")).toBeVisible();
  });

  test("dragging an item by its handle reorders and persists", async ({ page }) => {
    // Add a second item so we have something to reorder past.
    await page.locator(".view-add").last().click();
    await page.locator(".modal .form-field input").first().fill("The Matrix");
    await page.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.locator(".list-view-item")).toHaveCount(2);

    const items = page.locator(".list-view-item");
    await expect(items.nth(0)).toContainText("Inception");
    await expect(items.nth(1)).toContainText("The Matrix");

    // Drag Inception (row 0) down past The Matrix (row 1) via its drag handle.
    // SortableJS needs a real mouse gesture with intermediate moves; delayOnTouchOnly
    // means no hold delay for mouse input.
    const handle = items.nth(0).locator(".drag-handle");
    const hb = (await handle.boundingBox())!;
    const tb = (await items.nth(1).boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 4, { steps: 3 });
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height + 8, { steps: 12 });
    await page.mouse.up();

    // Order is now The Matrix, Inception.
    await expect(page.locator(".list-view-item").nth(0)).toContainText("The Matrix");
    await expect(page.locator(".list-view-item").nth(1)).toContainText("Inception");

    // The new order survives a reload (persisted via after_id, not just DOM).
    await page.reload();
    await expect(page.locator(".list-view-item").nth(0)).toContainText("The Matrix");
    await expect(page.locator(".list-view-item").nth(1)).toContainText("Inception");
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

test.describe("list mode navigation back to board view", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createBoard(page, "Movies");
    await createListInBoard(page, "Watchlist", "Movies");
  });

  // Regression: after switching to table/card view, clicking "List" should show list mode content.
  test("list button shows list mode content after table view", async ({ page }) => {
    // Switch to table view
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();
    await expect(page.locator("table")).toBeVisible();

    // Click "List" — should switch back to list mode within ListView
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
