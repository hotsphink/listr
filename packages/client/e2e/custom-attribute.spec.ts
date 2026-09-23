import { test, expect } from "@playwright/test";
import { clearDatabase, createBoard, createListInBoard, addItemToList, addItemViaModal } from "./helpers.js";

test.describe("custom attributes", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
  });

  test("create a list with a custom attribute, add an item, and verify display", async ({ page }) => {
    await createBoard(page, "Movies", [
      { key: "rating", label: "Rating", type: "number" },
      { key: "genre", label: "Genre" },
    ]);

    await createListInBoard(page, "My Movies", "Movies");
    await expect(page.locator(".page-header h1")).toHaveText("Movies");

    // Switch to table view to see attribute columns
    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();

    // Open the inline-add expand button to get the full New Item modal
    await page.locator(".inline-add-btn").last().click();
    const modal = page.locator(".modal");
    await modal.waitFor({ state: "visible" });
    await expect(modal.locator("h2")).toHaveText("New Item");

    // Verify the modal exposes all expected fields in order
    const labels = modal.locator(".form-field label");
    await expect(labels.nth(0)).toHaveText("Title");
    await expect(labels.nth(1)).toHaveText("Rating");
    await expect(labels.nth(2)).toHaveText("Genre");

    await modal.locator(".form-field input").first().fill("Inception");
    await modal.locator(".form-field").nth(1).locator("input").fill("4");
    await modal.locator(".form-field").nth(2).locator("input").fill("sci-fi");
    await modal.getByRole("button", { name: "Add", exact: true }).click();
    await modal.waitFor({ state: "hidden" });

    await expect(page.locator("tbody tr:not(.inline-add-item)")).toHaveCount(1);
    const firstRow = page.locator("tbody tr:not(.inline-add-item)").first();
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
    await expect(page.locator(".page-header h1")).toHaveText("Films");

    await page.locator(".view-switcher-btn", { hasText: "Table" }).click();

    await addItemViaModal(page, "Blade Runner", async (modal) => {
      await modal.locator(".form-field").nth(1).locator("input").fill("Ridley Scott");
    });

    const row = page.locator("tbody tr:not(.inline-add-item)").first();
    await expect(row.locator("td").nth(1)).toContainText("Blade Runner");
    await expect(row.locator("td").nth(2)).toContainText("Ridley Scott");

    await row.dblclick();
    await expect(page.locator(".modal h2")).toHaveText("Edit Item");
    const directorInput = page.locator(".modal .form-field").nth(1).locator("input");
    await expect(directorInput).toHaveValue("Ridley Scott");
  });

  test("board format is used in list display", async ({ page }) => {
    await createBoard(page, "Rated Movies", [
      { key: "year", label: "Year", type: "number" },
    ], "[title] ([year])");
    await createListInBoard(page, "Watchlist", "Rated Movies");
    await expect(page.locator(".page-header h1")).toHaveText("Rated Movies");

    // Default is list view — add an item via the inline-add expand button.
    await addItemViaModal(page, "Alien", async (modal) => {
      await modal.locator(".form-field").nth(1).locator("input").fill("1979");
    });

    // List view should show the formatted string from the board
    await expect(page.locator(".list-view-item:not(.inline-add-item)").first()).toContainText("Alien (1979)");
  });

  test("Number fields have no steppers and Whole Number fields do", async ({ page }) => {
    await createBoard(page, "Scores", [
      { key: "rating", label: "Rating", type: "number" },
      { key: "votes", label: "Votes", type: "integer" },
    ], "[title] [rating] [votes]");
    await createListInBoard(page, "Games", "Scores");
    await expect(page.locator(".page-header h1")).toHaveText("Scores");

    await addItemViaModal(page, "Chess", async (modal) => {
      const rating = modal.getByLabel("Rating");
      const votes = modal.getByLabel("Votes");
      await expect(rating).not.toHaveAttribute("type", "number");
      await expect(rating).toHaveAttribute("inputmode", "decimal");
      await expect(votes).toHaveAttribute("type", "number");
      await expect(votes).toHaveAttribute("step", "1");
      await rating.fill("7.85");
      await votes.fill("1200");
    });

    await expect(page.locator(".list-view-item:not(.inline-add-item)").first()).toContainText("Chess 7.85 1200");
  });

  test("a list format override inherits the board's definitions", async ({ page }) => {
    await createBoard(page, "Inherit", [], '[title] [tag]\n\ntag="(board)"');
    await createListInBoard(page, "Mine", "Inherit");
    await expect(page.locator(".page-header h1")).toHaveText("Inherit");
    await addItemToList(page, "Alien");
    const text = page.locator(".list-view-item:not(.inline-add-item) .formatted-text").first();
    await expect(text).toHaveText("Alien (board)");

    await page.locator(".multi-list-column-header", { hasText: "Mine" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Edit" }).click();
    const modal = page.locator(".modal");
    await modal.getByLabel("Override board format").check();
    // The override starts from the board's first line only.
    const format = modal.getByLabel("Format", { exact: true });
    await expect(format).toHaveValue("[title] [tag]");
    await format.fill("[tag] [title]");
    await modal.getByRole("button", { name: "Save" }).click();

    await expect(text).toHaveText("(board) Alien");
  });

  test("the board editor warns before breaking a list's format", async ({ page }) => {
    await createBoard(page, "Warn", [], '[title]\n\ntag="(board)"');
    await createListInBoard(page, "Mine", "Warn");
    await expect(page.locator(".page-header h1")).toHaveText("Warn");

    await page.locator(".multi-list-column-header", { hasText: "Mine" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Edit" }).click();
    let modal = page.locator(".modal");
    await modal.getByLabel("Override board format").check();
    await modal.getByLabel("Format", { exact: true }).fill("[title] [tag]");
    await modal.getByRole("button", { name: "Save" }).click();
    await expect(modal).toHaveCount(0);

    await page.locator(".sidebar-board", { hasText: "Warn" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Edit" }).click();
    modal = page.locator(".modal");
    await expect(modal.locator(".field-warning")).toHaveCount(0);
    await modal.getByLabel("Format", { exact: true }).fill("[title]");
    await expect(modal.locator(".field-warning")).toContainText('list "Mine"');

    // Declining the confirmation keeps the editor open; accepting saves.
    page.once("dialog", (d) => d.dismiss());
    await modal.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".modal h2")).toHaveText("Edit Board");
    page.once("dialog", (d) => d.accept());
    await modal.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".modal")).toHaveCount(0);
  });

  test("the format preview defaults to the fullest item and can switch items", async ({ page }) => {
    await createBoard(page, "Preview", [
      { key: "year", label: "Year", type: "integer" },
    ], "[title] ([year/?])");
    await createListInBoard(page, "Films", "Preview");
    await expect(page.locator(".page-header h1")).toHaveText("Preview");
    await addItemToList(page, "Plain");
    await addItemViaModal(page, "Rich", async (modal) => {
      await modal.getByLabel("Year").fill("1979");
    });

    await page.locator(".sidebar-board", { hasText: "Preview" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Edit" }).click();
    const modal = page.locator(".modal");
    const preview = modal.locator(".format-preview");
    await expect(preview).toHaveText("Rich (1979)");
    await modal.getByLabel("Sample").selectOption({ label: "Plain" });
    await expect(preview).toHaveText("Plain (?)");
  });

  test("board format applies styles and a tooltip and sanitizes markup", async ({ page }) => {
    const format = [
      '[title] <img src=x onerror="window.__xss = 1"><span class="modal-overlay">[year]</span>',
      "wrap as top:",
      "  if @year < 2000:",
      '    style(+subdued): "[top]" end',
      "  else:",
      '    "[top]"',
      "  end",
      "end",
      'tooltip: "Released [year]" end',
    ].join("\n");
    await createBoard(page, "Styled Movies", [
      { key: "year", label: "Year", type: "number" },
    ], format);
    await createListInBoard(page, "Watchlist", "Styled Movies");
    await expect(page.locator(".page-header h1")).toHaveText("Styled Movies");

    await addItemViaModal(page, "Alien", async (modal) => {
      await modal.locator(".form-field").nth(1).locator("input").fill("1979");
    });

    const text = page.locator(".list-view-item:not(.inline-add-item) .formatted-text").first();
    await expect(text).toContainText("Alien 1979");
    await expect(text).toHaveAttribute("title", "Released 1979");
    await expect(text.locator("span.fmt-subdued")).toHaveCount(1);
    // Format output may not use app classes or event handlers.
    await expect(text.locator(".modal-overlay")).toHaveCount(0);
    await expect(text.locator("img[onerror]")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  });
});
