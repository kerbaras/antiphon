// W3-A shared project doc: one Y.Doc per session, synced to desks over the
// /session/:uuid/collab WSS route and persisted as a merged update in
// Postgres (collab_docs). The server is a relay + durable replica, not an
// editor: it never writes doc content. Audio bytes are NEVER in the doc —
// blobs stay content-addressed in the blob store (ARCHITECTURE §6).
//
// Wire protocol (binary WS frames, 1-byte tag + payload; both sides speak
// the same three messages — y-protocols sync semantics, hand-framed so the
// dependency surface stays yjs + y-protocols public APIs):
//   0x00 sync-step-1  payload = Y.encodeStateVector(doc)   "what do you have?"
//   0x01 update       payload = Y update                    step-2 reply / live edit
//   0x02 awareness    payload = y-protocols awareness update (presence)
// On open each side sends its step-1; each side answers a step-1 with the
// diff update. Live edits fan out as tag-1 frames to every other desk.
//
// AUTHORITY BOUNDARY (documented for W3-A): the doc carries mix state,
// markers, comments and clip arrangement ONLY. Transport control
// (record/stop/chirp/delete/disarm) stays on the signaling protocol exactly
// as with one desk — any desk socket may issue them, last write wins, and
// A14 re-assert semantics are unchanged. Multi-desk take authority (a
// server-side room epoch) is the documented v2 follow-up, out of scope here.

import { eq } from "drizzle-orm";
import type { WSContext } from "hono/ws";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import type { Db } from "../db/index.ts";
import { schema } from "../db/index.ts";
import { createLogger } from "../logger.ts";
import { TokenBucket } from "../ratelimit.ts";

export const MSG_SYNC_STEP1 = 0;
export const MSG_UPDATE = 1;
export const MSG_AWARENESS = 2;

/** Debounce for persisting the merged doc after the last change. */
const SAVE_DEBOUNCE_MS = 2_000;

export function frame(tag: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(1 + payload.length);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}

/** Per-connection state (awareness origin + flood guard). */
interface CollabConn {
  ws: WSContext;
  /** Awareness clientIDs this connection introduced — pruned on close. */
  controlledIds: Set<number>;
  msgBucket: TokenBucket;
}

interface CollabRoom {
  sessionId: string;
  doc: Y.Doc;
  awareness: Awareness;
  conns: Set<CollabConn>;
  saveTimer: NodeJS.Timeout | null;
  dirty: boolean;
  /** Serializes saves so a flush never races the debounced writer. */
  saving: Promise<void>;
}

export interface CollabLimits {
  msgRatePerSec: number;
  msgBurst: number;
}

export class CollabHub {
  private readonly rooms = new Map<string, Promise<CollabRoom>>();
  private readonly live = new Map<string, CollabRoom>();
  private readonly log = createLogger({ module: "collab" });
  private readonly db: Db;
  private readonly limits: CollabLimits;

  constructor(db: Db, limits: CollabLimits) {
    this.db = db;
    this.limits = limits;
  }

