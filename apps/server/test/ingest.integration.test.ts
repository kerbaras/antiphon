// End-to-end server integration over REAL transports: WS signaling, WebRTC
// DataChannels, WASM engines on both ends, Postgres + filesystem blobs. No
// protocol mocks anywhere. Requires Postgres (docker compose up -d postgres
// or CI service); skipped when TEST_DATABASE_URL is unreachable.

import { existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract_chunk_payload, extract_codec_header } from "@antiphon/core-wasm";
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

/** Independent STREAMINFO bit-reader (FLAC spec, not the implementation):
 * total-samples is the 36-bit big-endian field at STREAMINFO body offset
 * 13.4 — in a `fLaC`(4) + block-header(4) + body(34) bootstrap that is the
 * low nibble of file byte 21 followed by bytes 22..25. */
function readTotalSamples(flac: Uint8Array): number {
  expect(String.fromCharCode(...flac.subarray(0, 4))).toBe("fLaC");
  return (
    ((flac[21] as number) & 0x0f) * 2 ** 32 +
    (flac[22] as number) * 2 ** 24 +
    (flac[23] as number) * 2 ** 16 +
    (flac[24] as number) * 2 ** 8 +
    (flac[25] as number)
  );
}

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

    // The reconstructed FLAC is served and structurally valid. This
    // recorder never set a nickname, so the filename falls back to the
    // device family derived from its userAgent ("fake-recorder" matches no
    // family → "Browser"), mirroring the desk's unlabeled lane names.
    const flacRes = await fetch(`${server.baseUrl}/api/streams/${streamId}/flac`);
    expect(flacRes.status).toBe(200);
    expect(flacRes.headers.get("content-disposition")).toBe(
      `attachment; filename="Browser-${streamId.slice(0, 8)}.flac"`,
    );
    const flac = new Uint8Array(await flacRes.arrayBuffer());
    expect(String.fromCharCode(...flac.subarray(0, 4))).toBe("fLaC");
    expect(flac[42]).toBe(0xff);
    // QA #27 (server side): the assembled copy's STREAMINFO is finalized
    // with the true sample count — players report a real duration instead
    // of N/A. Exactly the samples pushed: 2.2s at 48k.
    expect(readTotalSamples(flac)).toBe(audio.length);
    expect(readTotalSamples(flac) / 48_000).toBeCloseTo(2.2, 6);

    // Route params are not decorative: the same take under a foreign
    // session id is a 404, not another session's data.
    const foreign = await fetch(
      `${server.baseUrl}/api/sessions/${crypto.randomUUID()}/takes/${takeId}`,
    );
    expect(foreign.status).toBe(404);

    await recorder.close();
    desk.close();
  }, 60_000);

  it("FLAC downloads carry the peer nickname in Content-Disposition (F14)", async () => {
    const { sessionId } = (await (
      await fetch(`${server.baseUrl}/api/sessions`, { method: "POST" })
    ).json()) as { sessionId: string };
    const desk = new FakeDesk(server.baseUrl, sessionId);
    await desk.join();
    // Labels chosen to exercise both sanitization branches: punctuation
    // collapses to "-" (ASCII path) and a non-ASCII letter + emoji forces
    // the RFC 6266/5987 filename* path.
    const alto = new FakeRecorder(server.baseUrl, sessionId, { label: "Alto Sax!" });
    const zoe = new FakeRecorder(server.baseUrl, sessionId, { label: "Zoë 🎤" });
    await alto.join();
    await zoe.join();
    await alto.connectDataChannel();
    await zoe.connectDataChannel();

    const takeId = crypto.randomUUID();
    const altoStreamId = crypto.randomUUID();
    const zoeStreamId = crypto.randomUUID();
    const started = Promise.all([
      new Promise<void>((resolve) => {
        alto.onTakeStart(() => {
          alto.arm(takeId, altoStreamId);
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        zoe.onTakeStart(() => {
          zoe.arm(takeId, zoeStreamId);
          resolve();
        });
      }),
    ]);
    desk.takeStart(takeId);
    await started;

    alto.pushAudio(sine(1.2));
    zoe.pushAudio(sine(1.2));
    alto.finish(takeId, altoStreamId);
    zoe.finish(takeId, zoeStreamId);
    desk.takeStop(takeId);
    await alto.waitDrained();
    await zoe.waitDrained();
    await pollUntil(
      () => takeSummary(server.baseUrl, sessionId, takeId),
      (s) => s.length === 2 && s.every((stream) => stream.complete),
      "both streams archived complete",
    );

    // The desk names lane exports `fileSafe(name)-<streamId8>` (W1-D); the
    // server's Content-Disposition wins in Chromium, so it must agree.
    const altoRes = await fetch(`${server.baseUrl}/api/streams/${altoStreamId}/flac`);
    expect(altoRes.status).toBe(200);
    expect(altoRes.headers.get("content-disposition")).toBe(
      `attachment; filename="Alto-Sax-${altoStreamId.slice(0, 8)}.flac"`,
    );

    // Non-ASCII label: RFC 5987 filename* carries the real name (UTF-8
    // percent-encoded); the plain filename is the ASCII-stripped fallback.
    // The emoji is not \p{L}/\p{N}, so fileSafe drops it (web parity).
    const zoeRes = await fetch(`${server.baseUrl}/api/streams/${zoeStreamId}/flac`);
    expect(zoeRes.status).toBe(200);
    expect(zoeRes.headers.get("content-disposition")).toBe(
      `attachment; filename="Zo-${zoeStreamId.slice(0, 8)}.flac"; filename*=UTF-8''Zo%C3%AB-${zoeStreamId.slice(0, 8)}.flac`,
    );

    await alto.close();
    await zoe.close();
    desk.close();
  }, 60_000);

  it("unlabeled peers download as device-derived names, not raw uuids (F14 follow-up)", async () => {
    const { sessionId } = (await (
      await fetch(`${server.baseUrl}/api/sessions`, { method: "POST" })
    ).json()) as { sessionId: string };
    const desk = new FakeDesk(server.baseUrl, sessionId);
    await desk.join();
    // A phone that never set a nickname: the desk labels its lane by device
    // family (track-model.ts deviceName), so the download must agree.
    const phone = new FakeRecorder(server.baseUrl, sessionId, {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    });
    await phone.join();
    await phone.connectDataChannel();

    const takeId = crypto.randomUUID();
    const streamId = crypto.randomUUID();
    const started = new Promise<void>((resolve) => {
      phone.onTakeStart(() => {
        phone.arm(takeId, streamId);
        resolve();
      });
    });
    desk.takeStart(takeId);
    await started;
    phone.pushAudio(sine(1.2));
    phone.finish(takeId, streamId);
    desk.takeStop(takeId);
    await phone.waitDrained();
    await pollUntil(
      () => takeSummary(server.baseUrl, sessionId, takeId),
      (s) => s.length === 1 && (s[0]?.complete ?? false),
      "stream archived complete",
    );

    const res = await fetch(`${server.baseUrl}/api/streams/${streamId}/flac`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="iPhone-${streamId.slice(0, 8)}.flac"`,
    );

    await phone.close();
    desk.close();
  }, 60_000);

  it("STREAMINFO finalization: served copies carry the served sample count; stored blobs stay untouched (QA #27)", async () => {
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

    // 3.0s pushed in dribbles; the take stays OPEN (no finish yet).
    const audio = sine(3.0);
    for (let off = 0; off < audio.length; off += 4_800) {
      recorder.pushAudio(audio.subarray(off, Math.min(off + 4_800, audio.length)));
      await new Promise((r) => setTimeout(r, 5));
    }
    await pollUntil(
      () => takeSummary(server.baseUrl, sessionId, takeId),
      (s) => (s[0]?.chunkCount ?? 0) >= 2,
      "some chunks archived mid-take",
    );

    // Mid-take partial serve: the header advertises exactly what THIS file
    // holds — some positive number of full 4096-sample blocks (finish alone
    // may flush a short block), never more than was pushed.
    const partialRes = await fetch(`${server.baseUrl}/api/streams/${streamId}/flac?partial=1`);
    expect(partialRes.status).toBe(200);
    const partial = new Uint8Array(await partialRes.arrayBuffer());
    const partialSamples = readTotalSamples(partial);
    expect(partialSamples).toBeGreaterThan(0);
    expect(partialSamples % 4_096).toBe(0);
    expect(partialSamples).toBeLessThanOrEqual(audio.length);

    const finalSeq = recorder.finish(takeId, streamId);
    desk.takeStop(takeId);
    await recorder.waitDrained();
    await pollUntil(
      () => takeSummary(server.baseUrl, sessionId, takeId),
      (s) => s.length === 1 && (s[0]?.complete ?? false),
      "archive complete",
    );

    // Complete serve: exactly the pushed samples — the ffprobe-equivalent
    // duration falls out of the same math (samples / rate).
    const fullRes = await fetch(`${server.baseUrl}/api/streams/${streamId}/flac`);
    expect(fullRes.status).toBe(200);
    const full = new Uint8Array(await fullRes.arrayBuffer());
    expect(readTotalSamples(full)).toBe(audio.length);
    expect(readTotalSamples(full) / 48_000).toBeCloseTo(3.0, 6);
    // The patch touched ONLY the total-samples field: magic verified above,
    // the first audio frame still syncs right after the 42-byte bootstrap.
    expect(full[42]).toBe(0xff);

    // A partial serve of a now-complete stream holds everything: both
    // serving paths finalize to the served sum.
    const partial2Res = await fetch(`${server.baseUrl}/api/streams/${streamId}/flac?partial=1`);
    const partial2 = new Uint8Array(await partial2Res.arrayBuffer());
    expect(readTotalSamples(partial2)).toBe(audio.length);

    // NEVER mutate stored chunk blobs (§13): the seq-0 blob on disk still
    // says total-samples unknown — only the assembled output copy is
    // finalized.
    const seq0Blob = new Uint8Array(await readFile(join(blobRoot, takeId, streamId, "0")));
    const storedBootstrap = extract_codec_header(extract_chunk_payload(seq0Blob));
    expect(readTotalSamples(storedBootstrap)).toBe(0);
    expect(finalSeq).toBeGreaterThan(0);

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

    // A hard-deleted stream is gone forever: 404, not the 409 reserved for
    // known-but-incomplete streams. Never-existed ids read the same way.
    const flacRes = await fetch(`${server.baseUrl}/api/streams/${streamId}/flac`);
    expect(flacRes.status).toBe(404);
    const neverExisted = await fetch(`${server.baseUrl}/api/streams/${crypto.randomUUID()}/flac`);
    expect(neverExisted.status).toBe(404);

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
