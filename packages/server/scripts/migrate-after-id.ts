// One-time offline migration: convert at-rest item blobs from legacy numeric
// `position` ordering to `after_id` linked-list ordering.
//
// The sync server stores opaque entity JSON and never migrates it, so the client
// Dexie `.upgrade()` only fixes each client's LOCAL rows — blobs already sitting
// on the server keep their old shape until this script rewrites them. Uses the
// SAME migrateListToAfterId as the client so both produce identical chains.
//
// Dry-run by default; pass --apply to write. See scripts/cli.ts for the shared
// convention (--db=, backup-before-write). Run with the sync server STOPPED
// (the prod DB is treated read-only during normal operation — see memory
// feedback_db_readonly). Usage:
//
//   pnpm exec tsx packages/server/scripts/migrate-after-id.ts [--apply] [--db=/path/to/listr.db]
//
// Internally-mixed lists (whose recovered order is heuristic) are reported.

import Database from "better-sqlite3";
import { migrateListToAfterId, ENTITY_SCHEMA_VERSION, type OrderableItem } from "@listr/shared";
import { parseScriptArgs } from "./cli.js";

interface ItemRow {
  id: string;
  sync_key: string;
  list_id: string | null;
  data: string;
}

function main(): void {
  const { dbPath, apply } = parseScriptArgs("migrate-after-id");
  const sql = new Database(dbPath);
  sql.pragma("journal_mode = WAL");

  const rows = sql.prepare("SELECT id, sync_key, list_id, data FROM items").all() as ItemRow[];

  // Group by (sync_key, list_id) — ordering is per list within a namespace.
  const groups = new Map<string, ItemRow[]>();
  for (const row of rows) {
    const key = `${row.sync_key} ${row.list_id ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const update = sql.prepare("UPDATE items SET data = ? WHERE id = ?");

  // list_id -> name, so output names the lists it touches rather than raw IDs.
  const listNames = new Map<string, string>();
  for (const r of sql.prepare("SELECT id, data FROM lists").all() as { id: string; data: string }[]) {
    try { listNames.set(r.id, (JSON.parse(r.data).name as string) ?? "(unnamed)"); } catch { /* ignore */ }
  }
  const labelFor = (listId: string) => `"${listNames.get(listId) ?? "(unknown list)"}" [${listId}]`;

  let listsConverted = 0;
  let itemsRewritten = 0;
  const mixedLists: string[] = [];

  const run = sql.transaction(() => {
    for (const groupRows of groups.values()) {
      const listId = groupRows[0]?.list_id ?? "";
      const parsed = new Map<string, Record<string, unknown>>();
      const orderable: OrderableItem[] = groupRows.map((row) => {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        parsed.set(row.id, data);
        const item: OrderableItem = { id: row.id, created_at: data.created_at as number | undefined };
        if ("after_id" in data) item.after_id = data.after_id as string | null;
        if ("position" in data) item.position = data.position as number;
        return item;
      });

      // Nothing to do if every item is already in after_id shape with no position.
      const needsWork = orderable.some((i) => i.position !== undefined || i.after_id === undefined);
      if (!needsWork) continue;

      const { afterIds, mixed } = migrateListToAfterId(orderable);
      const label = labelFor(listId);
      if (mixed) mixedLists.push(label);

      let converted = 0;
      for (const row of groupRows) {
        const data = parsed.get(row.id)!;
        data.after_id = afterIds.get(row.id) ?? null;
        delete data.position;
        data.schema_version = ENTITY_SCHEMA_VERSION;
        // Deliberately keep data.updated_at unchanged: clients migrate their own
        // local copies via the Dexie upgrade, so bumping it would cause a needless
        // resync storm. A fresh full-sync pulls this new-shape blob regardless.
        if (apply) update.run(JSON.stringify(data), row.id);
        itemsRewritten++;
        converted++;
      }
      listsConverted++;
      console.log(`  ${apply ? "converted" : "would convert"} ${label} — ${converted} item(s)${mixed ? " (internally mixed — order is heuristic)" : ""}`);
    }
  });
  run();

  console.log(`\n[migrate-after-id] ${apply ? "converted" : "would convert"} ${itemsRewritten} items across ${listsConverted} list(s)`);
  if (mixedLists.length > 0) {
    console.warn(`[migrate-after-id] ${mixedLists.length} internally-mixed list(s) — order is heuristic, review manually:`);
    for (const m of mixedLists) console.warn(`    ${m}`);
  }
  sql.close();
}

main();
