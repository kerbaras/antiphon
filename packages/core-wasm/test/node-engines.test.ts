// Proof that the same wasm package drives the full protocol in Node: the
// RecorderEngine encodes real FLAC, the SinkEngine ingests it idempotently,
// ACKs flow back, and the reassembled payload is a structurally valid FLAC
// stream. (Sample-exact decode verification lives in Rust via claxon; the
// browser leg of the same package is exercised by the Playwright smoke.)

import { beforeAll, describe, expect, it } from "vitest";
import { RecorderEngine, SinkEngine, TimeSyncSession, init, version } from "../src/index.ts";

const TAKE_ID = new Uint8Array(16).fill(0xa1);
const STREAM_ID = new Uint8Array(16).fill(0xb2);
const RATE = 48_000;

/** Parse the §6.2 AUDIO_CHUNK header (little-endian). */
function parseChunkFrame(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(bytes[0]).toBe(0x41); // 'A'
  expect(bytes[1]).toBe(0x4e); // 'N'
  expect(bytes[2]).toBe(0x01); // version
  expect(bytes[3]).toBe(0x01); // AUDIO_CHUNK
  return {
    takeId: bytes.slice(4, 20),
    streamId: bytes.slice(20, 36),
    seq: dv.getUint32(36, true),
    firstSampleIndex: dv.getBigUint64(40, true),
    sampleCount: dv.getUint32(48, true),
    captureTsUs: dv.getBigUint64(52, true),
    crc32c: dv.getUint32(60, true),
    payload: bytes.slice(68),
  };
}

/** Parse our StreamHeaderV1 (the seq-0 payload) — doubles as a TS-side
 * conformance check of the layout defined in packages/core/src/chunk.rs. */
function parseStreamHeader(payload: Uint8Array) {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  expect(new TextDecoder().decode(payload.slice(0, 4))).toBe("ANS0");
  expect(payload[4]).toBe(1); // header version
  const descLen = dv.getUint16(28, true);
  const codecHeaderLen = dv.getUint16(30 + descLen, true);
  return {
    codec: payload[5],
    channels: payload[6],
    bitsPerSample: payload[7],
    sampleRate: dv.getUint32(8, true),
    clockEpochUs: dv.getBigUint64(12, true),
    deviceDesc: new TextDecoder().decode(payload.slice(30, 30 + descLen)),
    codecHeader: payload.slice(32 + descLen, 32 + descLen + codecHeaderLen),
  };
}

function sine(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.sin((i * 440 * 2 * Math.PI) / RATE) * 0.7;
  }
  return out;
}

function drain(engine: RecorderEngine, sink: number): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (;;) {
    const frame = engine.pop_frame(sink);
    if (!frame) return frames;
    frames.push(frame);
  }
}

beforeAll(async () => {
  await init();
});

