import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import { readFileSync, writeFileSync, existsSync } from "fs";

const certKey = new URL("../../certs/tailscale.key", import.meta.url);
const certCrt = new URL("../../certs/tailscale.crt", import.meta.url);

export default defineConfig(({ mode }) => {
  const https = !process.env.VITE_NO_HTTPS && existsSync(certKey)
    ? { key: readFileSync(certKey), cert: readFileSync(certCrt) }
    : undefined;

  return {
    base: "/",
    plugins: [
      solidPlugin(),
      // Stamp dist/sw.js with the build time so the browser detects a new
      // service worker and triggers an update on next page load.
      // Default: on for non-production builds, off for production.
      // Override: STAMP_SW=1 forces on, STAMP_SW=0 forces off.
      (process.env.STAMP_SW ? process.env.STAMP_SW === "1" : mode !== "production") && {
        name: "stamp-sw",
        apply: "build" as const,
        closeBundle() {
          const swUrl = new URL("dist/sw.js", import.meta.url);
          if (existsSync(swUrl)) {
            const sw = readFileSync(swUrl, "utf8");
            writeFileSync(swUrl, sw.replace('"listr-v1"', `"listr-v${Date.now()}"`));
          }
        },
      },
      // Swap in the dev favicon/app icon/manifest so the `pnpm dev` tab and
      // installed PWA are visually distinct from a production instance.
      {
        name: "dev-icons",
        apply: "serve" as const,
        transformIndexHtml(html: string) {
          return html
            .replace(/favicon\.png/g, "favicon-dev.png")
            .replace(/icons\/icon-192x192\.png/g, "favicon-dev.png")
            .replace(/icons\/icon-512x512\.png/g, "favicon-dev.png")
            .replace(/icons\/icon-180x180\.png/g, "favicon-dev.png")
            .replace("manifest.json", "manifest-dev.json")
            .replace("Listr Listenator", "Listr Listenator (Dev)")
            .replace("<title>Listr</title>", "<title>Listr (Dev)</title>");
        },
      },
    ],
    server: {
      port: 3000,
      host: true,
      allowedHosts: true,
      https,
      hmr: https ? { protocol: "wss" } : true,
    },
    build: {
      target: "esnext",
    },
    resolve: {
      conditions: ["development", "browser"],
    },
    define: {
      // Stamped at config-eval time: build time for production builds, dev-server
      // start time in development. Surfaced on the admin page.
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      // Which world this client is built for (dev/prod/…) — compared against
      // the server's own `variant` in the sync handshake (§3.3 of
      // work/auth-design.md) so a dev client refuses a prod server and vice
      // versa. LISTR_VARIANT overrides; otherwise a production build is
      // "prod" and everything else (dev server, unlabeled builds) is "dev".
      __VARIANT__: JSON.stringify(process.env.LISTR_VARIANT ?? (mode === "production" ? "prod" : "dev")),
    },
  };
});
