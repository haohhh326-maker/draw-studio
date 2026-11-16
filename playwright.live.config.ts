import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/live",
  workers: 1,
  retries: 0,
  timeout: 30 * 60_000,
  reporter: "list",
  outputDir: "live-results/browser",
  use: {
    baseURL: "http://127.0.0.1:1420",
    channel: process.platform === "win32" ? "msedge" : undefined,
    viewport: { width: 1600, height: 1000 },
    headless: true,
  },
  webServer: {
    command: "npm run preview",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: true,
  },
});
