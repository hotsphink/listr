// Sync protocol version this client speaks. Sent to the server in the `hello`
// handshake. The server advertises a range of versions it understands and
// rejects the connection if this version falls outside that range.
//
// Bump this whenever the wire protocol changes in a way that is not backward
// compatible with older servers. Keep the server's supported range
// (packages/server/src/protocol.ts) in sync.
export const PROTOCOL_VERSION = 1;