describe("core-wasm in Node", () => {
  it("exposes the wasm build", () => {
    expect(version()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("encodes, ships, ingests, acks, drains, and reassembles FLAC", () => {
    const recorder = new RecorderEngine(
      TAKE_ID,
      STREAM_ID,
      RATE,
      24,
      "vitest-node",
      1_000_000,
      Date.now(),
      8 * 1024 * 1024,
    );
    recorder.add_sink(0);
    recorder.set_sink_connected(0, true);
    expect(recorder.state()).toBe("streaming");

    // 1.3s of audio pushed in awkward slabs, then take-stop.
    const audio = sine(1.3);
    for (let off = 0; off < audio.length; off += 1_777) {
      recorder.push_samples(audio.subarray(off, Math.min(off + 1_777, audio.length)));
    }
    recorder.finish();
    expect(recorder.state()).toBe("draining");
    const finalSeq = recorder.final_seq();
    expect(finalSeq).toBeGreaterThanOrEqual(2);

    const frames = drain(recorder, 0);
    expect(frames.length).toBe((finalSeq as number) + 1);

    // Sink side: ingest everything; verify continuity and idempotency.
    // (Order is not seq order: a sink added after arm() receives seq 0 via
    // the backfill queue, after live chunks — receivers key by chunk key.)
    const sink = new SinkEngine();
    const now = 5_000_000;
    const bySeq = new Map<number, ReturnType<typeof parseChunkFrame>>();
    for (const frame of frames) {
      const parsed = parseChunkFrame(frame);
      const result = sink.ingest(frame, now);
      expect(result.kind).toBe("stored");
      bySeq.set(parsed.seq, parsed);
    }
    // Duplicates are no-ops (the idempotency law).
    expect(sink.ingest(frames[1] as Uint8Array, now).kind).toBe("duplicate");

    sink.set_final_seq(TAKE_ID, STREAM_ID, finalSeq as number);
    const status = JSON.parse(sink.status_json());
    expect(status).toHaveLength(1);
    expect(status[0].complete).toBe(true);
    expect(status[0].settled).toBe(true);
    expect(status[0].flagged).toBe(false);
    expect(status[0].chwm).toBe(finalSeq);
    expect(status[0].holes).toEqual([]);

    // ACK flows back; the recorder observes the sink settled and closes.
    const acks = sink.ack_frames();
    expect(acks.length).toBe(1);
    recorder.handle_frame(0, new Uint8Array(acks[0].buffer ?? acks[0]), now);
    expect(recorder.drained_any()).toBe(true);
    expect(recorder.drained_all()).toBe(true);
    expect(recorder.state()).toBe("closed");

    // Reassembly: seq0.codec_header ++ payloads(1..=final) is a FLAC stream.
    const header = parseStreamHeader(bySeq.get(0)?.payload as Uint8Array);
    expect(header.codec).toBe(1);
    expect(header.channels).toBe(1);
    expect(header.bitsPerSample).toBe(24);
    expect(header.sampleRate).toBe(RATE);
    expect(header.deviceDesc).toBe("vitest-node");
    expect(new TextDecoder().decode(header.codecHeader.slice(0, 4))).toBe("fLaC");

    let sampleCursor = 0n;
    for (let seq = 1; seq <= (finalSeq as number); seq++) {
      const parsed = bySeq.get(seq);
      expect(parsed, `seq ${seq} present`).toBeDefined();
      if (!parsed) continue;
      expect(parsed.firstSampleIndex).toBe(sampleCursor);
      sampleCursor += BigInt(parsed.sampleCount);
      // Chunk starts on a FLAC frame boundary (sync code).
      expect(parsed.payload[0]).toBe(0xff);
      expect((parsed.payload[1] as number) & 0xfc).toBe(0xf8);
    }
    expect(sampleCursor).toBe(BigInt(audio.length));

    const stats = JSON.parse(recorder.stats_json());
    expect(stats.state).toBe("closed");
    expect(stats.sinks[0].settled).toBe(true);
    expect(stats.gaps).toEqual([]);
  });

  it("answers backfill after a simulated dropout", () => {
    const recorder = new RecorderEngine(
      TAKE_ID,
      STREAM_ID,
      RATE,
      16,
      "vitest-node",
      0,
      0,
      8 * 1024 * 1024,
    );
    recorder.add_sink(7);
    recorder.set_sink_connected(7, true);

    recorder.push_samples(sine(1.6)); // several chunks
    const live = drain(recorder, 7);
    expect(live.length).toBeGreaterThanOrEqual(3);

    const sink = new SinkEngine();
    // Deliver only frames 0 and 3+ — 1..2 "lost" in a dropout.
    const lost = new Set([1, 2]);
    for (const frame of live) {
      const { seq } = parseChunkFrame(frame);
      if (!lost.has(seq)) sink.ingest(frame, 0);
    }
    const status = JSON.parse(sink.status_json())[0];
    expect(status.chwm).toBe(0);
    expect(status.holes).toEqual([[1, 2]]);

    // Reconnect: the sink acks (with holes) — recorder requeues them.
    const ack = sink.ack_frames()[0];
    recorder.handle_frame(7, new Uint8Array(ack.buffer ?? ack), 0);
    const backfill = drain(recorder, 7);
    const seqs = backfill.map((f) => parseChunkFrame(f).seq);
    expect(seqs).toContain(1);
    expect(seqs).toContain(2);
    for (const frame of backfill) {
      const result = sink.ingest(frame, 0);
      expect(["stored", "duplicate"]).toContain(result.kind);
    }
    expect(JSON.parse(sink.status_json())[0].holes).toEqual([]);
  });

  it("runs NTP-style time sync over frames", () => {
    const recorder = new RecorderEngine(
      TAKE_ID,
      STREAM_ID,
      RATE,
      24,
      "t",
      0,
      0,
      1 << 20,
    );
    const session = new TimeSyncSession();
    // Recorder clock runs 250ms ahead of sink clock.
    const offset = 250_000;
    let sinkNow = 1_000_000;
    for (let i = 0; i < 5; i++) {
      const ping = session.ping(sinkNow);
      const reply = recorder.handle_frame(0, ping, sinkNow + offset + 2_000);
      expect(reply).toBeDefined();
      sinkNow += 4_100;
      expect(session.handle_pong(reply as Uint8Array, sinkNow)).toBe(true);
      sinkNow += 100_000;
    }
    const measured = session.offset_us();
    expect(measured).toBeDefined();
    expect(Math.abs((measured as number) - offset)).toBeLessThan(3_000);
  });
});
