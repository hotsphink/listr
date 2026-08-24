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
// v4: server-side user/key-group tracking. hello requires a `default_key` field
// identifying "the user"; the server persists which other keys have been used
// together with that default_key (table `user_keys`) and returns the full known
// set via `ok.user_keys`, so any of a user's devices converges on the same set
// of boards/board-groups. New `associate_key`/`leave_key` message types let a
// client explicitly label a key (e.g. name a board group) or drop an
// association (e.g. leaving a shared board removes it from all your devices).
// Flag day: MIN bumped to 4 so pre-v4 clients (no default_key) are rejected
// outright rather than silently missing out on cross-device sync.
export const MIN_PROTOCOL_VERSION: number = 4;
export const MAX_PROTOCOL_VERSION: number = 4;
