/**
 * Dev/prod variant guard: a dev client must refuse to talk to a prod server
 * and vice versa, so a misconfigured endpoint cannot write live data into the
 * wrong world.
 *
 * A server that reports no `variant` at all is running an older build without
 * the field. PROTOCOL_VERSION deliberately does not gate this, so that case is
 * treated as unknown and allowed, with a console warning at the call site,
 * rather than rejected. Rejecting it would stop an updated client from ever
 * talking to a server that has not been updated yet.
 */
export function variantAllowed(serverVariant: string | undefined, clientVariant: string): boolean {
  return serverVariant === undefined || serverVariant === clientVariant;
}
