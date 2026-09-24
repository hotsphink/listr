import { describe, it, expect } from "vitest";
import type { AttributeDefinition, IntegrationResult, Item } from "./types.js";
import {
  addMissingSettings, applyPick, attributeMaps, attributeMapTemplate, coerceValue, computeOverlay, effectiveValue, mentionedSettings,
  optionsKey, orderResults, resolveOverlay, withOverlay,
} from "./integrations.js";

const attr = (key: string, type: AttributeDefinition["type"]): AttributeDefinition =>
  ({ key, label: key, type, required: false, position: 0 });

const item = (over: Partial<Item> = {}): Item => ({
  id: "i1", list_id: "l1", title: "matrix", after_id: null, created_at: 1, updated_at: 1, attributes: {}, ...over,
});

const result = (integration_id: string, attribute_values: Record<string, unknown>, over: Partial<IntegrationResult> = {}): IntegrationResult => ({
  id: `i1:${integration_id}`, item_id: "i1", integration_id, status: "complete",
  attribute_values, integration_data: {}, created_at: 1, updated_at: 1, ...over,
});

describe("coerceValue", () => {
  it("converts numeric strings", () => {
    expect(coerceValue("2010", "integer")).toBe(2010);
    expect(coerceValue("1,234", "integer")).toBe(1234);
    expect(coerceValue("7.5", "number")).toBe(7.5);
  });
  it("drops values that don't convert", () => {
    expect(coerceValue("2010-2015", "integer")).toBeUndefined();
    expect(coerceValue("7.5", "integer")).toBeUndefined();
    expect(coerceValue("N/A", "number")).toBeUndefined();
    expect(coerceValue("x", "boolean")).toBeUndefined();
  });
  it("splits and joins tags", () => {
    expect(coerceValue("Action, Sci-Fi", "tags")).toEqual(["Action", "Sci-Fi"]);
    expect(coerceValue(["Action", "Sci-Fi"], "text")).toBe("Action, Sci-Fi");
  });
});

describe("overlay", () => {
  const schema = [attr("year", "integer"), attr("imdb_id", "text")];

  it("orders results by the board's enabled integrations", () => {
    const rs = [result("b", {}), result("a", {}), result("off", {})];
    const cfgs = [
      { integration_id: "a", enabled: true },
      { integration_id: "off", enabled: false },
      { integration_id: "b", enabled: true },
    ];
    expect(orderResults(rs, cfgs).map((r) => r.integration_id)).toEqual(["a", "b"]);
  });

  it("lets the first result win and drops keys outside the schema", () => {
    const o = computeOverlay(item(), [result("a", { year: "1999", junk: 1 }), result("b", { year: 2000, imdb_id: "tt1" })], schema);
    expect(o).toEqual({ year: 1999, imdb_id: "tt1" });
  });

  it("records which integration each value came from", () => {
    const r = resolveOverlay(item(), [result("a", { year: 1999 }), result("b", { year: 2000, imdb_id: "tt1" })], schema);
    expect(r).toEqual({ values: { year: 1999, imdb_id: "tt1" }, sources: { year: "a", imdb_id: "b" }, unshown: [] });
  });

  it("fills the board attribute each value is mapped to, and leaves out values mapped to nothing", () => {
    const r = resolveOverlay(item(), [result("a", { imdb_rating: 8.7, runtime: 136, poster: "p" })], [attr("imdb", "number"), attr("duration", "duration"), attr("poster", "url")], {
      a: { imdb_rating: "imdb", runtime: "duration", poster: "" },
    });
    expect(r?.values).toEqual({ imdb: 8.7, duration: 136 });
    expect(r?.sources).toEqual({ imdb: "a", duration: "a" });
    expect(r?.unshown).toEqual([]);
  });

  it("reports values with no attribute or of the wrong type, but not ones another integration filled", () => {
    const r = resolveOverlay(
      item(),
      [result("a", { year: 1999 }), result("b", { year: 2000, imdb_rating: 8.7, votes: 7.5 })],
      [attr("year", "integer"), attr("votes", "integer")],
    );
    expect(r?.values).toEqual({ year: 1999 });
    expect(r?.unshown).toEqual([
      { integration_id: "b", key: "imdb_rating", target: "imdb_rating", value: 8.7, reason: "no_attribute" },
      { integration_id: "b", key: "votes", target: "votes", value: 7.5, reason: "wrong_type", type: "integer" },
    ]);
    expect(computeOverlay(item(), [result("a", { junk: 1 })], schema)).toBeNull();
    expect(resolveOverlay(item(), [result("a", { junk: 1 })], schema)?.unshown).toHaveLength(1);
  });

  it("reads attribute maps from each integration's TOML, skipping configs that don't parse", () => {
    const parse = (text: string) => {
      if (text === "bad") throw new Error("bad");
      return text === "mapped" ? { attributes: { imdb_rating: "imdb", junk: 3 } } : {};
    };
    const maps = attributeMaps([
      { integration_id: "a", enabled: true, config: "mapped" },
      { integration_id: "b", enabled: true, config: "bad" },
      { integration_id: "c", enabled: true },
    ], parse);
    expect(maps).toEqual({ a: { imdb_rating: "imdb" } });
  });

  it("returns null when nothing applies", () => {
    expect(computeOverlay(item(), [result("a", { junk: 1 })], schema)).toBeNull();
  });

  it("shows the user's value when set, else the overlay's", () => {
    const o = { year: 1999, title: "The Matrix" };
    expect(effectiveValue(item({ attributes: { year: 2003 } }), "year", o)).toBe(2003);
    expect(effectiveValue(item({ attributes: { year: null } }), "year", o)).toBe(1999);
    expect(effectiveValue(item(), "title", o)).toBe("matrix");
    expect(effectiveValue(item({ title: "" }), "title", o)).toBe("The Matrix");
    expect(withOverlay(item({ title: "" }), o).title).toBe("The Matrix");
    expect(withOverlay(item(), null)).toEqual(item());
  });

  it("hides a value whose pick is stale", () => {
    const choices = { imdb_id: { options: [{ value: "tt1", label: "x" }], options_key: "new" } };
    const r = result("a", { imdb_id: "tt1" }, { choices });
    const fresh = item({ choices: { imdb_id: { value: "tt1", options_key: "new" } } });
    const stale = item({ choices: { imdb_id: { value: "tt1", options_key: "old" } } });
    expect(computeOverlay(fresh, [r], schema)).toEqual({ imdb_id: "tt1" });
    expect(computeOverlay(stale, [r], schema)).toBeNull();
  });
});

