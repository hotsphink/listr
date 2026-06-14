import { type Component, For, createSignal, onMount } from "solid-js";
import Dexie, { type EntityTable } from "dexie";
import type { AttributeDefinition, Category, Item, List } from "@listr/shared";
import { renderFormatString } from "@listr/shared";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

type TestFn = () => Promise<void>;

class TestDB extends Dexie {
  categories!: EntityTable<Category, "id">;
  lists!: EntityTable<List, "id">;
  items!: EntityTable<Item, "id">;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      categories: "id, position",
      lists: "id, category_id, position",
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

async function createTestList(
  name: string,
  schema: AttributeDefinition[],
  formatString: string,
): Promise<List> {
  const list: List = {
    id: id(),
    category_id: null,
    name,
    icon: "",
    position: 0,
    format_string: formatString,
    view_mode: "table",
    schema,
    created_at: now(),
    updated_at: now(),
  };
  await testDb.lists.add(list);
  return list;
}

async function createTestItem(
  list: List,
  title: string,
  attributes: Record<string, unknown> = {},
): Promise<Item> {
  const resolvedAttrs = { ...attributes };
  for (const def of list.schema) {
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
    position: 0,
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
        { key: "rating", label: "Rating", type: "rating", required: false, position: 0 },
        { key: "duration", label: "Duration", type: "duration", required: false, position: 1 },
      ];
      const list = await createTestList("Movies", schema, "{rating:stars} {title}{ ({duration:short})|}");

      const item = await createTestItem(list, "Inception", { rating: 4, duration: 148 });

      const stored = await testDb.items.get(item.id);
      assert(stored !== undefined, "item should be in IndexedDB");
      assertEqual(stored!.title, "Inception");
      assertEqual(stored!.attributes.rating, 4);
      assertEqual(stored!.attributes.duration, 148);

      const storedList = await testDb.lists.get(list.id);
      const display = renderFormatString(storedList!.format_string, stored!, storedList!.schema);
      assertEqual(display, "★★★★☆ Inception (2h28m)");
    },
  },
  {
    name: "display falls back to title when custom attributes are missing",
    fn: async () => {
      const schema: AttributeDefinition[] = [
        { key: "rating", label: "Rating", type: "rating", required: false, position: 0 },
      ];
      const list = await createTestList("Sparse", schema, "{rating:stars} - {title}");
      const item = await createTestItem(list, "No Rating");

      const stored = await testDb.items.get(item.id);
      const display = renderFormatString(list.format_string, stored!, list.schema);
      assertEqual(display, "No Rating", "should fall back to title when rating is missing");
    },
  },
  {
    name: "enum attribute shows in display",
    fn: async () => {
      const schema: AttributeDefinition[] = [
        { key: "status", label: "Status", type: "enum", required: false, options: ["to watch", "watching", "watched"], position: 0 },
      ];
      const list = await createTestList("Watch Status", schema, "{title} [{status:upper}]");
      const item = await createTestItem(list, "Dune", { status: "watching" });

      const stored = await testDb.items.get(item.id);
      const display = renderFormatString(list.format_string, stored!, list.schema);
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
      const list = await createTestList("Conditionals", schema, "{title}{ ({year})|}{ - {genre}|}");

      const full = await createTestItem(list, "Alien", { year: 1979, genre: "sci-fi" });
      const stored1 = await testDb.items.get(full.id);
      assertEqual(
        renderFormatString(list.format_string, stored1!, list.schema),
        "Alien (1979) - sci-fi",
      );

      const noGenre = await createTestItem(list, "Memento", { year: 2000 });
      const stored2 = await testDb.items.get(noGenre.id);
      assertEqual(
        renderFormatString(list.format_string, stored2!, list.schema),
        "Memento (2000)",
      );

      const bare = await createTestItem(list, "TBD", {});
      const stored3 = await testDb.items.get(bare.id);
      assertEqual(
        renderFormatString(list.format_string, stored3!, list.schema),
        "TBD",
      );
    },
  },
  {
    name: "default_value is applied on item creation",
    fn: async () => {
      const schema: AttributeDefinition[] = [
        { key: "status", label: "Status", type: "enum", required: false, options: ["backlog", "active", "done"], default_value: "backlog", position: 0 },
      ];
      const list = await createTestList("Defaults", schema, "{title} ({status})");
      const item = await createTestItem(list, "New Movie");

      const stored = await testDb.items.get(item.id);
      assertEqual(stored!.attributes.status, "backlog", "default_value should be applied");
      assertEqual(
        renderFormatString(list.format_string, stored!, list.schema),
        "New Movie (backlog)",
      );
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
      const list = await createTestList("Auto", schema, "{title}");
      const before = Date.now();
      const item = await createTestItem(list, "Auto Item");
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
      const list = await createTestList("Tagged", schema, "{title}{ - {tags}|}");
      const item = await createTestItem(list, "The Matrix", { tags: ["classic", "must-see"] });

      const stored = await testDb.items.get(item.id);
      assertEqual(
        renderFormatString(list.format_string, stored!, list.schema),
        "The Matrix - classic, must-see",
      );
    },
  },
  {
    name: "items are scoped to their list",
    fn: async () => {
      const schema: AttributeDefinition[] = [];
      const list1 = await createTestList("List A", schema, "{title}");
      const list2 = await createTestList("List B", schema, "{title}");

      await createTestItem(list1, "Item 1");
      await createTestItem(list1, "Item 2");
      await createTestItem(list2, "Item 3");

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
