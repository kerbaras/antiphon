// Collab room state, wire framing, and doc persistence helpers.

import { eq } from "drizzle-orm";
import type { WSContext } from "hono/ws";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Db } from "../db/index.ts";
import { schema } from "../db/index.ts";
import { createLogger } from "../logger.ts";
import type { TokenBucket } from "../ratelimit.ts";

const log = createLogger({ module: "collab" });

// Binary WS frames: 1-byte tag + payload (y-protocols sync semantics,
// hand-framed so the dependency surface stays yjs + y-protocols public
// APIs). On open each side sends its step-1; a step-1 is answered with the
// diff update; live edits fan out as tag-1 frames.
export const MSG_SYNC_STEP1 = 0; // payload = Y.encodeStateVector(doc)
export const MSG_UPDATE = 1; // payload = Y update
export const MSG_AWARENESS = 2; // payload = awareness update (presence)

/** Debounce for persisting the merged doc after the last change. */
const SAVE_DEBOUNCE_MS = 2_000;

export function frame(tag: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(1 + payload.length);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}

/** Per-connection state (awareness origin + flood guard). */
export interface CollabConn {
  ws: WSContext;
  /** Awareness clientIDs this connection introduced — pruned on close. */
  controlledIds: Set<number>;
  msgBucket: TokenBucket;
}

export interface CollabRoom {
  sessionId: string;
  doc: Y.Doc;
  awareness: Awareness;
  conns: Set<CollabConn>;
  saveTimer: NodeJS.Timeout | null;
  dirty: boolean;
  /** Serializes saves so a flush never races the debounced writer. */
  saving: Promise<void>;
  /** Idle-grace countdown started when the last desk leaves. */
  evictTimer: NodeJS.Timeout | null;
  /** Set at the moment the room leaves the maps; a late attach that raced
   * the eviction sees the flag and rebuilds a fresh room from Postgres. */
  evicted: boolean;
}

interface AwarenessDelta {
  added: number[];
  updated: number[];
  removed: number[];
}

/** Load (or start) the session doc from Postgres and wire fanout + the
 * debounced save. */
export async function createRoom(db: Db, sessionId: string): Promise<CollabRoom> {
  const doc = new Y.Doc();
  const row = await db
    .select({ doc: schema.collabDocs.doc })
    .from(schema.collabDocs)
    .where(eq(schema.collabDocs.sessionId, sessionId));
  if (row[0]) Y.applyUpdate(doc, new Uint8Array(row[0].doc), "load");
  const awareness = new Awareness(doc);
  awareness.setLocalState(null); // the server has no presence of its own
  const room: CollabRoom = {
    sessionId,
    doc,
    awareness,
    conns: new Set(),
    saveTimer: null,
    dirty: false,
    saving: Promise.resolve(),
    evictTimer: null,
    evicted: false,
  };
  // Any doc change (from any desk) schedules a debounced merged save and
  // fans out to every other desk.
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "load") scheduleSave(db, room);
    broadcast(room, frame(MSG_UPDATE, update), origin);
  });
  // Awareness deltas (presence joins/moves/leaves, incl. the 30s
  // outdated-state purge) fan out likewise.
  awareness.on("update", ({ added, updated, removed }: AwarenessDelta, origin: unknown) => {
    const changed = [...added, ...updated, ...removed];
    // Track which clientIDs each connection speaks for, so its presence is
    // pruned the moment the socket closes.
    if (origin && room.conns.has(origin as CollabConn)) {
      const conn = origin as CollabConn;
      for (const id of [...added, ...updated]) conn.controlledIds.add(id);
      for (const id of removed) conn.controlledIds.delete(id);
    }
    broadcast(room, frame(MSG_AWARENESS, encodeAwarenessUpdate(awareness, changed)), origin);
  });
  return room;
}

export function broadcast(room: CollabRoom, bytes: Uint8Array<ArrayBuffer>, origin: unknown): void {
  for (const conn of room.conns) {
    if (conn === origin) continue; // the editor already has this change
    send(conn, bytes);
  }
}

export function send(conn: CollabConn, bytes: Uint8Array<ArrayBuffer>): void {
  try {
    conn.ws.send(bytes);
  } catch (error) {
    log.debug("collab send failed; peer gone", { error });
  }
}

function scheduleSave(db: Db, room: CollabRoom): void {
  room.dirty = true;
  if (room.saveTimer) return;
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    room.saving = room.saving.then(() => save(db, room));
  }, SAVE_DEBOUNCE_MS);
  room.saveTimer.unref();
}

async function save(db: Db, room: CollabRoom): Promise<void> {
  if (!room.dirty) return;
  room.dirty = false;
  const bytes = Buffer.from(Y.encodeStateAsUpdate(room.doc));
  try {
    await db
      .insert(schema.collabDocs)
      .values({ sessionId: room.sessionId, doc: bytes, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.collabDocs.sessionId,
        set: { doc: bytes, updatedAt: new Date() },
      });
  } catch (error) {
    // Expected once in the deletion race (session row gone → FK refuses);
    // anything else is a real persistence failure worth surfacing.
    room.dirty = true;
    log.warn("collab doc save failed", { sessionId: room.sessionId, error });
  }
}

/** Cancel any pending debounce and force a save now, serialized behind any
 * in-flight write. */
export function flushRoom(db: Db, room: CollabRoom): Promise<void> {
  if (room.saveTimer) {
    clearTimeout(room.saveTimer);
    room.saveTimer = null;
  }
  room.saving = room.saving.then(() => save(db, room));
  return room.saving;
}
