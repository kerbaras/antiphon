// Desk sink worker: the SAME SinkEngine as the server, persisting to OPFS.
// Crash recovery = rescan OPFS on boot and rejoin as if merely disconnected
// (RFC §8). Persist-before-ack: all work serializes on a chain and ACK
// generation joins it, so an ACK can never claim an unpersisted chunk.

import {
  chunk_meta_json,
  extract_chunk_payload,
  extract_codec_header,
  init,
  SinkEngine,
} from "@antiphon/core-wasm";
import type { DeskStreamStatus, FromSinkWorker, ToSinkWorker } from "./sink-worker-protocol";

let engine: SinkEngine | null = null;
let root: FileSystemDirectoryHandle | null = null;

interface ChunkMetaLite {
  crc32c: number;
  payloadLen: number;
  sampleCount: number;
}

/** streamKey (`take_stream`) → seq → meta (digest + waveform inputs). */
const metas = new Map<string, Map<number, ChunkMetaLite>>();

let chain: Promise<void> = Promise.resolve();

function post(msg: FromSinkWorker, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function nowUs(): number {
  return performance.now() * 1_000;
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function streamDirName(takeId: string, streamId: string): string {
  return `${takeId}_${streamId}`;
}

async function writeFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes as unknown as ArrayBufferView<ArrayBuffer>);
  await writable.close();
}

async function rebuild(): Promise<number> {
  if (!root || !engine) return 0;
  let count = 0;
  for await (const [dirName, handle] of root.entries()) {
    if (handle.kind !== "directory") continue;
    const [takeId, streamId] = dirName.split("_");
    if (!takeId || !streamId) continue;
    const streamDir = handle as FileSystemDirectoryHandle;
    const key = streamDirName(takeId, streamId);
    const streamMetas = new Map<number, ChunkMetaLite>();
    metas.set(key, streamMetas);
    for await (const [name, fileHandle] of streamDir.entries()) {
      if (fileHandle.kind !== "file") continue;
      if (name.startsWith("gap_")) {
        const [, s, e] = name.split("_");
        engine.rebuild_gap(uuidBytes(takeId), uuidBytes(streamId), Number(s), Number(e));
        continue;
      }
      if (name === "final.json") {
        const file = await (fileHandle as FileSystemFileHandle).getFile();
        const { finalSeq } = JSON.parse(await file.text()) as { finalSeq: number };
        engine.set_final_seq(uuidBytes(takeId), uuidBytes(streamId), finalSeq);
        continue;
      }
      const seq = Number(name);
      if (!Number.isInteger(seq)) continue;
      const file = await (fileHandle as FileSystemFileHandle).getFile();
      const frame = new Uint8Array(await file.arrayBuffer());
      try {
        const meta = JSON.parse(chunk_meta_json(frame)) as {
          seq: number;
          crc32c: number;
          firstSampleIndex: number;
          sampleCount: number;
          payloadLen: number;
        };
        engine.rebuild_chunk(
          uuidBytes(takeId),
          uuidBytes(streamId),
          meta.seq,
          meta.crc32c,
          meta.firstSampleIndex,
          meta.sampleCount,
          meta.payloadLen,
        );
        streamMetas.set(meta.seq, {
          crc32c: meta.crc32c,
          payloadLen: meta.payloadLen,
          sampleCount: meta.sampleCount,
        });
        count += 1;
      } catch {
        // Unreadable file: leave it, the hole machinery re-fetches.
      }
    }
  }
  return count;
}

async function persistChunk(
  takeId: string,
  streamId: string,
  meta: { seq: number; crc32c: number; payloadLen: number; sampleCount: number },
  bytes: Uint8Array,
): Promise<void> {
  if (!root) throw new Error("no OPFS root");
  const dir = await root.getDirectoryHandle(streamDirName(takeId, streamId), { create: true });
  await writeFile(dir, String(meta.seq), bytes);
  let streamMetas = metas.get(streamDirName(takeId, streamId));
  if (!streamMetas) {
    streamMetas = new Map();
    metas.set(streamDirName(takeId, streamId), streamMetas);
  }
  streamMetas.set(meta.seq, {
    crc32c: meta.crc32c,
    payloadLen: meta.payloadLen,
    sampleCount: meta.sampleCount,
  });
}

