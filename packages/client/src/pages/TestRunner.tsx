import { type Component, For, createSignal, onMount } from "solid-js";
import Dexie, { type EntityTable } from "dexie";
import type { AttributeDefinition, Board, Item, List } from "@listr/shared";
import { renderFormatString } from "@listr/shared";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

type TestFn = () => Promise<void>;

class TestDB extends Dexie {
  boards!: EntityTable<Board, "id">;
  lists!: EntityTable<List, "id">;
  items!: EntityTable<Item, "id">;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      boards: "id, position",
      lists: "id, board_id, position",
      items: "id, list_id, position, title",
    });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual: unknown, expected: unknown, label?: string) {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

let testDb: TestDB;
let nextId = 0;

function id(): string {
  return `test-${++nextId}`;
}

function now(): number {
  return Date.now();
}

async function createTestBoard(
  name: string,
  schema: AttributeDefinition[],
  formatString: string,
): Promise<Board> {
  const board: Board = {
    id: id(),
    name,
    color: "#5b8def",
    position: 0,
    schema,
    format_string: formatString,
    created_at: now(),
    updated_at: now(),
  };
  await testDb.boards.add(board);
  return board;
}

async function createTestList(
  name: string,
  boardId: string,
): Promise<List> {
  const list: List = {
    id: id(),
    board_id: boardId,
    name,
    icon: "",
    position: 0,
    format_string: null,
    view_mode: "table",
    created_at: now(),
    updated_at: now(),
  };
  await testDb.lists.add(list);
  return list;
}

async function createTestItem(
  list: List,
  schema: AttributeDefinition[],
  title: string,
  attributes: Record<string, unknown> = {},
): Promise<Item> {
  const resolvedAttrs = { ...attributes };
  for (const def of schema) {
    if (resolvedAttrs[def.key] === undefined && def.default_value !== undefined) {
      resolvedAttrs[def.key] = def.default_value;
    }
    if (def.auto?.trigger === "on_create" && def.auto.source === "timestamp") {
      resolvedAttrs[def.key] = now();
    }
  }

  const item: Item = {
    id: id(),
    list_id: list.id,
    title,
    after_id: null,
    created_at: now(),
    updated_at: now(),
    attributes: resolvedAttrs,
  };
  await testDb.items.add(item);
  return item;
}

const tests: Array<{ name: string; fn: TestFn }> = [
  {
    name: "create a movie list with rating attribute and display formatted items",
    fn: async () => {
      const schema: AttributeDefinition[] = [
        { key: "rating", label: "Rating", type: "number", required: false, position: 0 },
        { key: "duration", label: "Duration", type: "duration", required: false, position: 1 },
      ];
      const cat = await createTestBoard("Movies", schema, "{rating:stars} {title}{ ({duration:short})|}");
      const list = await createTestList("Movies", cat.id);
      const item = await createTestItem(list, schema, "Inception", { rating: 4, duration: 148 });

      const stored = await testDb.items.get(item.id);
      assert(stored !== undefined, "item should be in IndexedDB");
      assertEqual(stored!.title, "Inception");
      assertEqual(stored!.attributes.rating, 4);
      assertEqual(stored!.attributes.duration, 148);

      const storedCat = await testDb.boards.get(cat.id);
      const display = renderFormatString(storedCat!.format_string, stored!, storedCat!.schema);
      assertEqual(display, "★★★★☆ Inception (2h28m)");
    },
  },
  {
    name: "display falls back to title when custom attributes are missing",
    fn: async () => {
      const schema: AttributeDefinition[] = [
        { key: "rating", label: "Rating", type: "number", required: false, position: 0 },
      ];
      const cat = await createTestBoard("Sparse", schema, "{rating:stars} - {title}");
      const list = await createTestList("Sparse", cat.id);
      const item = await createTestItem(list, schema, "No Rating");

      const stored = await testDb.items.get(item.id);
      const display = renderFormatString(cat.format_string, stored!, cat.schema);
      assertEqual(display, " - No Rating", "missing rating renders empty at top level");
    },
  },
  {
    name: "enum attribute shows in display",
    fn: async () => {
      const schema: AttributeDefinition[] = [
        { key: "status", label: "Status", type: "enum", required: false, options: ["to watch", "watching", "watched"], position: 0 },
      ];
      const cat = await createTestBoard("Watch Status", schema, "{title} [{status:upper}]");
      const list = await createTestList("Watch Status", cat.id);
      const item = await createTestItem(list, schema, "Dune", { status: "watching" });

      const stored = await testDb.items.get(item.id);
      const display = renderFormatString(cat.format_string, stored!, cat.schema);
      assertEqual(display, "Dune [WATCHING]");
    },
  },
  {
    name: "conditional section hides when attribute absent, shows when present",
    fn: async () => {
      const schema: AttributeDefinition[] = [
        { key: "genre", label: "Genre", type: "text", required: false, position: 0 },
        { key: "year", label: "Year", type: "number", required: false, position: 1 },
      ];
      const cat = await createTestBoard("Conditionals", schema, "{title}{ ({year})|}{ - {genre}|}");
      const list = await createTestList("Conditionals", cat.id);

      const full = await createTestItem(list, schema, "Alien", { year: 1979, genre: "sci-fi" });
      const stored1 = await testDb.items.get(full.id);
      assertEqual(renderFormatString(cat.format_string, stored1!, cat.schema), "Alien (1979) - sci-fi");

      const noGenre = await createTestItem(list, schema, "Memento", { year: 2000 });
      const stored2 = await testDb.items.get(noGenre.id);
      assertEqual(renderFormatString(cat.format_string, stored2!, cat.schema), "Memento (2000)");

      const bare = await createTestItem(list, schema, "TBD", {});
      const stored3 = await testDb.items.get(bare.id);
      assertEqual(renderFormatString(cat.format_string, stored3!, cat.schema), "TBD");
    },
  },
  {
    name: "default_value is applied on item creation",
    fn: async () => {
      const schema: AttributeDefinition[] = [
        { key: "status", label: "Status", type: "enum", required: false, options: ["backlog", "active", "done"], default_value: "backlog", position: 0 },
      ];
      const cat = await createTestBoard("Defaults", schema, "{title} ({status})");
      const list = await createTestList("Defaults", cat.id);
      const item = await createTestItem(list, schema, "New Movie");

      const stored = await testDb.items.get(item.id);
      assertEqual(stored!.attributes.status, "backlog", "default_value should be applied");
      assertEqual(renderFormatString(cat.format_string, stored!, cat.schema), "New Movie (backlog)");
    },
  },
  {
    name: "auto timestamp attribute is set on creation",
    fn: async () => {
      const schema: AttributeDefinition[] = [
        {
          key: "added_at", label: "Added At", type: "datetime", required: false, position: 0,
          auto: { trigger: "on_create", source: "timestamp" },
        },
      ];
      const cat = await createTestBoard("Auto", schema, "{title}");
      const list = await createTestList("Auto", cat.id);
      const before = Date.now();
      const item = await createTestItem(list, schema, "Auto Item");
      const after = Date.now();

      const stored = await testDb.items.get(item.id);
      const ts = stored!.attributes.added_at as number;
      assert(typeof ts === "number", "added_at should be a number");
      assert(ts >= before && ts <= after, "timestamp should be within test window");
    },
  },
  {
    name: "tags attribute renders comma-separated in display",
    fn: async () => {
      const schema: AttributeDefinition[] = [
        { key: "tags", label: "Tags", type: "tags", required: false, options: ["classic", "must-see", "rewatchable"], position: 0 },
      ];
      const cat = await createTestBoard("Tagged", schema, "{title}{ - {tags}|}");
      const list = await createTestList("Tagged", cat.id);
      const item = await createTestItem(list, schema, "The Matrix", { tags: ["classic", "must-see"] });

      const stored = await testDb.items.get(item.id);
      assertEqual(renderFormatString(cat.format_string, stored!, cat.schema), "The Matrix - classic, must-see");
    },
  },
  {
    name: "items are scoped to their list",
    fn: async () => {
      const cat = await createTestBoard("Scoped", [], "{title}");
      const list1 = await createTestList("List A", cat.id);
      const list2 = await createTestList("List B", cat.id);

      await createTestItem(list1, [], "Item 1");
      await createTestItem(list1, [], "Item 2");
      await createTestItem(list2, [], "Item 3");

      const list1Items = await testDb.items.where("list_id").equals(list1.id).toArray();
      const list2Items = await testDb.items.where("list_id").equals(list2.id).toArray();

      assertEqual(list1Items.length, 2, "list1 should have 2 items");
      assertEqual(list2Items.length, 1, "list2 should have 1 item");
    },
  },
];

const TestRunner: Component = () => {
  const [results, setResults] = createSignal<TestResult[]>([]);
  const [running, setRunning] = createSignal(false);

  const runTests = async () => {
    setRunning(true);
    setResults([]);
    const collected: TestResult[] = [];

    const dbName = `listr-test-${Date.now()}`;
    testDb = new TestDB(dbName);
    nextId = 0;

    try {
      for (const test of tests) {
        try {
          await test.fn();
          collected.push({ name: test.name, passed: true });
        } catch (e) {
          collected.push({ name: test.name, passed: false, error: String(e) });
        }
        setResults([...collected]);
      }
    } finally {
      testDb.close();
      await Dexie.delete(dbName);
      setRunning(false);
    }
  };

  onMount(runTests);

  const passed = () => results().filter((r) => r.passed).length;
  const failed = () => results().filter((r) => !r.passed).length;

  return (
    <div class="main">
      <div class="page-header">
        <h1>Tests</h1>
        <div class="header-actions">
          <button class="btn-primary" onClick={runTests} disabled={running()}>
            {running() ? "Running..." : "Run Tests"}
          </button>
        </div>
      </div>
      <div style="padding: 24px">
        <div style="margin-bottom: 16px; font-size: 14px; color: var(--text-muted)">
          {results().length > 0 && (
            <span>
              <span style={`color: ${failed() > 0 ? "var(--danger)" : "var(--success)"}`}>
                {passed()} passed, {failed()} failed
              </span>
              {" / "}
              {tests.length} total
            </span>
          )}
        </div>
        <For each={results()}>
          {(r) => (
            <div
              style={`
                padding: 10px 14px;
                margin-bottom: 4px;
                border-radius: var(--radius);
                border-left: 3px solid ${r.passed ? "var(--success)" : "var(--danger)"};
                background: var(--bg-surface);
              `}
            >
              <div style="display: flex; align-items: center; gap: 8px">
                <span style={`color: ${r.passed ? "var(--success)" : "var(--danger)"}`}>
                  {r.passed ? "PASS" : "FAIL"}
                </span>
                <span>{r.name}</span>
              </div>
              {r.error && (
                <pre style="margin-top: 6px; font-size: 12px; color: var(--danger); white-space: pre-wrap">
                  {r.error}
                </pre>
              )}
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

export default TestRunner;
