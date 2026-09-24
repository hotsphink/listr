import { describe, it, expect, beforeEach } from "vitest";
import { ENTITY_SCHEMA_VERSION, type Board, type Item } from "@listr/shared";
import { openDb } from "./db.js";
import { IntegrationRunner } from "./integration-runner.js";
import type { IntegrationModule, IntegrationRunContext, IntegrationRunResult } from "./integrations/types.js";
import type { IntegrationServerConfig } from "./config.js";

type DbApi = ReturnType<typeof openDb>;
const KEY = "k1";

interface Call {
  ctx: IntegrationRunContext;
  resolve: (r: IntegrationRunResult) => void;
  reject: (e: Error) => void;
}

/** A module whose runs finish only when the test says so. */
class FakeModule implements IntegrationModule {
  readonly name: string;
  readonly attributes: IntegrationModule["attributes"];
  readonly configTemplate = "";
  calls: Call[] = [];
  /** Answer each run immediately with this, instead of waiting. */
  auto: ((ctx: IntegrationRunContext) => IntegrationRunResult | Error) | null = null;

  constructor(
    readonly id: string,
    attrs: string[],
    private inputs: (item: Item, effective: Item) => Record<string, unknown> | null = (item) => (item.title ? { title: item.title } : null),
  ) {
    this.name = id;
    this.attributes = attrs.map((key) => ({ key, type: "integer" as const, label: key }));
  }

  isActive() { return true; }
  inputsOf(item: Item, effective: Item) { return this.inputs(item, effective); }

