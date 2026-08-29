/**
 * The default sync endpoint baked into the build. The app (github.io or a
 * custom domain) and the sync server are permanently different origins, so a
 * join link can omit a route entirely: a brand-new client with zero configured
 * endpoints still has somewhere to try when a join link's server hash matches
 * nothing already known.
 *
 * Picked by __VARIANT__, vite.config.ts's build-time define that also drives
 * the dev/prod handshake guard, so a dev build never defaults to production's
 * real server. `secure` follows a host-based rule: plain `ws://` only for
 * localhost, `wss://` for everything else. There is no reason for the
 * *default* to ever be an insecure host.
 *
 * Both hostnames below are verified against the live deployments: each answers
 * "Listr sync server running" on 443 and completes a WebSocket upgrade on
 * /sync, and a browser handshake against the dev one reaches `challenge` with
 * variant=dev. Re-check here if either sync server moves to another port.
 */

export interface DefaultEndpoint {
  host: string;
  port: number;
  secure: boolean;
}

export const DEFAULT_ENDPOINT: DefaultEndpoint =
  __VARIANT__ === "prod"
    ? { host: "listr-sync.aapx.org", port: 443, secure: true }
    : { host: "listr-dev-sync.aapx.org", port: 443, secure: true };
