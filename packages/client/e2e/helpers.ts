import type { Page, Locator } from "@playwright/test";
import { expect } from "@playwright/test";

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
  await page.waitForSelector(".page-header");
}

export async function fillSchemaField(page: Page, input: Locator, value: string) {
  await input.click({ clickCount: 3 });
  await page.keyboard.type(value);
}

export async function createCategory(
  page: Page,
  name: string,
  attributes?: Array<{ key: string; label: string; type?: string; options?: string }>,
  formatString?: string,
) {
  await page.getByRole("button", { name: "+ Category" }).click();
  await expect(page.locator(".modal h2")).toHaveText("New Category");

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
    const formatInput = page.locator(".modal .form-field input").nth(1); // after name input, skipping color
    // The format string field is the one with label "Format String"
    const formatField = page.locator(".modal .form-field").filter({ has: page.locator("label", { hasText: "Format String" }) });
    await formatField.locator("input").fill(formatString);
  }

  await page.getByRole("button", { name: "Create" }).click();
}

export async function createListInCategory(
  page: Page,
  name: string,
  categoryName?: string,
) {
  await page.getByRole("button", { name: "+ New List" }).first().click();
  await expect(page.locator(".modal h2")).toHaveText("New List");

  await page.locator(".modal .form-field input").first().fill(name);

  if (categoryName) {
    await page.locator(".modal select").first().selectOption({ label: categoryName });
  }

  await page.getByRole("button", { name: "Create" }).click();
}
