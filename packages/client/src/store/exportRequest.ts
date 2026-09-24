import { createSignal } from "solid-js";
import { db } from "../db/database.js";
import { exportAllData, exportBoard, exportList, DEFAULT_EXPORT_OPTIONS, type ExportOptions } from "../db/exportImport.js";
import { triggerDownload } from "../utils/download.js";

export type ExportScope =
  | { type: "all" }
  | { type: "board"; boardId: string; name: string }
  | { type: "list"; listId: string; boardId: string; name: string };

// The export waiting on the user's choices in ExportModal, if any.
const [pendingExport, setPendingExport] = createSignal<ExportScope | null>(null);
export { pendingExport, setPendingExport };

/** Whether any board the export covers has integrations, so there is something to choose. */
async function scopeHasIntegrations(scope: ExportScope): Promise<boolean> {
  const boards = scope.type === "all" ? await db.boards.toArray() : [await db.boards.get(scope.boardId)];
  return boards.some((b) => (b?.integrations ?? []).length > 0);
}

/** Download the export with these options. */
export async function runExport(scope: ExportScope, options: ExportOptions): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  if (scope.type === "all") triggerDownload(await exportAllData(options), `listr-${date}.json`);
  else if (scope.type === "board") triggerDownload(await exportBoard(scope.boardId, options), `listr-board-${scope.name}-${date}.json`);
  else triggerDownload(await exportList(scope.listId, options), `listr-list-${scope.name}-${date}.json`);
}

/** Export right away when there is nothing to choose, else ask first. */
export async function requestExport(scope: ExportScope): Promise<void> {
  if (await scopeHasIntegrations(scope)) setPendingExport(scope);
  else await runExport(scope, DEFAULT_EXPORT_OPTIONS);
}
