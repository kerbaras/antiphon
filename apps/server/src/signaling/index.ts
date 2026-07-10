// Signaling: WS rooms, ICE relay, take lifecycle fanout (RFC §4.1, §5).
// The server relays ICE between peers, answers offers addressed to its own
// well-known sink peer id, and is the fallback control authority.

import { parseSignalingMessage, type SignalingMessage } from "@antiphon/protocol";
import type { WSContext } from "hono/ws";
import type { Archive } from "../archive/index.ts";
import { createLogger } from "../logger.ts";
import { TokenBucket } from "../ratelimit.ts";
import { dispatchMessage } from "./handlers.ts";
import { type HelloHost, handleHello } from "./hello.ts";
import {
  type ConnState,
  createRoom,
  DEFAULT_LIMITS,
  type DeskHelloAuth,
  leave,
  type Room,
  type SignalingLimits,
  send,
} from "./room.ts";

export type { ConnState, DeskHelloAuth, SignalingLimits } from "./room.ts";

export class Signaling {
  private readonly rooms = new Map<string, Promise<Room>>();
  /** Rooms whose init has resolved (subset of `rooms`), for sync inspection. */
  private readonly live = new Map<string, Room>();
  private readonly archive: Archive;
  private readonly limits: SignalingLimits;
  private readonly deskHelloAuth: DeskHelloAuth | null;
  private readonly log = createLogger({ module: "signaling" });
  private readonly helloHost: HelloHost;
  private epochs = 0;

  constructor(
    archive: Archive,
    limits: Partial<SignalingLimits> = {},
    deskHelloAuth: DeskHelloAuth | null = null,
  ) {
    this.archive = archive;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.deskHelloAuth = deskHelloAuth;
    this.helloHost = {
      archive: this.archive,
      limits: this.limits,
      log: this.log,
      nextEpoch: () => ++this.epochs,
      activeSessionCount: () => this.activeSessionCount(),
    };
  }

  private async getRoom(sessionId: string): Promise<Room> {
    let pending = this.rooms.get(sessionId);
    if (!pending) {
      pending = createRoom(sessionId, this.archive).then((room) => {
        this.live.set(sessionId, room);
        return room;
      });
      this.rooms.set(sessionId, pending);
    }
    return await pending;
  }

  ingestStatus(sessionId: string): Promise<string> {
    return this.getRoom(sessionId).then((room) => room.ingest.status());
  }

  async handleMessage(conn: ConnState, ws: WSContext, raw: string): Promise<void> {
    conn.msgBucket ??= new TokenBucket(this.limits.msgBurst, this.limits.msgRatePerSec);
    if (!conn.msgBucket.take()) {
      this.log.warn("signaling message flood; disconnecting", {
        sessionId: conn.sessionId,
        peerId: conn.peerId,
      });
      send(ws, {
        v: 1,
        type: "error",
        code: "rate-limited",
        message: "signaling message rate exceeded",
        fatal: true,
      });
      ws.close();
      return;
    }
    let msg: SignalingMessage | null;
    try {
      msg = parseSignalingMessage(raw);
    } catch (error) {
      this.log.warn("malformed signaling message", {
        sessionId: conn.sessionId,
        peerId: conn.peerId,
        error,
      });
      send(ws, { v: 1, type: "error", code: "malformed", message: "unparseable message" });
      return;
    }
    if (msg === null) return; // unknown type / future version: ignore (§5)

    if (msg.type === "hello") {
      // A desk hello is judged BEFORE the room exists: an unauthorized desk
      // must attach zero session state (no room, no ingest, no peer).
      // Fatal by contract — the client halts its reconnect loop.
      if (conn.pathRole === "desk" && this.deskHelloAuth) {
        const verdict = await this.deskHelloAuth(conn.sessionId, msg.authToken);
        if (!verdict.ok) {
          this.log.warn("desk hello refused: unauthorized", { sessionId: conn.sessionId });
          send(ws, {
            v: 1,
            type: "error",
            code: "unauthorized",
            message: verdict.message,
            fatal: true,
          });
          ws.close();
          return;
        }
      }
      await handleHello(this.helloHost, conn, ws, await this.getRoom(conn.sessionId), msg);
      return;
    }
    if (!conn.peerId) {
      // Checked before getRoom on purpose: a socket that never said hello
      // (authorized or not) must not conjure a room into existence.
      send(ws, { v: 1, type: "error", code: "no-hello", message: "hello first" });
      return;
    }
    const room = await this.getRoom(conn.sessionId);
    const from = room.peers.get(conn.peerId);
    if (!from) return;
    await dispatchMessage({ archive: this.archive, log: this.log }, room, conn, ws, from, msg);
  }

  handleClose(conn: ConnState): void {
    const pending = this.rooms.get(conn.sessionId);
    if (!pending) return;
    void pending.then((room) => leave(conn, room));
  }

  // ---- retention hooks (RFC §12: expiry + hard deletion) -----------------

  /** True while the session must not be expired: connected peers, an active
   * take, live ingest links, or a room still initializing. */
  sessionBusy(sessionId: string): boolean {
    if (!this.rooms.has(sessionId)) return false;
    const room = this.live.get(sessionId);
    if (!room) return true; // init in flight — treat as busy
    return (
      room.peers.size > 0 || room.activeTake !== null || room.ingest.connectedPeerIds().length > 0
    );
  }

  /** Disconnect all live peers and drop the room (session hard-delete path).
   * A later join rebuilds state from the archive (RFC §8). */
  async closeSession(sessionId: string): Promise<void> {
    const pending = this.rooms.get(sessionId);
    this.rooms.delete(sessionId);
    this.live.delete(sessionId);
    if (!pending) return;
    const room = await pending.catch(() => null);
    if (!room) return;
    for (const peer of room.peers.values()) {
      send(peer.ws, {
        v: 1,
        type: "error",
        code: "session-deleted",
        message: "session was deleted",
        fatal: true,
      });
      try {
        peer.ws.close();
      } catch (error) {
        this.log.debug("ws close failed; peer already gone", {
          sessionId,
          peerId: peer.peerId,
          error,
        });
      }
    }
    room.peers.clear();
    await room.ingest.close();
  }

  /** Drop in-memory rooms with no peers, no active take, and no ingest
   * links (sweep hygiene — rooms are otherwise never evicted). */
  async pruneIdleRooms(): Promise<void> {
    for (const [sessionId, room] of this.live) {
      if (room.peers.size > 0 || room.activeTake !== null) continue;
      if (room.ingest.connectedPeerIds().length > 0) continue;
      this.rooms.delete(sessionId);
      this.live.delete(sessionId);
      await room.ingest.close();
      this.log.debug("pruned idle room", { sessionId });
    }
  }

  private activeSessionCount(): number {
    let count = 0;
    for (const room of this.live.values()) {
      if (room.peers.size > 0 || room.activeTake !== null) count += 1;
    }
    return count;
  }

  async close(): Promise<void> {
    for (const pending of this.rooms.values()) {
      const room = await pending.catch(() => null);
      if (!room) continue;
      // Upgraded WS sockets are detached from the HTTP server's connection
      // tracking; close them explicitly or shutdown hangs.
      for (const peer of room.peers.values()) {
        try {
          peer.ws.close();
        } catch (error) {
          this.log.debug("ws close failed; peer already gone", {
            sessionId: room.sessionId,
            peerId: peer.peerId,
            error,
          });
        }
      }
      await room.ingest.close();
    }
    this.rooms.clear();
    this.live.clear();
  }
}
