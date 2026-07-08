// Environment configuration. Fail fast on missing/invalid values.

import { type LogLevel, parseLogLevel } from "./logger.ts";

export interface ServerConfig {
  port: number;
  databaseUrl: string;
  blob: { driver: "fs"; root: string } | { driver: "s3"; endpoint: string; bucket: string };
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
      sweepIntervalMs: envPositiveNumber("SESSION_SWEEP_INTERVAL_MS", 600_000),
    },
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when BLOB_DRIVER=s3`);
  return value;
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

function envPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}
