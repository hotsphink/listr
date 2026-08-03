import type { IntegrationModule } from "./types.js";
import { OmdbIntegration } from "./omdb.js";

export const INTEGRATIONS = new Map<string, IntegrationModule>([
  ["omdb", new OmdbIntegration()],
]);

export type { IntegrationModule };
