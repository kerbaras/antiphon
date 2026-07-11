import { defineConfig, devices } from "@playwright/test";
import { SERVER_PORT, WEB_PORT } from "./ports";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // CI: inline github annotations plus an HTML report (self-contained, traces
  // embedded) that the workflow uploads as an artifact when the job fails.
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // Worker caps: at the default worker count the suite flakes under machine
  // load — concurrent WebRTC DTLS handshakes starve and 1-5 rotating
  // "serverLink down" failures appear. 2 workers is reliably green locally.
  // CI pins 1: on shared 4-vCPU runners two concurrent signal suites starve
  // each other (archive/declared drift, missed onsets in live playback taps).
  workers: process.env.CI ? 1 : 2,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      // live-clerk is env-gated and NOT part of the default suite: it
      // boots its own auth-enabled server (real Clerk keys) and would be
      // 100% skips here anyway.
      testIgnore: /live-clerk\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        // Fake mic (sine tone) so capture-path tests run headless in CI.
        launchOptions: {
          args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
        },
      },
    },
    // Mobile Safari is the hostile baseline for the phone recorder. Capture
    // journeys self-skip off-chromium (fake mic is Chromium-only), so scope
    // this project to the specs that genuinely exercise webkit — app boot /
    // cross-origin isolation (smoke) and QR decode (qr) — instead of
    // launching-and-skipping the other twelve.
    {
      name: "mobile-safari",
      testMatch: /(smoke|qr)\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
    // W8-A live-Clerk journey against the real dev instance: run with
    //   CLERK_SECRET_KEY=… CLERK_PUBLISHABLE_KEY=… \
    //     pnpm exec playwright test --project=live-clerk
    // Self-skips without keys (so a bare `playwright test` stays green in
    // CI); never in --project=chromium runs. Fake mic: the journey proves
    // an accountless phone can record into an auth-gated session.
    {
      name: "live-clerk",
      testMatch: /live-clerk\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
        },
      },
    },
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
        // KEYLESS PIN (W8-A): the server boots with --env-file-if-exists,
        // and a developer worktree's apps/server/.env can carry REAL Clerk
        // keys — which would flip auth ON and fail the whole keyless
        // suite. Explicit empty strings win over the env file (Node:
        // environment beats --env-file) and read as unset (config.ts), so
        // this suite is deterministically keyless everywhere. Auth runs
        // live in the separate env-gated live-clerk project only.
        CLERK_SECRET_KEY: "",
        CLERK_PUBLISHABLE_KEY: "",
      },
    },
  ],
});
