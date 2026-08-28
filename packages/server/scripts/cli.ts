// Shared CLI preamble for the one-off maintenance scripts in this directory.
//
// Convention (identical across scripts): dry-run by default — pass --apply to
// write. The DB path comes from --db= (default ~/.local/share/listr/listr.db).
// Before any writes a timestamped backup copy is made. Run with the sync server
// STOPPED (SQLite is single-writer; the prod DB is otherwise read-only).

import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { LATEST_SCHEMA_VERSION, peekSchemaVersion } from "../src/db.js";

/**
 * When to spend a full-file copy of the database.
 *
 * - `"always"`: correct for the one-off scripts here that rewrite every row.
 *   You run them once and want a rollback.
 * - `"schema-change"`: copy only when this run will migrate the schema. Right
 *   for a *routine* tool like auth-cli, where issuing a grant is a single
 *   INSERT and copying a multi-megabyte database for it is pure cost. Note
 *   this can trigger without `--apply`, because `openDb` migrates even for
 *   read-only commands, and the schema mutation is the risky part rather than
 *   the writes.
 * - `"never"`: for genuinely read-only work.
 */
export type BackupPolicy = "always" | "schema-change" | "never";

/** Keep the most recent few and delete the rest; nothing else ever pruned these. */
const KEEP_BACKUPS = 5;

function pruneBackups(dbPath: string, label: string): void {
  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}.bak-`;
  const backups = readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const stale of backups.slice(KEEP_BACKUPS)) {
    try {
      unlinkSync(stale);
    } catch {
      /* best effort; a backup we cannot delete is not worth failing the command over */
    }
  }
  if (backups.length > KEEP_BACKUPS) {
    console.log(`[${label}] Pruned ${backups.length - KEEP_BACKUPS} old backup(s), keeping ${KEEP_BACKUPS}`);
  }
}

export function parseScriptArgs(
  label: string,
  opts: { backup?: BackupPolicy } = {},
): { dbPath: string; apply: boolean } {
  const policy = opts.backup ?? "always";
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dbArg = args.find((a) => a.startsWith("--db="))?.slice("--db=".length);
  const dbPath = (dbArg ?? join(homedir(), ".local/share/listr/listr.db")).replace(/^~(?=$|\/)/, homedir());

  if (!existsSync(dbPath)) {
    console.error(`[${label}] DB not found: ${dbPath}`);
    process.exit(1);
  }

  console.log(`[${label}] DB:   ${dbPath}`);
  console.log(`[${label}] MODE: ${apply ? "APPLY (writing changes)" : "dry-run (no writes; pass --apply to write)"}`);

  const migrationPending = policy === "schema-change" && peekSchemaVersion(dbPath) < LATEST_SCHEMA_VERSION;
  const wantBackup = policy === "always" ? apply : migrationPending;

  if (wantBackup) {
    const bak = `${dbPath}.bak-${Date.now()}`;
    copyFileSync(dbPath, bak);
    console.log(
      `[${label}] Backup: ${bak}` +
        (migrationPending ? ` (schema v${peekSchemaVersion(dbPath)} -> v${LATEST_SCHEMA_VERSION} pending)` : ""),
    );
    pruneBackups(dbPath, label);
  }

  return { dbPath, apply };
}
