import type { Page, Locator } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Add an item with only a title using the inline-add input in list view.
 * Types the title and presses Enter; waits for the real item to appear.
 */
export async function addItemToList(page: Page, title: string) {
  const input = page.locator(".inline-add-input").last();
  await input.fill(title);
  await input.press("Enter");
  await expect(page.locator(".list-view-item:not(.inline-add-item)", { hasText: title })).toBeVisible();
}

/**
 * Add an item via the expand (⤢) button, which opens the full ItemFormModal.
 * Optionally fill attribute fields via the callback before clicking Add.
 * Waits for the modal to close before returning.
 */
export async function addItemViaModal(
  page: Page,
  title: string,
  fillAttrs?: (modal: Locator) => Promise<void>,
) {
  await page.locator(".inline-add-btn").last().click();
  const modal = page.locator(".modal");
  await modal.waitFor({ state: "visible" });
  await modal.locator(".form-field input").first().fill(title);
  if (fillAttrs) await fillAttrs(modal);
  await modal.getByRole("button", { name: "Add", exact: true }).click();
  await modal.waitFor({ state: "hidden" });
}

export async function clearDatabase(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase("listr");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
  await page.reload();
  await page.waitForSelector(".sidebar");
}

export async function fillSchemaField(page: Page, input: Locator, value: string) {
  await input.click({ clickCount: 3 });
  await page.keyboard.type(value);
}

export async function createBoard(
  page: Page,
  name: string,
  attributes?: Array<{ key: string; label: string; type?: string; options?: string }>,
  formatString?: string,
) {
  await page.locator(".sidebar-item.sidebar-new.board").click();
  await expect(page.locator(".modal h2")).toHaveText("New Board");

  await page.locator(".modal .form-field input").first().fill(name);

  if (attributes) {
    for (const attr of attributes) {
      await page.getByRole("button", { name: "+ Add attribute" }).click();
      const entries = page.locator(".schema-entry");
      const entry = entries.last();
      await fillSchemaField(page, entry.locator("input").nth(0), attr.key);
      await page.keyboard.press("Tab");
      await fillSchemaField(page, entry.locator("input").nth(1), attr.label);
      await page.keyboard.press("Tab");
      if (attr.type) {
        await entry.locator("select").first().selectOption(attr.type);
      }
      if (attr.options) {
        await entry.locator('input[placeholder="opt1, opt2, ..."]').fill(attr.options);
        await page.keyboard.press("Tab");
      }
    }
  }

  if (formatString) {
    const formatField = page.locator(".modal .form-field").filter({ has: page.locator("label", { hasText: "Format String" }) });
    await formatField.locator("input").fill(formatString);
  }

  await page.getByRole("button", { name: "Create" }).click();
}

export async function createListInBoard(
  page: Page,
  name: string,
  boardName?: string,
) {
  if (boardName) {
    const catSection = page.locator(".sidebar-board").filter({
      has: page.locator(".sidebar-board-header", { hasText: boardName }),
    });
    const listsDiv = catSection.locator(".sidebar-board-lists");
    if (!(await listsDiv.isVisible())) {
      await catSection.locator(".sidebar-board-chevron").click();
      await listsDiv.waitFor({ state: "visible" });
    }
    await catSection.locator(".sidebar-item.sidebar-new").click();
  } else {
    await page.locator(".sidebar-board-lists .sidebar-item.sidebar-new").first().click();
  }
  const renameInput = page.locator(".sidebar-rename-input").last();
  await renameInput.waitFor({ state: "visible" });
  await renameInput.fill(name);
  await renameInput.press("Enter");
  await page.waitForSelector(".page-header");
}
