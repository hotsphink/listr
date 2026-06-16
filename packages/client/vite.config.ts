import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import { readFileSync } from "fs";

export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    port: 3000,
    host: true,
    https: {
      key: readFileSync(new URL("../../certs/tailscale.key", import.meta.url)),
      cert: readFileSync(new URL("../../certs/tailscale.crt", import.meta.url)),
    },
  },
  build: {
    target: "esnext",
  },
  resolve: {
    conditions: ["development", "browser"],
  },
});
