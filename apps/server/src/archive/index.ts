// Archive: every chunk persisted — metadata in Postgres, frame bytes in the
// blob store. Source of truth (architecture §2.3). This module is the
// persistence boundary the ingest module talks through, plus the read side
// (status summaries, .flac reconstruction, crash-rebuild scans).

import { createHash } from "node:crypto";
import { extract_chunk_payload, extract_codec_header } from "@antiphon/core-wasm";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type BlobStore, chunkBlobKey } from "../blob/index.ts";
import type { Db } from "../db/index.ts";
import { schema } from "../db/index.ts";

export interface ChunkMetaRecord {
  takeId: string;
  streamId: string;
  seq: number;
  firstSampleIndex: number;
  sampleCount: number;
  captureTsUs: number;
  crc32c: number;
  payloadLen: number;
}

export interface StreamHeaderRecord {
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
  deviceDesc: string;
  clockEpochUs: number;
  wallClockHintMs: number;
}

export class Archive {
  private readonly db: Db;
  private readonly blobs: BlobStore;

  constructor(db: Db, blobs: BlobStore) {
    this.db = db;
    this.blobs = blobs;
  }

  // ---- write side (called by ingest) ----------------------------------

  async ensureSession(sessionId: string): Promise<void> {
    await this.db.insert(schema.sessions).values({ id: sessionId }).onConflictDoNothing();
  }

  async ensureTake(sessionId: string, takeId: string, wallClockHint?: string): Promise<void> {
    await this.ensureSession(sessionId);
    await this.db
      .insert(schema.takes)
      .values({ id: takeId, sessionId, wallClockHint: wallClockHint ?? null })
      .onConflictDoNothing();
  }

  async stopTake(takeId: string): Promise<void> {
    await this.db
      .update(schema.takes)
      .set({ stoppedAt: new Date() })
      .where(and(eq(schema.takes.id, takeId)));
  }

  async ensureStream(takeId: string, streamId: string, peerId?: string): Promise<void> {
    await this.db
      .insert(schema.streams)
      .values({ id: streamId, takeId, peerId: peerId ?? null })
      .onConflictDoNothing();
    if (peerId) {
      await this.db
        .update(schema.streams)
        .set({ peerId })
        .where(and(eq(schema.streams.id, streamId), eq(schema.streams.takeId, takeId)));
    }
  }

  /** Idempotent chunk persist: blob first, then the metadata row with
   * ON CONFLICT DO NOTHING — the idempotency law in SQL. Returns whether
   * the row was new. */
  async persistChunk(meta: ChunkMetaRecord, frameBytes: Uint8Array): Promise<boolean> {
    const blobKey = chunkBlobKey(meta.takeId, meta.streamId, meta.seq);
    // Blob before row: a row implies a durable blob. Re-put on duplicate is
    // harmless (same immutable bytes).
    await this.blobs.put(blobKey, frameBytes);
    const inserted = await this.db
      .insert(schema.chunks)
      .values({
        streamId: meta.streamId,
        seq: meta.seq,
        takeId: meta.takeId,
        firstSampleIndex: meta.firstSampleIndex,
        sampleCount: meta.sampleCount,
        captureTsUs: meta.captureTsUs,
        crc32c: meta.crc32c,
        payloadLen: meta.payloadLen,
        blobKey,
      })
      .onConflictDoNothing()
      .returning({ seq: schema.chunks.seq });
    return inserted.length > 0;
  }

  async applyStreamHeader(streamId: string, header: StreamHeaderRecord): Promise<void> {
    await this.db
      .update(schema.streams)
      .set({
        sampleRate: header.sampleRate,
        bitsPerSample: header.bitsPerSample,
        channels: header.channels,
        deviceDesc: header.deviceDesc,
        clockEpochUs: header.clockEpochUs,
        wallClockHintMs: header.wallClockHintMs,
      })
      .where(eq(schema.streams.id, streamId));
  }

  async persistGaps(streamId: string, ranges: Array<[number, number]>): Promise<void> {
    if (ranges.length === 0) return;
    await this.db
      .insert(schema.gaps)
      .values(ranges.map(([startSeq, endSeq]) => ({ streamId, startSeq, endSeq })))
      .onConflictDoNothing();
  }

  async setFinalSeq(streamId: string, finalSeq: number): Promise<void> {
    await this.db.update(schema.streams).set({ finalSeq }).where(eq(schema.streams.id, streamId));
  }

  async flagStream(streamId: string): Promise<void> {
    await this.db
      .update(schema.streams)
      .set({ flagged: true })
      .where(eq(schema.streams.id, streamId));
  }

  async recordChirp(sessionId: string, chirpId: string, emitTsDeskUs: number, spec: unknown) {
    await this.ensureSession(sessionId);
    await this.db
      .insert(schema.chirps)
      .values({ id: chirpId, sessionId, emitTsDeskUs, spec })
      .onConflictDoNothing();
  }

  // ---- crash rebuild (RFC §8) ------------------------------------------

  /** Everything needed to rebuild a session's SinkEngine from disk. */
  async loadSessionState(sessionId: string) {
    const takes = await this.db
      .select()
      .from(schema.takes)
      .where(eq(schema.takes.sessionId, sessionId));
    if (takes.length === 0) return { streams: [], chunks: [], gaps: [] };
    const takeIds = takes.map((t) => t.id);
    const streams = await this.db
      .select()
      .from(schema.streams)
      .where(inArray(schema.streams.takeId, takeIds));
    const chunkRows = await this.db
      .select({
        streamId: schema.chunks.streamId,
        takeId: schema.chunks.takeId,
        seq: schema.chunks.seq,
        crc32c: schema.chunks.crc32c,
        firstSampleIndex: schema.chunks.firstSampleIndex,
        sampleCount: schema.chunks.sampleCount,
        payloadLen: schema.chunks.payloadLen,
      })
      .from(schema.chunks)
      .where(inArray(schema.chunks.takeId, takeIds));
    const streamIds = streams.map((s) => s.id);
    const gapRows = streamIds.length
      ? await this.db.select().from(schema.gaps).where(inArray(schema.gaps.streamId, streamIds))
      : [];
    return { streams, chunks: chunkRows, gaps: gapRows };
  }

