export type AttributeType =
  | "text"
  | "number"
  | "date"
  | "datetime"
  | "boolean"
  | "enum"
  | "tags"
  | "url"
  | "duration";

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

/** Config for a server-side integration, stored on Board or List (synced). */
export interface Integration {
  integration_id: string;           // matches a registered IntegrationModule on the server
  enabled: boolean;
  config?: Record<string, unknown>; // non-secret, integration-specific config
}

export interface Board {
  id: string;
  name: string;
  color: string;
  position: number;
  schema: AttributeDefinition[];
  format_string: string;
  macros?: Record<string, string>;
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
  format_string: string | null;
  /** null = inherit board's integrations */
  integrations?: Integration[] | null;
  view_mode: ViewMode;
  created_at: number;
  updated_at: number;
  /** Data-shape version this record was authored under. Missing = pre-versioning (treat as 1). */
  schema_version?: number;
}

export type IntegrationStatus = "unprocessed" | "complete" | "error" | "ambiguous";

/** Server-side integration result, keyed by "${item_id}:${integration_id}". */
export interface IntegrationResult {
  id: string;
  item_id: string;
  integration_id: string;
  sync_key: string;
  status: IntegrationStatus;
  /** Shadow copy of attribute values the integration wrote to item.attributes. */
  attribute_values: Record<string, unknown>;
  /** Arbitrary integration-internal state (candidates for disambiguation, etc.). */
  integration_data: Record<string, unknown>;
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
  attributes: Record<string, unknown>;
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
