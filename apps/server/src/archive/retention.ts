// Archive deletion paths (RFC §12: expiry + hard deletion). The two paths
// bias opposite ways on purpose — see each function's ordering note.

import { eq, inArray, lt } from "drizzle-orm";
import type { BlobStore } from "../blob/index.ts";
import type { Db } from "../db/index.ts";
import { schema } from "../db/index.ts";
import type { Logger } from "../logger.ts";

/** Sessions whose last signaling activity predates `cutoff`. */
export async function listSessionsIdleSince(db: Db, cutoff: Date): Promise<string[]> {
  const rows = await db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(lt(schema.sessions.lastActivityAt, cutoff));
  return rows.map((r) => r.id);
}

/** Drop a take row that ended with zero streams so it never haunts the
 * session summary. Safe against late chunks: persistence re-creates the
 * take row on arrival. */
export async function deleteTakeIfEmpty(db: Db, takeId: string): Promise<boolean> {
  const remaining = await db
    .select({ id: schema.streams.id })
    .from(schema.streams)
    .where(eq(schema.streams.takeId, takeId))
    .limit(1);
  if (remaining.length > 0) return false;
  await db.delete(schema.takes).where(eq(schema.takes.id, takeId));
  return true;
}

/** Delete streams outright (desk-initiated take removal): rows first
 * (stream delete cascades chunks + gaps), then blobs — a failed blob delete
 * leaks bytes but can never resurrect a row. Takes losing their last stream
 * are removed too; returns those take ids. Idempotent. */
export async function deleteStreams(
  db: Db,
  blobs: BlobStore,
  log: Logger,
  refs: Array<{ takeId: string; streamId: string }>,
): Promise<string[]> {
  if (refs.length === 0) return [];
  const streamIds = refs.map((r) => r.streamId);
  const blobRows = await db
    .select({ blobKey: schema.chunks.blobKey })
    .from(schema.chunks)
    .where(inArray(schema.chunks.streamId, streamIds));
  await db.delete(schema.streams).where(inArray(schema.streams.id, streamIds));
  for (const row of blobRows) {
    try {
      await blobs.delete(row.blobKey);
    } catch (error) {
      // Orphaned blob: harmless (unreferenced by any row) but worth eyes.
      log.warn("blob delete failed after stream delete; blob orphaned", {
        blobKey: row.blobKey,
        error,
      });
    }
  }
  const deletedTakeIds: string[] = [];
  for (const takeId of new Set(refs.map((r) => r.takeId))) {
    const remaining = await db
      .select({ id: schema.streams.id })
      .from(schema.streams)
      .where(eq(schema.streams.takeId, takeId))
      .limit(1);
    if (remaining.length === 0) {
      await db.delete(schema.takes).where(eq(schema.takes.id, takeId));
      deletedTakeIds.push(takeId);
    }
  }
  return deletedTakeIds;
}

/** Hard-delete a whole session: blobs FIRST, then rows. A failed blob
 * delete aborts with rows intact, so a retry re-attempts every blob — a
 * hard delete must never leak recordings of identifiable people (RFC §12).
 * Idempotent: an unknown session deletes to nothing. */
export async function deleteSession(db: Db, blobs: BlobStore, sessionId: string): Promise<void> {
  const takes = await db
    .select({ id: schema.takes.id })
    .from(schema.takes)
    .where(eq(schema.takes.sessionId, sessionId));
  const takeIds = takes.map((t) => t.id);
  const streams = takeIds.length
    ? await db
        .select({ id: schema.streams.id })
        .from(schema.streams)
        .where(inArray(schema.streams.takeId, takeIds))
    : [];
  const streamIds = streams.map((s) => s.id);
  const blobRows = streamIds.length
    ? await db
        .select({ blobKey: schema.chunks.blobKey })
        .from(schema.chunks)
        .where(inArray(schema.chunks.streamId, streamIds))
    : [];
  for (const row of blobRows) {
    await blobs.delete(row.blobKey);
  }
  if (streamIds.length) {
    await db.delete(schema.chunks).where(inArray(schema.chunks.streamId, streamIds));
    await db.delete(schema.gaps).where(inArray(schema.gaps.streamId, streamIds));
    await db.delete(schema.streams).where(inArray(schema.streams.id, streamIds));
  }
  if (takeIds.length) {
    await db.delete(schema.takes).where(inArray(schema.takes.id, takeIds));
  }
  await db.delete(schema.chirps).where(eq(schema.chirps.sessionId, sessionId));
  // The caller drops the live collab room BEFORE this runs (destroySession
  // ordering), so no debounced save resurrects the doc row; the sessions FK
  // cascade backstops any race.
  await db.delete(schema.collabDocs).where(eq(schema.collabDocs.sessionId, sessionId));
  await db.delete(schema.peers).where(eq(schema.peers.sessionId, sessionId));
  await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}
