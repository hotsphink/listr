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
 * ASSUMPTION, not verified against a live deployment: the hostnames below
 * come from index.ts's ALLOWED_ORIGINS list (listr-sync.aapx.org for prod,
 * listr-dev.aapx.org for dev), both on the default 443. If either sync
 * server actually listens on a different port, update here.
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
