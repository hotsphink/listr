import type { Item } from "@listr/shared";
import type { IntegrationModule, IntegrationRunResult } from "./types.js";

interface OmdbResponse {
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
  imdbRating?: string;
  imdbVotes?: string;
  Type?: string;
  totalSeasons?: string;
  Metascore?: string;
}

function parseRuntime(runtime: string | undefined): number | undefined {
  if (!runtime) return undefined;
  const m = runtime.match(/^(\d+)\s*min/);
  return m ? parseInt(m[1], 10) : undefined;
}

export class OmdbIntegration implements IntegrationModule {
  readonly id = "omdb";

  needsUpdate(item: Item, changedKeys: Set<string> | null, _listConfig?: Record<string, unknown>): boolean {
    if (!item.title) return false;
    return changedKeys === null || changedKeys.has("title") || changedKeys.has("imdb_id");
  }

  async run(
    item: Item,
    serverConfig: Record<string, unknown>,
    _listConfig?: Record<string, unknown>,
  ): Promise<IntegrationRunResult> {
    const apiKey = serverConfig.omdb_api_key as string | undefined;
    if (!apiKey) {
      return { status: "error", attribute_values: {}, error: "OMDb API key not configured" };
    }

    // Prefer a direct imdb_id lookup (more precise) over title search.
    const imdbId = item.attributes?.imdb_id as string | undefined;
    const query = imdbId
      ? `i=${encodeURIComponent(imdbId)}`
      : `t=${encodeURIComponent(item.title)}`;
    const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}&${query}&plot=short`;
    let data: OmdbResponse;
    try {
      const resp = await fetch(url);
      data = await resp.json() as OmdbResponse;
    } catch (err) {
      return { status: "error", attribute_values: {}, error: `OMDb request failed: ${String(err)}` };
    }

    if (data.Response !== "True") {
      if (data.Error === "Movie not found!") {
        return { status: "ambiguous", attribute_values: {}, integration_data: { query: item.title } };
      }
      return { status: "error", attribute_values: {}, error: data.Error ?? "Unknown OMDb error" };
    }

    const attribute_values: Record<string, unknown> = {};
    if (data.imdbID) attribute_values.imdb_id = data.imdbID;
    if (data.Year) attribute_values.year = data.Year;
    if (data.Rated && data.Rated !== "N/A") attribute_values.rated = data.Rated;
    if (data.Genre) attribute_values.genre = data.Genre;
    if (data.Director && data.Director !== "N/A") attribute_values.director = data.Director;
    if (data.Actors && data.Actors !== "N/A") attribute_values.actors = data.Actors;
    if (data.Plot && data.Plot !== "N/A") attribute_values.plot = data.Plot;
    if (data.Language && data.Language !== "N/A") attribute_values.language = data.Language;
    if (data.Country && data.Country !== "N/A") attribute_values.country = data.Country;
    if (data.imdbRating && data.imdbRating !== "N/A") attribute_values.imdb_rating = parseFloat(data.imdbRating);
    if (data.imdbVotes && data.imdbVotes !== "N/A") {
      attribute_values.imdb_votes = parseInt(data.imdbVotes.replace(/,/g, ""), 10);
    }
    if (data.Metascore && data.Metascore !== "N/A") attribute_values.metascore = parseInt(data.Metascore, 10);
    const runtimeMin = parseRuntime(data.Runtime);
    if (runtimeMin !== undefined) attribute_values.runtime_minutes = runtimeMin;
    if (data.Type) attribute_values.media_type = data.Type;
    if (data.totalSeasons) attribute_values.total_seasons = parseInt(data.totalSeasons, 10);

    const integration_data: Record<string, unknown> = { raw: data };

    return { status: "complete", attribute_values, integration_data, cascade: true };
  }
}
