// Archive: every chunk persisted — metadata in Postgres, frame bytes in the
// blob store. Source of truth (architecture §2.3). This module is the
// persistence boundary the ingest module talks through, plus the read side
// (status summaries, .flac reconstruction, crash-rebuild scans).

import { createHash } from "node:crypto";
import { extract_chunk_payload, extract_codec_header } from "@antiphon/core-wasm";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { type BlobStore, chunkBlobKey } from "../blob/index.ts";
import type { Db } from "../db/index.ts";
import { schema } from "../db/index.ts";
import { withTotalSamples } from "../flac-streaminfo.ts";
import { createLogger } from "../logger.ts";

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
  private readonly log = createLogger({ module: "archive" });

  constructor(db: Db, blobs: BlobStore) {
    this.db = db;
    this.blobs = blobs;
  }

  // ---- write side (called by ingest) ----------------------------------

  async ensureSession(sessionId: string): Promise<void> {
    await this.db.insert(schema.sessions).values({ id: sessionId }).onConflictDoNothing();
  }

  /** Bump the expiry-sweep clock. Signaling-level events only (join,
   * take start/stop) — never per-chunk. */
  async touchSession(sessionId: string): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ lastActivityAt: new Date() })
      .where(eq(schema.sessions.id, sessionId));
  }

  async ensureTake(sessionId: string, takeId: string, wallClockHint?: string): Promise<void> {
    await this.ensureSession(sessionId);
    await this.db
      .insert(schema.takes)
      .values({ id: takeId, sessionId, wallClockHint: wallClockHint ?? null })
      .onConflictDoNothing();
  }

  /** Peer row upsert, keyed by peerId (A12): an identity resume refreshes
   * the same row instead of forking a new one. */
  async upsertPeer(peer: {
    peerId: string;
    sessionId: string;
    role: "desk" | "recorder";
    userAgent: string;
    label: string | null;
    deviceId: string | null;
    joinedAt: Date;
  }): Promise<void> {
    await this.db
      .insert(schema.peers)
      .values({
        id: peer.peerId,
        sessionId: peer.sessionId,
        role: peer.role,
        userAgent: peer.userAgent,
        label: peer.label,
        deviceId: peer.deviceId,
        joinedAt: peer.joinedAt,
      })
      .onConflictDoUpdate({
        target: schema.peers.id,
        set: { userAgent: peer.userAgent, label: peer.label, deviceId: peer.deviceId },
      });
  }

  /** Live rename (A13). */
  async updatePeerLabel(peerId: string, label: string | null): Promise<void> {
    await this.db.update(schema.peers).set({ label }).where(eq(schema.peers.id, peerId));
  }

  /** Known peers of a session — rebuilds the device→peer index on room boot
   * so identity resume survives a server restart. */
  async loadPeers(sessionId: string) {
    return await this.db.select().from(schema.peers).where(eq(schema.peers.sessionId, sessionId));
  }

  async stopTake(takeId: string): Promise<void> {
    await this.db
      .update(schema.takes)
      .set({ stoppedAt: new Date() })
      .where(and(eq(schema.takes.id, takeId)));
  }

  /** Drop a take row that ended with zero streams (e.g. every lane was
   * disarmed) so it never haunts the session summary. Safe against late
   * chunks: persistence re-creates the take row on arrival. */
  async deleteTakeIfEmpty(takeId: string): Promise<boolean> {
    const remaining = await this.db
      .select({ id: schema.streams.id })
      .from(schema.streams)
      .where(eq(schema.streams.takeId, takeId))
      .limit(1);
    if (remaining.length > 0) return false;
    await this.db.delete(schema.takes).where(eq(schema.takes.id, takeId));
    return true;
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

  /** Delete streams outright (desk-initiated take removal): rows first
   * (stream delete cascades chunks + gaps), then blobs — a failed blob
   * delete leaks bytes but can never resurrect a row. Takes that lose
   * their last stream are removed too; returns those take ids. Idempotent:
   * unknown streams delete to nothing. */
  async deleteStreams(refs: Array<{ takeId: string; streamId: string }>): Promise<string[]> {
    if (refs.length === 0) return [];
    const streamIds = refs.map((r) => r.streamId);
    const blobRows = await this.db
      .select({ blobKey: schema.chunks.blobKey })
      .from(schema.chunks)
      .where(inArray(schema.chunks.streamId, streamIds));
    await this.db.delete(schema.streams).where(inArray(schema.streams.id, streamIds));
    for (const row of blobRows) {
      try {
        await this.blobs.delete(row.blobKey);
      } catch (error) {
        // Orphaned blob: harmless (unreferenced by any row) but worth eyes.
        this.log.warn("blob delete failed after stream delete; blob orphaned", {
          blobKey: row.blobKey,
          error,
        });
      }
    }
    const deletedTakeIds: string[] = [];
    for (const takeId of new Set(refs.map((r) => r.takeId))) {
      const remaining = await this.db
        .select({ id: schema.streams.id })
        .from(schema.streams)
        .where(eq(schema.streams.takeId, takeId))
        .limit(1);
      if (remaining.length === 0) {
        await this.db.delete(schema.takes).where(eq(schema.takes.id, takeId));
        deletedTakeIds.push(takeId);
      }
    }
    return deletedTakeIds;
  }

  // ---- session retention (RFC §12: expiry + hard deletion) --------------

  /** Sessions whose last signaling activity predates `cutoff`. */
  async listSessionsIdleSince(cutoff: Date): Promise<string[]> {
    const rows = await this.db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(lt(schema.sessions.lastActivityAt, cutoff));
    return rows.map((r) => r.id);
  }

  /** Hard-delete a whole session: blobs FIRST, then rows (chunks, gaps,
   * streams, takes, chirps, collab doc, peers, session). A failed blob
   * delete aborts with rows intact, so a retry re-attempts every blob — a
   * hard delete must never leak recordings of identifiable people (RFC §12).
   * Idempotent: an unknown session deletes to nothing. */
  async deleteSession(sessionId: string): Promise<void> {
    const takes = await this.db
      .select({ id: schema.takes.id })
      .from(schema.takes)
      .where(eq(schema.takes.sessionId, sessionId));
    const takeIds = takes.map((t) => t.id);
    const streams = takeIds.length
      ? await this.db
          .select({ id: schema.streams.id })
          .from(schema.streams)
          .where(inArray(schema.streams.takeId, takeIds))
      : [];
    const streamIds = streams.map((s) => s.id);
    const blobRows = streamIds.length
      ? await this.db
          .select({ blobKey: schema.chunks.blobKey })
          .from(schema.chunks)
          .where(inArray(schema.chunks.streamId, streamIds))
      : [];
    for (const row of blobRows) {
      await this.blobs.delete(row.blobKey);
    }
    if (streamIds.length) {
      await this.db.delete(schema.chunks).where(inArray(schema.chunks.streamId, streamIds));
      await this.db.delete(schema.gaps).where(inArray(schema.gaps.streamId, streamIds));
      await this.db.delete(schema.streams).where(inArray(schema.streams.id, streamIds));
    }
    if (takeIds.length) {
      await this.db.delete(schema.takes).where(inArray(schema.takes.id, takeIds));
    }
    await this.db.delete(schema.chirps).where(eq(schema.chirps.sessionId, sessionId));
    // W3-A shared project doc: session-scoped metadata, deleted with the
    // session (the caller drops the live collab room first — see
    // destroySession ordering in index.ts — so no debounced save resurrects
    // the row; the sessions FK cascade backstops any race).
    await this.db.delete(schema.collabDocs).where(eq(schema.collabDocs.sessionId, sessionId));
    await this.db.delete(schema.peers).where(eq(schema.peers.sessionId, sessionId));
    await this.db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
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

  /** Session snapshot with full attribution (F1): takes in chronological
   * order each carrying its streams' stream→peer mapping, plus every peer
   * ever seen (label/deviceId/role) — everything a cold desk needs to
   * rebuild lanes, take ordering, and its status-polling set in ONE
   * round-trip. `takes[].id` stays for existing consumers. */
  async sessionSummary(sessionId: string) {
    const takes = await this.db
      .select()
      .from(schema.takes)
      .where(eq(schema.takes.sessionId, sessionId))
      .orderBy(asc(schema.takes.startedAt), asc(schema.takes.id));
    const takeIds = takes.map((t) => t.id);
    const streams = takeIds.length
      ? await this.db
          .select({
            streamId: schema.streams.id,
            takeId: schema.streams.takeId,
            peerId: schema.streams.peerId,
            finalSeq: schema.streams.finalSeq,
          })
          .from(schema.streams)
          .where(inArray(schema.streams.takeId, takeIds))
      : [];
    const streamsByTake = new Map<
      string,
      Array<{ streamId: string; peerId: string | null; finalSeq: number | null }>
    >();
    for (const s of streams) {
      const list = streamsByTake.get(s.takeId) ?? [];
      list.push({ streamId: s.streamId, peerId: s.peerId, finalSeq: s.finalSeq });
      streamsByTake.set(s.takeId, list);
    }
    const peers = await this.loadPeers(sessionId);
    return {
      sessionId,
      takes: takes.map((t) => ({ ...t, streams: streamsByTake.get(t.id) ?? [] })),
      peers: peers.map((p) => ({
        peerId: p.id,
        role: p.role,
        userAgent: p.userAgent,
        label: p.label,
        deviceId: p.deviceId,
        joinedAt: p.joinedAt,
      })),
    };
  }

  /** Per-stream status for a take, scoped to its owning session: a takeId
   * under the wrong (or an unknown) session resolves to null, never to
   * another session's data. */
  async takeSummary(sessionId: string, takeId: string) {
    const [take] = await this.db
      .select({ sessionId: schema.takes.sessionId })
      .from(schema.takes)
      .where(eq(schema.takes.id, takeId));
    if (!take || take.sessionId !== sessionId) return null;
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

  /** Peer identity behind a stream (streams.peerId → peers) for
   * human-readable download filenames (F14): the nickname when set, plus
   * the userAgent for the device-family fallback name. Null when the
   * stream has no peer attribution at all — only then does the download
   * keep the historical full-uuid name. */
  async streamPeer(streamId: string): Promise<{ label: string | null; userAgent: string } | null> {
    const [row] = await this.db
      .select({ label: schema.peers.label, userAgent: schema.peers.userAgent })
      .from(schema.streams)
      .innerJoin(schema.peers, eq(schema.streams.peerId, schema.peers.id))
      .where(eq(schema.streams.id, streamId));
    return row ?? null;
  }

  /** Reassemble a playable .flac: seq0 codec header ++ payloads 1..=final.
   * Refuses when incomplete unless `allowPartial` (never lie about audio).
   * Failures are discriminated: "not-found" means the stream row does not
   * exist (never did, or was hard-deleted — gone forever), "incomplete"
   * means the stream is known but cannot honestly be served yet.
   *
   * The assembled copy's STREAMINFO is finalized with the SERVED sample
   * count (QA #27): the streamed bootstrap says total-samples unknown, but
   * once assembly happens the sum of the served chunks' sampleCounts is
   * exactly what a decoder will get out of this file — for a complete
   * stream the full take, for a `?partial=1` serve the held subset. Both
   * get the honest number: total-samples describes THIS file, not the
   * platonic take, and "unknown" would leave players durationless for a
   * length we know precisely. Stored blobs are never touched — see
   * flac-streaminfo.ts for the §13 no-transcode reasoning. */
  async reconstructFlac(
    streamId: string,
    allowPartial = false,
  ): Promise<
    | { ok: true; bytes: Uint8Array }
    | { ok: false; code: "not-found" | "incomplete"; reason: string }
  > {
    const [stream] = await this.db
      .select()
      .from(schema.streams)
      .where(eq(schema.streams.id, streamId));
    if (!stream) return { ok: false, code: "not-found", reason: "unknown stream" };
    const rows = await this.db
      .select()
      .from(schema.chunks)
      .where(eq(schema.chunks.streamId, streamId))
      .orderBy(asc(schema.chunks.seq));
    if (rows.length === 0 || rows[0]?.seq !== 0) {
      return { ok: false, code: "incomplete", reason: "stream header (seq 0) not held" };
    }
    if (!allowPartial) {
      if (stream.finalSeq === null) {
        return { ok: false, code: "incomplete", reason: "final seq unknown" };
      }
      const expected = stream.finalSeq + 1;
      if (rows.length !== expected) {
        return { ok: false, code: "incomplete", reason: `holds ${rows.length}/${expected} chunks` };
      }
    }
    // Sum over the rows actually served (seq 0 carries sampleCount 0), so
    // partial serves advertise the partial length. Chunk rows are the
    // metadata source of truth — no decode needed.
    const servedSamples = rows.reduce((n, row) => n + row.sampleCount, 0);
    const parts: Uint8Array[] = [];
    for (const row of rows) {
      const frame = await this.blobs.get(row.blobKey);
      if (row.seq === 0) {
        parts.push(
          withTotalSamples(extract_codec_header(extract_chunk_payload(frame)), servedSamples),
        );
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
