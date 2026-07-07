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

export interface Board {
  id: string;
  name: string;
  color: string;
  position: number;
  schema: AttributeDefinition[];
  format_string: string;
  macros?: Record<string, string>;
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
  view_mode: ViewMode;
  created_at: number;
  updated_at: number;
  /** Data-shape version this record was authored under. Missing = pre-versioning (treat as 1). */
  schema_version?: number;
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
