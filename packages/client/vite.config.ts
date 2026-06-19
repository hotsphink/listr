import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import { readFileSync, existsSync } from "fs";

const certKey = new URL("../../certs/tailscale.key", import.meta.url);
const certCrt = new URL("../../certs/tailscale.crt", import.meta.url);

export default defineConfig(({ mode }) => {
  const https = existsSync(certKey)
    ? { key: readFileSync(certKey), cert: readFileSync(certCrt) }
    : undefined;

  return {
    base: mode === "production" ? "/listr/" : "/",
    plugins: [solidPlugin()],
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
  };
});
