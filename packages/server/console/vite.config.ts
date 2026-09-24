import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import { existsSync, readFileSync } from "node:fs";

const certKey = new URL("../../../certs/tailscale.key", import.meta.url);
const certCrt = new URL("../../../certs/tailscale.crt", import.meta.url);

// `pnpm console:dev` serves the console with hot reload and proxies the API
// to a running sync server, the dev one on :10443 unless LISTR_CONSOLE_API
// says otherwise. Proxying keeps the session cookie same-origin.
export default defineConfig(() => {
  const https = !process.env.VITE_NO_HTTPS && existsSync(certKey)
    ? { key: readFileSync(certKey), cert: readFileSync(certCrt) }
    : undefined;
  return {
    root: new URL(".", import.meta.url).pathname,
    base: "/console/",
    plugins: [solidPlugin()],
    server: {
      port: 3200,
      host: true,
      allowedHosts: true,
      https,
      proxy: {
        "/console/api": {
          target: process.env.LISTR_CONSOLE_API ?? "https://localhost:10443",
          secure: false,
        },
      },
    },
    build: {
      target: "es2022",
      outDir: "dist",
      emptyOutDir: true,
    },
    resolve: {
      conditions: ["development", "browser"],
    },
  };
});
