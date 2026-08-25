/**
 * Dev/prod variant guard (§3.3 of work/auth-design.md): a dev client must
 * refuse to talk to a prod server and vice versa, so a misconfigured
 * endpoint can't write live data into the wrong world.
 *
 * A server that reports no `variant` at all is an older server that
 * predates this field. PROTOCOL_VERSION is deliberately not bumped for
 * this change, so that case is treated as unknown and allowed (with a
 * console warning at the call site) rather than rejected — otherwise a
 * freshly-updated client could never talk to a not-yet-updated server.
 */
export function variantAllowed(serverVariant: string | undefined, clientVariant: string): boolean {
  return serverVariant === undefined || serverVariant === clientVariant;
}
