// Archive read side: status summaries and the crash-rebuild scan (RFC §8).
// Pure queries over Db; .flac reassembly lives in flac.ts.

import { createHash } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { schema } from "../db/index.ts";

/** Row-existence probe backing the public /exists endpoint — cheaper and
 * less revealing than sessionSummary. */
export async function sessionExists(db: Db, sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);
  return rows.length > 0;
}

/** Session id owning a stream (stream → take → session), for the FLAC
 * route's authorization. Null = unknown stream. */
export async function streamSessionId(db: Db, streamId: string): Promise<string | null> {
  const rows = await db
    .select({ sessionId: schema.takes.sessionId })
    .from(schema.streams)
    .innerJoin(schema.takes, eq(schema.streams.takeId, schema.takes.id))
    .where(eq(schema.streams.id, streamId))
    .limit(1);
  return rows[0]?.sessionId ?? null;
}

/** Known peers of a session — also rebuilds the device→peer index on room
 * boot so identity resume survives a server restart. */
export async function loadPeers(db: Db, sessionId: string) {
  return await db.select().from(schema.peers).where(eq(schema.peers.sessionId, sessionId));
}

/** Everything needed to rebuild a session's SinkEngine from disk. */
export async function loadSessionState(db: Db, sessionId: string) {
  const takes = await db.select().from(schema.takes).where(eq(schema.takes.sessionId, sessionId));
  if (takes.length === 0) return { streams: [], chunks: [], gaps: [] };
  const takeIds = takes.map((t) => t.id);
  const streams = await db
    .select()
    .from(schema.streams)
    .where(inArray(schema.streams.takeId, takeIds));
  const chunks = await db
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
  const gaps = streamIds.length
    ? await db.select().from(schema.gaps).where(inArray(schema.gaps.streamId, streamIds))
    : [];
  return { streams, chunks, gaps };
}

/** Session snapshot with full attribution: takes in chronological order,
 * each with its stream→peer mapping, plus every peer ever seen — all a cold
 * desk needs in one round-trip. Null when the session row does not exist
 * (an honest 404, never a fabricated empty summary). */
export async function sessionSummary(db: Db, sessionId: string) {
  const [session] = await db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId));
  if (!session) return null;
  const takes = await db
    .select()
    .from(schema.takes)
    .where(eq(schema.takes.sessionId, sessionId))
    .orderBy(asc(schema.takes.startedAt), asc(schema.takes.id));
  const takeIds = takes.map((t) => t.id);
  const streams = takeIds.length
    ? await db
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
  const peers = await loadPeers(db, sessionId);
  return {
    sessionId,
    takes: takes.map((t) => ({ ...t, streams: streamsByTake.get(t.id) ?? [] })),
    peers: peers.map((p) => ({
      peerId: p.id,
      role: p.role,
      userAgent: p.userAgent,
      label: p.label,
      deviceId: p.deviceId,
      avatarUrl: p.avatarUrl,
      joinedAt: p.joinedAt,
    })),
  };
}

/** Per-stream status for a take, scoped to its owning session: a takeId
 * under the wrong (or an unknown) session resolves to null, never to
 * another session's data. */
export async function takeSummary(db: Db, sessionId: string, takeId: string) {
  const [take] = await db
    .select({ sessionId: schema.takes.sessionId })
    .from(schema.takes)
    .where(eq(schema.takes.id, takeId));
  if (!take || take.sessionId !== sessionId) return null;
  const streams = await db.select().from(schema.streams).where(eq(schema.streams.takeId, takeId));
  const result = [];
  for (const stream of streams) {
    const rows = await db
      .select({ seq: schema.chunks.seq, crc32c: schema.chunks.crc32c })
      .from(schema.chunks)
      .where(eq(schema.chunks.streamId, stream.id))
      .orderBy(asc(schema.chunks.seq));
    const gapRows = await db.select().from(schema.gaps).where(eq(schema.gaps.streamId, stream.id));
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

/** Peer identity behind a stream, for human-readable download filenames:
 * nickname when set, userAgent for the device-family fallback. Null when
 * the stream has no peer attribution (download keeps the full-uuid name). */
export async function streamPeer(
  db: Db,
  streamId: string,
): Promise<{ label: string | null; userAgent: string } | null> {
  const [row] = await db
    .select({ label: schema.peers.label, userAgent: schema.peers.userAgent })
    .from(schema.streams)
    .innerJoin(schema.peers, eq(schema.streams.peerId, schema.peers.id))
    .where(eq(schema.streams.id, streamId));
  return row ?? null;
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
