// Env → config plumbing for the W5-A knobs. loadConfig reads process.env
// directly, so each case swaps a minimal env in and restores the original
// after — no Postgres, no server boot.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const BASE_ENV = {
  DATABASE_URL: "postgres://antiphon:antiphon@localhost:5433/antiphon",
};

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, BASE_ENV);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("WEBRTC_PUBLIC_IP plumbing", () => {
  it("defaults to null when unset — the supported topology needs no knob", () => {
    expect(loadConfig().webrtcPublicIp).toBeNull();
  });

  it("is read and trimmed when set (feeds the startup WARN, nothing else)", () => {
    process.env.WEBRTC_PUBLIC_IP = "  203.0.113.10  ";
    expect(loadConfig().webrtcPublicIp).toBe("203.0.113.10");
  });

  it("treats a whitespace-only value as unset", () => {
    process.env.WEBRTC_PUBLIC_IP = "   ";
    expect(loadConfig().webrtcPublicIp).toBeNull();
  });
});

describe("COLLAB_IDLE_EVICT_MS plumbing", () => {
  it("defaults to 15 minutes", () => {
    expect(loadConfig().collab.idleEvictMs).toBe(900_000);
  });

  it("honours an override", () => {
    process.env.COLLAB_IDLE_EVICT_MS = "60000";
    expect(loadConfig().collab.idleEvictMs).toBe(60_000);
  });

  it("rejects a non-positive value", () => {
    process.env.COLLAB_IDLE_EVICT_MS = "0";
    expect(() => loadConfig()).toThrow(/COLLAB_IDLE_EVICT_MS/);
  });

  it("rejects values past the 32-bit timer ceiling (setTimeout overflows to ~1 ms)", () => {
    process.env.COLLAB_IDLE_EVICT_MS = "2592000000"; // "30 days" would evict instantly
    expect(() => loadConfig()).toThrow(/timer ceiling/);
  });

  it("accepts the ceiling itself", () => {
    process.env.COLLAB_IDLE_EVICT_MS = "2147483647";
    expect(loadConfig().collab.idleEvictMs).toBe(2_147_483_647);
  });
});

describe("timer-backed knobs share the ceiling", () => {
  it("SESSION_SWEEP_INTERVAL_MS has the same silent-overflow failure mode", () => {
    process.env.SESSION_SWEEP_INTERVAL_MS = "9999999999";
    expect(() => loadConfig()).toThrow(/timer ceiling/);
  });
});
