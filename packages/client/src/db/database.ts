import Dexie, { type EntityTable, type Table } from "dexie";
import type { Asset, Board, Item, List, IntegrationResult } from "@listr/shared";

const DB_NAME = "listr2";
const LEGACY_DB_NAME = "listr";

export interface SyncConfig {
  id: string; // always "default"
  sync_url: string;
  sync_key: string;
  client_id: string;
  enabled: boolean;
  last_sync_at: number;
  last_sync_key?: string;
}

export interface SyncEndpoint {
  id: string;
  host: string;
  port: number;
  enabled: boolean;
  secure: boolean;
  last_server_id: string | null;
  position: number;
}

export interface LocalTombstone {
  id: string; // `${entity_type}:${entity_id}`
  entity_type: string;
  entity_id: string;
  deleted_at: number;
  sync_key?: string; // which namespace this delete belongs to
}

export interface KeySyncState {
  key: string;
  last_sync_at: number;
}

export interface SharedKey {
  key: string; // primary key — the sync_key to subscribe to
  added_at: number;
  board_name?: string; // display hint from the share QR
  /**
   * Which server this key is scoped to, or null if unscoped, meaning it is
   * offered to every configured endpoint. A freshly accepted share starts
   * unscoped until its first successful connect tags it. See SyncClient's
   * per-endpoint key scoping and keyScoping.ts.
   */
  server_id: string | null;
}

/**
 * Local-only (never synced) label for a sync_key that's known to be a deliberate
 * board group, as opposed to an ordinary individually-shared board. Drives the
 * sidebar's decision to give a key its own group heading instead of lumping it
 * into the generic "Shared Boards" bucket.
 */
export interface BoardGroupMeta {
  key: string; // primary key — the sync_key this label applies to
  name: string;
  created_at: number;
}


/**
 * Local-only, never synced, board-to-server binding. A board with no row
 * here, or `server_id: null`, is "not yet placed", the same
 * null-means-unscoped convention shared_keys uses (see keyScoping.ts), and is
 * offered to every endpoint until it binds on its first successful connect.
 * Deliberately a separate table rather than a field on Board: Board is a
 * synced entity type shared with the wire protocol, and this must never become
 * a synced field.
 */
export interface BoardServerBinding {
  board_id: string; // primary key
  server_id: string | null;
}

/**
 * Client's own keypair, global to the browser profile and created lazily on
 * the first server connection. Offline-only users do not have a key. The same
 * keypair may register independently with several servers. CryptoKey objects
 * are structured-cloneable, so Dexie stores
 * them directly and `privateKey`'s non-extractability survives reloads. The
 * private key is never serialized to anything else (see clientKeys.ts).
 *
 * `client_id` is the RFC 7638 JWK thumbprint of `publicKey`, computed once at
 * creation time and cached here.
 */
export interface ClientIdentity {
  id: string; // always "default"
  privateKey: CryptoKey; // extractable: false
  publicKey: CryptoKey;
  client_id: string;
}

/**
 * Per-server registration state, keyed by `server_id`. `state` folds
 * registration status and account status into one field: "needs_grant" means
 * this server has never seen this client's key (or has forgotten it) and is
 * waiting for a grant to be redeemed; the other three mirror the server's own
 * UserState. `home_key`/`user_id`/`caps`/ `display_name` are all null until the
 * first successful `ok`.
 */
export interface ServerIdentity {
  server_id: string; // primary key
  state: "needs_grant" | "active" | "suspended" | "revoked";
  user_id: string | null;
  home_key: string | null;
  caps: string[];
  display_name: string | null;
  updated_at: number;
}

export class ListrDB extends Dexie {
  boards!: EntityTable<Board, "id">;
  lists!: EntityTable<List, "id">;
  items!: EntityTable<Item, "id">;
  assets!: EntityTable<Asset, "id">;
  integration_results!: EntityTable<IntegrationResult, "id">;
  sync_config!: Table<SyncConfig, string>;
  tombstones!: Table<LocalTombstone, string>;
  sync_endpoints!: Table<SyncEndpoint, string>;
  key_sync_state!: Table<KeySyncState, string>;
  shared_keys!: Table<SharedKey, string>;
  board_groups!: Table<BoardGroupMeta, string>;
  board_server_binding!: Table<BoardServerBinding, string>;
  client_identity!: Table<ClientIdentity, string>;
  server_identity!: Table<ServerIdentity, string>;

