// Range of sync protocol versions this server understands (inclusive).
// A client announces the version it speaks in its `hello` message; if that
// version is outside [MIN, MAX] the server rejects the connection.
//
// Clients that predate protocol versioning send no version and are treated as
// version 0 — reject them by keeping MIN >= 1.
//
// Keep in sync with the client's PROTOCOL_VERSION
// (packages/client/src/sync/protocol.ts).
// v2: items use `after_id` linked-list ordering instead of numeric `position`.
// MIN is 2 so old position-format clients can't push into an after_id server and
// corrupt shared ordering (the flag-day gate; see memory project_data_format_versioning).
// v3: multi-key sync — hello sends `keys[]`, push_entity/push_delete carry `sync_key`.
export const MIN_PROTOCOL_VERSION: number = 2;
export const MAX_PROTOCOL_VERSION: number = 3;
