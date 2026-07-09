// Environment configuration. Fail fast on missing/invalid values.

import type { S3BlobConfig } from "./blob/index.ts";
import { type LogLevel, parseLogLevel } from "./logger.ts";

export interface ServerConfig {
  port: number;
  databaseUrl: string;
  blob: { driver: "fs"; root: string } | ({ driver: "s3" } & S3BlobConfig);
  logLevel: LogLevel;
  /** Allowed origins for /api/*; null = allow all (a startup warning is logged). */
  corsOrigins: string[] | null;
  /** Trust X-Forwarded-For for client IPs (enable behind a reverse proxy). */
  trustProxy: boolean;
  limits: {
    /** Join (WS upgrade) attempts per IP: sustained per minute + burst. */
    joinRatePerMin: number;
    joinBurst: number;
    /** Signaling messages per connection: sustained per second + burst. */
    msgRatePerSec: number;
    msgBurst: number;
    maxPeersPerSession: number;
    maxActiveSessions: number;
  };
  retention: {
    /** Idle sessions older than this are hard-deleted by the sweep. */
    sessionTtlHours: number;
    sweepIntervalMs: number;
  };
  collab: {
    /** Collab rooms with zero connections are evicted (doc flushed to
     * Postgres first) after this idle grace. */
    idleEvictMs: number;
  };
  /** Read for honesty, not for function: node-datachannel (libdatachannel/
   * libjuice underneath) exposes no external-address / 1:1-NAT hint, so the
   * server cannot advertise this IP as an ICE candidate. Setting it only
   * produces a startup WARN; NATed hosts stay unsupported (docs/deploy.md
   * §5). Kept in config so the day upstream grows the API, the plumbing —
   * and its tests — are already here. */
  webrtcPublicIp: string | null;
}

export function loadConfig(): ServerConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (see .env.example)");
  }
  const driver = process.env.BLOB_DRIVER ?? "fs";
  const blob =
    driver === "s3"
      ? {
          driver: "s3" as const,
          endpoint: required("S3_ENDPOINT"),
          bucket: required("S3_BUCKET"),
          region: process.env.S3_REGION ?? "auto",
          accessKeyId: required("S3_ACCESS_KEY_ID"),
          secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
          forcePathStyle: envFlag("S3_FORCE_PATH_STYLE"),
        }
      : { driver: "fs" as const, root: process.env.BLOB_FS_ROOT ?? "./data/blobs" };
  return {
    port: Number(process.env.PORT ?? 8787),
    databaseUrl,
    blob,
    logLevel: envLogLevel(),
    corsOrigins: envCorsOrigins(),
    trustProxy: process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true",
    limits: {
      joinRatePerMin: envPositiveNumber("JOIN_RATE_PER_MIN", 30),
      joinBurst: envPositiveNumber("JOIN_RATE_BURST", 10),
      msgRatePerSec: envPositiveNumber("SIGNALING_MSG_RATE_PER_SEC", 100),
      msgBurst: envPositiveNumber("SIGNALING_MSG_BURST", 200),
      maxPeersPerSession: envPositiveNumber("MAX_PEERS_PER_SESSION", 32),
      maxActiveSessions: envPositiveNumber("MAX_ACTIVE_SESSIONS", 200),
    },
    retention: {
      sessionTtlHours: envPositiveNumber("SESSION_TTL_HOURS", 720),
      sweepIntervalMs: envPositiveNumber("SESSION_SWEEP_INTERVAL_MS", 600_000, MAX_TIMER_MS),
    },
    collab: {
      idleEvictMs: envPositiveNumber("COLLAB_IDLE_EVICT_MS", 900_000, MAX_TIMER_MS), // 15 min
    },
    webrtcPublicIp: process.env.WEBRTC_PUBLIC_IP?.trim() || null,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when BLOB_DRIVER=s3`);
  return value;
}

/** Boolean env: "1"/"true" = on, anything else (or unset) = off. */
function envFlag(name: string): boolean {
  const raw = process.env[name];
  return raw === "1" || raw === "true";
}

function envLogLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  if (raw === undefined || raw === "") return "info";
  const level = parseLogLevel(raw);
  if (!level) throw new Error(`LOG_LEVEL must be debug|info|warn|error, got "${raw}"`);
  return level;
}

function envCorsOrigins(): string[] | null {
  const raw = process.env.CORS_ORIGINS;
  if (!raw) return null;
  const origins = raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return origins.length > 0 ? origins : null;
}

/** setTimeout/setInterval take a signed 32-bit ms delay; anything larger
 * overflows to ~1 ms — a "30-day grace" would evict immediately. Timer-
 * backed knobs pass this as `max` so a misconfiguration fails loudly at
 * boot instead of silently inverting its own meaning. ≈ 24.8 days. */
const MAX_TIMER_MS = 2_147_483_647;

function envPositiveNumber(name: string, fallback: number, max = Number.POSITIVE_INFINITY): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  if (value > max) {
    throw new Error(`${name} must be ≤ ${max} (32-bit timer ceiling, ~24.8 days), got "${raw}"`);
  }
  return value;
}
