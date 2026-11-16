import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:1420",
    channel: process.platform === "win32" ? "msedge" : undefined,
    viewport: { width: 1600, height: 1000 },
    headless: true,
  },
  reporter: "list",
  webServer: {
    command: "npm run preview",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: true,
  },
});