  constructor() {
    super(DB_NAME);

    // ── Data-format versioning ────────────────────────────────────────────
    // IndexedDB persists the Dexie schema version below; when a client with a
    // higher declared version opens an older local DB, the matching `.upgrade()`
    // runs ONCE to migrate existing rows forward.
    //
    // Whenever you change the stored shape of an entity (add/rename/remove a
    // field, change how ordering is represented, etc.):
    //   1. Add a NEW `this.version(N+1).stores(...).upgrade(...)` block below.
    //      Never edit an existing version block.
    //   2. If the changed field is also synced to the server, bump the sync
    //      PROTOCOL_VERSION (src/sync/protocol.ts) and the server's supported
    //      range so old- and new-format clients can't share one server and
    //      corrupt each other's data. NOTE: `.upgrade()` migrates only LOCAL
    //      data at open time — it does NOT run on entities pulled over sync.
    // See memory: project_data_format_versioning.
    //
    // 2026-08-24: reset to a single version(1) here (DB renamed "listr" →
    // "listr2") instead of carrying the old position/category-era migration
    // chain forward — see migrateFromLegacyDatabase() below, which copies
    // sync_config/sync_endpoints from the old database and otherwise forces
    // a full resync from the server, alongside the protocol v4 flag day.
    // ──────────────────────────────────────────────────────────────────────

    this.version(1).stores({
      boards: "id, position, updated_at",
      lists: "id, board_id, position, updated_at",
      items: "id, list_id, after_id, title, updated_at",
      sync_config: "id",
      tombstones: "id, entity_type, deleted_at",
      assets: "id, updated_at",
      sync_endpoints: "id, position",
      key_sync_state: "key",
      shared_keys: "key",
      integration_results: "id, item_id, integration_id, status, updated_at",
      board_groups: "key",
    });

    // shared_keys gains a nullable `server_id`, for server-scoped sync keys.
    // It is not part of the index string below, since nothing queries by it.
    // The upgrade only needs to back-fill the field on existing rows so
    // `row.server_id` is always present rather than `undefined`. null means
    // unscoped, so every pre-existing row migrates to null, which preserves
    // the "send this key to every endpoint" behavior exactly.
    this.version(2).stores({
      boards: "id, position, updated_at",
      lists: "id, board_id, position, updated_at",
      items: "id, list_id, after_id, title, updated_at",
      sync_config: "id",
      tombstones: "id, entity_type, deleted_at",
      assets: "id, updated_at",
      sync_endpoints: "id, position",
      key_sync_state: "key",
      shared_keys: "key",
      integration_results: "id, item_id, integration_id, status, updated_at",
      board_groups: "key",
    }).upgrade(async (tx) => {
      await tx.table("shared_keys").toCollection().modify((row: SharedKey) => {
        if (row.server_id === undefined) row.server_id = null;
      });
    });

    // board_server_binding makes a board sync only to the server it belongs
    // to. This adds a table only, so no store string changes for anything
    // else. The upgrade binds every existing board to the one server this
    // client already knows, via sync_endpoints.last_server_id, so a
    // single-server setup is unaffected.
    //
    // Bind only when there is exactly one distinct known server_id. Zero or
    // several is ambiguous, meaning this client has never synced or has talked
    // to more than one server, so those boards stay unbound (null) and are
    // placed individually the next time each is pushed. See
    // SyncClient.bindUnboundBoards.
    this.version(3).stores({
      boards: "id, position, updated_at",
      lists: "id, board_id, position, updated_at",
      items: "id, list_id, after_id, title, updated_at",
      sync_config: "id",
      tombstones: "id, entity_type, deleted_at",
      assets: "id, updated_at",
      sync_endpoints: "id, position",
      key_sync_state: "key",
      shared_keys: "key",
      integration_results: "id, item_id, integration_id, status, updated_at",
      board_groups: "key",
      board_server_binding: "board_id",
    }).upgrade(async (tx) => {
      const endpoints = await tx.table("sync_endpoints").toArray();
      const knownServerIds = [
        ...new Set(
          endpoints
            .map((e: SyncEndpoint) => e.last_server_id)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      ];

      if (knownServerIds.length === 1) {
        const serverId = knownServerIds[0];
        const boards = await tx.table("boards").toArray();
        for (const b of boards) {
          await tx.table("board_server_binding").put({ board_id: b.id, server_id: serverId });
        }
      }
    });

    // client_identity / server_identity: the handshake's client-side state.
    this.version(4).stores({
      boards: "id, position, updated_at",
      lists: "id, board_id, position, updated_at",
      items: "id, list_id, after_id, title, updated_at",
      sync_config: "id",
      tombstones: "id, entity_type, deleted_at",
      assets: "id, updated_at",
      sync_endpoints: "id, position",
      key_sync_state: "key",
      shared_keys: "key",
      integration_results: "id, item_id, integration_id, status, updated_at",
      board_groups: "key",
      board_server_binding: "board_id",
      client_identity: "id",
      server_identity: "server_id",
    });
  }
}

export const db = new ListrDB();
migrateFromLegacyDatabase().catch(console.error);

/**
 * One-time bridge from the pre-flag-day "listr" database to the current
 * "listr2" one (see the version(1) comment above): carries over sync_config/
 * sync_endpoints (so devices don't need their sync key re-entered), then
 * deletes the old database. Everything else (boards/lists/items/tombstones/
 * key_sync_state/shared_keys/board_groups) is intentionally left empty —
 * key_sync_state being empty means every key's `since` is 0, so the normal
 * sync machinery already does a full resync from the server on first
 * connect, and shared_keys/board_groups get repopulated the same way via
 * the server's `user_keys` association (see SyncClient.adoptUserKeys).
 *
 * Safe to delete this function (and the migration it performs) once every
 * device that had local data has run it at least once.
 */
async function migrateFromLegacyDatabase(): Promise<void> {
  if (await db.sync_config.get("default")) return; // already migrated, or fresh install already configured

  const legacy = await readLegacyConfig();
  if (legacy.syncConfig) {
    await db.sync_config.put(legacy.syncConfig);
    if (legacy.syncEndpoints.length) await db.sync_endpoints.bulkPut(legacy.syncEndpoints);
  }
  indexedDB.deleteDatabase(LEGACY_DB_NAME);
}

function readLegacyConfig(): Promise<{ syncConfig: SyncConfig | null; syncEndpoints: SyncEndpoint[] }> {
  return new Promise((resolve) => {
    const empty = { syncConfig: null, syncEndpoints: [] };
    // No version specified: opens at whatever version already exists, or — if
    // the legacy database never existed on this device — creates a fresh
    // empty one. Abort that creation in onupgradeneeded so a fresh install
    // doesn't leave a stray empty "listr" database behind.
    const req = indexedDB.open(LEGACY_DB_NAME);
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onsuccess = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains("sync_config")) {
        idb.close();
        resolve(empty);
        return;
      }
      const storeNames = ["sync_config", ...(idb.objectStoreNames.contains("sync_endpoints") ? ["sync_endpoints"] : [])];
      const tx = idb.transaction(storeNames, "readonly");
      let syncConfig: SyncConfig | null = null;
      let syncEndpoints: SyncEndpoint[] = [];
      tx.objectStore("sync_config").get("default").onsuccess = (e) => {
        syncConfig = (e.target as IDBRequest).result ?? null;
      };
      if (storeNames.includes("sync_endpoints")) {
        tx.objectStore("sync_endpoints").getAll().onsuccess = (e) => {
          syncEndpoints = (e.target as IDBRequest).result ?? [];
        };
      }
      tx.oncomplete = () => { idb.close(); resolve({ syncConfig, syncEndpoints }); };
      tx.onerror = () => { idb.close(); resolve(empty); };
    };
    req.onerror = () => resolve(empty);
  });
}
