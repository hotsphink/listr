import { describe, it, expect } from "vitest";
import { optionsKey, type Item } from "@listr/shared";
import { OmdbIntegration } from "./omdb.js";
import type { IntegrationRunContext } from "./types.js";

const omdb = new OmdbIntegration();

const item = (over: Partial<Item> = {}): Item => ({
  id: "i1", list_id: "l1", title: "matrix", after_id: null, created_at: 1, updated_at: 1, attributes: {}, ...over,
});

const MATRIX = {
  Response: "True", imdbID: "tt0133093", Title: "The Matrix", Year: "1999", Genre: "Action, Sci-Fi", imdbRating: "8.7",
  imdbVotes: "2,000,000", Runtime: "136 min", Rated: "N/A", Type: "movie",
  Ratings: [{ Source: "Internet Movie Database", Value: "8.7/10" }, { Source: "Rotten Tomatoes", Value: "83%" }],
};
const SEARCH = {
  Response: "True",
  Search: [
    { Title: "The Matrix", Year: "1999", imdbID: "tt0133093", Type: "movie" },
    { Title: "The Matrix Reloaded", Year: "2003", imdbID: "tt0234215", Type: "movie" },
  ],
};

/** Run with a fetch that answers by query parameter, and record the URLs asked for. */
async function run(it: Item, answers: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const urls: string[] = [];
  const inputs = omdb.inputsOf(it, it, config)!;
  const ctx: IntegrationRunContext = {
    item: it, inputs, config, serverConfig: { api_key: "k" }, now: 0,
    fetch: async (url) => {
      urls.push(url);
      const q = new URL(url).searchParams;
      const key = q.has("i") ? `i=${q.get("i")}` : `s=${q.get("s")}`;
      if (!(key in answers)) throw new Error(`unexpected ${key}`);
      const body = answers[key];
      if (body instanceof Error) throw body;
      return new Response(JSON.stringify(body));
    },
  };
  return { out: await omdb.run(ctx), urls };
}

describe("OmdbIntegration.inputsOf", () => {
  it("prefers a user-set imdb_id", () => {
    expect(omdb.inputsOf(item({ attributes: { imdb_id: "tt1" } }), item(), {})).toEqual({ imdb_id: "tt1", type: "", v: 2 });
  });
  it("searches on a released title's stored query, not the overlay", () => {
    const it = item({ title: "", choices: { imdb_id: { value: "tt1", options_key: "k", query: { title: "matrix" } } } });
    const effective = { ...it, title: "The Matrix" };
    expect(omdb.inputsOf(it, effective, {})).toEqual({ title: "matrix", pick: { value: "tt1", options_key: "k" }, type: "", v: 2 });
  });
  it("has nothing to look up without a title or id", () => {
    expect(omdb.inputsOf(item({ title: "" }), item(), {})).toBeNull();
  });
});

describe("OmdbIntegration.run", () => {
  it("searches by title when the title changes, even after a pick", async () => {
    const it = item({ title: "reloaded", choices: { imdb_id: { value: "tt0133093", options_key: "old", query: { title: "matrix" } } } });
    const { urls } = await run(it, { "s=reloaded": { Response: "False", Error: "Movie not found!" } });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("s=reloaded");
  });

  it("offers choices and settles on the one exact title match", async () => {
    const { out } = await run(item({ title: "The Matrix" }), { "s=The Matrix": SEARCH, "i=tt0133093": MATRIX });
    expect(out.status).toBe("complete");
    expect(out.choices?.imdb_id.options.map((o) => o.value)).toEqual(["tt0133093", "tt0234215"]);
    expect(out.choices?.imdb_id.releases).toEqual(["title"]);
    expect(out.attribute_values).toMatchObject({ imdb_id: "tt0133093", title: "The Matrix", year: "1999", imdb_rating: "8.7" });
    expect(out.attribute_values).not.toHaveProperty("rated");
    expect(out.attribute_values.rotten_tomatoes).toBe("83");
    expect(out.attribute_values.runtime_minutes).toBe("136");
  });

  it("is ambiguous when several titles match and none was picked", async () => {
    const { out, urls } = await run(item({ title: "matrix" }), { "s=matrix": SEARCH });
    expect(out.status).toBe("ambiguous");
    expect(out.choices?.imdb_id.options).toHaveLength(2);
    expect(urls).toHaveLength(1);
  });

  it("looks up a valid pick", async () => {
    const key = optionsKey(["tt0133093", "tt0234215"]);
    const it = item({ title: "", choices: { imdb_id: { value: "tt0234215", options_key: key, query: { title: "matrix" } } } });
    const { out, urls } = await run(it, { "s=matrix": SEARCH, "i=tt0234215": { ...MATRIX, imdbID: "tt0234215", Title: "The Matrix Reloaded" } });
    expect(out.status).toBe("complete");
    expect(out.attribute_values.title).toBe("The Matrix Reloaded");
    expect(urls[1]).toContain("i=tt0234215");
  });

  it("ignores a pick made against a different option set", async () => {
    const it = item({ choices: { imdb_id: { value: "tt0234215", options_key: "stale" } } });
    const { out } = await run(it, { "s=matrix": SEARCH });
    expect(out.status).toBe("ambiguous");
  });

  it("returns not_found for a miss", async () => {
    const { out } = await run(item(), { "s=matrix": { Response: "False", Error: "Movie not found!" } });
    expect(out.status).toBe("not_found");
    const byId = await run(item({ attributes: { imdb_id: "tt0" } }), { "i=tt0": { Response: "False", Error: "Incorrect IMDb ID." } });
    expect(byId.out.status).toBe("not_found");
  });

  it("throws on other API errors and on network failures, so the runner retries", async () => {
    await expect(run(item(), { "s=matrix": { Response: "False", Error: "Invalid API key!" } })).rejects.toThrow("Invalid API key!");
    await expect(run(item(), { "s=matrix": new Error("timeout") })).rejects.toThrow("timeout");
  });

  it("schedules a refresh from the board config", async () => {
    const { out } = await run(item(), { "s=matrix": { Response: "False", Error: "Movie not found!" } }, { refresh_days: 2 });
    expect(out.refresh_at).toBe(2 * 86_400_000);
  });

  it("passes the type filter through", async () => {
    const { urls } = await run(item(), { "s=matrix": { Response: "False", Error: "Movie not found!" } }, { type: "series" });
    expect(urls[0]).toContain("type=series");
  });
});
