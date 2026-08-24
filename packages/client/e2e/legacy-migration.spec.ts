import { test, expect } from "@playwright/test";

// Covers the one-time bridge in packages/client/src/db/database.ts that carries
// sync_config/sync_endpoints over from the pre-flag-day "listr" database to the
// current "listr2" one, then deletes the old database.

test("carries over sync_config/sync_endpoints from the legacy database and deletes it", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("listr2");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  }));

  // Seed a legacy "listr" database, mimicking a pre-upgrade device.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const req = indexedDB.open("listr");
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("sync_config", { keyPath: "id" });
      db.createObjectStore("sync_endpoints", { keyPath: "id" });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(["sync_config", "sync_endpoints"], "readwrite");
      tx.objectStore("sync_config").put({
        id: "default", sync_url: "", sync_key: "legacykey123", client_id: "legacy-client", enabled: true, last_sync_at: 0,
      });
      tx.objectStore("sync_endpoints").put({
        id: "ep1", host: "legacy.example.com", port: 1234, enabled: true, secure: true, last_server_id: null, position: 0,
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }));

  await page.reload();
  await page.waitForSelector(".sidebar");

  await expect.poll(async () => {
    return page.evaluate(() => new Promise<{ syncKey?: string; endpointCount: number } | null>((resolve, reject) => {
      const req = indexedDB.open("listr2");
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("sync_config")) { db.close(); resolve(null); return; }
        const tx = db.transaction(["sync_config", "sync_endpoints"], "readonly");
        let syncKey: string | undefined;
        let endpointCount = 0;
        tx.objectStore("sync_config").get("default").onsuccess = (e) => {
          syncKey = (e.target as IDBRequest).result?.sync_key;
        };
        tx.objectStore("sync_endpoints").count().onsuccess = (e) => {
          endpointCount = (e.target as IDBRequest).result;
        };
        tx.oncomplete = () => { db.close(); resolve(syncKey === undefined ? null : { syncKey, endpointCount }); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    }));
  }, { timeout: 5000 }).toEqual({ syncKey: "legacykey123", endpointCount: 1 });

  // The legacy database must be gone.
  const legacyExisted = await page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    let existed = true;
    const req = indexedDB.open("listr");
    req.onupgradeneeded = () => { existed = false; req.transaction?.abort(); };
    req.onsuccess = () => { req.result.close(); resolve(existed); };
    req.onerror = () => resolve(false);
  }));
  expect(legacyExisted).toBe(false);
});
