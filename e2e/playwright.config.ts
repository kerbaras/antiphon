import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Fake mic (sine tone) so capture-path tests run headless in CI.
        launchOptions: {
          args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
        },
      },
    },
    // Mobile Safari is the hostile baseline for the phone recorder.
    { name: "mobile-safari", use: { ...devices["iPhone 15"] } },
  ],
  webServer: [
    {
      command: "pnpm --filter @antiphon/web preview",
      url: "http://localhost:4173",
      reuseExistingServer: !process.env.CI,
    },
    {
      // The real thing: Hono + node-datachannel + Postgres + blobs.
      command: "pnpm --filter @antiphon/server start",
      url: "http://localhost:8787/health",
      reuseExistingServer: !process.env.CI,
      env: {
        DATABASE_URL:
          process.env.DATABASE_URL ?? "postgres://antiphon:antiphon@localhost:5433/antiphon",
        PORT: "8787",
        BLOB_DRIVER: "fs",
        BLOB_FS_ROOT: "./data/e2e-blobs",
        // Every join in the suite comes from 127.0.0.1: production per-IP
        // join limits (30/min) would starve late-scheduled tests. The
        // limiter has its own coverage in hardening.integration.test.ts.
        JOIN_RATE_PER_MIN: "6000",
        JOIN_RATE_BURST: "1000",
      },
    },
  ],
});
