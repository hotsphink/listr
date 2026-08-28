import { db } from "./database.js";

/**
 * Remove all local boards/lists/items under syncKey, plus its shared_keys/
 * board_groups bookkeeping. Local-only, with no tombstones and no server push.
 *
 * Separate from operations.ts so SyncClient.ts can reuse it when the server
 * tells a sibling connection that a key was removed from the user, without
 * importing operations.ts, which imports SyncClient.ts and would close a
 * cycle.
 */
export async function removeKeyLocal(syncKey: string): Promise<void> {
  const boards = await db.boards.filter((b) => b.sync_key === syncKey).toArray();

  await db.transaction("rw", [db.boards, db.lists, db.items], async () => {
    for (const board of boards) {
      const lists = await db.lists.where("board_id").equals(board.id).toArray();
      for (const list of lists) {
        await db.items.where("list_id").equals(list.id).delete();
      }
      await db.lists.where("board_id").equals(board.id).delete();
      await db.boards.delete(board.id);
    }
  });

  await db.shared_keys.delete(syncKey);
  await db.board_groups.delete(syncKey);
  await db.board_server_binding.bulkDelete(boards.map((b) => b.id));
}
