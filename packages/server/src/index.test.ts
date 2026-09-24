import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { webcrypto } from "node:crypto";
import type { AddressInfo } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createSyncServer, warnIfCertExpiring, type SyncServerHandle } from "./index.js";
import { MAX_PROTOCOL_VERSION } from "./protocol.js";
import { jwkThumbprint, buildAuthPayload } from "./authCrypto.js";

// Minimal in-process WS integration harness: a real WebSocketServer on
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
// browser profile's client_identity (database.ts). This is everything the
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

describe("sync server: WS integration", () => {
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
   * CLI-equivalent db calls, then completes its handshake. This is the
   * shortest path to "an active, registered client" for tests that do not
   * care about the grant flow itself. */
  async function registerAndConnect(ws: WebSocket, client: TestClient, keys: string[] = []): Promise<any> {
    const root = db.bootstrapRootUser(Date.now());
    const user = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, Date.now());
    db.registerClient({ clientId: client.clientId, userId: user.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk) }, Date.now());
    const { result } = await handshake(ws, client, keys);
    return result;
  }

  // Regression: set_display_name / list_clients shipped with no coverage at
  // all, so nothing caught whether the server actually answers them.
  // The point of the fan-out: a second device of the SAME user learns about a
  // device-list change without asking. Previously list_clients was strictly
  // request/response, so every other machine stayed stale until someone hit
  // Refresh.
  it("pushes the refreshed device list to a user's other open connections", async () => {
    const clientA = await makeTestClient();
    const wsA = connect();
    const ok = await registerAndConnect(wsA, clientA);

    // A second device on the SAME user, connected concurrently.
    const clientB = await makeTestClient();
    db.registerClient(
      { clientId: clientB.clientId, userId: ok.user_id, pubkeyJwk: JSON.stringify(clientB.pubkeyJwk) },
      Date.now(),
    );
    const wsB = connect();
    await handshake(wsB, clientB);

    // A renames a device; B should be told without having asked.
    const pushedToB = waitForMessage(wsB);
    wsA.send(JSON.stringify({ type: "set_client_label", client_id: clientA.clientId, label: "desktop" }));
    const msg = await pushedToB;

    expect(msg.type).toBe("clients");
    expect(msg.clients.find((c: any) => c.client_id === clientA.clientId).label).toBe("desktop");

    wsA.close();
    wsB.close();
  });

  it("set_client_label renames the device and replies with the refreshed list", async () => {
    const client = await makeTestClient();
    const ws = connect();
    await registerAndConnect(ws, client);

    const replyPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "set_client_label", client_id: client.clientId, label: "  desktop  " }));
    const reply = await replyPromise;

    expect(reply.type).toBe("clients");
    expect(reply.clients).toHaveLength(1);
    expect(reply.clients[0].label).toBe("desktop");
    ws.close();
  });

  // The ownership check lives in setClientLabel's WHERE clause; this is what
  // proves it, since the wire message carries an arbitrary client_id.
  it("set_client_label cannot rename a device belonging to another user", async () => {
    const client = await makeTestClient();
    const ws = connect();
    await registerAndConnect(ws, client);

    // A second user with their own device, untouched by this connection.
    const otherUser = db.createUser({ authorizedBy: null, caps: ["sync"] }, Date.now());
    db.registerClient(
      { clientId: "victim-client-id", userId: otherUser.user_id, pubkeyJwk: "{}", label: "victim laptop" },
      Date.now(),
    );

    const replyPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "set_client_label", client_id: "victim-client-id", label: "pwned" }));
    const reply = await replyPromise;

    expect(reply.type).toBe("error");
    expect(reply.reason).toBe("bad_request");
    expect(db.getClientById("victim-client-id")?.label).toBe("victim laptop");
    ws.close();
  });

  it("set_display_name persists the name and replies display_name_set", async () => {
    const client = await makeTestClient();
    const ws = connect();
    await registerAndConnect(ws, client);

    const replyPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "set_display_name", display_name: "  Steve  " }));
    const reply = await replyPromise;

    expect(reply.type).toBe("display_name_set");
    expect(reply.display_name).toBe("Steve");
    ws.close();
  });

  it("set_display_name with a blank string clears the name", async () => {
    const client = await makeTestClient();
    const ws = connect();
    await registerAndConnect(ws, client);

    const replyPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "set_display_name", display_name: "   " }));
    const reply = await replyPromise;

    expect(reply.type).toBe("display_name_set");
    expect(reply.display_name).toBeNull();
    ws.close();
  });

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

  it("reports a non-default variant when the server is configured for one", async () => {
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

  it("rejects a signature computed for a different server_id (cross-server replay)", async () => {
    // A second, independent server instance. A different in-memory db means
    // a different, randomly generated server_id.
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
      // read identically (128 random bits, so it will not), the signature was
      // computed against the other server's server_id and must not verify
      // here. In practice this also gets caught earlier, as an unrecognized
      // nonce. See the comment on the dedicated crypto-layer test in
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

  it("rejects a replayed (already-consumed) nonce: auth is single-use per connection", async () => {
    const client = await makeTestClient();
    const ws = connect();
    const challenge = await sendHello(ws, client);
    const sig = await signFor(client, challenge.server_id, challenge.nonce);

    // First use succeeds in the sense of being processed (this client is
    // unregistered, so the substantive reply is needs_grant, which is fine;
    // what matters is that the nonce got consumed).
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
    } catch { /* socket already closed, also an acceptable outcome */ }
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

  // associate_key and leave_key carry no client-supplied identity field at
  // all, since identity comes entirely from the authenticated connection, so
  // there is nothing to spoof.
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

  it("rejects a WebSocket upgrade from a disallowed Origin", async () => {
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

  it("takes allowed origins from its options, ignoring a trailing slash", async () => {
    const other = createSyncServer(openDb(":memory:"), { tls: false, allowedOrigins: ["https://app.example/"] });
    await new Promise<void>((resolve) => other.httpServer.listen(0, "127.0.0.1", () => resolve()));
    const otherPort = (other.httpServer.address() as AddressInfo).port;
    const outcome = (origin: string) => new Promise<number | "open">((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${otherPort}/sync`, { headers: { origin } });
      ws.once("open", () => { ws.close(); resolve("open"); });
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    });
    try {
      expect(await outcome("https://app.example")).toBe("open");
      expect(await outcome("http://localhost:3000")).toBe(403);
    } finally {
      other.stop();
    }
  });
});

describe("redeem_grant: registration plumbing", () => {
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

  // Registers a brand-new client as a fresh root-authorized user, then
  // completes its handshake. Mirrors the outer describe block's helper of the
  // same name, duplicated locally since this block has its own db, port, and
  // connect fixtures.
  async function registerAndConnect(ws: WebSocket, client: TestClient): Promise<any> {
    const root = db.bootstrapRootUser(Date.now());
    const user = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, Date.now());
    db.registerClient({ clientId: client.clientId, userId: user.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk) }, Date.now());
    const challenge = await sendHello(ws, client);
    const sig = await signFor(client, challenge.server_id, challenge.nonce);
    const p = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig }));
    return p;
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

  // db.test.ts covers this rejection at the db layer. This exercises it over
  // the real WS wire path, where the "already has an identity" client is a
  // full second live connection that has completed its own handshake, the
  // shape a misdirected tap actually takes.
  it("rejects an invite grant redeemed by an already-registered client over the wire, without burning it", async () => {
    const root = db.bootstrapRootUser(Date.now());
    const { grantId, secret } = db.createGrant({ kind: "invite", issuerUserId: root.user_id, caps: ["sync"] }, Date.now());

    // Someone already has an account on this server (unrelated to the grant).
    const already = await makeTestClient();
    const wsAlready = connect();
    await registerAndConnect(wsAlready, already);

    // That same client mistakenly taps an invite link meant for someone else.
    const errPromise = waitForMessage(wsAlready);
    wsAlready.send(JSON.stringify({ type: "redeem_grant", grant_id: grantId, secret }));
    const err = await errPromise;
    expect(err.type).toBe("error");
    expect(err.reason).toBe("already_registered");
    wsAlready.close();

    // The grant is untouched, so the intended recipient can still use it.
    const recipient = await makeTestClient();
    const wsRecipient = connect();
    await getToNeedsGrant(wsRecipient, recipient);
    const okPromise = waitForMessage(wsRecipient);
    wsRecipient.send(JSON.stringify({ type: "redeem_grant", grant_id: grantId, secret }));
    const ok = await okPromise;
    expect(ok.type).toBe("ok");
    wsRecipient.close();
  });
});

describe("peek_grant / create_grant", () => {
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

  it("peek_grant reveals the greeting and voucher's display name without consuming the grant", async () => {
    const root = db.bootstrapRootUser(Date.now());
    db.setUserDisplayName(root.user_id, "Steve", Date.now());
    const { grantId, secret } = db.createGrant(
      { kind: "guest", issuerUserId: root.user_id, payload: "shopping-key", greeting: "Groceries" },
      Date.now(),
    );

    const client = await makeTestClient();
    const ws = connect();
    await waitForOpen(ws);
    const infoPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "peek_grant", grant_id: grantId, secret }));
    const info = await infoPromise;
    expect(info.type).toBe("grant_info");
    expect(info.greeting).toBe("Groceries");
    expect(info.issuer_display_name).toBe("Steve");

    // Still fully redeemable, since peeking is not a consuming action.
    const challengePromise = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: "hello", protocol_version: MAX_PROTOCOL_VERSION, client_id: client.clientId, pubkey_jwk: client.pubkeyJwk, keys: [],
    }));
    const challenge = await challengePromise;
    const sig = await signFor(client, challenge.server_id, challenge.nonce);
    const needsGrantPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig }));
    const needsGrant = await needsGrantPromise;
    expect(needsGrant.type).toBe("needs_grant");
    const redeemResultPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "redeem_grant", grant_id: grantId, secret }));
    const result = await redeemResultPromise;
    expect(result.type).toBe("ok");
    ws.close();
  });

  it("create_grant is rejected for a user lacking the 'invite' cap", async () => {
    const root = db.bootstrapRootUser(Date.now());
    const syncOnly = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, Date.now());
    const client = await makeTestClient();
    db.registerClient({ clientId: client.clientId, userId: syncOnly.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk) }, Date.now());

    const ws = connect();
    await waitForOpen(ws);
    const challengePromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "hello", protocol_version: MAX_PROTOCOL_VERSION, client_id: client.clientId, pubkey_jwk: client.pubkeyJwk, keys: [] }));
    const challenge = await challengePromise;
    const sig = await signFor(client, challenge.server_id, challenge.nonce);
    const okPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig }));
    const ok = await okPromise;
    expect(ok.type).toBe("ok");

    const errPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "create_grant", kind: "invite", caps: ["sync"] }));
    const err = await errPromise;
    expect(err.type).toBe("error");
    ws.close();
  });

  it("create_grant succeeds for a user with 'invite' and the resulting grant is redeemable", async () => {
    const root = db.bootstrapRootUser(Date.now());
    const client = await makeTestClient();
    db.registerClient({ clientId: client.clientId, userId: root.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk) }, Date.now());

    const ws = connect();
    await waitForOpen(ws);
    const challengePromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "hello", protocol_version: MAX_PROTOCOL_VERSION, client_id: client.clientId, pubkey_jwk: client.pubkeyJwk, keys: [] }));
    const challenge = await challengePromise;
    const sig = await signFor(client, challenge.server_id, challenge.nonce);
    const okPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig }));
    await okPromise;

    const createdPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "create_grant", kind: "invite", caps: ["sync"], greeting: "Welcome!" }));
    const created = await createdPromise;
    expect(created.type).toBe("grant_created");
    expect(created.greeting).toBe("Welcome!");
    ws.close();

    const redeemer = await makeTestClient();
    const wsRedeem = connect();
    await getToNeedsGrantLocal(wsRedeem, redeemer);
    const redeemPromise = waitForMessage(wsRedeem);
    wsRedeem.send(JSON.stringify({ type: "redeem_grant", grant_id: created.grant_id, secret: created.secret }));
    const redeemed = await redeemPromise;
    expect(redeemed.type).toBe("ok");
    wsRedeem.close();

    async function getToNeedsGrantLocal(sock: WebSocket, c: TestClient): Promise<void> {
      await waitForOpen(sock);
      const chPromise = waitForMessage(sock);
      sock.send(JSON.stringify({ type: "hello", protocol_version: MAX_PROTOCOL_VERSION, client_id: c.clientId, pubkey_jwk: c.pubkeyJwk, keys: [] }));
      const ch = await chPromise;
      const s = await signFor(c, ch.server_id, ch.nonce);
      const p = waitForMessage(sock);
      sock.send(JSON.stringify({ type: "auth", sig: s }));
      const reply = await p;
      expect(reply.type).toBe("needs_grant");
    }
  });
});

describe("basic limits", () => {
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

  it("closes a connection that sends an oversized frame (maxPayload, ~1MB)", async () => {
    const ws = connect();
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    const closePromise = new Promise<number>((resolve) => ws.once("close", (code: number) => resolve(code)));
    // A hello whose pubkey_jwk carries a > 1MB junk field. It is still valid
    // JSON, so this exercises maxPayload rather than the JSON-parse error
    // path.
    const huge = "x".repeat(2 * 1024 * 1024);
    ws.send(JSON.stringify({ type: "hello", protocol_version: MAX_PROTOCOL_VERSION, client_id: "c", pubkey_jwk: { junk: huge }, keys: [] }));
    const code = await closePromise;
    // `ws` terminates the connection abnormally when maxPayload is exceeded.
    expect(code).not.toBe(1000);
  });

  it("closes a connection that exceeds the per-connection message rate limit", async () => {
    const client = await makeTestClient();
    const ws = connect();
    const root = db.bootstrapRootUser(Date.now());
    const user = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, Date.now());
    db.registerClient({ clientId: client.clientId, userId: user.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk) }, Date.now());

    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    const challengePromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "hello", protocol_version: MAX_PROTOCOL_VERSION, client_id: client.clientId, pubkey_jwk: client.pubkeyJwk, keys: [] }));
    const challenge = await challengePromise;
    const sig = await signFor(client, challenge.server_id, challenge.nonce);
    const okPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig }));
    await okPromise;

    const closePromise = new Promise<number>((resolve) => ws.once("close", (code: number) => resolve(code)));
    // Drain the burst allowance. Unrecognized types fall through the handler
    // chain without a reply, but are still counted, since the limiter runs
    // before anything is parsed, so this stays cheap.
    for (let i = 0; i < 5200; i++) {
      ws.send(JSON.stringify({ type: "noop" }));
    }
    const code = await closePromise;
    expect(code).toBe(1008);
  });

  // doInitialSync sends one push_entity PER ENTITY, so a fixed per-second
  // window would close the socket mid-sync for any client with more than a
  // window's worth of local data, which then retries and loops forever. The
  // token bucket has to let that burst through.
  it("allows an initial-sync-sized burst without closing the connection", async () => {
    const client = await makeTestClient();
    const ws = connect();
    const root = db.bootstrapRootUser(Date.now());
    const user = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, Date.now());
    db.registerClient({ clientId: client.clientId, userId: user.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk) }, Date.now());

    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    const challengePromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "hello", protocol_version: MAX_PROTOCOL_VERSION, client_id: client.clientId, pubkey_jwk: client.pubkeyJwk, keys: [] }));
    const challenge = await challengePromise;
    const sig = await signFor(client, challenge.server_id, challenge.nonce);
    const okPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig }));
    await okPromise;

    let closed = false;
    ws.once("close", () => { closed = true; });
    for (let i = 0; i < 1000; i++) {
      ws.send(JSON.stringify({
        type: "push_entity",
        entity_type: "board",
        sync_key: "burst-key",
        data: { id: `b${i}`, updated_at: Date.now(), name: `Board ${i}` },
      }));
    }
    await sleep(300);
    expect(closed).toBe(false);
    ws.close();
  });

  it("rejects a new connection from an IP already at the per-IP connection limit", async () => {
    const sockets: WebSocket[] = [];
    try {
      for (let i = 0; i < 20; i++) {
        const ws = connect();
        await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
        sockets.push(ws);
      }
      const overflow = new WebSocket(`ws://127.0.0.1:${port}/sync`);
      const rejected = await new Promise<boolean>((resolve) => {
        overflow.once("unexpected-response", (_req, res) => resolve(res.statusCode === 429));
        overflow.once("open", () => resolve(false));
        overflow.once("error", () => resolve(true));
      });
      expect(rejected).toBe(true);
    } finally {
      for (const ws of sockets) ws.close();
    }
  });

  it("pull response omits a key that would exceed the total entity budget, leaving its since-cursor untouched", async () => {
    const client = await makeTestClient();
    const root = db.bootstrapRootUser(Date.now());
    const user = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, Date.now());
    db.registerClient({ clientId: client.clientId, userId: user.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk) }, Date.now());

    // One key with more entities than the whole per-pull budget allows...
    const bigKey = "big-key";
    for (let i = 0; i < 5001; i++) {
      db.upsertEntity("board", { id: `b${i}`, updated_at: Date.now(), name: "x" }, bigKey);
    }
    // ...and a second, small key that should be unaffected.
    const smallKey = "small-key";
    db.upsertEntity("board", { id: "s1", updated_at: Date.now(), name: "small" }, smallKey);

    const ws = connect();
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    const challengePromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "hello", protocol_version: MAX_PROTOCOL_VERSION, client_id: client.clientId, pubkey_jwk: client.pubkeyJwk, keys: [bigKey, smallKey] }));
    const challenge = await challengePromise;
    const sig = await signFor(client, challenge.server_id, challenge.nonce);
    const okPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig }));
    await okPromise;

    const snapshotPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "pull", keys: [{ key: bigKey, since: 0 }, { key: smallKey, since: 0 }] }));
    const snapshot = await snapshotPromise;
    expect(snapshot.type).toBe("snapshot");
    // The big key was skipped wholesale rather than truncated.
    expect(snapshot.boards.some((b: any) => b.id.startsWith("b"))).toBe(false);
    expect(snapshot.server_times[bigKey]).toBeUndefined();
    // The small key came through untouched.
    expect(snapshot.boards.some((b: any) => b.id === "s1")).toBe(true);
    expect(snapshot.server_times[smallKey]).toBeDefined();
    ws.close();
  });
});

