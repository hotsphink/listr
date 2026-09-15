import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extractFromImage, type ModelConfig } from "./gemini.js";

// A stub provider standing in for Gemini. The model name in the path picks the
// behavior, so a test names a model to choose how the call answers.
//
//   fail-*     500, echoing the credential back the way a real provider does
//   slow-*     200, but late enough that anything else in its tier beats it
//   invalid-*  200 whose body is not JSON at all
//   badtext-*  200 whose envelope parses but whose candidate text does not
//   fenced-*   200 whose candidate text is wrapped in a markdown fence
//   empty-*    200 carrying no candidates
//   anything   200 with a usable answer

let server: Server;
let origin: string;
let started: string[] = [];
let aborted: string[] = [];
let paths: string[] = [];

const SLOW_MS = 300;

function envelope(text: string): string {
  return JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
}

function answerFor(model: string): string {
  return envelope(JSON.stringify({ items: [{ title: `from ${model}` }] }));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const model = decodeURIComponent(url.pathname.slice(1));
    started.push(model);
    paths.push(`${url.pathname}${url.search}`);
    req.on("aborted", () => aborted.push(model));

    const credential = url.searchParams.get("key") ?? url.searchParams.get("token") ?? "";
    const send = (status: number, body: string, delayMs = 0) => {
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      }, delayMs);
    };

    if (model.startsWith("fail")) send(500, JSON.stringify({ error: `rejected credential ${credential}` }));
    else if (model.startsWith("slow")) send(200, answerFor(model), SLOW_MS);
    else if (model.startsWith("invalid")) send(200, "this is not json");
    else if (model.startsWith("badtext")) send(200, envelope("still not json"));
    else if (model.startsWith("fenced")) send(200, envelope(`\`\`\`json\n${JSON.stringify({ items: [{ title: `from ${model}` }] })}\n\`\`\``));
    else if (model.startsWith("empty")) send(200, JSON.stringify({ candidates: [] }));
    else send(200, answerFor(model));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  started = [];
  aborted = [];
  paths = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SECRET = "SECRET_CREDENTIAL";

function model(name: string, fields: Record<string, string> = {}, url?: string): ModelConfig {
  return {
    model: name,
    url: url ?? `${origin}/{model}?key={api_key}`,
    fields: { model: name, api_key: SECRET, ...fields },
  };
}

function extract(tiers: ModelConfig[][]) {
  return extractFromImage("AAAA", "image/png", { type: "list" }, tiers);
}

// Everything console.log and console.error were handed this test.
function logged(): string {
  const calls = [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ];
  return calls.map((args) => args.join(" ")).join("\n");
}

describe("url expansion", () => {
  it("fills every placeholder from the model's merged fields", async () => {
    const entry = model("ok", { version: "v1beta" }, `${origin}/{version}/{model}?key={api_key}`);
    await extract([[entry]]);
    expect(paths[0]).toBe(`/v1beta/ok?key=${SECRET}`);
  });

  it("names the model and the key when a placeholder has no field", async () => {
    const entry = model("ok", {}, `${origin}/{model}?v={nope}`);
    await expect(extract([[entry]])).rejects.toThrow(/model 'ok' url references unknown key 'nope'/);
    expect(started).toEqual([]);
  });

  it("leaves a model id containing a slash unencoded, so it can span path segments", async () => {
    await extract([[model("vendor/ok")]]);
    expect(paths[0]).toBe(`/vendor/ok?key=${SECRET}`);
  });
});

describe("redaction", () => {
  it("keeps the credential out of the error handed back to the caller", async () => {
    const error = await extract([[model("fail")]]).catch((err: Error) => err.message);
    expect(error).not.toContain(SECRET);
    expect(error).toContain("<redacted>");
  });

  it("keeps the credential out of the logs", async () => {
    await extract([[model("fail")]]).catch(() => {});
    expect(logged()).not.toContain(SECRET);
    expect(logged()).toContain("key=<redacted>");
  });

  it("redacts every field named like a credential, not just api_key", async () => {
    const entry = model("fail", { session_token: "TOKEN_VALUE", client_secret: "SECRET_VALUE" });
    const error = await extract([[entry]]).catch((err: Error) => err.message);
    for (const leaked of [SECRET, "TOKEN_VALUE", "SECRET_VALUE"]) {
      expect(error).not.toContain(leaked);
    }
  });

  it("leaves fields that are not credentials readable", async () => {
    const entry = model("fail", { version: "v1beta" }, `${origin}/{version}/{model}?key={api_key}`);
    await extract([[entry]]).catch(() => {});
    expect(logged()).toContain("/v1beta/fail");
  });

  // An empty needle matches at every position, which would splice the
  // replacement between every character of the message.
  it("leaves the message intact when a credential is empty", async () => {
    const error = await extract([[model("fail", { api_key: "" })]]).catch((err: Error) => err.message);
    expect(error).toContain("fail API 500");
    expect(error).not.toContain("<redacted>");
  });
});

describe("tiers", () => {
  it("returns the first tier's answer and never reaches the next tier", async () => {
    const result = await extract([[model("ok-first")], [model("ok-second")]]);
    expect(result).toEqual({ items: [{ title: "from ok-first" }] });
    expect(started).toEqual(["ok-first"]);
  });

  it("falls through to the next tier once every model in one fails", async () => {
    const result = await extract([[model("fail-a"), model("fail-b")], [model("ok")]]);
    expect(result).toEqual({ items: [{ title: "from ok" }] });
    expect(started).toEqual(["fail-a", "fail-b", "ok"]);
  });

  it("runs a tier's models at once and keeps the fastest answer", async () => {
    const started_at = Date.now();
    const result = await extract([[model("slow"), model("ok-fast")]]);
    expect(result).toEqual({ items: [{ title: "from ok-fast" }] });
    expect(Date.now() - started_at).toBeLessThan(SLOW_MS);
  });

  it("aborts the models that lost the race", async () => {
    await extract([[model("slow"), model("ok-fast")]]);
    await vi.waitFor(() => expect(aborted).toContain("slow"));
  });

  it("treats a malformed answer as a failure and moves on", async () => {
    const result = await extract([[model("invalid")], [model("badtext")], [model("empty")], [model("ok")]]);
    expect(result).toEqual({ items: [{ title: "from ok" }] });
    expect(started).toEqual(["invalid", "badtext", "empty", "ok"]);
  });

  it("names every model that failed when none of them answer", async () => {
    const error = await extract([
      [model("fail-a")], [model("invalid-b")], [model("badtext-c")], [model("empty-d")],
    ]).catch((err: Error) => err.message);
    expect(error).toContain("fail-a: fail-a API 500");
    expect(error).toContain("invalid-b: ");
    expect(error).toContain("badtext-c returned invalid JSON");
    expect(error).toContain("Empty response from empty-d");
  });

  it("unwraps a candidate text wrapped in a markdown fence", async () => {
    const result = await extract([[model("fenced")]]);
    expect(result).toEqual({ items: [{ title: "from fenced" }] });
  });

  it("rejects when no model is configured", async () => {
    await expect(extract([])).rejects.toThrow(/No import model configured/);
    await expect(extract([[]])).rejects.toThrow(/No import model configured/);
  });
});
