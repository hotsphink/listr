// Shared CLI preamble for the one-off maintenance scripts in this directory.
//
// Convention (identical across scripts): dry-run by default — pass --apply to
// write. The DB path comes from --db= (default ~/.local/share/listr/listr.db).
// Before any writes a timestamped backup copy is made. Run with the sync server
// STOPPED (SQLite is single-writer; the prod DB is otherwise read-only).

import { homedir } from "node:os";
import { join } from "node:path";
import { copyFileSync, existsSync } from "node:fs";

export function parseScriptArgs(label: string): { dbPath: string; apply: boolean } {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dbArg = args.find((a) => a.startsWith("--db="))?.slice("--db=".length);
  const dbPath = (dbArg ?? join(homedir(), ".local/share/listr/listr.db")).replace(/^~(?=$|\/)/, homedir());

  if (!existsSync(dbPath)) {
    console.error(`[${label}] DB not found: ${dbPath}`);
    process.exit(1);
  }

  console.log(`[${label}] DB:   ${dbPath}`);
  console.log(`[${label}] MODE: ${apply ? "APPLY (writing changes)" : "dry-run (no writes — pass --apply to write)"}`);
  if (apply) {
    const bak = `${dbPath}.bak-${Date.now()}`;
    copyFileSync(dbPath, bak);
    console.log(`[${label}] Backup: ${bak}`);
  }
  return { dbPath, apply };
}
