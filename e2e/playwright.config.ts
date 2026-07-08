import { defineConfig, devices } from "@playwright/test";
import { SERVER_PORT, WEB_PORT } from "./ports";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  // Local cap: at the default worker count the suite flakes under machine
  // load — concurrent WebRTC DTLS handshakes starve and 1-5 rotating
  // "serverLink down" failures appear. 2 workers is reliably green. CI keeps
  // the playwright default (workers omitted; exactOptionalPropertyTypes
  // forbids an explicit undefined).
  ...(process.env.CI ? {} : { workers: 2 }),
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
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
      // Locally: --strictPort so a taken derived port fails loudly instead
      // of vite drifting to port+1 (that's this worktree's SERVER_PORT). In
      // CI the command stays byte-identical (vite's own default is 4173).
      command: process.env.CI
        ? "pnpm --filter @antiphon/web preview"
        : `pnpm --filter @antiphon/web preview --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      env: {
        // vite.config.ts preview proxy target for /api + WS (defaults to
        // :8787 when unset — dev and CI unchanged).
        ANTIPHON_SERVER_ORIGIN: `http://localhost:${SERVER_PORT}`,
      },
    },
    {
      // The real thing: Hono + node-datachannel + Postgres + blobs.
      command: "pnpm --filter @antiphon/server start",
      url: `http://localhost:${SERVER_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        DATABASE_URL:
          process.env.DATABASE_URL ?? "postgres://antiphon:antiphon@localhost:5433/antiphon",
        PORT: String(SERVER_PORT),
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
