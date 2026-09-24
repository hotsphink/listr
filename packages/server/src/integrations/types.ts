import type { AttributeType, IntegrationChoice, IntegrationStatus, Item } from "@listr/shared";
import type { IntegrationServerConfig } from "../config.js";

export interface IntegrationRunResult {
  status: Exclude<IntegrationStatus, "unprocessed" | "error">;
  /** Attribute key to value. Values are coerced to the module's declared types, and undeclared keys are dropped. */
  attribute_values: Record<string, unknown>;
  /** Arbitrary integration-internal state. */
  integration_data?: Record<string, unknown>;
  /** Pickable options, keyed by the attribute they fill. */
  choices?: Record<string, IntegrationChoice>;
  /** When this result goes stale. Omit to never refresh. */
  refresh_at?: number;
}

export interface IntegrationRunContext {
  item: Item;
  /** Output of inputsOf for this run. */
  inputs: Record<string, unknown>;
  /** Parsed board-level TOML config. */
  config: Record<string, unknown>;
  serverConfig: IntegrationServerConfig;
  /** Fetch with the server's timeout and daily budget applied. Use it for every external call. */
  fetch: (url: string) => Promise<Response>;
  now: number;
}

export interface IntegrationModule {
  readonly id: string;
  readonly name: string;
  /** Attributes this module can fill, with the types its values are coerced to. */
  readonly attributes: { key: string; type: AttributeType; label: string }[];
  /** TOML listing every board-level setting with its default commented out. */
  readonly configTemplate: string;
  /** Defaults for server-side settings the server config leaves unset. */
  readonly serverDefaults?: Partial<IntegrationServerConfig>;

  /** Whether the module can run with this server config, for example whether it has an API key. */
  isActive(serverConfig: IntegrationServerConfig): boolean;

  /**
   * Everything a run depends on, or null when there is nothing to look up.
   * The runner reruns only when this changes. `item` holds user values only,
   * and `effective` has other integrations' overlay applied.
   */
  inputsOf(item: Item, effective: Item, config: Record<string, unknown>): Record<string, unknown> | null;

  /** Look the item up. Throw on failures worth retrying. */
  run(ctx: IntegrationRunContext): Promise<IntegrationRunResult>;
}
