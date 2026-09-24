import { isSet, optionsKey, type IntegrationChoice, type Item } from "@listr/shared";
import type { IntegrationServerConfig } from "../config.js";
import type { IntegrationModule, IntegrationRunContext, IntegrationRunResult } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_DAYS = 30;
const MAX_OPTIONS = 10;

// OMDb reports a miss as an error string with Response "False".
const NOT_FOUND_ERRORS = new Set(["Movie not found!", "Series or episode not found!", "Incorrect IMDb ID.", "Too many results."]);

interface OmdbDetail {
  Response: "True" | "False";
  Error?: string;
  imdbID?: string;
  Title?: string;
  Year?: string;
  Rated?: string;
  Released?: string;
  Runtime?: string;
  Genre?: string;
  Director?: string;
  Actors?: string;
  Plot?: string;
  Language?: string;
  Country?: string;
  Poster?: string;
  imdbRating?: string;
  imdbVotes?: string;
  Type?: string;
  totalSeasons?: string;
  Metascore?: string;
}

interface OmdbSearch {
  Response: "True" | "False";
  Error?: string;
  Search?: { Title: string; Year: string; imdbID: string; Type: string }[];
}

function given(v: string | undefined): string | undefined {
  return v && v !== "N/A" ? v : undefined;
}

function detailValues(d: OmdbDetail): Record<string, unknown> {
  const values: Record<string, unknown> = {
    imdb_id: d.imdbID,
    title: given(d.Title),
    // A series reports a range such as "2010-2015". Keep its first year.
    year: given(d.Year)?.match(/^\d{4}/)?.[0],
    rated: given(d.Rated),
    genre: given(d.Genre),
    director: given(d.Director),
    actors: given(d.Actors),
    plot: given(d.Plot),
    language: given(d.Language),
    country: given(d.Country),
    poster: given(d.Poster),
    imdb_rating: given(d.imdbRating),
    imdb_votes: given(d.imdbVotes),
    metascore: given(d.Metascore),
    runtime_minutes: given(d.Runtime)?.match(/^(\d+)\s*min/)?.[1],
    media_type: given(d.Type),
    total_seasons: given(d.totalSeasons),
  };
  for (const key of Object.keys(values)) if (values[key] === undefined) delete values[key];
  return values;
}

function refreshAt(ctx: IntegrationRunContext): number {
  const days = typeof ctx.config.refresh_days === "number" ? ctx.config.refresh_days : DEFAULT_REFRESH_DAYS;
  return ctx.now + days * DAY_MS;
}

export class OmdbIntegration implements IntegrationModule {
  readonly id = "omdb";
  readonly name = "OMDb (movies and TV)";
  readonly attributes: IntegrationModule["attributes"] = [
    { key: "imdb_id", type: "text", label: "IMDb ID" },
    { key: "year", type: "integer", label: "Year" },
    { key: "rated", type: "text", label: "Rated" },
    { key: "genre", type: "tags", label: "Genre" },
    { key: "director", type: "text", label: "Director" },
    { key: "actors", type: "text", label: "Actors" },
    { key: "plot", type: "text", label: "Plot" },
    { key: "language", type: "text", label: "Language" },
    { key: "country", type: "text", label: "Country" },
    { key: "poster", type: "url", label: "Poster" },
    { key: "imdb_rating", type: "number", label: "IMDb rating" },
    { key: "imdb_votes", type: "integer", label: "IMDb votes" },
    { key: "metascore", type: "integer", label: "Metascore" },
    { key: "runtime_minutes", type: "duration", label: "Runtime" },
    { key: "media_type", type: "text", label: "Type" },
    { key: "total_seasons", type: "integer", label: "Seasons" },
  ];
  readonly configTemplate = [
    "# Days until a lookup is refreshed, so ratings stay current.",
    "# refresh_days = 30",
    "",
    "# Only match this kind of title: \"movie\", \"series\" or \"episode\". Empty matches all.",
    "# type = \"\"",
    "",
  ].join("\n");
  // The free OMDb tier allows 1000 calls a day.
  readonly serverDefaults = { daily_limit: 1000, daily_limit_per_key: 500 };

