import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { webcrypto } from "node:crypto";
import { get as httpGet } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ENTITY_SCHEMA_VERSION, type ConsoleClientDetail, type ConsoleClients, type ConsoleIntegrations, type ConsoleRunDetail, type ConsoleRunSummary, type ConsoleTrust } from "@listr/shared";
import { openDb } from "../db.js";
import { createSyncServer, type SyncServerHandle } from "../index.js";
import { MAX_PROTOCOL_VERSION } from "../protocol.js";
import { buildAuthPayload, jwkThumbprint } from "../authCrypto.js";
import type { IntegrationModule } from "../integrations/types.js";
import { ConsoleAuth, hashPassword, verifyPassword } from "./auth.js";

type DbApi = ReturnType<typeof openDb>;

const PASSWORD = "correct horse battery";
let PASSWORD_HASH: string;

beforeAll(() => {
  PASSWORD_HASH = hashPassword(PASSWORD);
});

describe("console password hashing", () => {
  it("verifies the right password and rejects others", () => {
    expect(verifyPassword(PASSWORD, PASSWORD_HASH)).toBe(true);
    expect(verifyPassword("wrong", PASSWORD_HASH)).toBe(false);
    expect(verifyPassword(PASSWORD, "garbage")).toBe(false);
    expect(verifyPassword(PASSWORD, "scrypt$N=16384$x")).toBe(false);
  });

  it("salts each hash", () => {
    expect(hashPassword(PASSWORD)).not.toBe(PASSWORD_HASH);
  });

  it("locks out after five failures and expires idle sessions", () => {
    let now = 1_000_000;
    const auth = new ConsoleAuth(PASSWORD_HASH, { idleHours: 1, now: () => now });
    for (let i = 0; i < 5; i++) expect(auth.login("nope")).toEqual({ ok: false, retryAfterMs: null });
    const locked = auth.login(PASSWORD);
    expect(locked.ok).toBe(false);
    now += 31_000;
    const ok = auth.login(PASSWORD);
    expect(ok.ok).toBe(true);
    const sid = (ok as { sessionId: string }).sessionId;
    expect(auth.check(sid)).toBe(true);
    now += 61 * 60 * 1000;
    expect(auth.check(sid)).toBe(false);
  });
});

// -- Server harness -----------------------------------------------------------

interface TestClient {
  clientId: string;
  pubkeyJwk: Record<string, unknown>;
  privateKey: CryptoKey;
}

async function makeTestClient(): Promise<TestClient> {
  const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pubkeyJwk = (await webcrypto.subtle.exportKey("jwk", kp.publicKey)) as unknown as Record<string, unknown>;
  return { clientId: await jwkThumbprint(pubkeyJwk), pubkeyJwk, privateKey: kp.privateKey };
}

function nextMessage(ws: WebSocket, type: string): Promise<any> {
  return new Promise((resolve) => {
    const onMessage = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== type) return;
      ws.off("message", onMessage);
      resolve(msg);
    };
    ws.on("message", onMessage);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await sleep(20);
  }
  throw new Error("condition never held");
}

const probeModule: IntegrationModule = {
  id: "probe",
  name: "Probe",
  attributes: [{ key: "year", type: "integer", label: "Year" }],
  configTemplate: "",
  isActive: () => true,
  inputsOf: (item) => (item.title ? { title: item.title } : null),
  async run(ctx) {
    const res = await ctx.fetch(`https://example.test/?apikey=${ctx.serverConfig.api_key}&t=${ctx.inputs.title}`);
    const body = (await res.json()) as { year: number };
    return { status: "complete", attribute_values: { year: body.year, bogus: 1 } };
  },
};