  private async getRoom(sessionId: string): Promise<CollabRoom> {
    let pending = this.rooms.get(sessionId);
    if (!pending) {
      pending = (async () => {
        const doc = new Y.Doc();
        const row = await this.db
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
        };
        // Any doc change (from any desk) schedules a debounced merged save
        // and fans out to every other desk.
        doc.on("update", (update: Uint8Array, origin: unknown) => {
          if (origin !== "load") this.scheduleSave(room);
          this.broadcast(room, frame(MSG_UPDATE, update), origin);
        });
        // Awareness deltas (presence joins/moves/leaves, incl. the 30s
        // outdated-state purge) fan out likewise.
        awareness.on("update", ({ added, updated, removed }: AwarenessDelta, origin: unknown) => {
          const changed = [...added, ...updated, ...removed];
          // Track which clientIDs each connection speaks for, so its
          // presence is pruned the moment the socket closes.
          if (origin && room.conns.has(origin as CollabConn)) {
            const conn = origin as CollabConn;
            for (const id of [...added, ...updated]) conn.controlledIds.add(id);
            for (const id of removed) conn.controlledIds.delete(id);
          }
          this.broadcast(
            room,
            frame(MSG_AWARENESS, encodeAwarenessUpdate(awareness, changed)),
            origin,
          );
        });
        this.live.set(sessionId, room);
        return room;
      })();
      this.rooms.set(sessionId, pending);
    }
    return await pending;
  }

  /** Hono WS handlers for one desk connection to /session/:uuid/collab. */
  handleConnection(sessionId: string): {
    onOpen: (ws: WSContext) => void;
    onMessage: (data: unknown, ws: WSContext) => void;
    onClose: () => void;
  } {
    const conn: CollabConn = {
      // Filled on open; messages before open cannot happen (ws semantics).
      ws: null as unknown as WSContext,
      controlledIds: new Set(),
      msgBucket: new TokenBucket(this.limits.msgBurst, this.limits.msgRatePerSec),
    };
    return {
      onOpen: (ws) => {
        conn.ws = ws;
        void this.getRoom(sessionId)
          .then((room) => {
            room.conns.add(conn);
            // Server speaks first: its step-1 (so the desk sends what the
            // room lacks) plus the room's current presence roster.
            this.send(conn, frame(MSG_SYNC_STEP1, Y.encodeStateVector(room.doc)));
            const clients = [...room.awareness.getStates().keys()];
            if (clients.length > 0) {
              this.send(conn, frame(MSG_AWARENESS, encodeAwarenessUpdate(room.awareness, clients)));
            }
          })
          .catch((error: unknown) => {
            this.log.error("collab room open failed", { sessionId, error });
            try {
              ws.close();
            } catch {
              // already gone
            }
          });
      },
      onMessage: (data, ws) => {
        if (!(data instanceof ArrayBuffer)) return; // text frames are not part of the protocol
        if (!conn.msgBucket.take()) {
          this.log.warn("collab message flood; disconnecting", { sessionId });
          ws.close();
          return;
        }
        const bytes = new Uint8Array(data);
        if (bytes.length < 1) return;
        void this.getRoom(sessionId)
          .then((room) => this.dispatch(room, conn, bytes))
          .catch((error: unknown) => {
            this.log.warn("collab message failed", { sessionId, error });
          });
      },
      onClose: () => {
        // Never CREATE a room on close: after shutdown/session-delete the
        // rooms map is empty and this must be a no-op (the pool is gone).
        const pending = this.rooms.get(sessionId);
        if (!pending) return;
        void pending
          .then((room) => {
            room.conns.delete(conn);
            if (conn.controlledIds.size > 0) {
              removeAwarenessStates(room.awareness, [...conn.controlledIds], "closed");
            }
            if (room.conns.size === 0) return this.releaseRoom(room);
            return undefined;
          })
          .catch((error: unknown) => {
            this.log.debug("collab close handling failed", { sessionId, error });
          });
      },
    };
  }

  private dispatch(room: CollabRoom, conn: CollabConn, bytes: Uint8Array): void {
    const payload = bytes.subarray(1);
    switch (bytes[0]) {
      case MSG_SYNC_STEP1:
        // The desk asks for what it lacks: answer with the diff update.
        this.send(conn, frame(MSG_UPDATE, Y.encodeStateAsUpdate(room.doc, payload)));
        break;
      case MSG_UPDATE:
        // Applying re-emits doc "update" → broadcast + debounced save.
        Y.applyUpdate(room.doc, payload, conn);
        break;
      case MSG_AWARENESS:
        applyAwarenessUpdate(room.awareness, payload, conn);
        break;
      default:
        break; // unknown tag from a future version: ignore
    }
  }

  private broadcast(room: CollabRoom, bytes: Uint8Array<ArrayBuffer>, origin: unknown): void {
    for (const conn of room.conns) {
      if (conn === origin) continue; // the editor already has this change
      this.send(conn, bytes);
    }
  }

  private send(conn: CollabConn, bytes: Uint8Array<ArrayBuffer>): void {
    try {
      conn.ws.send(bytes);
    } catch (error) {
      this.log.debug("collab send failed; peer gone", { error });
    }
  }

  // ---- persistence ---------------------------------------------------------

  private scheduleSave(room: CollabRoom): void {
    room.dirty = true;
    if (room.saveTimer) return;
    room.saveTimer = setTimeout(() => {
      room.saveTimer = null;
      room.saving = room.saving.then(() => this.save(room));
    }, SAVE_DEBOUNCE_MS);
    room.saveTimer.unref();
  }

  private async save(room: CollabRoom): Promise<void> {
    if (!room.dirty) return;
    room.dirty = false;
    const bytes = Buffer.from(Y.encodeStateAsUpdate(room.doc));
    try {
      await this.db
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
      this.log.warn("collab doc save failed", { sessionId: room.sessionId, error });
    }
  }

  /** Last desk left: flush the doc now (don't sit on the debounce). The
   * room object stays resident — it is tiny, a returning desk reattaches
   * with zero load races, and rooms are freed by session hard-delete /
   * expiry (closeSession). Idle-room eviction is a follow-up if long-lived
   * processes ever accumulate enough sessions for KB-sized docs to matter. */
  private async releaseRoom(room: CollabRoom): Promise<void> {
    if (room.conns.size > 0) return; // someone rejoined while we scheduled
    if (room.saveTimer) {
      clearTimeout(room.saveTimer);
      room.saveTimer = null;
    }
    room.saving = room.saving.then(() => this.save(room));
    await room.saving;
  }

  /** Session hard-delete path: disconnect desks and drop the room WITHOUT
   * saving (the row is being deleted; a flush would resurrect it). Runs
   * BEFORE archive.deleteSession — see destroySession ordering. */
  async closeSession(sessionId: string): Promise<void> {
    const pending = this.rooms.get(sessionId);
    this.rooms.delete(sessionId);
    this.live.delete(sessionId);
    if (!pending) return;
    const room = await pending.catch(() => null);
    if (!room) return;
    if (room.saveTimer) {
      clearTimeout(room.saveTimer);
      room.saveTimer = null;
    }
    room.dirty = false;
    for (const conn of room.conns) {
      try {
        conn.ws.close();
      } catch {
        // already gone
      }
    }
    room.conns.clear();
    room.awareness.destroy();
    room.doc.destroy();
  }

  /** Graceful shutdown: flush every dirty room. */
  async close(): Promise<void> {
    for (const room of this.live.values()) {
      if (room.saveTimer) {
        clearTimeout(room.saveTimer);
        room.saveTimer = null;
      }
      room.saving = room.saving.then(() => this.save(room));
      await room.saving;
      room.awareness.destroy();
      room.doc.destroy();
    }
    this.rooms.clear();
    this.live.clear();
  }
}

interface AwarenessDelta {
  added: number[];
  updated: number[];
  removed: number[];
}
