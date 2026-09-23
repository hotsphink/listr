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
 * Add an item via the expand button, which opens the full ItemFormModal.
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
      const req = indexedDB.deleteDatabase("listr2");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
  await page.reload();
  await page.waitForSelector(".sidebar");
}

/**
 * Give this device a home key directly in IndexedDB, bypassing both the Admin
 * page UI and an actual server registration. Most specs run no sync server;
 * syncServer.ts stands a real one up for the few that need one, which costs
 * seconds per run and is worth avoiding here. "Does this device have a default
 * sync key" means server_identity.home_key, a server-assigned field that
 * normally arrives only via a real handshake. This fakes just enough of a `server_identity` row, one
 * server with `state: "active"`, for Sidebar's "My Boards" gating to behave as
 * if registration had happened.
 */
export async function setDefaultSyncKey(page: Page, key: string) {
  await page.evaluate((homeKey) => {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("listr2");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("server_identity", "readwrite");
        const store = tx.objectStore("server_identity");
        store.put({
          server_id: "e2e-fake-server",
          state: "active",
          user_id: "e2e-fake-user",
          home_key: homeKey,
          caps: ["sync"],
          display_name: null,
          updated_at: Date.now(),
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, key);
}

/**
 * Every row of one IndexedDB object store, for asserting on state the UI does
 * not render, such as which sync keys a join actually delivered.
 */
export async function readStore<T = any>(page: Page, storeName: string): Promise<T[]> {
  return page.evaluate((name) => {
    return new Promise<any[]>((resolve, reject) => {
      const req = indexedDB.open("listr2");
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(name)) { db.close(); resolve([]); return; }
        const get = db.transaction(name, "readonly").objectStore(name).getAll();
        get.onsuccess = () => { db.close(); resolve(get.result); };
        get.onerror = () => { db.close(); reject(get.error); };
      };
      req.onerror = () => reject(req.error);
    });
  }, storeName);
}

/**
 * Configure a sync endpoint directly in IndexedDB, standing for a client that
 * has already spoken to this server: `last_server_id` is what lets a join link
 * resolve its server *identity* to this route without probing anything.
 *
 * Reloads afterwards, because writing through raw IndexedDB goes behind
 * Dexie's back: the liveQuery App.tsx feeds SyncClient from never fires, so
 * without a reload the new endpoint is never connected to at all.
 */
export async function addSyncEndpoint(
  page: Page,
  endpoint: { host: string; port: number; secure: boolean; lastServerId: string | null },
) {
  await page.evaluate((ep) => {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("listr2");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("sync_endpoints", "readwrite");
        tx.objectStore("sync_endpoints").put({
          id: crypto.randomUUID(),
          host: ep.host,
          port: ep.port,
          secure: ep.secure,
          enabled: true,
          last_server_id: ep.lastServerId,
          position: Date.now(),
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, endpoint);
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
  format?: string,
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

  if (format) {
    await page.locator(".modal").getByLabel("Format", { exact: true }).fill(format);
  }

  await page.getByRole("button", { name: "Create" }).click();
}

export async function createListInBoard(
  page: Page,
  name: string,
  boardName: string,
) {
  const boardRow = page.locator(".sidebar-board").filter({ hasText: boardName });
  await boardRow.click();
  await page.waitForSelector(".page-header");

  await page.locator(".multi-list-new-column").click();
  const modal = page.locator(".modal");
  await modal.waitFor({ state: "visible" });
  await modal.locator(".form-field input").first().fill(name);
  await modal.getByRole("button", { name: "Save" }).click();
  await modal.waitFor({ state: "hidden" });
}
