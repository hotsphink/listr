import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { webcrypto } from "node:crypto";
import type { AddressInfo } from "node:net";
import { openDb } from "./db.js";
import { createSyncServer, type SyncServerHandle } from "./index.js";
import { MAX_PROTOCOL_VERSION } from "./protocol.js";
import { jwkThumbprint, buildAuthPayload } from "./authCrypto.js";

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

// A fresh ECDSA P-256 keypair + its RFC 7638 client_id, standing in for one
// browser profile's client_identity (database.ts) — everything the v5
// handshake needs from "the client" in a test, without touching Dexie.
interface TestClient {
  clientId: string;
  pubkeyJwk: Record<string, unknown>;
  privateKey: CryptoKey;
}

async function makeTestClient(): Promise<TestClient> {
  const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pubkeyJwk = (await webcrypto.subtle.exportKey("jwk", kp.publicKey)) as unknown as Record<string, unknown>;
  const clientId = await jwkThumbprint(pubkeyJwk);
  return { clientId, pubkeyJwk, privateKey: kp.privateKey };
}

async function signFor(client: TestClient, serverId: string, nonce: string): Promise<string> {
  const payload = buildAuthPayload(serverId, nonce, client.clientId);
  const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, client.privateKey, payload);
  return Buffer.from(sig).toString("base64url");
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

  async function sendHello(ws: WebSocket, client: TestClient, keys: string[] = []): Promise<any> {
    await waitForOpen(ws);
    const challengePromise = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: "hello",
      protocol_version: MAX_PROTOCOL_VERSION,
      client_id: client.clientId,
      pubkey_jwk: client.pubkeyJwk,
      keys,
    }));
    return challengePromise;
  }

  /** Full hello -> challenge -> auth round trip. Returns whatever the server
   * replies to `auth` with (ok / needs_grant / error). */
  async function handshake(ws: WebSocket, client: TestClient, keys: string[] = []): Promise<any> {
    const challenge = await sendHello(ws, client, keys);
    expect(challenge.type).toBe("challenge");
    const sig = await signFor(client, challenge.server_id, challenge.nonce);
    const resultPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig }));
    const result = await resultPromise;
    return { challenge, result };
  }

  /** Registers a brand-new client as a fresh root-authorized user via the
   * CLI-equivalent db calls, then completes its handshake — the shortest
   * path to "an active, registered client" for tests that don't care about
   * the grant flow itself. */
  async function registerAndConnect(ws: WebSocket, client: TestClient, keys: string[] = []): Promise<any> {
    const root = db.bootstrapRootUser(Date.now());
    const user = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, Date.now());
    db.registerClient({ clientId: client.clientId, userId: user.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk) }, Date.now());
    const { result } = await handshake(ws, client, keys);
    return result;
  }

  it("completes a hello/challenge/auth handshake for a registered client and returns ok", async () => {
    const client = await makeTestClient();
    const ws = connect();
    const ok = await registerAndConnect(ws, client);
    expect(ok.type).toBe("ok");
    expect(typeof ok.user_id).toBe("string");
    expect(typeof ok.home_key).toBe("string");
    expect(ok.caps).toEqual(["sync"]);
    ws.close();
  });

  it("reports the server's configured variant in `challenge`, defaulting to prod", async () => {
    const client = await makeTestClient();
    const ws = connect();
    const challenge = await sendHello(ws, client);
    expect(challenge.type).toBe("challenge");
    expect(challenge.variant).toBe("prod");
    expect(typeof challenge.server_id).toBe("string");
    ws.close();
  });

  it("reports a non-default variant when the server is configured for one (§3.3 dev/prod guard)", async () => {
    const devHandle = createSyncServer(openDb(":memory:"), { tls: false, variant: "dev" });
    await new Promise<void>((resolve) => devHandle.httpServer.listen(0, "127.0.0.1", () => resolve()));
    const devPort = (devHandle.httpServer.address() as AddressInfo).port;
    try {
      const client = await makeTestClient();
      const ws = new WebSocket(`ws://127.0.0.1:${devPort}/sync`);
      const challenge = await sendHello(ws, client);
      expect(challenge.variant).toBe("dev");
      ws.close();
    } finally {
      devHandle.stop();
    }
  });

  it("rejects an unsupported protocol version before any challenge is issued", async () => {
    const client = await makeTestClient();
    const ws = connect();
    await waitForOpen(ws);
    const errPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "hello", protocol_version: 4, client_id: client.clientId, pubkey_jwk: client.pubkeyJwk, keys: [] }));
    const err = await errPromise;
    expect(err.type).toBe("error");
    expect(err.reason).toBe("protocol");
    ws.close();
  });

  it("rejects a hello whose client_id doesn't match the thumbprint of pubkey_jwk", async () => {
    const client = await makeTestClient();
    const other = await makeTestClient();
    const ws = connect();
    await waitForOpen(ws);
    const errPromise = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: "hello",
      protocol_version: MAX_PROTOCOL_VERSION,
      client_id: other.clientId, // mismatched on purpose
      pubkey_jwk: client.pubkeyJwk,
      keys: [],
    }));
    const err = await errPromise;
    expect(err.type).toBe("error");
    ws.close();
  });

  it("rejects a bad signature in `auth`", async () => {
    const client = await makeTestClient();
    const ws = connect();
    const challenge = await sendHello(ws, client);
    const errPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig: "not-a-valid-signature" }));
    const err = await errPromise;
    expect(err.type).toBe("error");
    expect(err.reason).toBe("bad_signature");
    ws.close();
  });

  it("rejects a signature computed for a different server_id (cross-server replay, §3.3)", async () => {
    // A second, independent server instance — a different in-memory db means
    // a different (real, randomly generated) server_id.
    const otherHandle = createSyncServer(openDb(":memory:"), { tls: false });
    await new Promise<void>((resolve) => otherHandle.httpServer.listen(0, "127.0.0.1", () => resolve()));
    const otherPort = (otherHandle.httpServer.address() as AddressInfo).port;
    try {
      const client = await makeTestClient();

      // Get a real challenge from the OTHER server and sign for it.
      const wsOther = new WebSocket(`ws://127.0.0.1:${otherPort}/sync`);
      const challengeOther = await sendHello(wsOther, client);
      const sigForOther = await signFor(client, challengeOther.server_id, challengeOther.nonce);
      wsOther.close();

      // Present that signature to THIS server. Even in the vanishingly
      // unlikely event its own independently-generated nonce happened to
      // read identically (128 random bits — it won't), the signature was
      // computed against the other server's server_id and must not verify
      // here. In practice this also gets caught earlier, as an unrecognized
      // nonce — see the comment on the dedicated crypto-layer test in
      // authCrypto.test.ts for why the server_id-binding property itself is
      // tested directly there rather than relying on an engineered
      // collision here.
      const ws = connect();
      const challenge = await sendHello(ws, client);
      const errPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "auth", sig: sigForOther }));
      const err = await errPromise;
      expect(err.type).toBe("error");
      expect(err.reason).toBe("bad_signature");
      expect(challenge.server_id).not.toBe(challengeOther.server_id);
      ws.close();
    } finally {
      otherHandle.stop();
    }
  });

  it("rejects a replayed (already-consumed) nonce — auth is single-use per connection", async () => {
    const client = await makeTestClient();
    const ws = connect();
    const challenge = await sendHello(ws, client);
    const sig = await signFor(client, challenge.server_id, challenge.nonce);

    // First use succeeds in the sense of being processed (this client is
    // unregistered, so the substantive reply is needs_grant — that's fine,
    // what matters is the nonce got consumed).
    const firstPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig }));
    const first = await firstPromise;
    expect(first.type).toBe("needs_grant");

    // Replaying the exact same auth message again must fail: the nonce was
    // consumed by the first attempt, so there's no pending challenge left
    // to verify against.
    const secondPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig }));
    const second = await secondPromise;
    expect(second.type).toBe("error");
    ws.close();
  });

  it("replies needs_grant for a client the server has never seen", async () => {
    const client = await makeTestClient();
    const ws = connect();
    const { result } = await handshake(ws, client);
    expect(result.type).toBe("needs_grant");
    ws.close();
  });

  it("rejects a suspended client's auth and does not authenticate the connection", async () => {
    const client = await makeTestClient();
    const root = db.bootstrapRootUser(Date.now());
    const user = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, Date.now());
    db.registerClient({ clientId: client.clientId, userId: user.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk) }, Date.now());
    db.setUserState(user.user_id, "suspended", Date.now());

    const ws = connect();
    const { result } = await handshake(ws, client);
    expect(result.type).toBe("error");
    expect(result.reason).toBe("suspended");
    ws.close();
  });

  it("rejects a revoked client's auth and does not authenticate the connection", async () => {
    const client = await makeTestClient();
    const root = db.bootstrapRootUser(Date.now());
    const user = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, Date.now());
    db.registerClient({ clientId: client.clientId, userId: user.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk) }, Date.now());
    db.setUserState(user.user_id, "revoked", Date.now());

    const ws = connect();
    const { result } = await handshake(ws, client);
    expect(result.type).toBe("error");
    expect(result.reason).toBe("revoked");
    ws.close();
  });

  it("a suspended client cannot push/pull after being rejected", async () => {
    const client = await makeTestClient();
    const root = db.bootstrapRootUser(Date.now());
    const user = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, Date.now());
    db.registerClient({ clientId: client.clientId, userId: user.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk) }, Date.now());
    db.setUserState(user.user_id, "suspended", Date.now());

    const ws = connect();
    await handshake(ws, client);
    // The close(1008) from the suspended rejection may already have fired;
    // guard the send so a closed-socket throw doesn't fail the test before
    // we can assert anything.
    const errPromise = waitForMessage(ws).catch(() => null);
    try {
      ws.send(JSON.stringify({ type: "pull", keys: [{ key: user.home_key, since: 0 }] }));
    } catch { /* socket already closed — also an acceptable outcome */ }
    const reply = await Promise.race([errPromise, sleep(100).then(() => null)]);
    if (reply) expect(reply.type).toBe("error");
    ws.close();
  });

  it("round-trips an entity push and pull under the assigned home key", async () => {
    const client = await makeTestClient();
    const ws = connect();
    const ok = await registerAndConnect(ws, client);
    ws.send(JSON.stringify({
      type: "push_entity",
      entity_type: "board",
      sync_key: ok.home_key,
      data: { id: "b1", updated_at: Date.now(), name: "Board" },
    }));
    await sleep(50);
    const snapshotPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "pull", keys: [{ key: ok.home_key, since: 0 }] }));
    const snapshot = await snapshotPromise;
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.boards).toHaveLength(1);
    expect(snapshot.boards[0].id).toBe("b1");
    ws.close();
  });

  it("rejects any message before authentication completes", async () => {
    const client = await makeTestClient();
    const ws = connect();
    await sendHello(ws, client);
    const errPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "pull", keys: [] }));
    const err = await errPromise;
    expect(err.type).toBe("error");
    ws.close();
  });

  // Regression for §2.1 defect 1, now structural rather than checked: there
  // is no client-supplied identity field on associate_key/leave_key at all
  // (identity comes entirely from the authenticated connection), so there is
  // nothing left to spoof.
  it("associate_key always acts on the authenticated connection's own user", async () => {
    const alice = await makeTestClient();
    const mallory = await makeTestClient();
    const wsAlice = connect();
    await registerAndConnect(wsAlice, alice);
    const wsMallory = connect();
    const okMallory = await registerAndConnect(wsMallory, mallory);

    wsMallory.send(JSON.stringify({ type: "associate_key", key: "stolen-key", name: "gotcha" }));
    await sleep(50);

    const aliceUser = db.getUserForClient(alice.clientId)!.user;
    expect(db.getUserKeys(aliceUser.user_id)).toEqual([]);
    expect(db.getUserKeys(db.getUserForClient(mallory.clientId)!.user.user_id)).toEqual([
      { key: "stolen-key", name: "gotcha" },
    ]);
    expect(okMallory.type).toBe("ok");

    wsAlice.close();
    wsMallory.close();
  });

  it("leave_key only removes the authenticated connection's own association", async () => {
    const alice = await makeTestClient();
    const root = db.bootstrapRootUser(Date.now());
    const aliceUser = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, Date.now());
    db.registerClient({ clientId: alice.clientId, userId: aliceUser.user_id, pubkeyJwk: JSON.stringify(alice.pubkeyJwk) }, Date.now());
    db.associateUserKey(aliceUser.user_id, "shared-group", "Alice's Group");

    const mallory = await makeTestClient();
    const wsMallory = connect();
    await registerAndConnect(wsMallory, mallory);
    wsMallory.send(JSON.stringify({ type: "leave_key", key: "shared-group" }));
    await sleep(50);

    expect(db.getUserKeys(aliceUser.user_id)).toEqual([{ key: "shared-group", name: "Alice's Group" }]);
    wsMallory.close();
  });

  it("rejects a WebSocket upgrade from a disallowed Origin (§2.1 defect 3)", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`, { headers: { origin: "https://evil.example" } });
    await new Promise<void>((resolve) => {
      ws.once("unexpected-response", (_req, res) => {
        expect(res.statusCode).toBe(403);
        resolve();
      });
      ws.once("open", () => { ws.close(); resolve(); });
      ws.once("error", () => resolve());
    });
  });

  it("allows a WebSocket upgrade with no Origin header (non-browser clients, e.g. this test harness)", async () => {
    const ws = connect();
    await waitForOpen(ws); // would hang/reject if verifyClient refused it
    ws.close();
  });
});

describe("redeem_grant (§6, §7.2) — registration plumbing", () => {
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

  async function sendHello(ws: WebSocket, client: TestClient, keys: string[] = []): Promise<any> {
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    const p = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "hello", protocol_version: MAX_PROTOCOL_VERSION, client_id: client.clientId, pubkey_jwk: client.pubkeyJwk, keys }));
    return p;
  }

  async function getToNeedsGrant(ws: WebSocket, client: TestClient): Promise<void> {
    const challenge = await sendHello(ws, client);
    const sig = await signFor(client, challenge.server_id, challenge.nonce);
    const p = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig }));
    const reply = await p;
    expect(reply.type).toBe("needs_grant");
  }

  it("an invite grant registers a brand-new client and returns ok on the same connection", async () => {
    const root = db.bootstrapRootUser(Date.now());
    const { grantId, secret } = db.createGrant({ kind: "invite", issuerUserId: root.user_id, caps: ["sync"] }, Date.now());

    const client = await makeTestClient();
    const ws = connect();
    await getToNeedsGrant(ws, client);

    const okPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "redeem_grant", grant_id: grantId, secret }));
    const ok = await okPromise;
    expect(ok.type).toBe("ok");
    expect(ok.caps).toEqual(["sync"]);

    const record = db.getUserForClient(client.clientId);
    expect(record?.user.authorized_by).toBe(root.user_id);
    ws.close();
  });

  it("a wrong secret is rejected without registering the client", async () => {
    const root = db.bootstrapRootUser(Date.now());
    const { grantId } = db.createGrant({ kind: "invite", issuerUserId: root.user_id, caps: ["sync"] }, Date.now());

    const client = await makeTestClient();
    const ws = connect();
    await getToNeedsGrant(ws, client);

    const errPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "redeem_grant", grant_id: grantId, secret: "wrong-secret" }));
    const err = await errPromise;
    expect(err.type).toBe("error");
    expect(db.getClientById(client.clientId)).toBeNull();
    ws.close();
  });

  it("a share grant hands an already-authenticated user another sync key", async () => {
    const root = db.bootstrapRootUser(Date.now());
    const alice = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, Date.now());
    const client = await makeTestClient();
    db.registerClient({ clientId: client.clientId, userId: alice.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk) }, Date.now());
    const { grantId, secret } = db.createGrant({ kind: "share", issuerUserId: root.user_id, payload: "shared-board-key" }, Date.now());

    const ws = connect();
    const challenge = await sendHello(ws, client);
    const sig = await signFor(client, challenge.server_id, challenge.nonce);
    const okPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig }));
    const ok = await okPromise;
    expect(ok.type).toBe("ok");

    const redeemPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "redeem_grant", grant_id: grantId, secret }));
    const redeemed = await redeemPromise;
    expect(redeemed.type).toBe("ok");
    expect(db.getUserKeys(alice.user_id).map((k) => k.key)).toContain("shared-board-key");
    ws.close();
  });
});