describe("console HTTP API", () => {
  let db: DbApi;
  let handle: SyncServerHandle;
  let base: string;
  let distDir: string;

  function start(consoleOn = true): Promise<void> {
    handle = createSyncServer(db, {
      tls: false,
      console: consoleOn ? { password_hash: PASSWORD_HASH } : {},
      consoleDistDir: distDir,
      integrationModules: new Map([["probe", probeModule]]),
      integrations: { probe: { api_key: "SECRET123" } },
      integrationRunner: {
        tickMs: 0,
        fetch: async () => new Response(JSON.stringify({ year: 1999, echo: "SECRET123" }), {
          headers: { "content-type": "application/json", "x-echo": "key=SECRET123" },
        }),
      },
    });
    return new Promise((resolve) => handle.httpServer.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(handle.httpServer.address() as AddressInfo).port}`;
      resolve();
    }));
  }

  beforeEach(() => {
    db = openDb(":memory:");
    distDir = mkdtempSync(join(tmpdir(), "listr-console-"));
    mkdirSync(join(distDir, "assets"));
    writeFileSync(join(distDir, "index.html"), "<!doctype html><title>Console</title>");
    writeFileSync(join(distDir, "assets", "app.js"), "console.log(1)");
  });

  afterEach(() => {
    handle?.stop();
    rmSync(distDir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, ...headers },
      body: JSON.stringify(body),
    });

  async function login(): Promise<string> {
    const res = await post("/console/api/login", { password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    return cookie.split(";")[0];
  }

  const getJson = async <T>(cookie: string, path: string): Promise<T> => {
    const res = await fetch(`${base}/console/api${path}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  };

  async function connectClient(client: TestClient, keys: string[] = []): Promise<{ ws: WebSocket; first: any }> {
    const ws = new WebSocket(`${base.replace("http", "ws")}/sync`, { headers: { "user-agent": "vitest-client" } });
    await new Promise((resolve) => ws.once("open", resolve));
    const challenge = nextMessage(ws, "challenge");
    ws.send(JSON.stringify({ type: "hello", protocol_version: MAX_PROTOCOL_VERSION, client_id: client.clientId, pubkey_jwk: client.pubkeyJwk, keys }));
    const { nonce, server_id } = await challenge;
    const sig = Buffer.from(await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, client.privateKey, buildAuthPayload(server_id, nonce, client.clientId),
    )).toString("base64url");
    const reply = new Promise<any>((resolve) => ws.once("message", (raw: Buffer) => resolve(JSON.parse(raw.toString()))));
    ws.send(JSON.stringify({ type: "auth", sig }));
    return { ws, first: await reply };
  }

  it("answers 404 everywhere under /console when no password is configured", async () => {
    await start(false);
    expect((await fetch(`${base}/console/`)).status).toBe(404);
    expect((await fetch(`${base}/console/api/session`)).status).toBe(404);
    expect(await (await fetch(`${base}/`)).text()).toContain("Listr sync server running");
  });

  it("requires a session for the API, and refuses cross-origin or non-JSON posts", async () => {
    await start();
    expect((await fetch(`${base}/console/api/overview`)).status).toBe(401);
    expect(await (await fetch(`${base}/console/api/session`)).json()).toEqual({ authenticated: false });
    expect((await post("/console/api/login", { password: PASSWORD }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/console/api/login", { password: PASSWORD }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post("/console/api/login", { password: "wrong" })).status).toBe(401);

    const cookie = await login();
    expect(cookie).not.toContain("Secure");
    expect(await getJson(cookie, "/session")).toEqual({ authenticated: true });
    const overview = await getJson<{ variant: string }>(cookie, "/overview");
    expect(typeof overview.variant).toBe("string");

    await post("/console/api/logout", {}, { cookie });
    expect((await fetch(`${base}/console/api/overview`, { headers: { cookie } })).status).toBe(401);
  });

  it("locks login out after repeated failures", async () => {
    await start();
    for (let i = 0; i < 5; i++) expect((await post("/console/api/login", { password: "x" })).status).toBe(401);
    const locked = await post("/console/api/login", { password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();
  });

  it("serves the built frontend with a client-route fallback and no traversal", async () => {
    await start();
    expect((await fetch(`${base}/console`, { redirect: "manual" })).status).toBe(301);
    const index = await fetch(`${base}/console/`);
    expect(await index.text()).toContain("<title>Console</title>");
    expect(index.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await (await fetch(`${base}/console/clients/abc`)).text()).toContain("<title>Console</title>");
    const asset = await fetch(`${base}/console/assets/app.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${base}/console/assets/missing.js`)).status).toBe(404);
    // Encoded dot segments collapse inside the dist directory, never above it.
    expect(await (await fetch(`${base}/console/..%2F..%2F..%2Fetc%2Fpasswd`)).text()).toContain("<title>Console</title>");
  });

  it("tracks live clients and their traffic", async () => {
    await start();
    const cookie = await login();
    const root = db.bootstrapRootUser(Date.now());
    const client = await makeTestClient();
    db.registerClient({ clientId: client.clientId, userId: root.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk), label: "laptop" }, Date.now());
    const stranger = await makeTestClient();

    const { ws, first } = await connectClient(client);
    expect(first.type).toBe("ok");
    const { ws: ws2, first: needs } = await connectClient(stranger);
    expect(needs.type).toBe("needs_grant");
    ws.send(JSON.stringify({ type: "pull", keys: [{ key: root.home_key, since: 0 }] }));
    await nextMessage(ws, "snapshot");

    const list = await getJson<ConsoleClients>(cookie, "/clients");
    expect(list.counts).toMatchObject({ registered: 1, connected: 1, unauthenticated: 1 });
    const row = list.rows.find((r) => r.client_id === client.clientId)!;
    expect(row).toMatchObject({ label: "laptop", sockets: 1, conn_state: "authenticated", user_agent: "vitest-client" });
    const unregistered = list.rows.find((r) => !r.registered)!;
    expect(unregistered).toMatchObject({ client_id: stranger.clientId, conn_state: "needs_grant" });

    const detail = await getJson<ConsoleClientDetail>(cookie, `/clients/${client.clientId}`);
    expect(detail.client?.label).toBe("laptop");
    expect(detail.traffic.in).toMatchObject({ hello: 1, auth: 1, pull: 1 });
    expect(detail.traffic.out).toMatchObject({ challenge: 1, ok: 1, snapshot: 1 });
    expect(detail.pulls).toHaveLength(1);
    expect(detail.keys[0]).toMatchObject({ tag: root.home_key.slice(0, 6), name: "(home)", since: 0 });
    expect(detail.log[0].type).toBe("snapshot");
    expect(JSON.stringify(detail)).not.toContain(root.home_key);

    ws.close();
    ws2.close();
    const after = await until(() => getJson<ConsoleClients>(cookie, "/clients"), (c) => c.counts.connected === 0);
    expect(after.counts.unauthenticated).toBe(0);
    const closed = await getJson<ConsoleClientDetail>(cookie, `/clients/${client.clientId}`);
    expect(closed.connections[0].state).toBe("closed");
    expect(closed.connections[0].close_code).toBe(1005);
  });

  it("builds the trust graph with grant redemptions and key provenance", async () => {
    await start();
    const cookie = await login();
    const now = Date.now();
    const root = db.bootstrapRootUser(now);
    const invite = db.createGrant({ kind: "invite", issuerUserId: root.user_id, caps: ["sync"] }, now);
    const newcomer = await makeTestClient();
    const redeemed = db.redeemGrant(invite.grantId, invite.secret, { clientId: newcomer.clientId, pubkeyJwk: JSON.stringify(newcomer.pubkeyJwk) }, now);
    expect(redeemed.ok).toBe(true);
    const bob = (redeemed as { ok: true; result: { user: { user_id: string } } }).result.user;
    db.associateUserKey(root.user_id, "shared-key-1234", "Groceries", "cli");
    const share = db.createGrant({ kind: "share", issuerUserId: root.user_id, payload: "shared-key-1234", payloadName: "Groceries" }, now);
    db.redeemGrant(share.grantId, share.secret, { existingUserId: bob.user_id }, now);
    db.createGrant({ kind: "device", issuerUserId: root.user_id }, now);

    const trust = await getJson<ConsoleTrust>(cookie, "/trust");
    expect(trust.root_user_id).toBe(root.user_id);
    expect(trust.users.find((u) => u.user_id === bob.user_id)).toMatchObject({ authorized_by: root.user_id, device_count: 1 });
    const inviteGrant = trust.grants.find((g) => g.id === invite.grantId)!;
    expect(inviteGrant).toMatchObject({ status: "used" });
    expect(inviteGrant.redemptions).toEqual([{ at: now, user_id: bob.user_id, client_id: newcomer.clientId }]);
    expect(trust.grants.filter((g) => g.status === "outstanding").map((g) => g.kind)).toEqual(["device"]);
    const shared = trust.keys.find((k) => k.tag === "shared")!;
    expect(shared.name).toBe("Groceries");
    expect(shared.holders).toEqual(expect.arrayContaining([
      { user_id: root.user_id, source: "cli", name: "Groceries" },
      { user_id: bob.user_id, source: `grant:${share.grantId}`, name: "Groceries" },
    ]));
    expect(JSON.stringify(trust)).not.toContain("shared-key-1234");

    const detail = await getJson<{ redeemed: { id: string }[]; events: { kind: string }[] }>(cookie, `/trust/users/${bob.user_id}`);
    expect(detail.redeemed.map((g) => g.id).sort()).toEqual([invite.grantId, share.grantId].sort());
    expect(detail.events.map((e) => e.kind)).toContain("grant_effect_invite");
  });

  it("captures integration runs with credentials redacted", async () => {
    await start();
    const cookie = await login();
    const t = Date.now();
    db.upsertEntity("board", {
      id: "b1", name: "B", color: "", position: 0, format: { version: 2, text: "[title]" },
      schema: [{ key: "year", label: "Year", type: "integer", required: false, position: 0 }],
      integrations: [{ integration_id: "probe", enabled: true }], created_at: 1, updated_at: t,
      schema_version: ENTITY_SCHEMA_VERSION,
    } as any, "k1");
    db.upsertEntity("list", { id: "l1", board_id: "b1", name: "L", updated_at: t }, "k1");
    db.upsertEntity("item", {
      id: "i1", list_id: "l1", title: "matrix", after_id: null, created_at: 1, updated_at: t, attributes: {},
      schema_version: ENTITY_SCHEMA_VERSION,
    }, "k1");
    handle.integrationRunner.onItemChanged("i1");
    await handle.integrationRunner.idle();

    const runs = await getJson<ConsoleRunSummary[]>(cookie, "/integrations/runs?module=probe");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ module: "probe", item_id: "i1", key_tag: "k1", outcome: "complete", request_count: 1 });

    const run = await getJson<ConsoleRunDetail>(cookie, `/integrations/runs/${runs[0].id}`);
    expect(JSON.stringify(run)).not.toContain("SECRET123");
    expect(run.requests[0].url).toBe("https://example.test/?apikey=<redacted>&t=matrix");
    expect(run.requests[0].status).toBe(200);
    expect(run.requests[0].response_headers!["x-echo"]).toBe("key=<redacted>");
    expect(JSON.parse(run.requests[0].body!)).toEqual({ year: 1999, echo: "<redacted>" });
    expect(run.output).toMatchObject({ attribute_values: { year: 1999 }, dropped: ["bogus"] });
    expect(run.result_after).toMatchObject({ status: "complete", attribute_values: { year: 1999 } });
    expect(run.broadcast).toBe(true);

    const stats = await getJson<ConsoleIntegrations>(cookie, "/integrations");
    const probe = stats.modules.find((m) => m.id === "probe")!;
    expect(probe).toMatchObject({ calls_today: 1, running: 0, queued_edit: 0, top_keys: [{ key_tag: "k1", count: 1 }] });
    expect(probe.results.by_status).toEqual({ complete: 1 });
    expect(probe.calls_per_minute.values.at(-1)).toBe(1);
  });

  it("streams live events over SSE", async () => {
    await start();
    const cookie = await login();
    const received: string[] = [];
    const req = httpGet(`${base}/console/api/stream`, { headers: { cookie } }, (res) => {
      expect(res.headers["content-type"]).toBe("text/event-stream");
      res.on("data", (chunk: Buffer) => received.push(chunk.toString()));
    });
    await until(async () => received.join(""), (s) => s.includes("retry:"));

    const root = db.bootstrapRootUser(Date.now());
    db.createGrant({ kind: "device", issuerUserId: root.user_id }, Date.now());
    const client = await makeTestClient();
    db.registerClient({ clientId: client.clientId, userId: root.user_id, pubkeyJwk: JSON.stringify(client.pubkeyJwk) }, Date.now());
    const { ws } = await connectClient(client);
    const text = await until(async () => received.join(""), (s) => s.includes("event: client.connect") && s.includes("event: trust"));
    expect(text).toContain(client.clientId);
    ws.close();
    await until(async () => received.join(""), (s) => s.includes("event: client.disconnect"));
    req.destroy();
  });
});
