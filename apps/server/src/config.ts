// Environment configuration. Fail fast on missing required values.

export interface ServerConfig {
  port: number;
  databaseUrl: string;
  blob: { driver: "fs"; root: string } | { driver: "s3"; endpoint: string; bucket: string };
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
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when BLOB_DRIVER=s3`);
  return value;
}
