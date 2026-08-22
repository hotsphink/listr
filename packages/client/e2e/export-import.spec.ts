import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { clearDatabase, createBoard, createListInBoard, addItemToList } from "./helpers.js";

interface DbItem { id: string; title: string; updated_at: number; list_id: string }

async function getItems(page: Page): Promise<DbItem[]> {
  return page.evaluate(() =>
    new Promise<DbItem[]>((resolve) => {
      const req = indexedDB.open("listr");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("items", "readonly");
        const all = tx.objectStore("items").getAll();
        all.onsuccess = () => resolve(all.result as DbItem[]);
        all.onerror = () => resolve([]);
      };
      req.onerror = () => resolve([]);
    }),
  );
}

async function getBoardNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    new Promise<string[]>((resolve) => {
      const req = indexedDB.open("listr");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("boards", "readonly");
        const all = tx.objectStore("boards").getAll();
        all.onsuccess = () => resolve((all.result as { name: string }[]).map((b) => b.name));
        all.onerror = () => resolve([]);
      };
      req.onerror = () => resolve([]);
    }),
  );
}

async function uploadJsonFile(page: Page, obj: unknown, name = "export.json") {
  const fileInput = page.locator('input[type="file"][accept="image/*,.json"]');
  await fileInput.setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(obj)),
  });
}

test.describe("native export/import round-trip", () => {
  test.beforeEach(async ({ page }) => {
    await clearDatabase(page);
  });

  test("Export All then Import restores data into a cleared database", async ({ page }) => {
    await createBoard(page, "Movies");
    await createListInBoard(page, "Watchlist", "Movies");
    await addItemToList(page, "Inception");

    const downloadPromise = page.waitForEvent("download");
    await page.locator(".sidebar-item", { hasText: "↑ Export" }).click();
    const download = await downloadPromise;
    const exportedPath = await download.path();
    const exported = JSON.parse(readFileSync(exportedPath!, "utf-8"));
    expect(exported.listr_export).toBe("2");

    await clearDatabase(page);
    expect(await getBoardNames(page)).toEqual([]);

    await page.locator(".sidebar-item", { hasText: "↓ Import" }).click();
    await uploadJsonFile(page, exported);
    await expect(page.locator(".import-native-stats")).toBeVisible();
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.locator(".modal")).toContainText("boards");

    expect(await getBoardNames(page)).toContain("Movies");
    const items = await getItems(page);
    expect(items.map((i) => i.title)).toContain("Inception");
  });

  test("importing a tombstone removes an existing item", async ({ page }) => {
    await createBoard(page, "Movies");
    await createListInBoard(page, "Watchlist", "Movies");
    await addItemToList(page, "Inception");
    const item = (await getItems(page)).find((i) => i.title === "Inception")!;

    await page.locator(".sidebar-item", { hasText: "↓ Import" }).click();
    await uploadJsonFile(page, {
      listr_export: "2",
      exported_at: Date.now(),
      boards: [],
      tombstones: [{ entity_type: "item", entity_id: item.id, deleted_at: Date.now() }],
    });

    await expect(page.locator(".import-native-stats")).toContainText("1");
    await page.getByRole("button", { name: "Apply" }).click();

    const remaining = await getItems(page);
    expect(remaining.map((i) => i.id)).not.toContain(item.id);
  });

  test("an independently-newer local item survives an older imported tombstone", async ({ page }) => {
    await createBoard(page, "Movies");
    await createListInBoard(page, "Watchlist", "Movies");
    await addItemToList(page, "Inception");
    const item = (await getItems(page)).find((i) => i.title === "Inception")!;

    await page.locator(".sidebar-item", { hasText: "↓ Import" }).click();
    await uploadJsonFile(page, {
      listr_export: "2",
      exported_at: Date.now(),
      boards: [],
      // Older than the item's updated_at — the local edit wins, per LWW.
      tombstones: [{ entity_type: "item", entity_id: item.id, deleted_at: item.updated_at - 10_000 }],
    });
    await page.getByRole("button", { name: "Apply" }).click();

    const remaining = await getItems(page);
    expect(remaining.map((i) => i.id)).toContain(item.id);
  });

  test("importing an unrelated export leaves existing data untouched", async ({ page }) => {
    await createBoard(page, "Existing");
    await createListInBoard(page, "L1", "Existing");
    await addItemToList(page, "Keep me");

    await page.locator(".sidebar-item", { hasText: "↓ Import" }).click();
    await uploadJsonFile(page, {
      listr_export: "2",
      exported_at: Date.now(),
      boards: [{
        id: "board-imported-1",
        name: "Imported Board",
        color: "#5b8def",
        position: 0,
        schema: [],
        format_string: "{title}",
        lists: [{
          id: "list-imported-1",
          name: "Imported List",
          icon: "",
          position: 0,
          format_string: null,
          view_mode: "list",
          items: [{ id: "item-imported-1", title: "New item", attributes: {} }],
        }],
      }],
    });
    await page.getByRole("button", { name: "Apply" }).click();

    expect(await getBoardNames(page)).toEqual(expect.arrayContaining(["Existing", "Imported Board"]));
    const items = await getItems(page);
    expect(items.map((i) => i.title)).toEqual(expect.arrayContaining(["Keep me", "New item"]));
  });
});