describe("applyPick", () => {
  it("records the pick and releases the title as the query", () => {
    const edit = applyPick(item(), "imdb_id", { options_key: "k", releases: ["title"] }, "tt1");
    expect(edit.title).toBe("");
    expect(edit.choices).toEqual({ imdb_id: { value: "tt1", options_key: "k", query: { title: "matrix" } } });
  });
  it("keeps the earlier query when the released field is already empty", () => {
    const prior = item({ title: "", choices: { imdb_id: { value: "tt0", options_key: "k", query: { title: "matrix" } } } });
    const edit = applyPick(prior, "imdb_id", { options_key: "k", releases: ["title"] }, "tt1");
    expect(edit.choices!.imdb_id.query).toEqual({ title: "matrix" });
  });
});

describe("optionsKey", () => {
  it("is stable and order-sensitive", () => {
    expect(optionsKey(["a", "b"])).toBe(optionsKey(["a", "b"]));
    expect(optionsKey(["a", "b"])).not.toBe(optionsKey(["b", "a"]));
  });
});

describe("attributeMapTemplate", () => {
  it("lists every key commented out, under one comment", () => {
    expect(attributeMapTemplate(["year", "imdb_id"])).toBe(
      '# Board attribute each value fills, when the board\'s key differs. "" leaves the value out.\n# attributes.year = "year"\n# attributes.imdb_id = "imdb_id"\n',
    );
    expect(attributeMapTemplate([])).toBe("");
  });
});

describe("mentionedSettings", () => {
  it("names dotted keys and keys under a table by their full path", () => {
    expect([...mentionedSettings('a = 1\n# attributes.year = "y"\n[attributes]\nimdb = "i"\n')]).toEqual(["a", "attributes.year", "attributes.imdb"]);
  });
});

describe("addMissingSettings", () => {
  const template = "# Days between refreshes.\n# refresh_days = 30\n\n# Kind of title.\n# type = \"\"\n";
  it("appends missing settings with their comments", () => {
    expect(addMissingSettings("refresh_days = 7\n", template)).toBe(
      "refresh_days = 7\n\n# Kind of title.\n# type = \"\"\n",
    );
  });
  it("leaves text alone when every setting is mentioned", () => {
    const text = "# refresh_days = 1\ntype = \"movie\"\n";
    expect(addMissingSettings(text, template)).toBe(text);
  });
  it("adds dotted settings, and puts new lines before a table so they stay top-level", () => {
    const tpl = "# Days.\n# refresh_days = 30\n\n# Map.\n# attributes.year = \"year\"\n# attributes.plot = \"plot\"\n";
    expect(addMissingSettings('[attributes]\nyear = "released"\n', tpl)).toBe(
      '# Days.\n# refresh_days = 30\n\n# attributes.plot = "plot"\n\n[attributes]\nyear = "released"\n',
    );
  });

  it("fills an empty box with the whole template", () => {
    expect(addMissingSettings("", template)).toBe(
      "# Days between refreshes.\n# refresh_days = 30\n\n# Kind of title.\n# type = \"\"\n",
    );
  });
});
