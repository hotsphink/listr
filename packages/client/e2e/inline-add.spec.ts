import { test, expect, type Page } from "@playwright/test";
import { clearDatabase, createBoard, createListInBoard, addItemToList } from "./helpers.js";

const realItems = (page: Page) =>
  page.locator(".list-view-item:not(.inline-add-item)");

test.describe("InlineAddItem", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createBoard(page, "Movies");
    await createListInBoard(page, "Watchlist", "Movies");
    await expect(page.locator(".page-header h1")).toHaveText("Movies");
  });

  // -----------------------------------------------------------------------
  // Presence across all view modes
  // -----------------------------------------------------------------------

  test("inline-add row is always present in list view", async ({ page }) => {
    await expect(page.locator(".inline-add-item")).toBeVisible();
    await expect(page.locator(".inline-add-input")).toBeVisible();
  });

  test("inline-add row is present in table view as a <tr>", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();
    await expect(page.locator("table")).toBeVisible();
    await expect(page.locator("tbody tr.inline-add-item")).toBeVisible();
    await expect(page.locator(".inline-add-input")).toBeVisible();
  });

  test("inline-add row is present in card view as a card", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
    await expect(page.locator(".card-grid")).toBeVisible();
    await expect(page.locator(".card.inline-add-item")).toBeVisible();
    await expect(page.locator(".inline-add-input")).toBeVisible();
  });

  test("inline-add persists when switching between view modes", async ({ page }) => {
    await expect(page.locator(".inline-add-item")).toBeVisible();

    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();
    await expect(page.locator(".inline-add-item")).toBeVisible();

    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
    await expect(page.locator(".inline-add-item")).toBeVisible();

    await page.locator(".view-switcher-btn", { hasText: "List" }).click();
    await expect(page.locator(".inline-add-item")).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // Title-only add via Enter
  // -----------------------------------------------------------------------

  test("typing a title and pressing Enter creates an item", async ({ page }) => {
    await expect(realItems(page)).toHaveCount(0);
    await addItemToList(page, "Inception");
    await expect(realItems(page)).toHaveCount(1);
    await expect(realItems(page).first()).toContainText("Inception");
  });

  test("submitting clears the input field", async ({ page }) => {
    const input = page.locator(".inline-add-input");
    await input.fill("Inception");
    await input.press("Enter");
    await expect(input).toHaveValue("");
  });

  test("two consecutive Enter adds create items in sequence", async ({ page }) => {
    await addItemToList(page, "Inception");
    await addItemToList(page, "The Matrix");

    await expect(realItems(page)).toHaveCount(2);
    // Items were added in sequence, so Inception precedes The Matrix.
    await expect(realItems(page).nth(0)).toContainText("Inception");
    await expect(realItems(page).nth(1)).toContainText("The Matrix");
  });

  test("inline-add input stays focused/available after a submit", async ({ page }) => {
    const input = page.locator(".inline-add-input");
    await input.fill("Inception");
    await input.press("Enter");
    // Input should be accessible immediately for a second entry.
    await expect(input).toBeVisible();
    await input.fill("The Matrix");
    await input.press("Enter");
    await expect(realItems(page)).toHaveCount(2);
  });

  test("pressing Enter on an empty input does not create an item", async ({ page }) => {
    await page.locator(".inline-add-input").press("Enter");
    await expect(realItems(page)).toHaveCount(0);
  });

  // -----------------------------------------------------------------------
  // Dummy position — default (tail)
  // -----------------------------------------------------------------------

  test("dummy starts at the tail of the list", async ({ page }) => {
    await addItemToList(page, "Inception");
    await addItemToList(page, "The Matrix");
    // Dummy must be the last list-view-item.
    const all = page.locator(".list-view-item");
    const count = await all.count();
    await expect(all.nth(count - 1)).toHaveClass(/inline-add-item/);
  });

  test("after a submit, dummy resets to the tail of the list", async ({ page }) => {
    await addItemToList(page, "Inception");
    await addItemToList(page, "The Matrix");

    // Dummy always resets to the tail after any add.
    const all = page.locator(".list-view-item");
    const count = await all.count();
    await expect(all.nth(count - 1)).toHaveClass(/inline-add-item/);
    await expect(all.nth(count - 2)).toContainText("The Matrix");
  });

  // -----------------------------------------------------------------------
  // Header + button moves dummy to top
  // -----------------------------------------------------------------------

  test("header + button moves dummy to the top of the list", async ({ page }) => {
    await addItemToList(page, "Inception");
    await addItemToList(page, "The Matrix");

    // The + button in the list header (first one found in list view)
    await page.locator(".multi-list-add-btn").first().click();

    // Dummy should now be the first list-view-item.
    await expect(page.locator(".list-view-item").first()).toHaveClass(/inline-add-item/);
  });

  test("adding after header + click inserts at the top", async ({ page }) => {
    await addItemToList(page, "Inception");

    await page.locator(".multi-list-add-btn").first().click();

    // Now type and submit — the new item should appear before Inception.
    await addItemToList(page, "Interstellar");

    await expect(realItems(page)).toHaveCount(2);
    await expect(realItems(page).nth(0)).toContainText("Interstellar");
    await expect(realItems(page).nth(1)).toContainText("Inception");
  });

  // -----------------------------------------------------------------------
  // Expand button opens pre-filled modal
  // -----------------------------------------------------------------------

  test("expand button opens the full item form modal", async ({ page }) => {
    await page.locator(".inline-add-btn").last().click();
    await expect(page.locator(".modal h2")).toHaveText("New Item");
  });

  test("text in the inline input is pre-filled in the opened modal", async ({ page }) => {
    const input = page.locator(".inline-add-input").last();
    await input.fill("Dunkirk");
    await page.locator(".inline-add-btn").last().click();
    const modal = page.locator(".modal");
    await expect(modal.locator(".form-field input").first()).toHaveValue("Dunkirk");
  });

  test("saving via modal creates an item at the dummy's current position", async ({ page }) => {
    await addItemToList(page, "Inception");
    await addItemToList(page, "The Matrix");

    // Move dummy to top.
    await page.locator(".multi-list-add-btn").first().click();

    // Expand and save from that position.
    await page.locator(".inline-add-btn").first().click();
    const modal = page.locator(".modal");
    await modal.locator(".form-field input").first().fill("Interstellar");
    await modal.getByRole("button", { name: "Add", exact: true }).click();

    await expect(realItems(page)).toHaveCount(3);
    // Interstellar was inserted at the top.
    await expect(realItems(page).nth(0)).toContainText("Interstellar");
    await expect(realItems(page).nth(1)).toContainText("Inception");
    await expect(realItems(page).nth(2)).toContainText("The Matrix");
  });

  // -----------------------------------------------------------------------
  // Persistence across page reload
  // -----------------------------------------------------------------------

  test("items added via inline-add persist after a reload", async ({ page }) => {
    await addItemToList(page, "Inception");
    await addItemToList(page, "The Matrix");

    await page.reload();
    await expect(realItems(page)).toHaveCount(2);
    await expect(realItems(page).nth(0)).toContainText("Inception");
    await expect(realItems(page).nth(1)).toContainText("The Matrix");
  });

  test("dummy resets to the tail after a page reload", async ({ page }) => {
    await addItemToList(page, "Inception");

    // Move dummy to top.
    await page.locator(".multi-list-add-btn").first().click();
    await expect(page.locator(".list-view-item").first()).toHaveClass(/inline-add-item/);

    // Reload — dummy should be back at the tail. Use .last() (re-evaluated on each
    // retry) rather than snapshotting count() up front: right after reload the list
    // can render in intermediate states (e.g. real items before the dummy is spliced
    // back in), and a frozen index would then point at the wrong row.
    await page.reload();
    await expect(page.locator(".list-view-item").last()).toHaveClass(/inline-add-item/);
  });

  // -----------------------------------------------------------------------
  // Table view inline-add
  // -----------------------------------------------------------------------

  test("typing in table view inline-add and pressing Enter creates an item", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();
    await expect(page.locator("table")).toBeVisible();

    const input = page.locator(".inline-add-input");
    await input.fill("Inception");
    await input.press("Enter");

    await expect(page.locator("tbody tr:not(.inline-add-item)")).toHaveCount(1);
    await expect(page.locator("tbody tr:not(.inline-add-item)").first().locator("td").nth(1)).toContainText("Inception");
    await expect(input).toHaveValue("");
  });

  test("two consecutive table-view adds create items in sequence", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();

    const input = page.locator(".inline-add-input");
    await input.fill("Inception");
    await input.press("Enter");
    await expect(page.locator("tbody tr:not(.inline-add-item)")).toHaveCount(1);

    await input.fill("The Matrix");
    await input.press("Enter");
    await expect(page.locator("tbody tr:not(.inline-add-item)")).toHaveCount(2);

    const rows = page.locator("tbody tr:not(.inline-add-item)");
    await expect(rows.nth(0).locator("td").nth(1)).toContainText("Inception");
    await expect(rows.nth(1).locator("td").nth(1)).toContainText("The Matrix");
  });

  test("table view expand button opens pre-filled modal", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();
    const input = page.locator(".inline-add-input");
    await input.fill("Interstellar");
    await page.locator(".inline-add-btn").last().click();
    const modal = page.locator(".modal");
    await expect(modal.locator(".form-field input").first()).toHaveValue("Interstellar");
    await modal.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.locator("tbody tr:not(.inline-add-item)")).toHaveCount(1);
  });

  // -----------------------------------------------------------------------
  // Card view inline-add
  // -----------------------------------------------------------------------

  test("typing in card view inline-add and pressing Enter creates a card", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();
    await expect(page.locator(".card-grid")).toBeVisible();

    const input = page.locator(".inline-add-input");
    await input.fill("Inception");
    await input.press("Enter");

    await expect(page.locator(".card.item")).toHaveCount(1);
    await expect(page.locator(".card.item").first()).toContainText("Inception");
    await expect(input).toHaveValue("");
  });

  test("two consecutive card-view adds create cards in sequence", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();

    const input = page.locator(".inline-add-input");
    await input.fill("Inception");
    await input.press("Enter");
    await expect(page.locator(".card.item")).toHaveCount(1);

    await input.fill("The Matrix");
    await input.press("Enter");
    await expect(page.locator(".card.item")).toHaveCount(2);

    // Items created in sequence; dummy sits after the last item, so real cards come first.
    await expect(page.locator(".card.item").nth(0)).toContainText("Inception");
    await expect(page.locator(".card.item").nth(1)).toContainText("The Matrix");
  });

  test("card view inline-add dummy is last card in grid", async ({ page }) => {
    await page.locator(".view-switcher-btn", { hasText: "Cards" }).click();

    const input = page.locator(".inline-add-input");
    await input.fill("Inception");
    await input.press("Enter");
    await expect(page.locator(".card.item", { hasText: "Inception" })).toBeVisible();

    const allCards = page.locator(".card-grid > .card");
    const count = await allCards.count();
    await expect(allCards.nth(count - 1)).toHaveClass(/inline-add-item/);
  });

  // -----------------------------------------------------------------------
  // Real items never get DUMMY_ITEM_ID as their after_id
  // -----------------------------------------------------------------------

  test("items are in a valid linked list (no item references the dummy)", async ({ page }) => {
    await addItemToList(page, "A");
    await addItemToList(page, "B");
    await addItemToList(page, "C");

    // Read items from IndexedDB and check none have after_id = DUMMY_ITEM_ID.
    const badAfterId = await page.evaluate(async () => {
      const DUMMY = "__inline_add__";
      return new Promise<boolean>((resolve, reject) => {
        const req = indexedDB.open("listr2");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("items", "readonly");
          const store = tx.objectStore("items");
          const getAll = store.getAll();
          getAll.onsuccess = () => {
            const items: Array<{ after_id: string | null }> = getAll.result;
            resolve(items.some((it) => it.after_id === DUMMY));
          };
          getAll.onerror = () => reject(getAll.error);
        };
        req.onerror = () => reject(req.error);
      });
    });
    expect(badAfterId).toBe(false);
  });
});
