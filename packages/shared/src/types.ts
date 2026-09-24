export type AttributeType =
  | "text"
  | "number"
  | "integer"
  | "date"
  | "datetime"
  | "boolean"
  | "enum"
  | "tags"
  | "url"
  | "duration"
  | "todo";

export type TodoState = "default" | "done" | "cancelled" | "skipped";

export interface AutoBehavior {
  trigger: "on_create" | "on_update" | "on_demand" | "periodic";
  source: "timestamp" | "scraper" | "computed";
  config?: Record<string, unknown>;
}

export interface AttributeDefinition {
  key: string;
  label: string;
  type: AttributeType;
  required: boolean;
  default_value?: unknown;
  auto?: AutoBehavior;
  options?: string[];
  config?: Record<string, unknown>;
  position: number;
}

/** A board or list display format, in the language described in doc/FORMAT.md. */
export interface FormatSpec {
  /** Format language version. Version 1 was the legacy `{key}` syntax. */
  version: number;
  text: string;
}

/** Config for a server-side integration, stored on Board (synced). */
export interface Integration {
  /** Matches a registered IntegrationModule on the server. */
  integration_id: string;
  enabled: boolean;
  /** Non-secret, integration-specific settings as TOML text, kept as written so comments survive. */
  config?: string;
}

/** What a server advertises about one of its integration modules. */
export interface IntegrationInfo {
  id: string;
  name: string;
  /** Attributes the module can fill, with the types it produces. */
  attributes: { key: string; type: AttributeType; label: string }[];
  /** TOML listing every setting with its default commented out. */
  config_template: string;
  /** False when the module can't run right now, for example a missing API key. */
  active: boolean;
}

export interface Board {
  id: string;
  name: string;
  color: string;
  position: number;
  schema: AttributeDefinition[];
  format: FormatSpec;
  /** If set, this board (and its lists/items) syncs under this namespace key instead of the default. */
  sync_key?: string;
  integrations?: Integration[];
  created_at: number;
  updated_at: number;
  /** Data-shape version this record was authored under. Missing = pre-versioning (treat as 1). */
  schema_version?: number;
}

export type ViewMode = "list" | "table" | "card";

export interface List {
  id: string;
  board_id: string;
  name: string;
  icon: string;
  position: number;
  /** null = use the board's format. An override replaces it entirely. */
  format: FormatSpec | null;
  view_mode: ViewMode;
  created_at: number;
  updated_at: number;
  /** Data-shape version this record was authored under. Missing = pre-versioning (treat as 1). */
  schema_version?: number;
}

export type IntegrationStatus = "unprocessed" | "complete" | "error" | "not_found" | "ambiguous";

/** A set of values a user can pick from for one attribute. */
export interface IntegrationChoice {
  options: { value: string; label: string }[];
  /** Hash of the option values. A pick is valid only while this matches. */
  options_key: string;
  /** User attributes a pick hands back to the integration, such as a typed title that was only a query. */
  releases?: string[];
}

/** A user's pick from an IntegrationChoice, stored on the item. */
export interface ItemChoice {
  value: string;
  options_key: string;
  /** The released user values, kept as the lookup's input. */
  query?: Record<string, unknown>;
}

/**
 * Server-side integration result, keyed by "${item_id}:${integration_id}".
 * Its attribute_values are laid over the item when read (see effectiveValue)
 * and are never copied into the item.
 */
export interface IntegrationResult {
  id: string;
  item_id: string;
  integration_id: string;
  status: IntegrationStatus;
  /** Everything the integration produced, keyed by attribute. */
  attribute_values: Record<string, unknown>;
  /** Arbitrary integration-internal state. */
  integration_data: Record<string, unknown>;
  /** Pickable options, keyed by the attribute they fill. */
  choices?: Record<string, IntegrationChoice>;
  error?: string;
  created_at: number;
  updated_at: number;
}

export interface Item {
  id: string;
  list_id: string;
  title: string;
  /** ID of the item this item follows in the list (null = first). Replaces numeric position. */
  after_id: string | null;
  created_at: number;
  updated_at: number;
  /** User-set attributes only. Integration values are overlaid when read. */
  attributes: Record<string, unknown>;
  /** User picks from integration choices, keyed by attribute. */
  choices?: Record<string, ItemChoice>;
  /** Data-shape version this record was authored under. Missing = pre-versioning (treat as 1). */
  schema_version?: number;
}

export interface Asset {
  id: string;        // first 20 hex chars of SHA-256(data)
  data: Uint8Array;  // binary content
  mime_type: string;
  ext: string;
  filename: string;
  size: number;
  created_at: number;
  updated_at: number;
}