async function digestFor(takeId: string, streamId: string): Promise<string> {
  const streamMetas = metas.get(streamDirName(takeId, streamId));
  if (!streamMetas) return "";
  const seqs = [...streamMetas.keys()].sort((a, b) => a - b);
  const buf = new Uint8Array(seqs.length * 8);
  const dv = new DataView(buf.buffer);
  seqs.forEach((seq, i) => {
    dv.setUint32(i * 8, seq, true);
    dv.setUint32(i * 8 + 4, ((streamMetas.get(seq) as ChunkMetaLite).crc32c ?? 0) >>> 0, true);
  });
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Waveform proxy for clip bars: per-chunk payload sizes (seq order,
 * audio chunks only), normalized against the stream's own peak and
 * downsampled to at most `maxBars`. Denser audio compresses worse, so this
 * is a real signal-complexity contour, not decoration. */
function energyFor(
  takeId: string,
  streamId: string,
  maxBars = 96,
): {
  energy: number[];
  totalSamples: number;
} {
  const streamMetas = metas.get(streamDirName(takeId, streamId));
  if (!streamMetas) return { energy: [], totalSamples: 0 };
  const seqs = [...streamMetas.keys()].filter((s) => s > 0).sort((a, b) => a - b);
  let totalSamples = 0;
  const sizes = seqs.map((seq) => {
    const meta = streamMetas.get(seq) as ChunkMetaLite;
    totalSamples += meta.sampleCount;
    return meta.payloadLen;
  });
  if (sizes.length === 0) return { energy: [], totalSamples };
  const bucketCount = Math.min(maxBars, sizes.length);
  const perBucket = sizes.length / bucketCount;
  const buckets: number[] = [];
  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * perBucket);
    const end = Math.max(start + 1, Math.floor((b + 1) * perBucket));
    let peak = 0;
    for (let i = start; i < end && i < sizes.length; i++) {
      peak = Math.max(peak, sizes[i] as number);
    }
    buckets.push(peak);
  }
  // FLAC payload sizes carry a large constant floor (frame headers, model
  // cost); min-max normalization exposes the actual variation. The decoded
  // waveform replaces this proxy once the take is loaded for playback.
  const max = Math.max(...buckets);
  const min = Math.min(...buckets);
  return {
    energy: buckets.map((v) => (max > min ? 0.08 + (0.92 * (v - min)) / (max - min) : 0.3)),
    totalSamples,
  };
}

