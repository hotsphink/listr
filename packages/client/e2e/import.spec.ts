import { test, expect, type Page } from "@playwright/test";
import { clearDatabase, createCategory } from "./helpers.js";

// Minimal 1×1 white PNG — content doesn't matter (server is mocked); only mimeType matters for the client check
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108020000" +
  "00907753de0000000c4944415478d763f8cfc000000002000" +
  "1e221bc330000000049454e44ae426082",
  "hex",
);

const FAKE_SERVER_WS = "wss://fake.test:19999";

async function setupSyncConfig(page: Page) {
  await page.evaluate((url: string) => {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("listr");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("sync_config", "readwrite");
        tx.objectStore("sync_config").put({ id: "default", sync_url: url });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, FAKE_SERVER_WS);
}

function mockImportRoute(page: Page, response: object) {
  return page.route("**/api/import", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    }),
  );
}

async function uploadFakeImage(page: Page) {
  const fileInput = page.locator('input[type="file"][accept="image/*"]');
  await fileInput.setInputFiles({ name: "board.png", mimeType: "image/png", buffer: TINY_PNG });
}

async function getItemTitles(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    new Promise<string[]>((resolve) => {
      const req = indexedDB.open("listr");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("items", "readonly");
        const all = tx.objectStore("items").getAll();
        all.onsuccess = () => resolve((all.result as { title: string }[]).map((i) => i.title));
        all.onerror = () => resolve([]);
      };
      req.onerror = () => resolve([]);
    }),
  );
}

test.describe("import modal", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
  });

  test("global Import sidebar link opens the modal", async ({ page }) => {
    await page.locator(".sidebar-item", { hasText: "↓ Import" }).click();
    await expect(page.locator(".modal h2")).toHaveText("Import from Screenshot");
    await expect(page.locator(".import-dropzone")).toBeVisible();
    await expect(page.locator(".modal")).toContainText("globally");
  });

  test("Import from category context menu opens scoped modal", async ({ page }) => {
    await createCategory(page, "Movies");
    await page.locator(".sidebar-category-header", { hasText: "Movies" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Import" }).click();
    await expect(page.locator(".modal h2")).toHaveText("Import from Screenshot");
    await expect(page.locator(".modal")).toContainText('into "Movies"');
  });

  test("Cancel closes the modal", async ({ page }) => {
    await page.locator(".sidebar-item", { hasText: "↓ Import" }).click();
    await expect(page.locator(".modal")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".modal")).toHaveCount(0);
  });

  test("uploading an image shows a preview of extracted items", async ({ page }) => {
    await createCategory(page, "Movies");
    await setupSyncConfig(page);
    await mockImportRoute(page, {
      categories: [{
        name: "Movies",
        lists: [
          { name: "Watchlist", items: [{ title: "Inception" }, { title: "The Matrix" }] },
        ],
      }],
    });

    await page.locator(".sidebar-item", { hasText: "↓ Import" }).click();
    await uploadFakeImage(page);

    await expect(page.locator(".import-preview")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".import-summary")).toContainText("2 new items");
    await expect(page.locator(".import-preview-list", { hasText: "Watchlist" })).toBeVisible();
    await expect(page.locator(".import-preview-item", { hasText: "Inception" })).toBeVisible();
    await expect(page.locator(".import-preview-item", { hasText: "The Matrix" })).toBeVisible();
    // All items are new
    const newBadges = page.locator(".import-preview-item .badge-new");
    await expect(newBadges).toHaveCount(2);
  });

  test("confirming import creates items in the database", async ({ page }) => {
    await createCategory(page, "Movies");
    await setupSyncConfig(page);
    await mockImportRoute(page, {
      categories: [{
        name: "Movies",
        lists: [{ name: "Watchlist", items: [{ title: "Inception" }, { title: "The Matrix" }] }],
      }],
    });

    await page.locator(".sidebar-item", { hasText: "↓ Import" }).click();
    await uploadFakeImage(page);
    await expect(page.locator(".import-preview")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /Import 2 items/ }).click();
    await expect(page.locator(".modal")).toContainText("Imported 2 items successfully");

    const titles = await getItemTitles(page);
    expect(titles).toContain("Inception");
    expect(titles).toContain("The Matrix");
  });

  test("done button closes the modal after import", async ({ page }) => {
    await createCategory(page, "Movies");
    await setupSyncConfig(page);
    await mockImportRoute(page, {
      categories: [{
        name: "Movies",
        lists: [{ name: "Watchlist", items: [{ title: "Inception" }] }],
      }],
    });

    await page.locator(".sidebar-item", { hasText: "↓ Import" }).click();
    await uploadFakeImage(page);
    await expect(page.locator(".import-preview")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /Import/ }).click();
    await expect(page.locator(".modal")).toContainText("Imported 1 item successfully");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.locator(".modal")).toHaveCount(0);
  });

  test("already-existing items are shown as skip in preview", async ({ page }) => {
    await createCategory(page, "Movies");
    await setupSyncConfig(page);

    const twoItemsResponse = {
      categories: [{
        name: "Movies",
        lists: [{ name: "Watchlist", items: [{ title: "Inception" }, { title: "The Matrix" }] }],
      }],
    };

    // First import — creates both items
    await mockImportRoute(page, twoItemsResponse);
    await page.locator(".sidebar-item", { hasText: "↓ Import" }).click();
    await uploadFakeImage(page);
    await expect(page.locator(".import-preview")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /Import 2 items/ }).click();
    await expect(page.locator(".modal")).toContainText("Imported 2 items successfully");
    await page.getByRole("button", { name: "Done" }).click();

    // Second import with same data — both should be skipped
    await mockImportRoute(page, twoItemsResponse);
    await page.locator(".sidebar-item", { hasText: "↓ Import" }).click();
    await uploadFakeImage(page);
    await expect(page.locator(".import-preview")).toBeVisible({ timeout: 10_000 });

    await expect(page.locator(".import-summary")).toContainText("0 new items");
    const skipBadges = page.locator(".import-preview-item .badge-skip");
    await expect(skipBadges).toHaveCount(2);
    await expect(page.getByRole("button", { name: /Import/ })).toBeDisabled();
  });

  test("attributes are shown as pills in the preview", async ({ page }) => {
    await createCategory(page, "Movies", [{ key: "imdb", label: "IMDB", type: "number" }]);
    await setupSyncConfig(page);
    await mockImportRoute(page, {
      categories: [{
        name: "Movies",
        lists: [{ name: "Watchlist", items: [{ title: "Inception", attributes: { imdb: 8.8 } }] }],
      }],
    });

    await page.locator(".sidebar-category-header", { hasText: "Movies" }).click({ button: "right" });
    await page.locator(".context-menu-item", { hasText: "Import" }).click();
    await uploadFakeImage(page);

    await expect(page.locator(".import-preview")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".import-attr-pill", { hasText: "imdb: 8.8" })).toBeVisible();
  });

  test("Back button returns to the upload screen", async ({ page }) => {
    await createCategory(page, "Movies");
    await setupSyncConfig(page);
    await mockImportRoute(page, {
      categories: [{ name: "Movies", lists: [{ name: "Watchlist", items: [{ title: "Inception" }] }] }],
    });

    await page.locator(".sidebar-item", { hasText: "↓ Import" }).click();
    await uploadFakeImage(page);
    await expect(page.locator(".import-preview")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.locator(".import-dropzone")).toBeVisible();
    await expect(page.locator(".import-preview")).toHaveCount(0);
  });
});