  run(ctx: IntegrationRunContext): Promise<IntegrationRunResult> {
    if (this.auto) {
      const out = this.auto(ctx);
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    }
    return new Promise((resolve, reject) => this.calls.push({ ctx, resolve, reject }));
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("IntegrationRunner", () => {
  let db: DbApi;
  let t: number;
  let sent: { key: string; msg: any }[];
  let fake: FakeModule;

  const board = (integrations: Board["integrations"], schema = ["year", "score"]): Board => ({
    id: "b1", name: "B", color: "", position: 0, format: { version: 2, text: "[title]" },
    schema: schema.map((key, position) => ({ key, label: key, type: "integer", required: false, position })),
    integrations, created_at: 1, updated_at: t, schema_version: ENTITY_SCHEMA_VERSION,
  });

  const putItem = (id: string, title: string, attributes: Record<string, unknown> = {}) => {
    t += 1;
    db.upsertEntity("item", {
      id, list_id: "l1", title, after_id: null, created_at: 1, updated_at: t, attributes, schema_version: ENTITY_SCHEMA_VERSION,
    }, KEY);
  };

  const makeRunner = (modules: IntegrationModule[], serverConfig: Record<string, IntegrationServerConfig> = {}) =>
    new IntegrationRunner(
      db,
      new Map(modules.map((m) => [m.id, m])),
      Object.fromEntries(modules.map((m) => [m.id, serverConfig[m.id] ?? {}])),
      (key, _s, msg) => sent.push({ key, msg }),
      { now: () => t, tickMs: 0 },
    );

  const result = (itemId = "i1", mod = "fake") => db.getIntegrationResult(`${itemId}:${mod}`);
  const results = () => sent.filter((s) => s.msg.entity_type === "integration_result" && s.msg.type === "entity").map((s) => s.msg.data);

  beforeEach(() => {
    db = openDb(":memory:");
    t = 1000;
    sent = [];
    fake = new FakeModule("fake", ["year"]);
    db.upsertEntity("board", board([{ integration_id: "fake", enabled: true }]) as any, KEY);
    db.upsertEntity("list", { id: "l1", board_id: "b1", name: "L", updated_at: t }, KEY);
    putItem("i1", "matrix");
  });

  it("stores a completion that lands in the same millisecond as the pending write", async () => {
    fake.auto = () => ({ status: "complete", attribute_values: { year: "1999" } });
    const runner = makeRunner([fake]);
    runner.onItemChanged("i1");
    await runner.idle();
    const statuses = results().map((r) => r.status);
    expect(statuses).toEqual(["unprocessed", "complete"]);
    const [pending, done] = results();
    expect(done.updated_at).toBeGreaterThan(pending.updated_at);
    expect(result()!.status).toBe("complete");
    expect(result()!.attribute_values).toEqual({ year: 1999 });
  });

  it("never writes or broadcasts the item", async () => {
    fake.auto = () => ({ status: "complete", attribute_values: { year: 1999 } });
    const runner = makeRunner([fake]);
    const before = db.getEntityById("item", "i1");
    runner.onItemChanged("i1");
    await runner.idle();
    expect(db.getEntityById("item", "i1")).toEqual(before);
    expect(sent.some((s) => s.msg.entity_type === "item")).toBe(false);
  });

  it("discards an answer for inputs that changed while it ran", async () => {
    const runner = makeRunner([fake]);
    runner.onItemChanged("i1");
    await flush();
    putItem("i1", "matrix reloaded");
    runner.onItemChanged("i1");
    fake.calls[0].resolve({ status: "complete", attribute_values: { year: 1999 } });
    await flush();
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].ctx.inputs).toEqual({ title: "matrix reloaded" });
    fake.calls[1].resolve({ status: "complete", attribute_values: { year: 2003 } });
    await runner.idle();
    expect(result()!.attribute_values).toEqual({ year: 2003 });
    expect(results().some((r) => r.attribute_values.year === 1999)).toBe(false);
  });

  it("coalesces a burst of edits into at most two runs", async () => {
    const runner = makeRunner([fake]);
    runner.onItemChanged("i1");
    await flush();
    for (const title of ["a", "b", "c"]) {
      putItem("i1", title);
      runner.onItemChanged("i1");
    }
    fake.calls[0].resolve({ status: "complete", attribute_values: {} });
    await flush();
    fake.calls[1].resolve({ status: "complete", attribute_values: {} });
    await runner.idle();
    expect(fake.calls.map((c) => c.ctx.inputs.title)).toEqual(["matrix", "c"]);
  });

  it("skips unchanged inputs and doesn't bump a result a refresh left unchanged", async () => {
    fake.auto = (ctx) => ({ status: "complete", attribute_values: { year: 1999 }, refresh_at: ctx.now + 100 });
    const runner = makeRunner([fake]);
    runner.onItemChanged("i1");
    await runner.idle();
    const first = result()!;
    runner.onItemChanged("i1");
    expect((runner as any).jobs.size).toBe(0);

    t += 200;
    sent = [];
    runner.tick();
    await runner.idle();
    expect(results()).toEqual([]);
    expect(result()!.updated_at).toBe(first.updated_at);
    expect(result()!.next_refresh_at).toBe(t + 100);
  });

  it("retries errors with backoff, then gives up", async () => {
    fake.auto = () => new Error("boom");
    const runner = makeRunner([fake]);
    runner.onItemChanged("i1");
    await runner.idle();
    expect(result()).toMatchObject({ status: "error", error: "boom", attempts: 1, next_attempt_at: t + 60_000 });

    for (let attempt = 2; attempt <= 5; attempt++) {
      t = result()!.next_attempt_at!;
      runner.tick();
      await runner.idle();
      expect(result()!.attempts).toBe(attempt);
    }
    expect(result()!.next_attempt_at).toBeNull();
  });

  it("keeps the last good values through an error", async () => {
    const runner = makeRunner([fake]);
    fake.auto = () => ({ status: "complete", attribute_values: { year: 1999 } });
    runner.onItemChanged("i1");
    await runner.idle();
    fake.auto = () => new Error("down");
    putItem("i1", "other");
    runner.onItemChanged("i1");
    await runner.idle();
    expect(result()).toMatchObject({ status: "error", attribute_values: { year: 1999 } });
  });

  it("requeues results a restart left unprocessed", async () => {
    const first = makeRunner([fake]);
    first.onItemChanged("i1");
    await flush();
    expect(result()!.status).toBe("unprocessed");

    const second = makeRunner([fake]);
    fake.auto = () => ({ status: "complete", attribute_values: { year: 1 } });
    second.start();
    await second.idle();
    expect(result()!.status).toBe("complete");
  });

  it("cascades to a module that reads another's output, without looping", async () => {
    const reader = new FakeModule("reader", ["score"], (_item, effective) =>
      effective.attributes.year !== undefined ? { year: effective.attributes.year } : null);
    db.upsertEntity("board", board([
      { integration_id: "fake", enabled: true },
      { integration_id: "reader", enabled: true },
    ]) as any, KEY);
    fake.auto = () => ({ status: "complete", attribute_values: { year: 1999 } });
    reader.auto = (ctx) => ({ status: "complete", attribute_values: { score: Number(ctx.inputs.year) + 1 } });
    const runner = makeRunner([fake, reader]);
    runner.onItemChanged("i1");
    await runner.idle();
    expect(result("i1", "reader")!.attribute_values).toEqual({ score: 2000 });
    expect(results().filter((r) => r.integration_id === "fake" && r.status === "complete")).toHaveLength(1);
  });

  it("lets a cascaded module read another's value under the board's mapped key", async () => {
    const reader = new FakeModule("reader", ["score"], (_item, effective) =>
      effective.attributes.released !== undefined ? { released: effective.attributes.released } : null);
    db.upsertEntity("board", board([
      { integration_id: "fake", enabled: true, config: 'attributes.year = "released"' },
      { integration_id: "reader", enabled: true },
    ], ["released", "score"]) as any, KEY);
    fake.auto = () => ({ status: "complete", attribute_values: { year: 1999 } });
    reader.auto = (ctx) => ({ status: "complete", attribute_values: { score: Number(ctx.inputs.released) + 1 } });
    const runner = makeRunner([fake, reader]);
    runner.onItemChanged("i1");
    await runner.idle();
    expect(result("i1", "reader")!.attribute_values).toEqual({ score: 2000 });
  });

  it("waits for the next UTC day once the daily limit is reached", async () => {
    fake.auto = () => ({ status: "complete", attribute_values: {} });
    const runner = makeRunner([fake], { fake: { daily_limit: 1 } });
    putItem("i2", "second");
    runner.onItemChanged("i1");
    runner.onItemChanged("i2");
    await runner.idle();
    expect(result("i1")!.status).toBe("complete");
    expect(result("i2")).toMatchObject({ status: "unprocessed", error: "quota", next_attempt_at: 86_400_000 });
  });

  it("caps each sync key separately", async () => {
    fake.auto = () => ({ status: "complete", attribute_values: {} });
    const runner = makeRunner([fake], { fake: { daily_limit_per_key: 1 } });
    putItem("i2", "second");
    runner.onItemChanged("i1");
    runner.onItemChanged("i2");
    await runner.idle();
    expect(result("i2")!.error).toBe("quota");
  });

  it("removes results when the board disables the integration", async () => {
    fake.auto = () => ({ status: "complete", attribute_values: { year: 1 } });
    const runner = makeRunner([fake]);
    runner.onItemChanged("i1");
    await runner.idle();
    const prev = db.getEntityById("board", "b1") as Board;
    const next = board([{ integration_id: "fake", enabled: false }]);
    runner.onBoardChanged(next, prev);
    expect(result()).toBeNull();
    expect(sent.at(-1)!.msg).toMatchObject({ type: "deleted", entity_type: "integration_result", entity_id: "i1:fake" });
    expect(db.getTombstonesSince(KEY, 0).some((x) => x.entity_type === "integration_result")).toBe(true);
  });

  it("runs every item when the board enables an integration", async () => {
    db.upsertEntity("board", board([]) as any, KEY);
    fake.auto = () => ({ status: "complete", attribute_values: {} });
    const runner = makeRunner([fake]);
    const next = board([{ integration_id: "fake", enabled: true }]);
    db.upsertEntity("board", { ...next, updated_at: t + 1 } as any, KEY);
    runner.onBoardChanged(next, board([]));
    await runner.idle();
    expect(result()!.status).toBe("complete");
  });

  it("drops an item's results when the item is deleted", async () => {
    fake.auto = () => ({ status: "complete", attribute_values: {} });
    const runner = makeRunner([fake]);
    runner.onItemChanged("i1");
    await runner.idle();
    runner.onItemDeleted("i1");
    expect(result()).toBeNull();
  });

  it("reports a TOML error as a config error without running", async () => {
    db.upsertEntity("board", board([{ integration_id: "fake", enabled: true, config: "not toml [" }]) as any, KEY);
    const runner = makeRunner([fake]);
    runner.onItemChanged("i1");
    await runner.idle();
    expect(fake.calls).toHaveLength(0);
    expect(result()!.status).toBe("error");
    expect(result()!.error).toMatch(/^Config: /);
  });

  it("drops values the module didn't declare or that don't convert", async () => {
    fake.auto = () => ({ status: "complete", attribute_values: { year: "2010-2015", junk: 1, title: "The Matrix" } });
    const runner = makeRunner([fake]);
    runner.onItemChanged("i1");
    await runner.idle();
    expect(result()!.attribute_values).toEqual({ title: "The Matrix" });
  });

  it("serves results through pulls joined on the item's key", async () => {
    fake.auto = () => ({ status: "complete", attribute_values: { year: 1 } });
    const runner = makeRunner([fake]);
    runner.onItemChanged("i1");
    await runner.idle();
    const pulled = db.getIntegrationResultsSince(KEY, 0);
    expect(pulled).toHaveLength(1);
    expect(pulled[0]).not.toHaveProperty("inputs");
    expect(db.getIntegrationResultsSince("other", 0)).toHaveLength(0);
  });
});
