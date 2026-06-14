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

export interface Category {
  id: string;
  name: string;
  color: string;
  position: number;
  schema: AttributeDefinition[];
  format_string: string;
  macros?: Record<string, string>;
  created_at: number;
  updated_at: number;
}

export type ViewMode = "list" | "table" | "board" | "card";

export interface List {
  id: string;
  category_id: string;
  name: string;
  icon: string;
  position: number;
  format_string: string | null;
  view_mode: ViewMode;
  created_at: number;
  updated_at: number;
}

export interface Item {
  id: string;
  list_id: string;
  title: string;
  position: number;
  created_at: number;
  updated_at: number;
  attributes: Record<string, unknown>;
}