  isActive(serverConfig: IntegrationServerConfig): boolean {
    return typeof serverConfig.api_key === "string" && serverConfig.api_key !== "";
  }

  inputsOf(item: Item, _effective: Item, config: Record<string, unknown>): Record<string, unknown> | null {
    const type = typeof config.type === "string" ? config.type : "";
    const userId = item.attributes.imdb_id;
    if (isSet(userId)) return { imdb_id: String(userId), type };
    const pick = item.choices?.imdb_id;
    // A title released by a pick was only a query. Search on what the user typed, never on the overlay.
    const title = isSet(item.title) ? item.title.trim() : pick?.query?.title;
    if (typeof title !== "string" || title === "") return null;
    return { title, pick: pick ? { value: pick.value, options_key: pick.options_key } : null, type };
  }

  async run(ctx: IntegrationRunContext): Promise<IntegrationRunResult> {
    const { inputs } = ctx;
    if (typeof inputs.imdb_id === "string") {
      const values = await this.lookup(ctx, inputs.imdb_id);
      if (!values) return { status: "not_found", attribute_values: {}, refresh_at: refreshAt(ctx) };
      return { status: "complete", attribute_values: values, refresh_at: refreshAt(ctx) };
    }

    const title = inputs.title as string;
    const search = await this.get<OmdbSearch>(ctx, `s=${encodeURIComponent(title)}`);
    const found = search.Search ?? [];
    if (!found.length) {
      return { status: "not_found", attribute_values: {}, integration_data: { query: title }, refresh_at: refreshAt(ctx) };
    }

    const options = found.slice(0, MAX_OPTIONS).map((r) => ({ value: r.imdbID, label: `${r.Title} (${r.Year}, ${r.Type})` }));
    const choice: IntegrationChoice = { options, options_key: optionsKey(options.map((o) => o.value)), releases: ["title"] };
    const choices = options.length > 1 ? { imdb_id: choice } : undefined;

    const pick = inputs.pick as { value: string; options_key: string } | null;
    const exact = found.filter((r) => r.Title.trim().toLowerCase() === title.toLowerCase());
    let chosen: string | undefined;
    if (pick && pick.options_key === choice.options_key && options.some((o) => o.value === pick.value)) chosen = pick.value;
    else if (options.length === 1) chosen = options[0].value;
    else if (exact.length === 1) chosen = exact[0].imdbID;

    if (!chosen) {
      return { status: "ambiguous", attribute_values: {}, choices, integration_data: { query: title }, refresh_at: refreshAt(ctx) };
    }
    const values = await this.lookup(ctx, chosen);
    if (!values) return { status: "not_found", attribute_values: {}, choices, refresh_at: refreshAt(ctx) };
    return { status: "complete", attribute_values: values, choices, refresh_at: refreshAt(ctx) };
  }

  private async lookup(ctx: IntegrationRunContext, imdbId: string): Promise<Record<string, unknown> | null> {
    const detail = await this.get<OmdbDetail>(ctx, `i=${encodeURIComponent(imdbId)}&plot=short`);
    return detail.Response === "True" ? detailValues(detail) : null;
  }

  // Resolve misses as a Response "False" body, and throw on every other failure so the runner retries.
  private async get<T extends { Response: string; Error?: string }>(ctx: IntegrationRunContext, query: string): Promise<T> {
    const apiKey = ctx.serverConfig.api_key;
    if (!apiKey) throw new Error("OMDb API key not configured");
    const type = typeof ctx.inputs.type === "string" && ctx.inputs.type ? `&type=${encodeURIComponent(ctx.inputs.type)}` : "";
    const resp = await ctx.fetch(`https://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}&${query}${type}`);
    const data = await resp.json() as T;
    if (data.Response === "True" || NOT_FOUND_ERRORS.has(data.Error ?? "")) return data;
    throw new Error(data.Error ?? `OMDb HTTP ${resp.status}`);
  }
}