  async getFrameBytes(takeId: string, streamId: string, seq: number): Promise<Uint8Array> {
    return await this.blobs.get(chunkBlobKey(takeId, streamId, seq));
  }

  // ---- read side (REST) ---------------------------------------------------

  async sessionSummary(sessionId: string) {
    const takes = await this.db
      .select()
      .from(schema.takes)
      .where(eq(schema.takes.sessionId, sessionId))
      .orderBy(asc(schema.takes.startedAt));
    return { sessionId, takes };
  }

  async takeSummary(takeId: string) {
    const streams = await this.db
      .select()
      .from(schema.streams)
      .where(eq(schema.streams.takeId, takeId));
    const result = [];
    for (const stream of streams) {
      const rows = await this.db
        .select({ seq: schema.chunks.seq, crc32c: schema.chunks.crc32c })
        .from(schema.chunks)
        .where(eq(schema.chunks.streamId, stream.id))
        .orderBy(asc(schema.chunks.seq));
      const gapRows = await this.db
        .select()
        .from(schema.gaps)
        .where(eq(schema.gaps.streamId, stream.id));
      const seqs = rows.map((r) => r.seq);
      const holes = computeHoles(seqs, stream.finalSeq, gapRows);
      const chwm = computeChwm(
        seqs,
        gapRows.map((g) => [g.startSeq, g.endSeq]),
      );
      result.push({
        streamId: stream.id,
        takeId,
        peerId: stream.peerId,
        deviceDesc: stream.deviceDesc,
        sampleRate: stream.sampleRate,
        bitsPerSample: stream.bitsPerSample,
        finalSeq: stream.finalSeq,
        flagged: stream.flagged,
        chunkCount: rows.length,
        chwm,
        holes,
        gaps: gapRows.map((g) => [g.startSeq, g.endSeq] as [number, number]),
        complete:
          stream.finalSeq !== null && holes.length === 0 && seqs.length === stream.finalSeq + 1,
        settled: stream.finalSeq !== null && holes.length === 0,
        digest: chunkSetDigest(rows),
      });
    }
    return result;
  }

  /** Reassemble a playable .flac: seq0 codec header ++ payloads 1..=final.
   * Refuses when incomplete unless `allowPartial` (never lie about audio). */
  async reconstructFlac(
    streamId: string,
    allowPartial = false,
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }> {
    const [stream] = await this.db
      .select()
      .from(schema.streams)
      .where(eq(schema.streams.id, streamId));
    if (!stream) return { ok: false, reason: "unknown stream" };
    const rows = await this.db
      .select()
      .from(schema.chunks)
      .where(eq(schema.chunks.streamId, streamId))
      .orderBy(asc(schema.chunks.seq));
    if (rows.length === 0 || rows[0]?.seq !== 0) {
      return { ok: false, reason: "stream header (seq 0) not held" };
    }
    if (!allowPartial) {
      if (stream.finalSeq === null) return { ok: false, reason: "final seq unknown" };
      const expected = stream.finalSeq + 1;
      if (rows.length !== expected) {
        return { ok: false, reason: `holds ${rows.length}/${expected} chunks` };
      }
    }
    const parts: Uint8Array[] = [];
    for (const row of rows) {
      const frame = await this.blobs.get(row.blobKey);
      if (row.seq === 0) {
        parts.push(extract_codec_header(extract_chunk_payload(frame)));
      } else {
        parts.push(extract_chunk_payload(frame));
      }
    }
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return { ok: true, bytes: out };
  }
}

/** Deterministic digest over the chunk set: sha256 of (seq, crc32c) LE
 * pairs in seq order. Desk computes the identical digest from OPFS — equal
 * digests = converged sinks. */
export function chunkSetDigest(rows: Array<{ seq: number; crc32c: number }>): string {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const buf = new Uint8Array(sorted.length * 8);
  const dv = new DataView(buf.buffer);
  sorted.forEach((row, i) => {
    dv.setUint32(i * 8, row.seq, true);
    dv.setUint32(i * 8 + 4, row.crc32c >>> 0, true);
  });
  return createHash("sha256").update(buf).digest("hex");
}

function computeChwm(seqs: number[], gapRanges: Array<[number, number]>): number | null {
  const have = new Set(seqs);
  for (const [s, e] of gapRanges) {
    for (let i = s; i <= e; i++) have.add(i);
  }
  let chwm = -1;
  while (have.has(chwm + 1)) chwm += 1;
  return chwm >= 0 ? chwm : null;
}

function computeHoles(
  seqs: number[],
  finalSeq: number | null,
  gapRows: Array<{ startSeq: number; endSeq: number }>,
): Array<[number, number]> {
  const have = new Set(seqs);
  for (const g of gapRows) {
    for (let i = g.startSeq; i <= g.endSeq; i++) have.add(i);
  }
  const horizon = finalSeq ?? (seqs.length > 0 ? Math.max(...seqs) : -1);
  const holes: Array<[number, number]> = [];
  let start: number | null = null;
  for (let i = 0; i <= horizon; i++) {
    if (!have.has(i)) {
      start ??= i;
    } else if (start !== null) {
      holes.push([start, i - 1]);
      start = null;
    }
  }
  if (start !== null) holes.push([start, horizon]);
  return holes;
}