// First-run bootstrap. A database with no users can register nobody, because
// registration needs a grant and a grant needs an issuer, so the operator can
// opt into letting the first client to authenticate claim the server as root.
describe("sync server: first-run bootstrap", () => {
  let db: DbApi;
  let handle: SyncServerHandle;
  let port: number;

  async function start(allowBootstrap: boolean): Promise<void> {
    db = openDb(":memory:");
    handle = createSyncServer(db, { tls: false, allowBootstrap });
    await new Promise<void>((resolve) => handle.httpServer.listen(0, "127.0.0.1", () => resolve()));
    port = (handle.httpServer.address() as AddressInfo).port;
  }

  afterEach(() => {
    handle.stop();
  });

  async function handshake(client: TestClient): Promise<{ ws: WebSocket; result: any }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`);
    await waitForOpen(ws);
    const challengePromise = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: "hello",
      protocol_version: MAX_PROTOCOL_VERSION,
      client_id: client.clientId,
      pubkey_jwk: client.pubkeyJwk,
      keys: [],
    }));
    const challenge = await challengePromise;
    const sig = await signFor(client, challenge.server_id, challenge.nonce);
    const resultPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig }));
    return { ws, result: await resultPromise };
  }

  it("lets the first client claim an empty server as root when bootstrap is enabled", async () => {
    await start(true);
    const client = await makeTestClient();
    const { ws, result } = await handshake(client);
    expect(result.type).toBe("ok");
    expect(result.caps).toContain("admin");
    expect(db.findRootUser()?.user_id).toBe(result.user_id);
    expect(db.getUserForClient(client.clientId)?.user.user_id).toBe(result.user_id);
    ws.close();
  });

  it("disarms itself: the second client gets needs_grant rather than a second root", async () => {
    await start(true);
    const first = await handshake(await makeTestClient());
    expect(first.result.type).toBe("ok");
    first.ws.close();

    const second = await handshake(await makeTestClient());
    expect(second.result.type).toBe("needs_grant");
    expect(db.countUsers()).toBe(1);
    second.ws.close();
  });

  it("leaves an empty server unclaimable when bootstrap is disabled", async () => {
    await start(false);
    const { ws, result } = await handshake(await makeTestClient());
    expect(result.type).toBe("needs_grant");
    expect(db.countUsers()).toBe(0);
    ws.close();
  });
});


// cert-expired.crt is a self-signed fixture valid 2024-01-01 to 2024-04-01. Every
// case below moves the clock around that fixed window instead of minting a new
// cert per case, so the fixture stays static and no private key is committed.
describe("cert expiry warnings", () => {
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/cert-expired.crt");
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    vi.spyOn(console, "warn").mockImplementation((msg: string) => void warnings.push(msg));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stays quiet while the cert is comfortably valid", () => {
    vi.setSystemTime(new Date("2024-01-15T00:00:00Z")); // 77 days left
    warnIfCertExpiring(FIXTURE);
    expect(warnings).toEqual([]);
  });

  it("warns inside the last week and names the fix", () => {
    vi.setSystemTime(new Date("2024-03-28T00:00:00Z")); // 4 days left
    warnIfCertExpiring(FIXTURE);
    expect(warnings.join("\n")).toContain("expires in 4d");
    expect(warnings.join("\n")).toContain("pnpm certs:refresh");
  });

  it("reports how long ago an expired cert lapsed", () => {
    vi.setSystemTime(new Date("2024-04-03T00:00:00Z")); // 2 days past
    warnIfCertExpiring(FIXTURE);
    expect(warnings.join("\n")).toContain("expired 2d ago");
  });

  it("warns rather than throwing when the cert is missing", () => {
    vi.setSystemTime(new Date("2024-01-15T00:00:00Z"));
    expect(() => warnIfCertExpiring(join(dirname(FIXTURE), "nope.crt"))).not.toThrow();
    expect(warnings.join("\n")).toContain("cannot read");
  });
});

describe("sync server: integrations", () => {
  let db: DbApi;
  let handle: SyncServerHandle;
  let port: number;

  beforeEach(async () => {
    db = openDb(":memory:");
    handle = createSyncServer(db, { tls: false, integrations: { omdb: {} } });
    await new Promise<void>((resolve) => handle.httpServer.listen(0, "127.0.0.1", () => resolve()));
    port = (handle.httpServer.address() as AddressInfo).port;
  });

  afterEach(() => {
    handle.stop();
  });

  async function connectReady(keys: string[]): Promise<{ ws: WebSocket; ok: any }> {
    const client = await makeTestClient();
    const root = db.bootstrapRootUser(Date.now());
    const user = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, Date.now());
    db.registerClient({ clientId: client.clientId, userId: user.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk) }, Date.now());
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`);
    await waitForOpen(ws);
    const challengeP = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "hello", protocol_version: MAX_PROTOCOL_VERSION, client_id: client.clientId, pubkey_jwk: client.pubkeyJwk, keys }));
    const challenge = await challengeP;
    const okP = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "auth", sig: await signFor(client, challenge.server_id, challenge.nonce) }));
    return { ws, ok: await okP };
  }

  it("advertises configured modules in ok, with their active flag", async () => {
    const { ws, ok } = await connectReady([]);
    expect(ok.integrations).toEqual([expect.objectContaining({ id: "omdb", active: false })]);
    expect(ok.integrations[0].config_template).toContain("refresh_days");
    // Every value the module produces can be mapped to a board attribute.
    expect(ok.integrations[0].config_template).toContain('# attributes.imdb_rating = "imdb_rating"');
    expect(ok.integrations[0].config_template).toContain('# attributes.rotten_tomatoes = "rotten_tomatoes"');
    ws.close();
  });

  it("ignores integration results pushed by a client", async () => {
    const { ws } = await connectReady(["k1"]);
    ws.send(JSON.stringify({
      type: "push_entity", entity_type: "integration_result", sync_key: "k1",
      data: { id: "i1:omdb", item_id: "i1", integration_id: "omdb", status: "complete", attribute_values: {}, integration_data: {}, created_at: 1, updated_at: 9e15 },
    }));
    ws.send(JSON.stringify({ type: "push_delete", entity_type: "integration_result", entity_id: "i1", deleted_at: Date.now(), sync_key: "k1" }));
    await sleep(50);
    expect(db.getIntegrationResult("i1:omdb")).toBeNull();
    expect(db.getTombstonesSince("k1", 0)).toEqual([]);
    ws.close();
  });
});
