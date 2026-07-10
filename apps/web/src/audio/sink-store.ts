// OPFS chunk store for the desk sink worker: persistence, boot rescan into
// the engine, stream digests, the payload-size waveform proxy, and playable
// FLAC assembly.

import {
  chunk_meta_json,
  extract_chunk_payload,
  extract_codec_header,
  type SinkEngine,
} from "@antiphon/core-wasm";

export interface ChunkMetaLite {
  crc32c: number;
  payloadLen: number;
  sampleCount: number;
}

/** streamKey (`take_stream`) → seq → meta (digest + waveform inputs). */
export type MetaStore = Map<string, Map<number, ChunkMetaLite>>;

export function streamDirName(takeId: string, streamId: string): string {
  return `${takeId}_${streamId}`;
}

export function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function writeFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes as unknown as ArrayBufferView<ArrayBuffer>);
  await writable.close();
}

/** Rescan OPFS on boot and replay every stored chunk/gap/final into the
 * engine — crash recovery rejoins as if merely disconnected (RFC §8). */
export async function rebuild(
  root: FileSystemDirectoryHandle,
  engine: SinkEngine,
  metas: MetaStore,
): Promise<number> {
  let count = 0;
  for await (const [dirName, handle] of root.entries()) {
    if (handle.kind !== "directory") continue;
    const [takeId, streamId] = dirName.split("_");
    if (!takeId || !streamId) continue;
    const streamDir = handle as FileSystemDirectoryHandle;
    const streamMetas = new Map<number, ChunkMetaLite>();
    metas.set(streamDirName(takeId, streamId), streamMetas);
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

export async function persistChunk(
  root: FileSystemDirectoryHandle,
  metas: MetaStore,
  takeId: string,
  streamId: string,
  meta: { seq: number; crc32c: number; payloadLen: number; sampleCount: number },
  bytes: Uint8Array,
): Promise<void> {
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

/** sha256 over (seq, crc32c) LE pairs in seq order — must equal the
 * server's digest for the same stream when converged. */
export async function digestFor(
  metas: MetaStore,
  takeId: string,
  streamId: string,
): Promise<string> {
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

/** Waveform proxy for clip bars: per-chunk payload sizes (seq order, audio
 * chunks only), normalized against the stream's own peak and downsampled —
 * denser audio compresses worse, so this is a real complexity contour. */
export function energyFor(
  metas: MetaStore,
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
  // waveform replaces this proxy once the take loads for playback.
  const max = Math.max(...buckets);
  const min = Math.min(...buckets);
  return {
    energy: buckets.map((v) => (max > min ? 0.08 + (0.92 * (v - min)) / (max - min) : 0.3)),
    totalSamples,
  };
}

/** codec bootstrap (seq 0) ++ payloads 1..=max held, refusing holes — a
 * playable file must never silently skip audio. */
export async function assembleFlacFromStore(
  root: FileSystemDirectoryHandle,
  metas: MetaStore,
  takeId: string,
  streamId: string,
): Promise<{ flac: ArrayBuffer } | { flac: null; reason: string }> {
  try {
    const dir = await root.getDirectoryHandle(streamDirName(takeId, streamId));
    const streamMetas = metas.get(streamDirName(takeId, streamId));
    const seqs = [...(streamMetas?.keys() ?? [])].sort((a, b) => a - b);
    if (seqs.length === 0 || seqs[0] !== 0) {
      return { flac: null, reason: "stream header not held" };
    }
    for (let i = 1; i < seqs.length; i++) {
      if ((seqs[i] as number) !== (seqs[i - 1] as number) + 1) {
        return { flac: null, reason: `hole at seq ${(seqs[i - 1] as number) + 1}` };
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
    return { flac: out.buffer as ArrayBuffer };
  } catch (e) {
    return { flac: null, reason: String(e) };
  }
}
