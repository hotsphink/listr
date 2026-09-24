// Wire types for the sync server's operator console (/console/api). Sync keys
// are bearer secrets, so the console only ever sees a short tag of each one.

export type ConsoleUserState = "active" | "suspended" | "revoked";

// -- Overview ---------------------------------------------------------------

export interface ConsoleOverview {
  variant: string;
  started_at: number;
  users: number;
  clients_registered: number;
  clients_connected: number;
  integrations: { id: string; name: string; healthy: boolean }[];
  cert_days_left: number | null;
}

// -- Trust graph --------------------------------------------------------------

export interface ConsoleUser {
  user_id: string;
  display_name: string | null;
  authorized_by: string | null;
  note: string | null;
  caps: string[];
  state: ConsoleUserState;
  effective_state: ConsoleUserState;
  provisional: boolean;
  created_at: number;
  home_key_tag: string;
  device_count: number;
  key_count: number;
}

export interface ConsoleDevice {
  client_id: string;
  user_id: string;
  label: string | null;
  created_at: number;
  last_seen: number | null;
  connected: boolean;
}

export type ConsoleGrantStatus = "outstanding" | "expired" | "used" | "burned";

export interface ConsoleGrant {
  id: string;
  kind: string;
  issuer_user_id: string;
  caps: string[] | null;
  key_tag: string | null;
  key_name: string | null;
  greeting: string | null;
  expires_at: number;
  uses_remaining: number;
  attempts: number;
  created_at: number;
  status: ConsoleGrantStatus;
  redemptions: { at: number; user_id: string; client_id: string | null }[];
}

export interface ConsoleKeyHolder {
  user_id: string;
  /** "home", "grant:<id>", "declared", "associated", "cli", or null when unknown. */
  source: string | null;
  name: string | null;
}

export interface ConsoleKey {
  tag: string;
  name: string | null;
  boards: number;
  lists: number;
  items: number;
  holders: ConsoleKeyHolder[];
}

export interface ConsoleTrust {
  root_user_id: string | null;
  users: ConsoleUser[];
  devices: ConsoleDevice[];
  grants: ConsoleGrant[];
  keys: ConsoleKey[];
}

export interface ConsoleAuthEvent {
  id: number;
  at: number;
  kind: string;
  actor_user_id: string | null;
  subject_user_id: string | null;
  detail: string | null;
}

export interface ConsoleUserDetail {
  user: ConsoleUser;
  devices: ConsoleDevice[];
  keys: { tag: string; name: string | null; source: string | null }[];
  grants_issued: ConsoleGrant[];
  /** Grants this user redeemed. */
  redeemed: ConsoleGrant[];
  events: ConsoleAuthEvent[];
}

// -- Integrations -------------------------------------------------------------

export interface ConsoleSeries {
  /** Start of the first bucket. */
  start: number;
  bucket_ms: number;
  values: number[];
}

export interface ConsoleIntegrationModule {
  id: string;
  name: string;
  active: boolean;
  queued_edit: number;
  queued_refresh: number;
  running: number;
  max_concurrent: number;
  calls_today: number;
  daily_limit: number | null;
  top_keys: { key_tag: string; count: number }[];
  daily_limit_per_key: number | null;
  /** The daily counts started after the last UTC midnight, so they cover less than the day. */
  counts_since_restart: boolean;
  calls_per_minute: ConsoleSeries;
  errors_per_minute: ConsoleSeries;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  results: { by_status: Record<string, number>; quota_waits: number; retries_pending: number; refreshes_due: number };
  /** Set while daily_limit is exhausted: when the budget resets. */
  quota_resets_at: number | null;
  errors_last_5m: number;
}

export interface ConsoleImportStats {
  configured: boolean;
  tiers: string[][];
  calls: number;
  ok: number;
  failed: number;
  calls_per_minute: ConsoleSeries;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  last_error: string | null;
  last_at: number | null;
}

export interface ConsoleIntegrations {
  modules: ConsoleIntegrationModule[];
  import: ConsoleImportStats;
}

export type ConsoleRunOutcome =
  | "running" | "complete" | "not_found" | "ambiguous" | "error" | "quota" | "stale" | "config_error";

export interface ConsoleRunSummary {
  id: number;
  module: string;
  item_id: string;
  key_tag: string;
  priority: string;
  started_at: number;
  duration_ms: number | null;
  request_count: number;
  outcome: ConsoleRunOutcome;
  error: string | null;
}

