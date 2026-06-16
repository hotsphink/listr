import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "https://localhost:3000",
    browserName: "firefox",
    ignoreHTTPSErrors: true,
  },
  webServer: {
    command: "npm run dev",
    url: "https://localhost:3000",
    reuseExistingServer: true,
    ignoreHTTPSErrors: true,
  },
});
