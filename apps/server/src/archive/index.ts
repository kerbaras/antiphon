// Archive: every chunk persisted — metadata in Postgres, frame bytes in the
// blob store. Source of truth; the persistence boundary ingest talks
// through. Read side in read.ts, deletion paths in retention.ts.

import { and, eq } from "drizzle-orm";
import { type BlobStore, chunkBlobKey } from "../blob/index.ts";
import type { Db } from "../db/index.ts";
import { schema } from "../db/index.ts";
import { createLogger } from "../logger.ts";
import { reconstructFlac } from "./flac.ts";
import * as read from "./read.ts";
import * as retention from "./retention.ts";

export { chunkSetDigest } from "./read.ts";

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

  sessionExists(sessionId: string): Promise<boolean> {
    return read.sessionExists(this.db, sessionId);
  }

  streamSessionId(streamId: string): Promise<string | null> {
    return read.streamSessionId(this.db, streamId);
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
    avatarUrl: string | null;
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
        avatarUrl: peer.avatarUrl,
        joinedAt: peer.joinedAt,
      })
      .onConflictDoUpdate({
        target: schema.peers.id,
        set: {
          userAgent: peer.userAgent,
          label: peer.label,
          deviceId: peer.deviceId,
          avatarUrl: peer.avatarUrl,
        },
      });
  }

  async updatePeerLabel(peerId: string, label: string | null): Promise<void> {
    await this.db.update(schema.peers).set({ label }).where(eq(schema.peers.id, peerId));
  }

  async loadPeers(sessionId: string) {
    return await read.loadPeers(this.db, sessionId);
  }

  async stopTake(takeId: string): Promise<void> {
    await this.db
      .update(schema.takes)
      .set({ stoppedAt: new Date() })
      .where(and(eq(schema.takes.id, takeId)));
  }

  deleteTakeIfEmpty(takeId: string): Promise<boolean> {
    return retention.deleteTakeIfEmpty(this.db, takeId);
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

  /** Idempotent chunk persist: blob before row — a row implies a durable
   * blob; re-put on duplicate is harmless (same immutable bytes). Returns
   * whether the row was new. */
  async persistChunk(meta: ChunkMetaRecord, frameBytes: Uint8Array): Promise<boolean> {
    const blobKey = chunkBlobKey(meta.takeId, meta.streamId, meta.seq);
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

  // ---- deletion / retention (see retention.ts for ordering rules) -------

  deleteStreams(refs: Array<{ takeId: string; streamId: string }>): Promise<string[]> {
    return retention.deleteStreams(this.db, this.blobs, this.log, refs);
  }

  listSessionsIdleSince(cutoff: Date): Promise<string[]> {
    return retention.listSessionsIdleSince(this.db, cutoff);
  }

  deleteSession(sessionId: string): Promise<void> {
    return retention.deleteSession(this.db, this.blobs, sessionId);
  }

  // ---- read side (REST + crash rebuild, see read.ts / flac.ts) -----------

  loadSessionState(sessionId: string) {
    return read.loadSessionState(this.db, sessionId);
  }

  getFrameBytes(takeId: string, streamId: string, seq: number): Promise<Uint8Array> {
    return this.blobs.get(chunkBlobKey(takeId, streamId, seq));
  }

  sessionSummary(sessionId: string) {
    return read.sessionSummary(this.db, sessionId);
  }

  takeSummary(sessionId: string, takeId: string) {
    return read.takeSummary(this.db, sessionId, takeId);
  }

  streamPeer(streamId: string): Promise<{ label: string | null; userAgent: string } | null> {
    return read.streamPeer(this.db, streamId);
  }

  reconstructFlac(streamId: string, allowPartial = false) {
    return reconstructFlac(this.db, this.blobs, streamId, allowPartial);
  }
}
