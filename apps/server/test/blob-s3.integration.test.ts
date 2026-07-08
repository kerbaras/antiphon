// S3 blob driver against a real MinIO (docker compose up -d minio). Two
// layers: the driver contract in isolation, then the whole server stack
// (real WS + WebRTC + WASM recorder) writing takes into MinIO instead of
// the filesystem. Skipped when MinIO (localhost:9100) or Postgres
// (TEST_DATABASE_URL) is unreachable.

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlobNotFoundError, type S3BlobConfig, S3BlobStore } from "../src/blob/index.ts";
import {
  FakeDesk,
  FakeRecorder,
  pollUntil,
  sine,
  startTestServer,
  type TestServer,
  takeSummary,
} from "./helpers.ts";

const MINIO_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? "http://localhost:9100";
const MINIO_CREDS = {
  region: "us-east-1",
  accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "antiphon",
  secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "antiphon-secret",
  forcePathStyle: true,
};
const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://antiphon:antiphon@localhost:5433/antiphon";

function s3Config(bucket: string): S3BlobConfig {
  return { endpoint: MINIO_ENDPOINT, bucket, ...MINIO_CREDS };
}

let minioUp = true;
try {
  await fetch(`${MINIO_ENDPOINT}/minio/health/live`, { signal: AbortSignal.timeout(3_000) });
} catch {
  minioUp = false;
}
let pgUp = true;
try {
  const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
} catch {
  pgUp = false;
}

const driverSuite = minioUp ? describe : describe.skip;
const stackSuite = minioUp && pgUp ? describe : describe.skip;

async function freshDatabase(name: string): Promise<string> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  return ADMIN_URL.replace(/\/[^/]+$/, `/${name}`);
}

async function listKeys(bucket: string, prefix?: string): Promise<string[]> {
  const client = new S3Client({
    endpoint: MINIO_ENDPOINT,
    region: MINIO_CREDS.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: MINIO_CREDS.accessKeyId,
      secretAccessKey: MINIO_CREDS.secretAccessKey,
    },
  });
  const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  client.destroy();
  return (res.Contents ?? []).map((o) => o.Key ?? "").filter((k) => k.length > 0);
}

driverSuite("S3BlobStore driver against MinIO", () => {
  const bucket = `antiphon-test-${crypto.randomUUID().slice(0, 8)}`;
  const store = new S3BlobStore(s3Config(bucket));

  it("ensureBucket creates a missing bucket and tolerates re-runs", async () => {
    await store.ensureBucket(); // creates
    await store.ensureBucket(); // HeadBucket hit, no-op
  });

  it("put/get round-trips bytes exactly", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(1024));
    await store.put("take/stream/0", bytes);
    expect(await store.get("take/stream/0")).toEqual(bytes);
  });

  it("get on a missing key rejects with BlobNotFoundError (fs-driver parity)", async () => {
    await expect(store.get("no/such/key")).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("delete removes the object and is idempotent", async () => {
    await store.put("take/stream/1", new Uint8Array([1, 2, 3]));
    await store.delete("take/stream/1");
    await expect(store.get("take/stream/1")).rejects.toBeInstanceOf(BlobNotFoundError);
    await store.delete("take/stream/1"); // second delete: no error
  });

  it("ensureBucket fails fast on an unreachable endpoint", async () => {
    const dead = new S3BlobStore({ ...s3Config(bucket), endpoint: "http://localhost:1" });
    await expect(dead.ensureBucket()).rejects.toThrow(/unreachable/);
  });
});

stackSuite("full stack on the s3 driver (MinIO)", () => {
  const bucket = `antiphon-stack-${crypto.randomUUID().slice(0, 8)}`;
  let server: TestServer;

  beforeAll(async () => {
    const dbUrl = await freshDatabase("antiphon_it_s3");
    server = await startTestServer(dbUrl, "/unused", {
      blob: { driver: "s3", ...s3Config(bucket) },
    });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("records a take into MinIO, serves FLAC, reports blob health, hard-deletes", async () => {
    const { sessionId } = (await (
      await fetch(`${server.baseUrl}/api/sessions`, { method: "POST" })
    ).json()) as { sessionId: string };

    const desk = new FakeDesk(server.baseUrl, sessionId);
    await desk.join();
    const recorder = new FakeRecorder(server.baseUrl, sessionId);
    await recorder.join();
    await recorder.connectDataChannel();

    const takeId = crypto.randomUUID();
    const streamId = crypto.randomUUID();
    const started = new Promise<void>((resolve) => {
      recorder.onTakeStart(() => {
        recorder.arm(takeId, streamId);
        resolve();
      });
    });
    desk.takeStart(takeId);
    await started;

    recorder.pushAudio(sine(1.5));
    const finalSeq = recorder.finish(takeId, streamId);
    desk.takeStop(takeId);
    await recorder.waitDrained();
    await pollUntil(
      () => takeSummary(server.baseUrl, sessionId, takeId),
      (s) => s.length === 1 && (s[0]?.complete ?? false),
      "archive complete on s3",
    );

    // Chunk objects actually landed in MinIO under takeId/streamId/seq.
    const keys = await listKeys(bucket, `${takeId}/${streamId}/`);
    expect(keys.length).toBe(finalSeq + 1);

    // FLAC reconstruction reads back through the S3 driver.
    const flacRes = await fetch(`${server.baseUrl}/api/streams/${streamId}/flac`);
    expect(flacRes.status).toBe(200);
    const flac = new Uint8Array(await flacRes.arrayBuffer());
    expect(String.fromCharCode(...flac.subarray(0, 4))).toBe("fLaC");

    // /health round-trips the blob store (put/get/delete probe).
    const health = (await (await fetch(`${server.baseUrl}/health`)).json()) as {
      ok: boolean;
      db: boolean;
      blob: boolean;
    };
    expect(health).toEqual({ ok: true, db: true, blob: true });

    // Hard delete empties the take's prefix in the bucket, and re-running
    // the delete is a 204 no-op (blob deletes are idempotent).
    await recorder.close();
    desk.close();
    const del = await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await listKeys(bucket, `${takeId}/`)).toEqual([]);
    const again = await fetch(`${server.baseUrl}/api/sessions/${sessionId}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(204);
  }, 60_000);
});
