import { test, expect } from "@playwright/test";
import { clearDatabase, createBoard, createListInBoard, addItemToList } from "./helpers.js";

test.describe("keyboard and screen reader access", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await createBoard(page, "Movies");
    await createListInBoard(page, "Watchlist", "Movies");
    await addItemToList(page, "Inception");
  });

  test("skip link moves focus to the main region", async ({ page }) => {
    await page.locator(".skip-link").focus();
    await expect(page.locator(".skip-link")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
    // The hash router must not have been navigated by the jump.
    expect(page.url()).toContain("#/board/");
  });

  test("landmarks and the document title name the current board", async ({ page }) => {
    await expect(page.locator("main#main-content")).toHaveCount(1);
    await expect(page.locator("nav.sidebar")).toHaveAttribute("aria-label", "Boards");
    await expect(page).toHaveTitle("Movies - Listr");
  });

  test("a board row is a button marked as the current page", async ({ page }) => {
    const row = page.getByRole("button", { name: /Movies/ }).first();
    await expect(row).toHaveAttribute("aria-current", "page");
  });

  test("a sidebar group header reports whether it is expanded", async ({ page }) => {
    const toggle = page.locator(".sidebar-group-toggle").first();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("Enter on an item row opens the edit dialog, and Escape closes it", async ({ page }) => {
    const row = page.locator(".list-view-item:not(.inline-add-item)").first();
    await row.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    // Named by its own heading.
    await expect(dialog).toContainText("Edit Item");

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    // Focus goes back to the row that opened it.
    await expect(row).toBeFocused();
  });

  test("Space on an item row toggles its selection", async ({ page }) => {
    const row = page.locator(".list-view-item:not(.inline-add-item)").first();
    await row.focus();
    await page.keyboard.press(" ");
    await expect(row).toHaveClass(/selected/);
    await page.keyboard.press(" ");
    await expect(row).not.toHaveClass(/selected/);
  });

  test("a dialog keeps Tab inside itself", async ({ page }) => {
    await page.locator(".list-view-item:not(.inline-add-item)").first().focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Walk well past the end of the dialog's controls; focus must never escape.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
      expect(inside).toBe(true);
    }
  });

  test("board actions open a keyboard-navigable menu", async ({ page }) => {
    await page.getByRole("button", { name: /Actions for board Movies/ }).click();

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    // The first entry takes focus so arrow keys have somewhere to start.
    await expect(menu.getByRole("menuitem").first()).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem").last()).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("list actions are reachable without a right-click", async ({ page }) => {
    await page.getByRole("button", { name: /Actions for list Watchlist/ }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Edit" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  });

  test("every form field in the item dialog has an accessible name", async ({ page }) => {
    await page.locator(".list-view-item:not(.inline-add-item)").first().focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const unnamed = await dialog.evaluate((root) =>
      Array.from(root.querySelectorAll("input, select, textarea"))
        .filter((el) => (el as HTMLElement).getClientRects().length > 0)
        .filter((el) => {
          const id = el.id;
          const labelled = id && root.ownerDocument.querySelector(`label[for="${id}"]`);
          return !labelled && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby") && !el.closest("label");
        })
        .map((el) => el.outerHTML.slice(0, 80)),
    );
    expect(unnamed).toEqual([]);
  });

  test("no interactive element is left unreachable by the keyboard", async ({ page }) => {
    // Anything with a click handler should be a real control, not a bare div.
    const offenders = await page.evaluate(() => {
      const interactive = "a[href], button, input, select, textarea, [tabindex], [role='button'], [role='menuitem']";
      return Array.from(document.querySelectorAll(".main *, .sidebar *"))
        // The inline-add row is a container for its input, not a target itself.
        .filter((el) => !el.classList.contains("inline-add-item"))
        .filter((el) => el.classList.contains("sidebar-item") || el.classList.contains("list-view-item"))
        .filter((el) => !el.matches(interactive))
        .map((el) => el.className);
    });
    expect(offenders).toEqual([]);
  });
});
