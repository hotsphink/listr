/**
 * One-time fixup: revert every item in the sync DB to the legacy `position`
 * ordering format, removing any `after_id` fields written by newer clients.
 *
 * Ordering lives inside each item's `data` JSON blob (there is no position
 * column). Items are one of two disjoint shapes: `{position: number}` (old) or
 * `{after_id: string|null}` (new). This script, per list that contains ANY
 * after_id item:
 *   1. builds a best-effort total order — position items form the spine (sorted
 *      by position), then each after_id item is spliced in immediately after its
 *      chain target (after_id === null → front; missing/broken target → appended);
 *   2. renumbers the whole list with clean integer positions (0, 64, 128, …);
 *   3. rewrites each item's data with the new `position` and no `after_id`,
 *      bumping updated_at (column and in-blob) so clients re-sync the fix.
 * Lists with no after_id items are left completely untouched.
 *
 * SAFETY:
 *   - Run with the sync server STOPPED (SQLite is single-writer).
 *   - Dry run by default; pass --apply to write. See scripts/cli.ts.
 *   - On --apply a timestamped backup copy is made first.
 *
 * Usage:
 *   pnpm exec tsx packages/server/scripts/revert-items-to-position.ts [--apply] [--db=/path/to/listr.db]
 *   (default DB: ~/.local/share/listr/listr.db)
 */
import Database from "better-sqlite3";
import { parseScriptArgs } from "./cli.js";

const POSITION_STEP = 64;

const { dbPath: DB_PATH, apply } = parseScriptArgs("revert-items-to-position");

interface ItemData {
  position?: number;
  after_id?: string | null;
  updated_at?: number;
  title?: string;
  [k: string]: unknown;
}
interface Node {
  id: string;
  created_at: number;
  data: ItemData;
  wasAfterId: boolean;
}

/** Build a best-effort total order merging the position spine with after_id chains. */
function buildOrder(items: Node[]): Node[] {
  const posItems = items
    .filter((i) => !i.wasAfterId)
    .sort((a, b) => (a.data.position ?? 0) - (b.data.position ?? 0));
  const result: Node[] = [...posItems];

  let remaining = items.filter((i) => i.wasAfterId).sort((a, b) => a.created_at - b.created_at);
  let progress = true;
  while (remaining.length && progress) {
    progress = false;
    const still: Node[] = [];
    for (const it of remaining) {
      const target = it.data.after_id;
      if (target === null || target === undefined) {
        result.unshift(it);
        progress = true;
      } else if (target === it.id) {
        still.push(it); // self-reference — treat as orphan
      } else {
        const idx = result.findIndex((r) => r.id === target);
        if (idx >= 0) {
          result.splice(idx + 1, 0, it);
          progress = true;
        } else {
          still.push(it); // target not placed yet (or missing)
        }
      }
    }
    remaining = still;
  }
  // Orphans (broken/missing chain target): append in created_at order.
  for (const it of remaining) result.push(it);
  return result;
}

const db = new Database(DB_PATH);

const rows = db
  .prepare("SELECT id, list_id, data, created_at FROM items")
  .all() as { id: string; list_id: string; data: string; created_at: number | null }[];

const listNames = new Map<string, string>();
for (const r of db.prepare("SELECT id, data FROM lists").all() as { id: string; data: string }[]) {
  try { listNames.set(r.id, (JSON.parse(r.data).name as string) ?? "?"); } catch { /* ignore */ }
}

const byList = new Map<string, Node[]>();
for (const r of rows) {
  let data: ItemData;
  try { data = JSON.parse(r.data); } catch { console.warn(`skip unparseable item ${r.id}`); continue; }
  const node: Node = { id: r.id, created_at: r.created_at ?? 0, data, wasAfterId: "after_id" in data };
  if (!byList.has(r.list_id)) byList.set(r.list_id, []);
  byList.get(r.list_id)!.push(node);
}

const now = Date.now();
const update = db.prepare("UPDATE items SET data = ?, updated_at = ? WHERE id = ?");

let listsAffected = 0;
let itemsConverted = 0; // items that had after_id
let itemsRenumbered = 0; // total rows rewritten

const run = db.transaction(() => {
  for (const [listId, items] of byList) {
    if (!items.some((i) => i.wasAfterId)) continue; // list already all-position → skip
    listsAffected++;

    const ordered = buildOrder(items);
    console.log(`\nList "${listNames.get(listId) ?? "(missing)"}" [${listId}] — ${ordered.length} items:`);
    ordered.forEach((it, idx) => {
      const newPos = idx * POSITION_STEP;
      const src = it.wasAfterId ? "after_id" : "position";
      console.log(`  ${String(newPos).padStart(5)}  (${src})  ${it.data.title ?? ""}`);

      it.data.position = newPos;
      delete it.data.after_id;
      it.data.updated_at = now;
      if (it.wasAfterId) itemsConverted++;
      itemsRenumbered++;
      if (apply) update.run(JSON.stringify(it.data), now, it.id);
    });
  }
});

run();

console.log(`\n${apply ? "Applied" : "Would apply"}: ${listsAffected} list(s), ${itemsRenumbered} item(s) rewritten, ${itemsConverted} converted from after_id → position.`);

// Verify no after_id remains (post-apply sanity check).
if (apply) {
  const left = db
    .prepare("SELECT COUNT(*) AS n FROM items WHERE json_type(data,'$.after_id') IS NOT NULL")
    .get() as { n: number };
  console.log(`Remaining items with after_id: ${left.n}`);
}

db.close();
