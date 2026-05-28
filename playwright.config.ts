import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT || "18081");

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure"
  },
  webServer: {
    command: "npm run start:web",
    env: {
      PORT: String(port),
      SPORTS_PROJECTOR_HISTORICAL_REFRESH_ENABLED: "false",
      SPORTS_PROJECTOR_LIVE_TRACKING_ENABLED: "false"
    },
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
    url: `http://127.0.0.1:${port}`
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
