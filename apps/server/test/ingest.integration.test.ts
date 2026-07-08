// End-to-end server integration over REAL transports: WS signaling, WebRTC
// DataChannels, WASM engines on both ends, Postgres + filesystem blobs. No
// protocol mocks anywhere. Requires Postgres (docker compose up -d postgres
// or CI service); skipped when TEST_DATABASE_URL is unreachable.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FakeDesk,
  FakeRecorder,
  pollUntil,
  sine,
  startTestServer,
  type TestServer,
  takeSummary,
} from "./helpers.ts";

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://antiphon:antiphon@localhost:5433/antiphon";

let available = true;
try {
  const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
} catch {
  available = false;
}

const suite = available ? describe : describe.skip;

async function freshDatabase(name: string): Promise<string> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  return ADMIN_URL.replace(/\/[^/]+$/, `/${name}`);
}

suite("server ingest end-to-end", () => {
  let server: TestServer;
  let dbUrl: string;
  let blobRoot: string;

  beforeAll(async () => {
    dbUrl = await freshDatabase("antiphon_it");
    blobRoot = mkdtempSync(join(tmpdir(), "antiphon-blobs-"));
    server = await startTestServer(dbUrl, blobRoot);
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    // No nodeDataChannel.cleanup(): see the note in helpers.ts (native
    // use-after-free in cleanup() flaked the fork ~1/3 of loaded runs).
  });

  it("happy path: recorder streams a take, server archive converges", async () => {
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

    // ~2.2s of audio in dribbles, like the worker pump would deliver.
    const audio = sine(2.2);
    for (let off = 0; off < audio.length; off += 4_800) {
      recorder.pushAudio(audio.subarray(off, Math.min(off + 4_800, audio.length)));
      await new Promise((r) => setTimeout(r, 5));
    }
    const finalSeq = recorder.finish(takeId, streamId);
    desk.takeStop(takeId);

    // The recorder observes the server settled via ACKs (§7.4)...
    await recorder.waitDrained();
    // ...and the archive holds the complete stream.
    const summary = await pollUntil(
      () => takeSummary(server.baseUrl, sessionId, takeId),
      (s) => s.length === 1 && (s[0]?.complete ?? false),
      "server archive complete",
    );
    expect(summary[0]?.finalSeq).toBe(finalSeq);
    expect(summary[0]?.chunkCount).toBe(finalSeq + 1);
    expect(summary[0]?.holes).toEqual([]);
    expect(summary[0]?.gaps).toEqual([]);
    expect(summary[0]?.flagged).toBe(false);

    // The reconstructed FLAC is served and structurally valid.
    const flacRes = await fetch(`${server.baseUrl}/api/streams/${streamId}/flac`);
    expect(flacRes.status).toBe(200);
    const flac = new Uint8Array(await flacRes.arrayBuffer());
    expect(String.fromCharCode(...flac.subarray(0, 4))).toBe("fLaC");
    expect(flac[42]).toBe(0xff);

    // Route params are not decorative: the same take under a foreign
    // session id is a 404, not another session's data.
    const foreign = await fetch(
      `${server.baseUrl}/api/sessions/${crypto.randomUUID()}/takes/${takeId}`,
    );
    expect(foreign.status).toBe(404);

    await recorder.close();
    desk.close();
  }, 60_000);

  it("mid-take dropout: capture continues, backfill converges after reconnect", async () => {
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

    const audio = sine(3.6);
    const third = Math.floor(audio.length / 3);
    recorder.pushAudio(audio.subarray(0, third));
    await new Promise((r) => setTimeout(r, 300));

    // Kill the network mid-take. Capture MUST NOT stop (§7.1).
    recorder.dropNetwork();
    recorder.pushAudio(audio.subarray(third, 2 * third));
    await new Promise((r) => setTimeout(r, 200));

    // Reconnect; live continues and the backlog backfills (§7.3).
    await recorder.connectDataChannel();
    recorder.pushAudio(audio.subarray(2 * third));
    const finalSeq = recorder.finish(takeId, streamId);
    desk.takeStop(takeId);

    await recorder.waitDrained();
    const summary = await pollUntil(
      () => takeSummary(server.baseUrl, sessionId, takeId),
      (s) => s.length === 1 && (s[0]?.complete ?? false),
      "post-dropout convergence",
    );
    expect(summary[0]?.chunkCount).toBe(finalSeq + 1);
    expect(summary[0]?.holes).toEqual([]);
    expect(summary[0]?.gaps).toEqual([]);

    await recorder.close();
    desk.close();
  }, 60_000);

  it("duplicate spam is a no-op (the idempotency law)", async () => {
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

    recorder.pushAudio(sine(1.2));
    const finalSeq = recorder.finish(takeId, streamId);
    desk.takeStop(takeId);
    await recorder.waitDrained();

    // Now spam every frame three more times.
    recorder.replayFrames(3);
    await new Promise((r) => setTimeout(r, 800));

    const summary = await takeSummary(server.baseUrl, sessionId, takeId);
    expect(summary[0]?.chunkCount).toBe(finalSeq + 1);
    expect(summary[0]?.flagged).toBe(false);
    expect(summary[0]?.complete).toBe(true);

    await recorder.close();
    desk.close();
  }, 60_000);

  it("desk-initiated deletion: rows, blobs, and engine state all drop; live takes are protected", async () => {
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
    recorder.pushAudio(sine(1.2));

    // Deleting under the live take must be refused outright.
    await pollUntil(
      () => takeSummary(server.baseUrl, sessionId, takeId),
      (s) => (s[0]?.chunkCount ?? 0) >= 1,
      "chunks archived before delete attempt",
    );
    desk.deleteStreams([{ takeId, streamId }]);
    const refusal = await desk.waitForMessage("error");
    expect(refusal.code).toBe("take-active");

    const finalSeq = recorder.finish(takeId, streamId);
    desk.takeStop(takeId);
    await recorder.waitDrained();
    await pollUntil(
      () => takeSummary(server.baseUrl, sessionId, takeId),
      (s) => s.length === 1 && (s[0]?.complete ?? false),
      "archive complete before deletion",
    );
    const blobPath = join(blobRoot, takeId, streamId, String(finalSeq));
    expect(existsSync(blobPath)).toBe(true);

    // Now the take is settled: delete for real.
    desk.deleteStreams([{ takeId, streamId }]);
    const confirm = await desk.waitForMessage("streams-deleted");
    expect(confirm.streams).toEqual([{ takeId, streamId }]);
    expect(confirm.deletedTakeIds).toEqual([takeId]);

    // Rows gone (the take lost its last stream so its row went too — the
    // session-scoped summary 404s), blobs gone, take gone from the session.
    const gone = await fetch(`${server.baseUrl}/api/sessions/${sessionId}/takes/${takeId}`);
    expect(gone.status).toBe(404);
    expect(existsSync(blobPath)).toBe(false);
    const session = (await (await fetch(`${server.baseUrl}/api/sessions/${sessionId}`)).json()) as {
      takes: Array<{ id: string }>;
    };
    expect(session.takes.map((t) => t.id)).not.toContain(takeId);

    // Engine state gone too: the stream vanished from ingest status, so
    // ACK/HAVE traffic can never resurrect it.
    const ingest = (await (
      await fetch(`${server.baseUrl}/api/sessions/${sessionId}/ingest`)
    ).json()) as Array<{ streamId: string }>;
    expect(ingest.map((s) => s.streamId)).not.toContain(streamId);

    // FLAC reconstruction refuses an unknown stream.
    const flacRes = await fetch(`${server.baseUrl}/api/streams/${streamId}/flac`);
    expect(flacRes.status).toBe(409);

    await recorder.close();
    desk.close();
  }, 60_000);

  it("server crash mid-take: restart rebuilds from the archive and converges", async () => {
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
    await pollUntil(
      () => takeSummary(server.baseUrl, sessionId, takeId),
      (s) => (s[0]?.chunkCount ?? 0) >= 2,
      "some chunks archived before crash",
    );

    // Crash: the whole process state dies; DB + blobs survive.
    recorder.dropNetwork();
    await server.stop();
    server = await startTestServer(dbUrl, blobRoot);

    // The recorder kept capturing through the outage.
    recorder.pushAudio(sine(1.0));

    // Rejoin the restarted server (new WS, new PC), resume streaming.
    const rejoined = new FakeRecorder(server.baseUrl, sessionId);
    rejoined.engine = recorder.engine; // same capture state machine
    await rejoined.join();
    await rejoined.connectDataChannel();

    rejoined.pushAudio(sine(0.6));
    const finalSeq = rejoined.finish(takeId, streamId);

    const desk2 = new FakeDesk(server.baseUrl, sessionId);
    await desk2.join();
    desk2.takeStop(takeId);

    await rejoined.waitDrained();
    const summary = await pollUntil(
      () => takeSummary(server.baseUrl, sessionId, takeId),
      (s) => s.length === 1 && (s[0]?.complete ?? false),
      "post-restart convergence",
    );
    expect(summary[0]?.chunkCount).toBe(finalSeq + 1);
    expect(summary[0]?.holes).toEqual([]);
    expect(summary[0]?.flagged).toBe(false);

    await rejoined.close();
    await recorder.close();
    desk.close();
    desk2.close();
  }, 90_000);
});
