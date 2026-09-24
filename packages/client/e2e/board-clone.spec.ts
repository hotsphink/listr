import { test, expect, type Page } from "@playwright/test";
import { clearDatabase, createBoard, createListInBoard, addItemToList, addItemViaModal } from "./helpers.js";

/** A board with an attribute, a custom format, two lists, and items in one of them. */
async function makeSource(page: Page): Promise<void> {
  await createBoard(page, "Movies", [{ key: "rating", label: "Rating", type: "number" }], "[title] ([rating])");
  await createListInBoard(page, "Watch", "Movies");
  await addItemViaModal(page, "Alien", async (modal) => {
    await modal.locator(".form-field").nth(1).locator("input").fill("5");
  });
  await addItemToList(page, "Brazil");
  await createListInBoard(page, "Seen", "Movies");
}

async function openClone(page: Page) {
  await page.locator(".sidebar-board", { hasText: "Movies" }).first().click({ button: "right" });
  await page.locator(".context-menu-item", { hasText: "Clone" }).click();
  const modal = page.locator(".modal");
  await expect(modal.locator("h2")).toHaveText("Clone board");
  await expect(modal.getByLabel("Name", { exact: true })).toHaveValue("Clone of Movies");
  return modal;
}

const columnNames = (page: Page) => page.locator(".multi-list-column-header .list-name, .list-column-name");

test.describe("board clone", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
    await makeSource(page);
  });

  test("clones lists and their items, in order, with the board's schema and format", async ({ page }) => {
    const modal = await openClone(page);
    await modal.getByLabel("Lists and their items").check();
    await modal.getByRole("button", { name: "Clone", exact: true }).click();
    await expect(modal).toHaveCount(0);

    await expect(page.locator(".page-header h1")).toHaveText("Clone of Movies");
    const items = page.locator(".list-view-item:not(.inline-add-item)");
    await expect(items).toHaveText([/Alien \(5\)/, /Brazil/]);
    await expect(page.getByRole("button", { name: /^Watch/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Seen/ })).toBeVisible();

    // The clone carries the source's schema.
    await page.locator(".sidebar-board", { hasText: "Clone of Movies" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Edit" }).first().click();
    await expect(page.locator(".modal h2")).toHaveText("Edit Board");
    await expect(page.locator(".modal .schema-entry")).toHaveCount(1);
  });

  test("clones list names only", async ({ page }) => {
    const modal = await openClone(page);
    await expect(modal.getByLabel("List names only")).toBeChecked();
    // The source has no integrations, so there is nothing to offer.
    await expect(modal.getByRole("group", { name: "Integrations" })).toHaveCount(0);
    await modal.getByRole("button", { name: "Clone", exact: true }).click();
    await expect(page.locator(".page-header h1")).toHaveText("Clone of Movies");
    await expect(page.getByRole("button", { name: /^Watch/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Seen/ })).toBeVisible();
    await expect(page.locator(".list-view-item:not(.inline-add-item)")).toHaveCount(0);
  });

  test("clones no lists, under a new name", async ({ page }) => {
    const modal = await openClone(page);
    await modal.getByLabel("Name", { exact: true }).fill("Film Ideas");
    await modal.getByLabel("No lists").check();
    await modal.getByRole("button", { name: "Clone", exact: true }).click();
    await expect(page.locator(".page-header h1")).toHaveText("Film Ideas");
    await expect(page.getByRole("button", { name: /^Watch/ })).toHaveCount(0);
  });

  test("the board header menu offers Clone too", async ({ page }) => {
    await page.getByRole("button", { name: "Actions for board Movies" }).click();
    await page.locator(".context-menu-item", { hasText: "Clone" }).click();
    await expect(page.locator(".modal h2")).toHaveText("Clone board");
  });
});
