import { test, expect, type Page } from "@playwright/test";
import { clearDatabase, createBoard, createListInBoard, addItemToList } from "./helpers.js";

// Real items only (excludes the always-present inline-add dummy row).
const realItems = (page: Page) =>
  page.locator(".list-view-item:not(.inline-add-item)");

test.describe("drag handles in list view", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createBoard(page, "Movies");
    await createListInBoard(page, "Watchlist", "Movies");
    await expect(page.locator(".page-header h1")).toHaveText("Movies");

    await addItemToList(page, "Inception");
    await expect(realItems(page)).toHaveCount(1);
  });

  test("drag handles are visible on initial load without switching views", async ({ page }) => {
    await expect(page.locator(".list-view-item .drag-handle").first()).toBeVisible();
  });

  test("dragging an item by its handle reorders and persists", async ({ page }) => {
    await addItemToList(page, "The Matrix");
    await expect(realItems(page)).toHaveCount(2);

    await expect(realItems(page).nth(0)).toContainText("Inception");
    await expect(realItems(page).nth(1)).toContainText("The Matrix");

    // Drag Inception (row 0) down past The Matrix (row 1) via its drag handle.
    // SortableJS needs a real mouse gesture with intermediate moves; delayOnTouchOnly
    // means no hold delay for mouse input.
    const handle = realItems(page).nth(0).locator(".drag-handle");
    const hb = (await handle.boundingBox())!;
    const tb = (await realItems(page).nth(1).boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 4, { steps: 3 });
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height + 8, { steps: 12 });
    await page.mouse.up();

    // Order is now The Matrix, Inception.
    await expect(realItems(page).nth(0)).toContainText("The Matrix");
    await expect(realItems(page).nth(1)).toContainText("Inception");

    // The new order survives a reload (persisted via after_id, not just DOM).
    await page.reload();
    await expect(realItems(page).nth(0)).toContainText("The Matrix");
    await expect(realItems(page).nth(1)).toContainText("Inception");
  });

  test("dragging an item to the last position lands last, not second-to-last", async ({ page }) => {
    // Regression: with 3+ items, dragging the first item past the last real item into
    // the inline-add zone must not snap it back to second-to-last.
    await addItemToList(page, "The Matrix");
    await addItemToList(page, "Interstellar");
    await expect(realItems(page)).toHaveCount(3);

    await expect(realItems(page).nth(0)).toContainText("Inception");
    await expect(realItems(page).nth(1)).toContainText("The Matrix");
    await expect(realItems(page).nth(2)).toContainText("Interstellar");

    // Drag Inception (first) to the end by moving its handle past Interstellar's bottom
    // edge, into the inline-add row below.
    const handle = realItems(page).nth(0).locator(".drag-handle");
    const hb = (await handle.boundingBox())!;
    const last = realItems(page).nth(2);
    const lb = (await last.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 4, { steps: 3 });
    await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height + 8, { steps: 12 });
    await page.mouse.up();

    await expect(realItems(page).nth(0)).toContainText("The Matrix");
    await expect(realItems(page).nth(1)).toContainText("Interstellar");
    await expect(realItems(page).nth(2)).toContainText("Inception");

    await page.reload();
    await expect(realItems(page).nth(0)).toContainText("The Matrix");
    await expect(realItems(page).nth(1)).toContainText("Interstellar");
    await expect(realItems(page).nth(2)).toContainText("Inception");
  });

  test("drag handles remain visible after switching to table and back to list", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();
    await expect(page.locator("table")).toBeVisible();

    await page.locator(".view-switcher-btn", { hasText: "List" }).click();
    await expect(realItems(page)).toHaveCount(1);
    await expect(page.locator(".list-view-item .drag-handle").first()).toBeVisible();
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
    await expect(page.locator(".list-view")).toBeVisible();
    await expect(page.locator("table")).toHaveCount(0);
  });
});
