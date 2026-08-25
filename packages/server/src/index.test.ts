import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { openDb } from "./db.js";
import { createSyncServer, type SyncServerHandle } from "./index.js";
import { MAX_PROTOCOL_VERSION } from "./protocol.js";

// Minimal in-process WS integration harness (§14): a real WebSocketServer on
// an ephemeral loopback port, backed by an in-memory db, driven with a real
// `ws` client. index.ts has no other coverage, so this exercises the message
// handler directly rather than through db.ts's exported functions.

type DbApi = ReturnType<typeof openDb>;

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    ws.once("message", (raw: Buffer) => {
      try { resolve(JSON.parse(raw.toString())); } catch (e) { reject(e); }
    });
    ws.once("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("sync server — WS integration", () => {
  let db: DbApi;
  let handle: SyncServerHandle;
  let port: number;

  beforeEach(async () => {
    db = openDb(":memory:");
    handle = createSyncServer(db, { tls: false });
    await new Promise<void>((resolve) => handle.httpServer.listen(0, "127.0.0.1", () => resolve()));
    port = (handle.httpServer.address() as AddressInfo).port;
  });

  afterEach(() => {
    handle.stop();
  });

  function connect(): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${port}/sync`);
  }

  async function hello(ws: WebSocket, defaultKey: string, keys?: string[]): Promise<any> {
    await waitForOpen(ws);
    const okPromise = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: "hello",
      keys: keys ?? [defaultKey],
      default_key: defaultKey,
      client_id: "test-client",
      protocol_version: MAX_PROTOCOL_VERSION,
    }));
    return okPromise;
  }

  it("completes a hello handshake and returns ok with the server's id", async () => {
    const ws = connect();
    const ok = await hello(ws, "alice-key");
    expect(ok.type).toBe("ok");
    expect(typeof ok.server_id).toBe("string");
    ws.close();
  });

  it("reports the server's configured variant in ok, defaulting to prod", async () => {
    const ws = connect();
    const ok = await hello(ws, "alice-key");
    expect(ok.variant).toBe("prod");
    ws.close();
  });

  it("reports a non-default variant when the server is configured for one (§3.3 dev/prod guard)", async () => {
    const devHandle = createSyncServer(openDb(":memory:"), { tls: false, variant: "dev" });
    await new Promise<void>((resolve) => devHandle.httpServer.listen(0, "127.0.0.1", () => resolve()));
    const devPort = (devHandle.httpServer.address() as AddressInfo).port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${devPort}/sync`);
      const ok = await hello(ws, "alice-key");
      expect(ok.variant).toBe("dev");
      ws.close();
    } finally {
      devHandle.stop();
    }
  });

  it("round-trips an entity push and pull under its own key", async () => {
    const ws = connect();
    await hello(ws, "alice-key");
    ws.send(JSON.stringify({
      type: "push_entity",
      entity_type: "board",
      sync_key: "alice-key",
      data: { id: "b1", updated_at: Date.now(), name: "Board" },
    }));
    await sleep(50);
    const snapshotPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "pull", keys: [{ key: "alice-key", since: 0 }] }));
    const snapshot = await snapshotPromise;
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.boards).toHaveLength(1);
    expect(snapshot.boards[0].id).toBe("b1");
    ws.close();
  });

  // Regression for §2.1 defect 1: associate_key/leave_key used to trust
  // `default_key` from the message body instead of the connection's own
  // identity, so any connected client could mutate any other user's key set
  // just by naming their default_key.
  it("associate_key cannot touch another user's key set via a spoofed body default_key", async () => {
    const wsAlice = connect();
    await hello(wsAlice, "alice-key");

    const wsMallory = connect();
    await hello(wsMallory, "mallory-key");
    wsMallory.send(JSON.stringify({
      type: "associate_key",
      default_key: "alice-key", // spoofed — Mallory's connection identity is "mallory-key"
      key: "stolen-key",
      name: "gotcha",
    }));
    await sleep(50);

    // Alice's key set is untouched.
    expect(db.getUserKeys("alice-key")).toEqual([]);
    // The association landed under Mallory's own authenticated identity
    // instead of being silently dropped or granted to Alice.
    expect(db.getUserKeys("mallory-key")).toEqual([{ key: "stolen-key", name: "gotcha" }]);

    wsAlice.close();
    wsMallory.close();
  });

  it("leave_key cannot remove another user's key association via a spoofed body default_key", async () => {
    db.associateUserKey("alice-key", "shared-group", "Alice's Group");

    const wsMallory = connect();
    await hello(wsMallory, "mallory-key");
    wsMallory.send(JSON.stringify({
      type: "leave_key",
      default_key: "alice-key", // spoofed
      key: "shared-group",
    }));
    await sleep(50);

    // Alice's association survives the spoofed leave_key from Mallory's connection.
    expect(db.getUserKeys("alice-key")).toEqual([{ key: "shared-group", name: "Alice's Group" }]);

    wsMallory.close();
  });

  it("associate_key with a truthful default_key works normally", async () => {
    const ws = connect();
    await hello(ws, "alice-key");
    ws.send(JSON.stringify({ type: "associate_key", default_key: "alice-key", key: "board-group-1", name: "Trip" }));
    await sleep(50);
    expect(db.getUserKeys("alice-key")).toEqual([{ key: "board-group-1", name: "Trip" }]);
    ws.close();
  });
});