export interface ConsoleRequest {
  method: string;
  url: string;
  request_headers: Record<string, string>;
  started_at: number;
  duration_ms: number | null;
  status: number | null;
  response_headers: Record<string, string> | null;
  body: string | null;
  body_bytes: number | null;
  body_truncated: boolean;
  /** Evicted to stay within the capture budget. */
  body_dropped: boolean;
  error: string | null;
}

export interface ConsoleRunDetail extends ConsoleRunSummary {
  board_id: string;
  attempt: number;
  inputs: unknown;
  requests: ConsoleRequest[];
  output: {
    status: string;
    raw_values: Record<string, unknown>;
    attribute_values: Record<string, unknown>;
    dropped: string[];
    choices: unknown;
    refresh_at: number | null;
  } | null;
  result_before: unknown;
  result_after: unknown;
  broadcast: boolean;
}

// -- Ports --------------------------------------------------------------------

export interface ConsoleCert {
  subject: string;
  issuer: string;
  sans: string[];
  valid_to: number;
  days_left: number;
}

export interface ConsoleExternalProbe {
  url: string;
  ok: boolean;
  status: number | null;
  error: string | null;
  cert: ConsoleCert | null;
  checked_at: number;
}

export interface ConsolePorts {
  variant: string;
  server_id: string;
  started_at: number;
  listeners: { address: string; port: number; protocol: "http" | "https"; routes: string[] }[];
  cert: ConsoleCert | null;
  cert_error: string | null;
  websockets_open: number;
  per_ip: { ip: string; count: number }[];
  rejected_upgrades: Record<string, number>;
  rate_limit_closes: number;
  allowed_origins: string[];
  external: ConsoleExternalProbe[];
}

// -- Clients ------------------------------------------------------------------

export type ConsoleConnState = "connecting" | "challenged" | "needs_grant" | "authenticated" | "closed";

export interface ConsoleClientRow {
  /** Null for a socket that never sent a usable hello. */
  client_id: string | null;
  conn_id: number | null;
  registered: boolean;
  label: string | null;
  user_id: string | null;
  user_name: string | null;
  effective_state: ConsoleUserState | null;
  sockets: number;
  connected_since: number | null;
  last_seen: number | null;
  conn_state: ConsoleConnState | null;
  protocol: number | null;
  ip: string | null;
  origin: string | null;
  user_agent: string | null;
  keys: number;
  msgs_in_per_min: number;
  msgs_out_per_min: number;
}

export interface ConsoleClients {
  counts: { registered: number; connected: number; unauthenticated: number; failed_auth_last_hour: number };
  rows: ConsoleClientRow[];
}

export interface ConsoleConnection {
  id: number;
  client_id: string | null;
  ip: string;
  origin: string | null;
  user_agent: string | null;
  opened_at: number;
  closed_at: number | null;
  close_code: number | null;
  close_reason: string | null;
  protocol: number | null;
  state: ConsoleConnState;
}

export interface ConsoleMessageLogEntry {
  at: number;
  dir: "in" | "out";
  type: string;
  bytes: number;
  detail: string | null;
}

export interface ConsolePull {
  at: number;
  keys: number;
  counts: Record<string, number>;
}

export interface ConsoleClientDetail {
  client: {
    client_id: string;
    pubkey_jwk: unknown;
    label: string | null;
    created_at: number;
    last_seen: number | null;
    user_id: string;
    user_name: string | null;
    effective_state: ConsoleUserState | null;
    registered_by_grant: string | null;
  } | null;
  client_id: string | null;
  connections: ConsoleConnection[];
  keys: { tag: string; name: string | null; since: number | null }[];
  traffic: { in: Record<string, number>; out: Record<string, number>; pushes: Record<string, number>; bytes_in: number; bytes_out: number };
  pulls: ConsolePull[];
  tokens: { at: number; level: number }[];
  token_burst: number;
  log: ConsoleMessageLogEntry[];
  errors: { at: number; message: string; reason: string | null }[];
}

// -- Live stream ----------------------------------------------------------------

export type ConsoleTopic =
  | "trust"
  | "integration.run"
  | "integration.stats"
  | "client.connect"
  | "client.disconnect"
  | "client.stats"
  | "ports.stats";

export interface ConsoleSession {
  authenticated: boolean;
}