async function handle(msg: ToSinkWorker): Promise<void> {
  switch (msg.type) {
    case "configure": {
      await init();
      engine = new SinkEngine();
      const opfs = await navigator.storage.getDirectory();
      const base = await opfs.getDirectoryHandle("antiphon", { create: true });
      root = await base.getDirectoryHandle(msg.sessionId, { create: true });
      const rebuiltChunks = await rebuild();
      post({ type: "ready", rebuiltChunks });
      break;
    }
    case "frame": {
      if (!engine) return;
      const bytes = new Uint8Array(msg.bytes);
      const result = engine.ingest(bytes, nowUs());
      try {
        switch (result.kind) {
          case "stored":
          case "continuity": {
            const meta = JSON.parse(result.json) as {
              takeId: string;
              streamId: string;
              seq: number;
              crc32c: number;
              payloadLen: number;
              sampleCount: number;
            };
            await persistChunk(meta.takeId, meta.streamId, meta, bytes);
            break;
          }
          case "gap-report": {
            const list = JSON.parse(result.json) as {
              takeId: string;
              streamId: string;
              ranges: Array<[number, number]>;
            };
            if (root) {
              const dir = await root.getDirectoryHandle(streamDirName(list.takeId, list.streamId), {
                create: true,
              });
              for (const [s, e] of list.ranges) {
                await writeFile(dir, `gap_${s}_${e}`, new Uint8Array(0));
              }
            }
            break;
          }
          case "time-ping": {
            const reply = result.reply;
            if (reply) {
              const buf = reply.buffer as ArrayBuffer;
              post({ type: "reply", connId: msg.connId, bytes: buf }, [buf]);
            }
            break;
          }
          default:
            break;
        }
      } finally {
        result.free();
      }
      break;
    }
    case "set-final": {
      if (!engine || !root) return;
      engine.set_final_seq(uuidBytes(msg.takeId), uuidBytes(msg.streamId), msg.finalSeq);
      const dir = await root.getDirectoryHandle(streamDirName(msg.takeId, msg.streamId), {
        create: true,
      });
      await writeFile(
        dir,
        "final.json",
        new TextEncoder().encode(JSON.stringify({ finalSeq: msg.finalSeq })),
      );
      break;
    }
    case "acks": {
      if (!engine) return;
      const frames = [...engine.ack_frames()].map((f) => (f as Uint8Array).buffer as ArrayBuffer);
      post({ type: "acks-result", frames }, frames);
      break;
    }
    case "haves": {
      if (!engine) return;
      const frames = [...engine.have_frames()].map((f) => (f as Uint8Array).buffer as ArrayBuffer);
      post({ type: "haves-result", frames }, frames);
      break;
    }
    case "plan-push": {
      if (!engine) return;
      const plan = JSON.parse(engine.plan_push(new Uint8Array(msg.haveBytes))) as {
        takeId: string;
        streamId: string;
        ranges: Array<[number, number]>;
      };
      post({ type: "push-plan", ...plan });
      break;
    }
    case "get-frames": {
      if (!root) return;
      const frames: ArrayBuffer[] = [];
      try {
        const dir = await root.getDirectoryHandle(streamDirName(msg.takeId, msg.streamId));
        for (const [start, end] of msg.ranges) {
          for (let seq = start; seq <= end; seq++) {
            try {
              const fh = await dir.getFileHandle(String(seq));
              frames.push(await (await fh.getFile()).arrayBuffer());
            } catch {
              // not held; skip
            }
          }
        }
      } catch {
        // stream dir missing entirely
      }
      post({ type: "frames-result", frames }, frames);
      break;
    }
    case "assemble-flac": {
      // codec bootstrap (seq 0) ++ payloads 1..=max held, refusing holes —
      // a playable file must never silently skip audio.
      if (!root) {
        post({ type: "flac-result", requestId: msg.requestId, flac: null, reason: "no store" });
        return;
      }
      try {
        const dir = await root.getDirectoryHandle(streamDirName(msg.takeId, msg.streamId));
        const streamMetas = metas.get(streamDirName(msg.takeId, msg.streamId));
        const seqs = [...(streamMetas?.keys() ?? [])].sort((a, b) => a - b);
        if (seqs.length === 0 || seqs[0] !== 0) {
          post({
            type: "flac-result",
            requestId: msg.requestId,
            flac: null,
            reason: "stream header not held",
          });
          return;
        }
        for (let i = 1; i < seqs.length; i++) {
          if ((seqs[i] as number) !== (seqs[i - 1] as number) + 1) {
            post({
              type: "flac-result",
              requestId: msg.requestId,
              flac: null,
              reason: `hole at seq ${(seqs[i - 1] as number) + 1}`,
            });
            return;
          }
        }
        const parts: Uint8Array[] = [];
        for (const seq of seqs) {
          const fh = await dir.getFileHandle(String(seq));
          const frame = new Uint8Array(await (await fh.getFile()).arrayBuffer());
          const payload = extract_chunk_payload(frame);
          parts.push(seq === 0 ? extract_codec_header(payload) : payload);
        }
        const total = parts.reduce((n, p) => n + p.byteLength, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const p of parts) {
          out.set(p, off);
          off += p.byteLength;
        }
        post({ type: "flac-result", requestId: msg.requestId, flac: out.buffer as ArrayBuffer }, [
          out.buffer as ArrayBuffer,
        ]);
      } catch (e) {
        post({ type: "flac-result", requestId: msg.requestId, flac: null, reason: String(e) });
      }
      break;
    }
    case "delete-streams": {
      // Server-confirmed deletion: drop engine state (so the streams leave
      // ACK/HAVE traffic and can't be re-pushed to us) and the OPFS copy.
      for (const { takeId, streamId } of msg.streams) {
        engine?.remove_stream(uuidBytes(takeId), uuidBytes(streamId));
        metas.delete(streamDirName(takeId, streamId));
        try {
          await root?.removeEntry(streamDirName(takeId, streamId), { recursive: true });
        } catch {
          // Directory never existed (stream lived only at the server).
        }
      }
      break;
    }
    case "status": {
      if (!engine) {
        post({ type: "status-result", streams: [] });
        return;
      }
      const raw = JSON.parse(engine.status_json()) as Array<
        Omit<DeskStreamStatus, "digest" | "energy" | "totalSamples">
      >;
      const streams: DeskStreamStatus[] = [];
      for (const s of raw) {
        streams.push({
          ...s,
          digest: await digestFor(s.takeId, s.streamId),
          ...energyFor(s.takeId, s.streamId),
        });
      }
      post({ type: "status-result", streams });
      break;
    }
  }
}

self.onmessage = (event: MessageEvent<ToSinkWorker>) => {
  chain = chain
    .then(() => handle(event.data))
    .catch((e) => post({ type: "error", message: String(e) }));
};
