// Range of sync protocol versions this server understands (inclusive).
// A client announces the version it speaks in its `hello` message; if that
// version is outside [MIN, MAX] the server rejects the connection.
//
// Clients that predate protocol versioning send no version and are treated as
// version 0 — reject them by keeping MIN >= 1.
//
// Keep in sync with the client's PROTOCOL_VERSION
// (packages/client/src/sync/protocol.ts).
export const MIN_PROTOCOL_VERSION = 1;
export const MAX_PROTOCOL_VERSION = 1;
