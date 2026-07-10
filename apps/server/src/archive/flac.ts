// .flac reassembly for GET /api/streams/:streamId/flac.

import { extract_chunk_payload, extract_codec_header } from "@antiphon/core-wasm";
import { asc, eq } from "drizzle-orm";
import type { BlobStore } from "../blob/index.ts";
import type { Db } from "../db/index.ts";
import { schema } from "../db/index.ts";
import { withTotalSamples } from "../flac-streaminfo.ts";

/** Reassemble a playable .flac: seq0 codec header ++ payloads 1..=final.
 * Refuses when incomplete unless `allowPartial` (never lie about audio).
 * "not-found" = the stream row does not exist (never did, or hard-deleted);
 * "incomplete" = known but cannot honestly be served yet. */
export async function reconstructFlac(
  db: Db,
  blobs: BlobStore,
  streamId: string,
  allowPartial = false,
): Promise<
  { ok: true; bytes: Uint8Array } | { ok: false; code: "not-found" | "incomplete"; reason: string }
> {
  const [stream] = await db.select().from(schema.streams).where(eq(schema.streams.id, streamId));
  if (!stream) return { ok: false, code: "not-found", reason: "unknown stream" };
  const rows = await db
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
  // STREAMINFO is finalized with the SERVED sample count (sum over the rows
  // actually served; seq 0 carries 0), so partial serves advertise the
  // partial length. Stored blobs stay untouched — see flac-streaminfo.ts.
  const servedSamples = rows.reduce((n, row) => n + row.sampleCount, 0);
  const parts: Uint8Array[] = [];
  for (const row of rows) {
    const frame = await blobs.get(row.blobKey);
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
