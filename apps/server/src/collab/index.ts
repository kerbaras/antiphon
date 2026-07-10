// Shared project doc: one Y.Doc per session, synced to desks over the
// /session/:uuid/collab WSS route and persisted as one merged update in
// Postgres. Relay + durable replica only — audio bytes are NEVER in the doc.
//
// The doc carries mix state, markers, comments and clip arrangement ONLY;
// transport control (record/stop/chirp/delete/disarm) stays on the
// signaling protocol — any desk may issue them, last write wins.

import type { WSContext } from "hono/ws";
import type { Db } from "../db/index.ts";
import { createLogger } from "../logger.ts";
import { TokenBucket } from "../ratelimit.ts";
import { type ConnectionHost, handleConnection } from "./connection.ts";
import { type CollabConn, type CollabRoom, createRoom, flushRoom } from "./room.ts";

export { frame, MSG_AWARENESS, MSG_SYNC_STEP1, MSG_UPDATE } from "./room.ts";

export interface CollabOptions {
  msgRatePerSec: number;
  msgBurst: number;
  /** Zero-connection rooms are dropped from memory (doc flushed first)
   * after this idle grace; a rejoin rebuilds from Postgres. */
  idleEvictMs: number;
}

export class CollabHub {
  private readonly rooms = new Map<string, Promise<CollabRoom>>();
  private readonly live = new Map<string, CollabRoom>();
  private readonly log = createLogger({ module: "collab" });
  private readonly db: Db;
  private readonly options: CollabOptions;
  /** Set by close(): the hub refuses new rooms/attaches from then on. A WS
   * upgrade can race SIGTERM (server.close() doesn't stop sockets already
   * upgrading), so shutdown must reject latecomers, not serve them. */
  private closing = false;
  private readonly connHost: ConnectionHost;

  constructor(db: Db, options: CollabOptions) {
    this.db = db;
    this.options = options;
    this.connHost = {
      log: this.log,
      newMsgBucket: () => new TokenBucket(options.msgBurst, options.msgRatePerSec),
      attachRoom: (sessionId, conn) => this.attachRoom(sessionId, conn),
      getRoom: (sessionId) => this.getRoom(sessionId),
      pendingRoom: (sessionId) => this.rooms.get(sessionId),
      releaseRoom: (room) => this.releaseRoom(room),
    };
  }

  /** Whether a room is resident in memory (ops/test introspection). */
  hasLiveRoom(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  private async getRoom(sessionId: string): Promise<CollabRoom> {
    if (this.closing) throw new Error("collab hub is shutting down");
    let pending = this.rooms.get(sessionId);
    if (!pending) {
      pending = createRoom(this.db, sessionId).then((room) => {
        // A load in flight when close() ran must not resurrect a room in
        // the maps close() just vacated — reject like the guard above.
        if (this.closing) {
          room.awareness.destroy();
          room.doc.destroy();
          throw new Error("collab hub is shutting down");
        }
        this.live.set(sessionId, room);
        return room;
      });
      this.rooms.set(sessionId, pending);
    }
    return await pending;
  }

  /** Resolve the room and claim membership, closing the attach↔evict race:
   * eviction/session-close flag `evicted` and vacate the maps in the same
   * synchronous block, so a retry's getRoom builds a fresh room. The loop
   * is BOUNDED: an evicted room that somehow stayed resident would make
   * `continue` re-await the same cached promise forever — a microtask spin
   * that starves timers and deadlocks close(). Two retries cover every
   * legal interleaving; beyond that, throw and the caller closes. */
  private async attachRoom(sessionId: string, conn: CollabConn): Promise<CollabRoom> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const room = await this.getRoom(sessionId);
      if (room.evicted) continue; // lost the race — a fresh getRoom rebuilds
      room.conns.add(conn);
      if (room.evictTimer) {
        clearTimeout(room.evictTimer);
        room.evictTimer = null;
      }
      return room;
    }
    throw new Error("collab attach kept racing evicted rooms; refusing to spin");
  }

  /** Hono WS handlers for one desk connection to /session/:uuid/collab. */
  handleConnection(sessionId: string): {
    onOpen: (ws: WSContext) => void;
    onMessage: (data: unknown, ws: WSContext) => void;
    onClose: () => void;
  } {
    return handleConnection(this.connHost, sessionId);
  }

  /** Last desk left: flush the doc now (don't sit on the debounce), then
   * start the idle-grace countdown. The room stays resident through the
   * grace so a bouncing desk reattaches with zero load races. */
  private async releaseRoom(room: CollabRoom): Promise<void> {
    if (room.conns.size > 0) return; // someone rejoined while we scheduled
    await flushRoom(this.db, room);
    if (room.conns.size > 0 || room.evicted) return; // rejoined mid-flush / already gone
    this.scheduleEvict(room);
  }

  private scheduleEvict(room: CollabRoom): void {
    if (room.evictTimer) clearTimeout(room.evictTimer);
    room.evictTimer = setTimeout(() => {
      room.evictTimer = null;
      this.evictRoom(room).catch((error: unknown) => {
        this.log.warn("collab room eviction failed", { sessionId: room.sessionId, error });
      });
    }, this.options.idleEvictMs);
    room.evictTimer.unref(); // never keep the process alive for housekeeping
  }

  /** Idle grace expired with the room still empty: force any pending
   * debounced write, then drop the room from memory. A later join rebuilds
   * the doc from Postgres — eviction is invisible to desks. */
  private async evictRoom(room: CollabRoom): Promise<void> {
    if (room.conns.size > 0 || room.evicted) return;
    await flushRoom(this.db, room);
    if (room.conns.size > 0 || room.evicted) return; // desk attached mid-flush
    if (room.dirty) {
      // The flush failed (save() logged why and re-flagged the room).
      // Never drop unsaved edits — keep the room and retry after another
      // grace; session delete clears the timer and frees without saving.
      this.scheduleEvict(room);
      return;
    }
    room.evicted = true;
    this.rooms.delete(room.sessionId);
    this.live.delete(room.sessionId);
    room.awareness.destroy();
    room.doc.destroy();
    this.log.info("idle collab room evicted", {
      sessionId: room.sessionId,
      idleMs: this.options.idleEvictMs,
    });
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
    if (room.evictTimer) {
      clearTimeout(room.evictTimer);
      room.evictTimer = null;
    }
    room.evicted = true; // an in-flight evictRoom flush must not double-free
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

  /** Graceful shutdown: flush every dirty room. The closing flag flips and
   * the maps are vacated BEFORE the first await — an upgrade racing SIGTERM
   * gets a clean rejection from the getRoom guard, and no attach can spin
   * on a still-cached promise of an evicted room (that interleaving once
   * hung shutdown until SIGKILL; collab-shutdown.test.ts pins it). */
  async close(): Promise<void> {
    this.closing = true;
    const rooms = [...this.live.values()];
    this.rooms.clear();
    this.live.clear();
    for (const room of rooms) {
      if (room.evictTimer) {
        clearTimeout(room.evictTimer);
        room.evictTimer = null;
      }
      room.evicted = true; // pending evictions are moot; nothing double-frees
      await flushRoom(this.db, room);
      room.awareness.destroy();
      room.doc.destroy();
    }
  }
}
