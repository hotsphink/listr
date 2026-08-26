import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { isCurrentSchemaVersion } from "@listr/shared";
import type { IntegrationResult } from "@listr/shared";
import { config } from "./config.js";

export type EntityType = "board" | "list" | "item" | "asset";

// ── Identity & authorization (auth-design.md §3, §5, §6, §12.1) ─────────────
// Phase 1, job 1 of 3: schema + pure db.ts logic + CLI only. No wire-protocol
// or WebSocket-handler changes here — those are jobs 2 (handshake) and 3 (UI).
export type UserState = "active" | "suspended" | "revoked";
export type Cap = "sync" | "invite" | "moderate" | "admin";
// `triage` was in the original sketch and is deliberately NOT here — it was
// never an authority bit, only a routing preference, and was killed once
// request-access (its only consumer) was cut (§5.2, §16.2.9).
export const ALL_CAPS: readonly Cap[] = ["sync", "invite", "moderate", "admin"];
export type GrantKind = "invite" | "device" | "share" | "guest";
export type AccessLevel = "rw" | "ro";

export interface UserRow {
  user_id: string;
  display_name: string | null;
  authorized_by: string | null;
  note: string | null;
  caps: Cap[];
  state: UserState;
  home_key: string;
  provisional: boolean;
  created_at: number;
}

export interface ClientRow {
  client_id: string;
  user_id: string;
  pubkey_jwk: string;
  label: string | null;
  created_at: number;
  last_seen: number | null;
}

