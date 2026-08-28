/**
 * The baked-in default sync endpoint (auth-design.md §7.3a: "bake a default
 * endpoint into the build" — settled after the app (github.io / a custom
 * domain) and the sync server turned out to be permanently different
 * origins). This is what lets a join link omit a route entirely (§7.3a-bis):
 * a brand-new client with zero configured endpoints still has somewhere to
 * try when a join link's server hash doesn't match anything already known.
 *
 * Picked by __VARIANT__ (vite.config.ts's build-time define, already used
 * for the dev/prod handshake guard) so a dev build never defaults to
 * production's real server. `secure` follows the same host-based rule
 * AdminPage's per-endpoint TLS toggle used to encode by hand (§7.3, [sf3]):
 * plain `ws://` only for localhost, `wss://` for everything else — there is
 * no reason for the *default* to ever be a manually-added insecure host.
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