export interface GrantRow {
  id: string;
  kind: GrantKind;
  issuer_user_id: string;
  caps: Cap[] | null;
  payload: string | null;
  greeting: string | null;
  expires_at: number;
  uses_remaining: number;
  attempts: number;
  created_at: number;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS server_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    sync_key TEXT NOT NULL,
    created_at INTEGER,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    sync_key TEXT NOT NULL,
    board_id TEXT,
    created_at INTEGER,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    sync_key TEXT NOT NULL,
    list_id TEXT,
    created_at INTEGER,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    created_at INTEGER,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tombstones (
    id TEXT PRIMARY KEY,
    sync_key TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    deleted_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS integration_results (
    id TEXT PRIMARY KEY,
    sync_key TEXT NOT NULL,
    item_id TEXT NOT NULL,
    integration_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attribute_values TEXT,
    integration_data TEXT,
    error TEXT,
    created_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  -- Keyed by \`user_id\`, not \`home_key\` (migration 5 — rekeyed from the
  -- home-key-keyed shape migration 3 produced). A home key is an ordinary,
  -- mutable attribute of a user record (§3.1), not a stable identifier: it has
  -- no FK to \`users\`, so a tombstoned user (§9.5 keeps user_id but deletes
  -- other identifying info) would leave orphaned rows nothing could find, and
  -- a future key rotation would silently orphan every association. Keying by
  -- user_id also matches job 2's identity shape (client_id -> user_id), rather
  -- than re-conflating the two things §3.1 exists to separate.
  -- \`access\` is added by migration 4 (§7.5): 'rw'|'ro', defaulting to 'rw'.
  -- Nothing sets 'ro' yet — read-only enforcement is Phase 3 — but the column
  -- ships now because retrofitting an access level onto an established
  -- user_keys table later is a protocol change, and an unused column today is
  -- free.
  CREATE TABLE IF NOT EXISTS user_keys (
    user_id  TEXT NOT NULL REFERENCES users(user_id),
    key      TEXT NOT NULL,
    name     TEXT,
    access   TEXT NOT NULL DEFAULT 'rw',
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  -- ── Identity tables (§12.1) ────────────────────────────────────────────────
  -- users.user_id is an opaque random id (randomUUID — 122 bits of randomness,
  -- comfortably close enough to the doc's "128-bit" figure). authorized_by is
  -- the one edge that makes this a forest: every user but the root has exactly
  -- one, and the root's is NULL. Cycles are impossible by construction because
  -- a grant's issuer must already exist when the grant is created, but the
  -- effective-state walk below still depth-caps defensively.
  --
  -- caps is a JSON array snapshotted at grant time and deliberately NEVER
  -- recomputed from the tree (§5.3) — state cascades down the tree, caps do
  -- not. state is the user's own EXPLICIT state; see getEffectiveState for the
  -- worst-state-on-the-path computation that makes cascade suspend/restore a
  -- single-row UPDATE.
  CREATE TABLE IF NOT EXISTS users (
    user_id       TEXT PRIMARY KEY,
    display_name  TEXT,
    authorized_by TEXT REFERENCES users(user_id),
    note          TEXT,
    caps          TEXT NOT NULL,
    state         TEXT NOT NULL DEFAULT 'active',
    home_key      TEXT NOT NULL,
    provisional   INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  -- clients.client_id is the RFC 7638 JWK thumbprint (computed client-side by
  -- job 2); this job only stores and looks it up, never computes it.
  CREATE TABLE IF NOT EXISTS clients (
    client_id  TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(user_id),
    pubkey_jwk TEXT NOT NULL,
    label      TEXT,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER
  );
  -- One table backs all four grant kinds (invite/device/share/guest, §6) —
  -- the field that varies is which of caps/payload is populated. The server
  -- stores only secret_hash (sha256 of a 96-bit random secret); no KDF, because
  -- the secret is high-entropy random rather than a password, and every check
  -- against it is online-only (§6.4/§6.6). No \`mailboxes\` table — spoken
  -- codes were cut (§6.5).
  CREATE TABLE IF NOT EXISTS grants (
    id             TEXT PRIMARY KEY,
    kind           TEXT NOT NULL,
    issuer_user_id TEXT NOT NULL REFERENCES users(user_id),
    secret_hash    TEXT NOT NULL,
    caps           TEXT,
    payload        TEXT,
    greeting       TEXT,
    expires_at     INTEGER NOT NULL,
    uses_remaining INTEGER NOT NULL,
    attempts       INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
  );
  -- Append-only audit trail of grant issuance/redemption and state changes
  -- (§12.1). No foreign keys onto users beyond the loose actor/subject ids,
  -- since a tombstoned user (§9.5) may still be a subject of old events.
  CREATE TABLE IF NOT EXISTS auth_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    at              INTEGER NOT NULL,
    kind            TEXT NOT NULL,
    actor_user_id   TEXT,
    subject_user_id TEXT,
    detail          TEXT
  );
  -- Many-to-many: the same content-addressed asset (Asset.id is a content
  -- hash) can legitimately be pushed into more than one namespace — e.g. the
  -- same image used on two unrelated boards. A single sync_key column on
  -- \`assets\` would be first-writer-wins and silently break the other
  -- namespace, so association lives in this join table instead. See
  -- migration 2.
  CREATE TABLE IF NOT EXISTS asset_keys (
    asset_id TEXT NOT NULL,
    sync_key TEXT NOT NULL,
    PRIMARY KEY (asset_id, sync_key)
  );
  CREATE INDEX IF NOT EXISTS idx_boards ON boards(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_lists ON lists(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_items ON items(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_assets ON assets(updated_at);
  CREATE INDEX IF NOT EXISTS idx_tombstones ON tombstones(sync_key, deleted_at);
  CREATE INDEX IF NOT EXISTS idx_integration_results ON integration_results(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_integration_results_item ON integration_results(item_id);
  CREATE INDEX IF NOT EXISTS idx_integration_results_refresh ON integration_results(integration_id, status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_asset_keys_key ON asset_keys(sync_key);
  CREATE INDEX IF NOT EXISTS idx_users_authorized_by ON users(authorized_by);
  CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id);
  CREATE INDEX IF NOT EXISTS idx_grants_issuer ON grants(issuer_user_id);
  CREATE INDEX IF NOT EXISTS idx_auth_events_at ON auth_events(at);
`;
// idx_user_keys is NOT created above, deliberately — unlike the other new
// indexes, user_keys' shape is migration-dependent: a pre-existing database
// may still have the pre-migration-5 `home_key` column at the moment
// SCHEMA_SQL runs (CREATE TABLE IF NOT EXISTS leaves an existing table's
// columns untouched), so an unconditional `CREATE INDEX ... (user_id)` here
// would throw "no such column" on exactly the databases migration 5 exists to
// upgrade. Instead migration 5 (below) creates it unconditionally at the end
// of its own run — reached on every open, whether or not that particular run
// needed to do any rekeying — which is late enough that the column always
// exists by then.

// ── Schema versioning (§12.1) ────────────────────────────────────────────────
// A `schema_version` row in `server_config`, plus an ordered migration list
// that `applyMigrations` walks. Every migration body is written to be a no-op
// when its target shape already exists (same `hasColumn`-style guards the old
// ad-hoc code used), so a brand-new database — where SCHEMA_SQL above already
// creates the latest shape — and a pre-existing database that predates
// schema_version entirely (no row at all, treated as version 0) take the
// exact same path: baselining and upgrading are the same code.

function readSchemaVersion(sql: Database.Database): number {
  const row = sql.prepare(`SELECT value FROM server_config WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

function setSchemaVersion(sql: Database.Database, version: number): void {
  sql
    .prepare(
      `INSERT INTO server_config (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(String(version));
}

function hasColumn(sql: Database.Database, table: string, col: string): boolean {
  const cols = sql.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

// Migration 1: the columns that used to be added ad hoc via PRAGMA table_info
// inspection on every server start. Folded into the migration list unchanged
// (same idempotent hasColumn guards) so it becomes one versioned step instead
// of code that ran unconditionally on every boot.
function migrateV1LegacyColumnBaseline(sql: Database.Database): void {
  if (!hasColumn(sql, "boards", "created_at")) {
    sql.exec(`ALTER TABLE boards ADD COLUMN created_at INTEGER`);
    sql.exec(`UPDATE boards SET created_at = json_extract(data, '$.created_at')`);
  }

  if (!hasColumn(sql, "lists", "board_id")) {
    sql.exec(`ALTER TABLE lists ADD COLUMN board_id TEXT`);
    sql.exec(`UPDATE lists SET board_id = json_extract(data, '$.board_id')`);
    sql.exec(`DELETE FROM lists WHERE board_id IS NULL`);
  }
  if (!hasColumn(sql, "lists", "created_at")) {
    sql.exec(`ALTER TABLE lists ADD COLUMN created_at INTEGER`);
    sql.exec(`UPDATE lists SET created_at = json_extract(data, '$.created_at')`);
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_lists_board ON lists(board_id)`);

  if (!hasColumn(sql, "items", "list_id")) {
    sql.exec(`ALTER TABLE items ADD COLUMN list_id TEXT`);
    sql.exec(`UPDATE items SET list_id = json_extract(data, '$.list_id')`);
  }
  if (!hasColumn(sql, "items", "created_at")) {
    sql.exec(`ALTER TABLE items ADD COLUMN created_at INTEGER`);
    sql.exec(`UPDATE items SET created_at = json_extract(data, '$.created_at')`);
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id)`);

  if (!hasColumn(sql, "assets", "created_at")) {
    sql.exec(`ALTER TABLE assets ADD COLUMN created_at INTEGER`);
    sql.exec(`UPDATE assets SET created_at = json_extract(data, '$.created_at')`);
  }
  if (hasColumn(sql, "assets", "sync_key")) {
    sql.exec(`CREATE TABLE assets_new (id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER NOT NULL, data TEXT NOT NULL)`);
    sql.exec(`INSERT INTO assets_new SELECT id, created_at, updated_at, data FROM assets`);
    sql.exec(`DROP TABLE assets`);
    sql.exec(`ALTER TABLE assets_new RENAME TO assets`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_assets ON assets(updated_at)`);
  }
}

// Migration 2: the asset_keys join table that closes the global asset leak
// (§2.1 defect 2) plus a one-time backfill for assets that predate it.
// Existing assets have no recorded association; leaving them unassociated
// would make them vanish for everyone, breaking images already in use.
// Backfill by substring-matching each asset id against every board/list/item's
// stored data — ids are 20 hex chars, so collisions aren't a practical
// concern, and these databases are small enough that an O(assets × entities)
// scan is fine. Assets matching nothing are genuinely orphaned; they're left
// unassociated and counted in the log line below.
// Assets are referenced from entity content as `hash://<20 hex>.<ext>` — the
// same form the client scans for in extractReferencedAssetIds (exportImport.ts).
// Pulling ids out of the JSON is O(references); matching against the whole
// assets table would be O(assets) on every single push.
const ASSET_HASH_RE = /hash:\/\/([0-9a-f]{20})\.[a-z0-9]+/gi;

function extractAssetIds(json: string): Set<string> {
  const ids = new Set<string>();
  if (!json.includes("hash://")) return ids;
  for (const m of json.matchAll(ASSET_HASH_RE)) ids.add(m[1].toLowerCase());
  return ids;
}

function migrateV2AssetKeys(sql: Database.Database): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS asset_keys (asset_id TEXT NOT NULL, sync_key TEXT NOT NULL, PRIMARY KEY (asset_id, sync_key))`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_asset_keys_key ON asset_keys(sync_key)`);

  const known = new Set(
    (sql.prepare(`SELECT id FROM assets`).all() as { id: string }[]).map((r) => r.id),
  );
  if (known.size === 0) return;

  // One pass over each entity table, extracting references as we go. The
  // previous shape ran a non-indexable `data LIKE '%id%'` scan per asset per
  // table, which is O(assets x rows) at startup.
  const insert = sql.prepare(`INSERT OR IGNORE INTO asset_keys (asset_id, sync_key) VALUES (?, ?)`);
  const associated = new Set<string>();
  for (const table of ["boards", "lists", "items"] as const) {
    const rows = sql.prepare(`SELECT sync_key, data FROM ${table}`).all() as { sync_key: string; data: string }[];
    for (const row of rows) {
      if (!row.sync_key) continue;
      for (const id of extractAssetIds(row.data)) {
        // Backfill only associates assets that actually exist; unlike the live
        // push path there is no later arrival to wait for.
        if (!known.has(id)) continue;
        insert.run(id, row.sync_key);
        associated.add(id);
      }
    }
  }
  console.log(`[migrate] asset_keys backfill: associated ${associated.size}/${known.size} asset(s), ${known.size - associated.size} left orphaned (no referencing entity found)`);
}

// Migration 3: user_keys.user_key -> home_key (§12.1 — internal rename only) —
// the home key is now server-assigned and arrives in `ok.home_key`. Superseded
// by migration 5, which rekeys user_keys again, this time to user_id — so on a
// brand-new database (SCHEMA_SQL already creates user_keys in the user_id shape
// directly) neither the rename nor the home_key index below has anything to do;
// both are guarded so this is a true no-op there.
function migrateV3RenameHomeKey(sql: Database.Database): void {
  if (hasColumn(sql, "user_keys", "user_key")) {
    sql.exec(`ALTER TABLE user_keys RENAME COLUMN user_key TO home_key`);
  }
  if (hasColumn(sql, "user_keys", "home_key")) {
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_keys ON user_keys(home_key)`);
  }
}

// Migration 4 (§12.1): the identity tables — users, clients, grants,
// auth_events — plus user_keys.access (§7.5). Same CREATE TABLE IF NOT EXISTS
// bodies as SCHEMA_SQL, so a brand-new database (which already gets them from
// SCHEMA_SQL) and a pre-v5 database (which does not) converge on the same
// shape, per the module-level convention above.
function migrateV4Identity(sql: Database.Database): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id       TEXT PRIMARY KEY,
      display_name  TEXT,
      authorized_by TEXT REFERENCES users(user_id),
      note          TEXT,
      caps          TEXT NOT NULL,
      state         TEXT NOT NULL DEFAULT 'active',
      home_key      TEXT NOT NULL,
      provisional   INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clients (
      client_id  TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(user_id),
      pubkey_jwk TEXT NOT NULL,
      label      TEXT,
      created_at INTEGER NOT NULL,
      last_seen  INTEGER
    );
    CREATE TABLE IF NOT EXISTS grants (
      id             TEXT PRIMARY KEY,
      kind           TEXT NOT NULL,
      issuer_user_id TEXT NOT NULL REFERENCES users(user_id),
      secret_hash    TEXT NOT NULL,
      caps           TEXT,
      payload        TEXT,
      greeting       TEXT,
      expires_at     INTEGER NOT NULL,
      uses_remaining INTEGER NOT NULL,
      attempts       INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      at              INTEGER NOT NULL,
      kind            TEXT NOT NULL,
      actor_user_id   TEXT,
      subject_user_id TEXT,
      detail          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_authorized_by ON users(authorized_by);
    CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id);
    CREATE INDEX IF NOT EXISTS idx_grants_issuer ON grants(issuer_user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_events_at ON auth_events(at);
  `);
  if (!hasColumn(sql, "user_keys", "access")) {
    // NOT NULL ADD COLUMN requires a default in SQLite; matches the
    // 'rw' default new rows get from SCHEMA_SQL.
    sql.exec(`ALTER TABLE user_keys ADD COLUMN access TEXT NOT NULL DEFAULT 'rw'`);
  }
}

// Migration 5: rekey user_keys from home_key to user_id. Reconsidered after
// job 1 shipped keyed by home_key — a home key has no FK to `users` (a
// tombstoned user, §9.5, would leave orphaned rows nothing could find), it's
// an ordinary mutable attribute rather than a stable identifier (§3.1 — a
// future rotation would silently orphan every association), and job 2 makes
// identity client_id -> user_id, so keying associations by home_key would
// re-conflate the two things §3.1 exists to keep separate.
//
// The hard part: a pre-v5 database's user_keys rows may reference home keys
// with NO corresponding `users` row at all (the users table didn't exist
// before migration 4). Per §13's migration procedure — "for each existing
// distinct home key, mint a user and carry that key over as their home_key,
// preserving their user_keys rows" — minting happens HERE rather than being
// left to a forgotten CLI step, so no association can be silently dropped by
// an upgrade that skips a manual command.
//
// Minted users are unparented (authorized_by=NULL). A forest with several
// unparented users is structurally fine (§5.1) — getEffectiveState terminates
// at each one regardless — but it does mean "unparented" can no longer be
// used as a proxy for "the designated root" (see findRootUser/bootstrapRootUser
// below, which were changed in this same pass to stop assuming that). The
// operator re-parents minted users with `auth-cli.ts set-parent`. They are
// deliberately NOT marked `provisional` — that flag means guest-link users
// specifically (§7.4), and these are pre-existing account holders, not
// guests picked up off a shared link.
function migrateV5RekeyUserKeysToUserId(sql: Database.Database): void {
  // Only the pre-migration-5 shape (home_key column present) needs the
  // mint-and-rebuild below. A fresh database's user_keys is already in the
  // user_id shape via SCHEMA_SQL and skips straight to the unconditional
  // index creation at the end of this function — which is precisely why that
  // index can't live in SCHEMA_SQL's unconditional block (see the comment
  // there): it has to run AFTER this rebuild for upgrading databases, so it
  // has to live here.
  if (hasColumn(sql, "user_keys", "home_key")) {
    const homeKeys = sql.prepare(`SELECT DISTINCT home_key FROM user_keys`).all() as { home_key: string }[];
    const userIdForHomeKey = new Map<string, string>();

    const findUserByHomeKey = sql.prepare(`SELECT user_id FROM users WHERE home_key = ? LIMIT 1`);
    const earliestAddedAt = sql.prepare(`SELECT MIN(added_at) AS min_added FROM user_keys WHERE home_key = ?`);
    const insertMintedUser = sql.prepare(`
      INSERT INTO users (user_id, display_name, authorized_by, note, caps, state, home_key, provisional, created_at)
      VALUES (?, NULL, NULL, NULL, ?, 'active', ?, 0, ?)
    `);

    let minted = 0;
    for (const { home_key } of homeKeys) {
      const existing = findUserByHomeKey.get(home_key) as { user_id: string } | undefined;
      if (existing) {
        userIdForHomeKey.set(home_key, existing.user_id);
        continue;
      }
      const userId = randomUUID();
      // Approximate created_at from the earliest association we have for
      // this home key, rather than "now" — a cosmetic nicety (there's no
      // better signal available), not load-bearing anywhere.
      const createdAt = (earliestAddedAt.get(home_key) as { min_added: number | null }).min_added ?? Date.now();
      insertMintedUser.run(userId, JSON.stringify(["sync"]), home_key, createdAt);
      userIdForHomeKey.set(home_key, userId);
      minted++;
    }

    sql.exec(`
      CREATE TABLE user_keys_new (
        user_id  TEXT NOT NULL REFERENCES users(user_id),
        key      TEXT NOT NULL,
        name     TEXT,
        access   TEXT NOT NULL DEFAULT 'rw',
        added_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );
    `);
    const oldRows = sql.prepare(`SELECT home_key, key, name, access, added_at FROM user_keys`).all() as
      { home_key: string; key: string; name: string | null; access: string; added_at: number }[];
    const insertNew = sql.prepare(
      `INSERT OR IGNORE INTO user_keys_new (user_id, key, name, access, added_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const row of oldRows) {
      insertNew.run(userIdForHomeKey.get(row.home_key)!, row.key, row.name, row.access, row.added_at);
    }
    // DROP TABLE takes user_keys' indexes with it (including the home_key one
    // migration 3 created), so the index created below can reuse the name
    // without conflict.
    sql.exec(`DROP TABLE user_keys`);
    sql.exec(`ALTER TABLE user_keys_new RENAME TO user_keys`);

    console.log(`[migrate] user_keys rekey: minted ${minted} user(s) for pre-existing home key(s), preserved ${oldRows.length} association(s)`);
  }

  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_keys ON user_keys(user_id)`);
}

const MIGRATIONS: { version: number; run: (sql: Database.Database) => void }[] = [
  { version: 1, run: migrateV1LegacyColumnBaseline },
  { version: 2, run: migrateV2AssetKeys },
  { version: 3, run: migrateV3RenameHomeKey },
  { version: 4, run: migrateV4Identity },
  { version: 5, run: migrateV5RekeyUserKeysToUserId },
];

function applyMigrations(sql: Database.Database): void {
  const current = readSchemaVersion(sql);
  for (const { version, run } of MIGRATIONS) {
    if (version > current) {
      run(sql);
      setSchemaVersion(sql, version);
    }
  }
}

// ── Clock-skew clamp (§11.2.2) ──────────────────────────────────────────────
// A bad or malicious client clock can otherwise write updated_at/deleted_at
// far in the future; LWW then treats that version as permanently unbeatable —
// every honest later edit loses forever, on every device. Clamp (don't
// reject) to server time plus a small allowance, so an honestly-skewed clock
// still gets its write accepted.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function clampToServerTime(ts: number): number {
  const cap = Date.now() + MAX_CLOCK_SKEW_MS;
  return ts > cap ? cap : ts;
}

// ── Auth constants ───────────────────────────────────────────────────────────
// The tree is a forest by construction (a grant's issuer must already exist),
// so no cycle should ever occur — but getEffectiveState walks it with a depth
// cap anyway, defensively, rather than trusting that invariant to hold forever.
const MAX_TREE_DEPTH = 200;

// §7.3b: guest TTL is 24h, not the original 30 minutes — single-use redemption
// does the security work, and a short TTL only strands the recipient. The doc
// only pins guest's default explicitly; the other three kinds get the same
// default here for lack of a stated reason to differ (a caller may always
// pass an explicit expiresAt).
const DEFAULT_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

// §6.6 / §6/6.1: every grant secret is checked online-only, so the attempt
// counter — not the secret's entropy — is the real defense. 10 wrong guesses
// then burn (uses_remaining forced to 0); the doc specifies "an attempt
// limit" without pinning the number, so this is a judgment call, not a
// transcription of the design doc.
const MAX_GRANT_ATTEMPTS = 10;

function tableFor(type: EntityType): string {
  if (type === "board") return "boards";
  if (type === "list") return "lists";
  if (type === "asset") return "assets";
  return "items";
}

export function createDbApi(sql: Database.Database) {
  function getServerId(): string {
    const row = sql.prepare("SELECT value FROM server_config WHERE key = 'server_id'").get() as { value: string } | undefined;
    if (row) return row.value;
    const id = randomUUID();
    sql.prepare("INSERT INTO server_config (key, value) VALUES ('server_id', ?)").run(id);
    return id;
  }

  // Any asset id (from the `assets` table) that appears as a substring of
  // `dataJson` gets linked to `syncKey`. Same technique as the migration-2
  // backfill above, run incrementally on every board/list/item push instead
  // of once. This matters going forward, not just for old data: a freshly
  // uploaded image is always pushed under the *uploader's* own key (the
  // client has no board context at asset-push time — see SyncClient
  // effectiveKeyForEntity), so without this, a new image added to a shared
  // board would sync down for its uploader only, not the people it was
  // shared with.
  function associateReferencedAssets(dataJson: string, syncKey: string): void {
    if (!syncKey) return;
    // Deliberately does NOT check that the asset already exists: doInitialSync
    // pushes boards/lists/items *before* assets, so on a first sync the asset
    // row lands after the entity that references it. Recording the association
    // up front makes this order-independent. asset_keys has no foreign key, and
    // getEntitiesSince joins through assets, so a row for an asset that never
    // arrives is inert.
    const insert = sql.prepare(`INSERT OR IGNORE INTO asset_keys (asset_id, sync_key) VALUES (?, ?)`);
    for (const id of extractAssetIds(dataJson)) insert.run(id, syncKey);
  }

  function upsertEntity(
    type: EntityType,
    data: Record<string, unknown>,
    syncKey: string,
  ): { accepted: boolean; previous: unknown | null } {
    // Format gate: refuse legacy/unversioned item blobs. The protocol version
    // gates the client BINARY, but a current client can still carry old-format
    // rows (the Dexie upgrade never touches sync-pulled data) and re-push them
    // in its initial sync. Keyed on schema_version alone — never field-sniffing.
    // Clients heal such rows to the current shape before their pushes are kept.
    if (type === "item" && !isCurrentSchemaVersion(data.schema_version)) {
      console.warn(`[sync] rejected legacy item ${data.id} (schema_version=${data.schema_version ?? "missing"})`);
      return { accepted: false, previous: null };
    }

    // Clamp before anything else touches it, so the stored column and the
    // embedded JSON (JSON.stringify(data) below) always agree.
    if (typeof data.updated_at === "number") {
      data.updated_at = clampToServerTime(data.updated_at);
    }

    const table = tableFor(type);
    const existingRow = sql
      .prepare(`SELECT updated_at, data FROM ${table} WHERE id = ?`)
      .get(data.id as string) as { updated_at: number; data: string } | undefined;
    if (existingRow && existingRow.updated_at >= (data.updated_at as number)) return { accepted: false, previous: null };
    // Reject if a newer tombstone already exists for this entity (tombstone wins on LWW).
    const tomb = sql
      .prepare(`SELECT deleted_at FROM tombstones WHERE entity_id = ? AND entity_type = ?`)
      .get(data.id as string, type) as { deleted_at: number } | undefined;
    if (tomb && tomb.deleted_at >= (data.updated_at as number)) return { accepted: false, previous: null };

    const previous = existingRow ? JSON.parse(existingRow.data) : null;
    const dataJson = JSON.stringify(data);

    if (type === "asset") {
      sql
        .prepare(`INSERT INTO assets (id, created_at, updated_at, data) VALUES (?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, updated_at=excluded.updated_at, data=excluded.data`)
        .run(data.id, data.created_at ?? null, data.updated_at, dataJson);
      // Global leak fix (§2.1 defect 2): record which namespace pushed this
      // asset instead of it being visible to every namespace on the server.
      if (syncKey) {
        sql.prepare(`INSERT OR IGNORE INTO asset_keys (asset_id, sync_key) VALUES (?, ?)`).run(data.id, syncKey);
      }
      return { accepted: true, previous };
    }

    const extraCols: string[] = ["created_at"];
    const extraVals: unknown[] = [data.created_at ?? null];
    if (type === "list") { extraCols.push("board_id"); extraVals.push(data.board_id ?? null); }
    if (type === "item") { extraCols.push("list_id"); extraVals.push(data.list_id ?? null); }

    const baseCols = ["id", "sync_key", "updated_at", "data"];
    const allCols = [...baseCols, ...extraCols];
    const placeholders = allCols.map(() => "?").join(", ");
    const onConflict = ["sync_key", "updated_at", "data", ...extraCols].map((c) => `${c}=excluded.${c}`).join(", ");

    sql
      .prepare(`INSERT INTO ${table} (${allCols.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${onConflict}`)
      .run(data.id, syncKey, data.updated_at, dataJson, ...extraVals);
    associateReferencedAssets(dataJson, syncKey);
    return { accepted: true, previous };
  }

  function getEntityById(type: EntityType, id: string): unknown | null {
    const table = tableFor(type);
    const row = sql.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  function upsertIntegrationResult(result: IntegrationResult): boolean {
    const existing = sql
      .prepare(`SELECT updated_at FROM integration_results WHERE id = ?`)
      .get(result.id) as { updated_at: number } | undefined;
    if (existing && existing.updated_at >= result.updated_at) return false;
    sql
      .prepare(`INSERT INTO integration_results
          (id, sync_key, item_id, integration_id, status, attribute_values, integration_data, error, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            sync_key=excluded.sync_key, status=excluded.status,
            attribute_values=excluded.attribute_values, integration_data=excluded.integration_data,
            error=excluded.error, updated_at=excluded.updated_at`)
      .run(
        result.id, result.sync_key, result.item_id, result.integration_id,
        result.status, JSON.stringify(result.attribute_values),
        JSON.stringify(result.integration_data), result.error ?? null,
        result.created_at, result.updated_at,
      );
    return true;
  }

  function getIntegrationResultsSince(syncKey: string, since: number): IntegrationResult[] {
    const rows = sql
      .prepare(`SELECT id, sync_key, item_id, integration_id, status, attribute_values, integration_data, error, created_at, updated_at
                FROM integration_results WHERE sync_key = ? AND updated_at > ?`)
      .all(syncKey, since) as any[];
    return rows.map(rowToIntegrationResult);
  }

  function getIntegrationResultsForRefresh(integrationId: string, olderThan: number): IntegrationResult[] {
    const rows = sql
      .prepare(`SELECT id, sync_key, item_id, integration_id, status, attribute_values, integration_data, error, created_at, updated_at
                FROM integration_results WHERE integration_id = ? AND status = 'complete' AND updated_at < ?`)
      .all(integrationId, olderThan) as any[];
    return rows.map(rowToIntegrationResult);
  }

  function rowToIntegrationResult(row: any): IntegrationResult {
    return {
      id: row.id,
      sync_key: row.sync_key,
      item_id: row.item_id,
      integration_id: row.integration_id,
      status: row.status,
      attribute_values: JSON.parse(row.attribute_values ?? "{}"),
      integration_data: JSON.parse(row.integration_data ?? "{}"),
      error: row.error ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function getEntitiesSince(type: EntityType, syncKey: string, since: number): unknown[] {
    const table = tableFor(type);
    if (type === "asset") {
      // Joined through asset_keys instead of a plain sync_key column — see
      // the asset_keys comment on SCHEMA_SQL above (§2.1 defect 2 fix).
      const rows = sql
        .prepare(`SELECT a.data FROM assets a JOIN asset_keys ak ON ak.asset_id = a.id WHERE ak.sync_key = ? AND a.updated_at > ?`)
        .all(syncKey, since) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data));
    }
    const rows = sql
      .prepare(`SELECT data FROM ${table} WHERE sync_key = ? AND updated_at > ?`)
      .all(syncKey, since) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  function applyTombstone(entityType: EntityType, entityId: string, deletedAt: number, syncKey: string): boolean {
    deletedAt = clampToServerTime(deletedAt);
    const existing = sql
      .prepare(`SELECT deleted_at FROM tombstones WHERE entity_id = ? AND entity_type = ?`)
      .get(entityId, entityType) as { deleted_at: number } | undefined;
    if (existing && existing.deleted_at >= deletedAt) return false;
    sql
      .prepare(
        `INSERT INTO tombstones (id, sync_key, entity_type, entity_id, deleted_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET deleted_at=excluded.deleted_at`,
      )
      .run(`${entityType}:${entityId}`, syncKey, entityType, entityId, deletedAt);
    // Only delete the entity if it hasn't been updated more recently than the tombstone.
    sql.prepare(`DELETE FROM ${tableFor(entityType)} WHERE id = ? AND updated_at <= ?`).run(entityId, deletedAt);
    return true;
  }

  function getTombstonesSince(
    syncKey: string,
    since: number,
  ): { entity_type: string; entity_id: string; deleted_at: number }[] {
    return sql
      .prepare(`SELECT entity_type, entity_id, deleted_at FROM tombstones WHERE sync_key = ? AND deleted_at > ?`)
      .all(syncKey, since) as { entity_type: string; entity_id: string; deleted_at: number }[];
  }

  // ── User/key associations ───────────────────────────────────────────────────
  // Keyed by `user_id` (migration 5) — a home key is an ordinary, mutable
  // attribute of a user record (§3.1), not a stable identifier, so it's the
  // wrong thing to key an association table on. See the migration-5 comment
  // above for the full reasoning. `key` here is never the user's own home key
  // itself — callers filter that out before calling.

  function associateUserKey(userId: string, key: string, name: string | null): void {
    sql
      .prepare(
        `INSERT INTO user_keys (user_id, key, name, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET name = COALESCE(excluded.name, user_keys.name)`,
      )
      .run(userId, key, name, Date.now());
  }

  function removeUserKey(userId: string, key: string): void {
    sql.prepare(`DELETE FROM user_keys WHERE user_id = ? AND key = ?`).run(userId, key);
  }

  function getUserKeys(userId: string): { key: string; name: string | null }[] {
    return sql
      .prepare(`SELECT key, name FROM user_keys WHERE user_id = ?`)
      .all(userId) as { key: string; name: string | null }[];
  }

  // Transitional bridge for the still-unauthenticated v4 wire protocol
  // (job 2 replaces this with real client registration + handshake). A v4
  // `hello` carries only a home key, no user_id — this resolves one from the
  // other, minting a user on first sight so v4 clients keep working
  // unchanged while the identity layer is introduced underneath them.
  // Unparented and caps=['sync'], same as migration 5's minted legacy users,
  // and for the same reason (these are ordinary pre-existing account holders,
  // not guests — provisional stays false).
  function getOrCreateUserByHomeKey(homeKey: string): UserRow {
    const existing = sql.prepare(`SELECT * FROM users WHERE home_key = ? LIMIT 1`).get(homeKey) as
      | Parameters<typeof rowToUser>[0]
      | undefined;
    if (existing) return rowToUser(existing);
    return createUser({ authorizedBy: null, caps: ["sync"], homeKey, provisional: false }, Date.now());
  }

  // ── Append-only audit trail (§12.1) ─────────────────────────────────────────

  function logAuthEvent(
    event: { kind: string; actorUserId: string | null; subjectUserId: string | null; detail?: string | null },
    now: number,
  ): void {
    sql
      .prepare(
        `INSERT INTO auth_events (at, kind, actor_user_id, subject_user_id, detail) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(now, event.kind, event.actorUserId, event.subjectUserId, event.detail ?? null);
  }

  interface AuthEventRow {
    id: number;
    at: number;
    kind: string;
    actor_user_id: string | null;
    subject_user_id: string | null;
    detail: string | null;
  }

  // Not wired into the CLI in this job (not in the explicit scope), but the
  // table is useless as an audit trail if nothing can ever read it back, so a
  // minimal accessor ships alongside the writer.
  function listAuthEvents(limit = 100): AuthEventRow[] {
    return sql.prepare(`SELECT * FROM auth_events ORDER BY id DESC LIMIT ?`).all(limit) as AuthEventRow[];
  }

  // ── Users (§3, §5, §9) ───────────────────────────────────────────────────────

  function rowToUser(row: {
    user_id: string; display_name: string | null; authorized_by: string | null; note: string | null;
    caps: string; state: string; home_key: string; provisional: number; created_at: number;
  }): UserRow {
    return {
      user_id: row.user_id,
      display_name: row.display_name,
      authorized_by: row.authorized_by,
      note: row.note,
      caps: JSON.parse(row.caps) as Cap[],
      state: row.state as UserState,
      home_key: row.home_key,
      provisional: !!row.provisional,
      created_at: row.created_at,
    };
  }

  function getUser(userId: string): UserRow | null {
    const row = sql.prepare(`SELECT * FROM users WHERE user_id = ?`).get(userId) as Parameters<typeof rowToUser>[0] | undefined;
    return row ? rowToUser(row) : null;
  }

  // The "designated root" is tracked explicitly in server_config, NOT inferred
  // from `authorized_by IS NULL`. It used to be inferred — that was correct
  // only as long as the root was the sole unparented user, which migration 5
  // broke: a pre-v5 database's home keys get minted as unparented users too
  // (§5.1 allows a forest of several), and until an operator re-parents them
  // with `set-parent`, "authorized_by IS NULL" matches all of them, not just
  // the one the CLI actually bootstrapped. An explicit marker is the only way
  // bootstrap-root stays idempotent (and doesn't mistake a migrated legacy
  // user for the root) once that forest can have more than one unparented tip.
  const ROOT_USER_CONFIG_KEY = "root_user_id";

  function findRootUser(): UserRow | null {
    const row = sql.prepare(`SELECT value FROM server_config WHERE key = ?`).get(ROOT_USER_CONFIG_KEY) as
      | { value: string }
      | undefined;
    return row ? getUser(row.value) : null;
  }

  function createUser(
    params: {
      userId?: string;
      displayName?: string | null;
      authorizedBy: string | null;
      caps: Cap[];
      homeKey?: string;
      provisional?: boolean;
      note?: string | null;
    },
    now: number,
  ): UserRow {
    // home_key is server-generated (§3.1) — the user never types or sees a
    // raw key at registration; it arrives later via ok.user_keys (job 2).
    const userId = params.userId ?? randomUUID();
    const homeKey = params.homeKey ?? randomUUID();
    sql
      .prepare(
        `INSERT INTO users (user_id, display_name, authorized_by, note, caps, state, home_key, provisional, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        userId,
        params.displayName ?? null,
        params.authorizedBy,
        params.note ?? null,
        JSON.stringify(params.caps),
        homeKey,
        params.provisional ? 1 : 0,
        now,
      );
    return getUser(userId)!;
  }

  function listChildren(userId: string): UserRow[] {
    return (sql.prepare(`SELECT * FROM users WHERE authorized_by = ?`).all(userId) as Parameters<typeof rowToUser>[0][]).map(
      rowToUser,
    );
  }

  function listAllUsers(): UserRow[] {
    return (sql.prepare(`SELECT * FROM users ORDER BY created_at`).all() as Parameters<typeof rowToUser>[0][]).map(rowToUser);
  }

  function setUserCaps(userId: string, caps: Cap[], now: number, actorUserId?: string | null): UserRow {
    const result = sql.prepare(`UPDATE users SET caps = ? WHERE user_id = ?`).run(JSON.stringify(caps), userId);
    if (result.changes === 0) throw new Error(`setUserCaps: no such user ${userId}`);
    logAuthEvent(
      { kind: "caps_set", actorUserId: actorUserId ?? null, subjectUserId: userId, detail: JSON.stringify({ caps }) },
      now,
    );
    return getUser(userId)!;
  }

  function setUserNote(userId: string, note: string | null): void {
    sql.prepare(`UPDATE users SET note = ? WHERE user_id = ?`).run(note, userId);
  }

  // Cascade suspend/revoke — and restore — are each exactly this one UPDATE on
  // this one row (§5.3). Descendants are never touched: their EXPLICIT state
  // is unchanged, and getEffectiveState recomputes the worst state on the
  // path fresh on every read, so restoring a parent makes children revert
  // automatically to whatever their own explicit state already was — there is
  // no "which children did I cascade to" bookkeeping to get wrong.
  function setUserState(userId: string, state: UserState, now: number, actorUserId?: string | null): UserRow {
    const result = sql.prepare(`UPDATE users SET state = ? WHERE user_id = ?`).run(state, userId);
    if (result.changes === 0) throw new Error(`setUserState: no such user ${userId}`);
    logAuthEvent({ kind: `state_set_${state}`, actorUserId: actorUserId ?? null, subjectUserId: userId, detail: null }, now);
    return getUser(userId)!;
  }

  // Effective state = the worst state on the path from root to `userId`,
  // computed with a WITH RECURSIVE CTE walking authorized_by upward (§5.3).
  // Depth-capped defensively even though the graph is a forest by
  // construction (a grant's issuer must already exist, so no cycle can form
  // through normal operation) — a corrupted or hand-edited DB should not be
  // able to turn this into an infinite walk.
  function getEffectiveState(userId: string): UserState | null {
    const row = sql
      .prepare(
        `WITH RECURSIVE chain(user_id, authorized_by, state, depth) AS (
           SELECT user_id, authorized_by, state, 0 FROM users WHERE user_id = ?
           UNION ALL
           SELECT u.user_id, u.authorized_by, u.state, chain.depth + 1
           FROM users u JOIN chain ON u.user_id = chain.authorized_by
           WHERE chain.depth < ?
         )
         SELECT state FROM chain
         ORDER BY CASE state WHEN 'revoked' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END
         LIMIT 1`,
      )
      .get(userId, MAX_TREE_DEPTH) as { state: UserState } | undefined;
    return row?.state ?? null;
  }

  // §7.4: "promote" clears provisional and (optionally) adds caps. Nothing is
  // re-created — the user keeps their user_id, home_key, and anything they
  // made as a guest, which is exactly what falls out of caps being
  // snapshotted rather than derived.
  function promoteProvisionalUser(userId: string, extraCaps: Cap[], now: number, actorUserId?: string | null): UserRow {
    const user = getUser(userId);
    if (!user) throw new Error(`promoteProvisionalUser: no such user ${userId}`);
    const caps = Array.from(new Set([...user.caps, ...extraCaps]));
    sql.prepare(`UPDATE users SET provisional = 0, caps = ? WHERE user_id = ?`).run(JSON.stringify(caps), userId);
    logAuthEvent(
      { kind: "user_promoted", actorUserId: actorUserId ?? null, subjectUserId: userId, detail: JSON.stringify({ caps }) },
      now,
    );
    return getUser(userId)!;
  }

  // §5.5: bootstrap is idempotent — calling it again after a root already
  // exists just returns that root rather than erroring, so the CLI command
  // is safe to re-run. Recorded in server_config (see ROOT_USER_CONFIG_KEY
  // above) rather than inferred from authorized_by, so it stays correct even
  // when migration 5 has minted other unparented users alongside it.
  function bootstrapRootUser(now: number): UserRow {
    const existing = findRootUser();
    if (existing) return existing;
    const root = createUser({ authorizedBy: null, caps: [...ALL_CAPS], provisional: false }, now);
    sql
      .prepare(
        `INSERT INTO server_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(ROOT_USER_CONFIG_KEY, root.user_id);
    return root;
  }

  // Cycle guard for setAuthorizedBy: does `candidateAncestorId` appear on the
  // walk up from `userId`'s current authorized_by chain? If so,
  // candidateAncestorId is (currently) a DESCENDANT of userId, and making it
  // userId's parent would close a loop. Depth-capped like getEffectiveState,
  // for the same defensive reason.
  function isAncestorOf(candidateAncestorId: string, userId: string): boolean {
    let current: string | null = userId;
    let depth = 0;
    while (current !== null && depth < MAX_TREE_DEPTH) {
      if (current === candidateAncestorId) return true;
      const row = sql.prepare(`SELECT authorized_by FROM users WHERE user_id = ?`).get(current) as
        | { authorized_by: string | null }
        | undefined;
      current = row?.authorized_by ?? null;
      depth++;
    }
    return false;
  }

  // Re-parent a user — the CLI's `set-parent`, needed precisely because
  // migration 5 can mint users with no authorized_by at all (§5.1's forest of
  // unparented tips) and the operator needs a way to graft them onto the real
  // tree afterward. `newParentId=null` explicitly detaches (a second forest
  // root), which is allowed but not the common case.
  function setAuthorizedBy(userId: string, newParentId: string | null, now: number, actorUserId?: string | null): UserRow {
    const user = getUser(userId);
    if (!user) throw new Error(`setAuthorizedBy: no such user ${userId}`);
    if (newParentId !== null) {
      if (newParentId === userId) throw new Error("setAuthorizedBy: a user cannot be their own parent");
      if (!getUser(newParentId)) throw new Error(`setAuthorizedBy: no such parent user ${newParentId}`);
      if (isAncestorOf(userId, newParentId)) {
        throw new Error("setAuthorizedBy: would create a cycle (the proposed parent is currently a descendant of this user)");
      }
    }
    sql.prepare(`UPDATE users SET authorized_by = ? WHERE user_id = ?`).run(newParentId, userId);
    logAuthEvent(
      { kind: "user_reparented", actorUserId: actorUserId ?? null, subjectUserId: userId, detail: JSON.stringify({ newParentId }) },
      now,
    );
    return getUser(userId)!;
  }

  // Break-glass admin grant (§5.5, §15) — CLI-only. Never reachable via the
  // grants table; assertCapsAttenuated below rejects 'admin' unconditionally.
  function grantAdminCap(userId: string, now: number, actorUserId?: string | null): UserRow {
    const user = getUser(userId);
    if (!user) throw new Error(`grantAdminCap: no such user ${userId}`);
    if (user.caps.includes("admin")) return user;
    return setUserCaps(userId, [...user.caps, "admin"], now, actorUserId ?? "cli-break-glass");
  }

  // ── Clients (§3, §12.1 scope D) ──────────────────────────────────────────────
  // client_id is the RFC 7638 JWK thumbprint, computed client-side (job 2).
  // This layer only stores and looks it up.

  function rowToClient(row: {
    client_id: string; user_id: string; pubkey_jwk: string; label: string | null; created_at: number; last_seen: number | null;
  }): ClientRow {
    return { ...row };
  }

  function getClientById(clientId: string): ClientRow | null {
    const row = sql.prepare(`SELECT * FROM clients WHERE client_id = ?`).get(clientId) as
      | Parameters<typeof rowToClient>[0]
      | undefined;
    return row ? rowToClient(row) : null;
  }

  function registerClient(
    params: { clientId: string; userId: string; pubkeyJwk: string; label?: string | null },
    now: number,
  ): ClientRow {
    // A conflicting client_id can only mean the same keypair redeeming again
    // (retry) or reconnecting — user_id and pubkey_jwk are keyed by the
    // thumbprint and cannot legitimately change, so only last_seen and label
    // move on conflict.
    sql
      .prepare(
        `INSERT INTO clients (client_id, user_id, pubkey_jwk, label, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET last_seen = excluded.last_seen, label = COALESCE(excluded.label, clients.label)`,
      )
      .run(params.clientId, params.userId, params.pubkeyJwk, params.label ?? null, now, now);
    return getClientById(params.clientId)!;
  }

  function touchClientLastSeen(clientId: string, now: number): void {
    sql.prepare(`UPDATE clients SET last_seen = ? WHERE client_id = ?`).run(now, clientId);
  }

  // The lookup job 2's handshake needs: client -> user -> effective state, in
  // one call, so the caller never has to remember to also check the tree.
  function getUserForClient(clientId: string): { client: ClientRow; user: UserRow; effectiveState: UserState } | null {
    const client = getClientById(clientId);
    if (!client) return null;
    const user = getUser(client.user_id);
    if (!user) return null;
    return { client, user, effectiveState: getEffectiveState(user.user_id) ?? user.state };
  }

  // ── Grants (§6) ──────────────────────────────────────────────────────────────

  function hashSecret(secret: string): string {
    return createHash("sha256").update(secret).digest("hex");
  }

  function generateGrantSecret(): string {
    // 96 bits (§7.3a-bis) — the secret is checkable only against this server
    // (no offline grind possible), and single-use redemption plus the attempt
    // limit below already does the real security work (§6.4/§6.6). 96 bits
    // is overkill on top of that; it costs nothing to keep.
    return randomBytes(12).toString("base64url");
  }

  // §5.2 attenuation rule: caps on a grant must be a subset of the issuer's
  // OWN caps (never recomputed from the tree — see the users table comment
  // above), and 'admin' is never grantable this way at all — only via config
  // or the CLI's break-glass command.
  function assertCapsAttenuated(issuerCaps: Cap[], requestedCaps: Cap[]): void {
    if (requestedCaps.includes("admin")) {
      throw new Error("admin cannot be granted via a grant; use the CLI break-glass path");
    }
    for (const cap of requestedCaps) {
      if (!issuerCaps.includes(cap)) {
        throw new Error(`cap '${cap}' exceeds issuer's own capabilities`);
      }
    }
  }

  function rowToGrant(row: {
    id: string; kind: string; issuer_user_id: string; caps: string | null; payload: string | null;
    greeting: string | null; expires_at: number; uses_remaining: number; attempts: number; created_at: number;
  }): GrantRow {
    return {
      id: row.id,
      kind: row.kind as GrantKind,
      issuer_user_id: row.issuer_user_id,
      caps: row.caps ? (JSON.parse(row.caps) as Cap[]) : null,
      payload: row.payload,
      greeting: row.greeting,
      expires_at: row.expires_at,
      uses_remaining: row.uses_remaining,
      attempts: row.attempts,
      created_at: row.created_at,
    };
  }

  function getGrant(grantId: string): GrantRow | null {
    const row = sql.prepare(`SELECT * FROM grants WHERE id = ?`).get(grantId) as Parameters<typeof rowToGrant>[0] | undefined;
    return row ? rowToGrant(row) : null;
  }

  function createGrant(
    params: {
      kind: GrantKind;
      issuerUserId: string;
      caps?: Cap[]; // invite only — guest's caps are fixed below, not caller-supplied
      payload?: string; // share/guest only: the sync_key being handed over
      greeting?: string | null;
      expiresAt?: number;
      usesRemaining?: number;
    },
    now: number,
  ): { grantId: string; secret: string } {
    const issuer = getUser(params.issuerUserId);
    if (!issuer) throw new Error(`createGrant: no such issuer ${params.issuerUserId}`);
    // Not spelled out verbatim in the doc, but a direct consequence of §5.3's
    // cascade intent: a suspended/revoked issuer's `invite` cap exists
    // precisely to admit new users, so honoring it for someone already cut
    // off would let the tree keep growing through grants issued after the
    // cutoff. Reject rather than silently allow.
    const effectiveState = getEffectiveState(issuer.user_id);
    if (effectiveState !== "active") {
      throw new Error(`createGrant: issuer is not active (effective state: ${effectiveState})`);
    }

    let caps: Cap[] | null = null;
    if (params.kind === "invite") {
      caps = params.caps ?? [];
      assertCapsAttenuated(issuer.caps, caps);
    } else if (params.kind === "guest") {
      // §7.4: caps=['sync'] always — a guest cannot invite anyone. Fixed
      // here rather than accepted from the caller, so there is no path that
      // could accidentally attenuate-check its way to a broader guest grant.
      caps = ["sync"];
    }
    // device/share: caps stays null — device attaches to the issuer's own
    // existing caps (nothing new to attenuate), and share never touches caps.

    const grantId = randomUUID();
    const secret = generateGrantSecret();
    sql
      .prepare(
        `INSERT INTO grants (id, kind, issuer_user_id, secret_hash, caps, payload, greeting, expires_at, uses_remaining, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        grantId,
        params.kind,
        params.issuerUserId,
        hashSecret(secret),
        caps ? JSON.stringify(caps) : null,
        params.payload ?? null,
        params.greeting ?? null,
        params.expiresAt ?? now + DEFAULT_GRANT_TTL_MS,
        params.usesRemaining ?? 1,
        now,
      );
    logAuthEvent(
      { kind: `grant_issued_${params.kind}`, actorUserId: params.issuerUserId, subjectUserId: null, detail: JSON.stringify({ grantId }) },
      now,
    );
    return { grantId, secret };
  }

  type RedeemFailureReason = "not_found" | "burned" | "bad_secret" | "expired" | "used";

  // The single-use guarantee (§6), verbatim: one atomic UPDATE, checked by
  // `changes === 1`. This is correct under concurrent attempts with no extra
  // locking — the WHERE clause's conditions are evaluated by SQLite as part
  // of the same statement that performs the write, never against a
  // previously-read snapshot, so two racing callers can never both see
  // changes===1 for the same grant.
  function attemptRedeemGrant(
    grantId: string,
    secret: string,
    now: number,
  ): { ok: true; grant: GrantRow } | { ok: false; reason: RedeemFailureReason } {
    const before = getGrant(grantId);
    if (!before) return { ok: false, reason: "not_found" };
    if (before.attempts >= MAX_GRANT_ATTEMPTS) return { ok: false, reason: "burned" };

    const secretHash = hashSecret(secret);
    const result = sql
      .prepare(
        `UPDATE grants SET uses_remaining = uses_remaining - 1
          WHERE id = ? AND secret_hash = ? AND uses_remaining > 0 AND expires_at > ?`,
      )
      .run(grantId, secretHash, now);

    if (result.changes === 1) {
      logAuthEvent(
        { kind: "grant_redeemed", actorUserId: null, subjectUserId: before.issuer_user_id, detail: JSON.stringify({ grantId, kind: before.kind }) },
        now,
      );
      return { ok: true, grant: before };
    }

    // Failed — either the secret was wrong, or the grant was already spent
    // or expired (in which case this isn't really a "guess" at all, but it's
    // harmless to count it). Attempt bookkeeping is deliberately NOT part of
    // the atomic statement above: that statement's only job is the single-use
    // guarantee, which it already provides unconditionally; this is a
    // separate, best-effort brute-force counter layered on top.
    sql.prepare(`UPDATE grants SET attempts = attempts + 1 WHERE id = ?`).run(grantId);
    const after = getGrant(grantId)!;
    if (after.attempts >= MAX_GRANT_ATTEMPTS && after.uses_remaining > 0) {
      sql.prepare(`UPDATE grants SET uses_remaining = 0 WHERE id = ?`).run(grantId); // burn
    }
    if (before.expires_at <= now) return { ok: false, reason: "expired" };
    if (before.uses_remaining <= 0) return { ok: false, reason: "used" };
    return { ok: false, reason: "bad_secret" };
  }

  interface RedeemEffectParams {
    clientId?: string; // invite/guest/device
    pubkeyJwk?: string; // invite/guest/device
    label?: string | null; // invite/guest/device
    existingUserId?: string; // share: the already-known user redeeming it
  }

  interface RedeemEffectResult {
    user: UserRow;
    client?: ClientRow;
    syncKey?: string; // share/guest
  }

  // Effects per kind (§6): invite -> new child user; device -> attach a
  // client to the issuer's existing user; share -> hand over a sync key, no
  // identity effect; guest -> invite + share together, with provisional=1 and
  // caps=['sync'] forced by createGrant already, not re-derived here.
  function applyGrantEffect(grant: GrantRow, effect: RedeemEffectParams, now: number): RedeemEffectResult {
    if (grant.kind === "invite" || grant.kind === "guest") {
      if (!effect.clientId || !effect.pubkeyJwk) {
        throw new Error(`applyGrantEffect: ${grant.kind} requires clientId + pubkeyJwk`);
      }
      const user = createUser(
        {
          authorizedBy: grant.issuer_user_id,
          caps: grant.caps ?? [],
          provisional: grant.kind === "guest",
        },
        now,
      );
      const client = registerClient(
        { clientId: effect.clientId, userId: user.user_id, pubkeyJwk: effect.pubkeyJwk, label: effect.label },
        now,
      );
      if (grant.kind === "guest" && grant.payload) {
        associateUserKey(user.user_id, grant.payload, null);
      }
      logAuthEvent(
        { kind: `grant_effect_${grant.kind}`, actorUserId: grant.issuer_user_id, subjectUserId: user.user_id, detail: null },
        now,
      );
      return { user, client, syncKey: grant.kind === "guest" ? grant.payload ?? undefined : undefined };
    }

    if (grant.kind === "device") {
      if (!effect.clientId || !effect.pubkeyJwk) {
        throw new Error("applyGrantEffect: device requires clientId + pubkeyJwk");
      }
      const user = getUser(grant.issuer_user_id);
      if (!user) throw new Error("applyGrantEffect: issuer no longer exists");
      const client = registerClient(
        { clientId: effect.clientId, userId: user.user_id, pubkeyJwk: effect.pubkeyJwk, label: effect.label },
        now,
      );
      logAuthEvent({ kind: "grant_effect_device", actorUserId: grant.issuer_user_id, subjectUserId: user.user_id, detail: null }, now);
      return { user, client };
    }

    if (grant.kind === "share") {
      if (!effect.existingUserId) throw new Error("applyGrantEffect: share requires existingUserId");
      const user = getUser(effect.existingUserId);
      if (!user) throw new Error("applyGrantEffect: no such user for share redemption");
      if (grant.payload) associateUserKey(user.user_id, grant.payload, null);
      logAuthEvent({ kind: "grant_effect_share", actorUserId: grant.issuer_user_id, subjectUserId: user.user_id, detail: null }, now);
      return { user, syncKey: grant.payload ?? undefined };
    }

    throw new Error(`applyGrantEffect: unknown grant kind ${grant.kind}`);
  }

  function redeemGrant(
    grantId: string,
    secret: string,
    effect: RedeemEffectParams,
    now: number,
  ): { ok: true; result: RedeemEffectResult } | { ok: false; reason: RedeemFailureReason } {
    // The atomic decrement in attemptRedeemGrant already gives the single-use
    // guarantee on its own (that is the part concurrency safety depends on).
    // Wrapping the whole redemption in one transaction on top of that means a
    // thrown error partway through applyGrantEffect (a malformed effect
    // param, say) rolls back the decrement too, rather than burning a grant
    // for which no user/client/key ever actually got created.
    const run = sql.transaction(() => {
      const attempt = attemptRedeemGrant(grantId, secret, now);
      if (!attempt.ok) return attempt;
      const result = applyGrantEffect(attempt.grant, effect, now);
      return { ok: true as const, result };
    });
    return run();
  }

  // ── Server identity maintenance ──────────────────────────────────────────────

  // Cloning a DB currently requires hand-editing server_id (auth-design.md
  // §3.3 [sf3]); this makes it a supported operation. Also useful after a
  // deliberate re-key of a compromised server.
  function resetServerId(newId?: string): string {
    const id = newId ?? randomUUID();
    sql
      .prepare(
        `INSERT INTO server_config (key, value) VALUES ('server_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(id);
    return id;
  }

  function getSchemaVersionApi(): number {
    return readSchemaVersion(sql);
  }

  function close(): void {
    sql.close();
  }

  return {
    getServerId, upsertEntity, getEntitiesSince, applyTombstone, getTombstonesSince,
    getEntityById, upsertIntegrationResult, getIntegrationResultsSince, getIntegrationResultsForRefresh,
    associateUserKey, removeUserKey, getUserKeys, getOrCreateUserByHomeKey, getSchemaVersion: getSchemaVersionApi, close,
    // Identity & authorization (auth-design.md §12.1, Phase 1 job 1):
    getUser, findRootUser, createUser, listChildren, listAllUsers, setUserCaps, setUserNote,
    setUserState, getEffectiveState, promoteProvisionalUser, setAuthorizedBy, bootstrapRootUser, grantAdminCap,
    getClientById, registerClient, touchClientLastSeen, getUserForClient,
    createGrant, getGrant, attemptRedeemGrant, applyGrantEffect, redeemGrant,
    logAuthEvent, listAuthEvents, resetServerId,
  };
}

export function openDb(path: string): ReturnType<typeof createDbApi> {
  const sql = new Database(path);
  sql.pragma("journal_mode = WAL");
  sql.exec(SCHEMA_SQL);
  applyMigrations(sql);
  return createDbApi(sql);
}

// Production module-level instance — created lazily on first call rather than
// at import time. This module is imported by test files (for `openDb`) and by
// integration-runner.ts (type-only), and eager creation used to mean every
// such import opened the real on-disk database as a side effect — harmless
// against the disposable in-repo data/listr.db, but a real hazard against a
// deployment whose config.db_path points at the actual (sandboxed read-only)
// production database. Only index.ts's production entry point calls this.
let productionDb: ReturnType<typeof createDbApi> | null = null;

export function getProductionDb(): ReturnType<typeof createDbApi> {
  if (!productionDb) {
    const dataDir = config.db_path ?? join(process.cwd(), "data");
    mkdirSync(dataDir, { recursive: true });
    productionDb = openDb(join(dataDir, "listr.db"));
  }
  return productionDb;
}
