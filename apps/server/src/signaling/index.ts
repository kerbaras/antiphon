// Signaling: WS rooms, ICE relay, take lifecycle fanout (RFC §4.1, §5).
// The server relays ICE between peers, answers offers addressed to its own
// well-known sink peer id, and is the fallback control authority.

import {
  type DeviceInfo,
  negotiateVersion,
  type PeerInfo,
  type PeerRole,
  parseSignalingMessage,
  SERVER_PEER_ID,
  type SessionState,
  type SignalingMessage,
  type TakeInfo,
} from "@antiphon/protocol";
import type { WSContext } from "hono/ws";
import type { Archive } from "../archive/index.ts";
import { SessionIngest } from "../ingest/index.ts";

interface RoomPeer {
  peerId: string;
  role: PeerRole;
  deviceInfo: DeviceInfo;
  joinedAt: string;
  /** Connection generation: leave() from a superseded socket must not
   * evict the peer that adopted a newer one (A12 zombie replacement). */
  epoch: number;
  ws: WSContext;
}

/** Resumable identity (A12): what survives a peer's disconnect. */
interface DeviceRecord {
  peerId: string;
  label: string | undefined;
  joinedAt: string;
}

interface Room {
  sessionId: string;
  peers: Map<string, RoomPeer>;
  /** `role:deviceId` → identity, for peerId resume across reconnects. */
  devices: Map<string, DeviceRecord>;
  ingest: SessionIngest;
  activeTake: TakeInfo | null;
}

/** Per-connection state carried by the WS handler. */
export interface ConnState {
  sessionId: string;
  pathRole: PeerRole;
  peerId: string | null;
  epoch: number;
}

export class Signaling {
  private readonly rooms = new Map<string, Promise<Room>>();
  private readonly archive: Archive;
  private epochs = 0;

  constructor(archive: Archive) {
    this.archive = archive;
  }

  private async getRoom(sessionId: string): Promise<Room> {
    let pending = this.rooms.get(sessionId);
    if (!pending) {
      pending = (async () => {
        const room: Room = {
          sessionId,
          peers: new Map(),
          devices: new Map(),
          activeTake: null,
          ingest: new SessionIngest(sessionId, this.archive, {
            onLocalCandidate: (peerId, candidate, mid) => {
              this.sendTo(room, peerId, {
                v: 1,
                type: "ice-candidate",
                targetPeerId: peerId,
                fromPeerId: SERVER_PEER_ID,
                candidate: { candidate, sdpMid: mid },
              });
            },
            onFatal: (peerId, code, message) => {
              const msg: SignalingMessage = { v: 1, type: "error", code, message, fatal: true };
              this.sendTo(room, peerId, msg);
              for (const peer of room.peers.values()) {
                if (peer.role === "desk") this.sendTo(room, peer.peerId, msg);
              }
            },
          }),
        };
        await room.ingest.init();
        // Rebuild the device→peer index so identity resume (A12) survives
        // a server restart the same way archive state does.
        for (const row of await this.archive.loadPeers(sessionId)) {
          if (!row.deviceId) continue;
          room.devices.set(`${row.role}:${row.deviceId}`, {
            peerId: row.id,
            label: row.label ?? undefined,
            joinedAt: row.joinedAt.toISOString(),
          });
        }
        return room;
      })();
      this.rooms.set(sessionId, pending);
    }
    return await pending;
  }

  ingestStatus(sessionId: string): Promise<string> {
    return this.getRoom(sessionId).then((room) => room.ingest.status());
  }

  async handleMessage(conn: ConnState, ws: WSContext, raw: string): Promise<void> {
    let msg: SignalingMessage | null;
    try {
      msg = parseSignalingMessage(raw);
    } catch {
      this.send(ws, { v: 1, type: "error", code: "malformed", message: "unparseable message" });
      return;
    }
    if (msg === null) return; // unknown type / future version: ignore (§5)

    const room = await this.getRoom(conn.sessionId);

    if (msg.type === "hello") {
      await this.handleHello(conn, ws, room, msg);
      return;
    }
    if (!conn.peerId) {
      this.send(ws, { v: 1, type: "error", code: "no-hello", message: "hello first" });
      return;
    }
    const from = room.peers.get(conn.peerId);
    if (!from) return;

    switch (msg.type) {
      case "ice-offer": {
        if (msg.targetPeerId === SERVER_PEER_ID) {
          try {
            const answer = await room.ingest.handleOffer(from.peerId, msg.sdp);
            this.sendTo(room, from.peerId, {
              v: 1,
              type: "ice-answer",
              targetPeerId: from.peerId,
              fromPeerId: SERVER_PEER_ID,
              sdp: answer.sdp,
            });
          } catch (e) {
            this.send(ws, {
              v: 1,
              type: "error",
              code: "ingest-offer-failed",
              message: String(e),
            });
          }
        } else {
          this.relay(room, from.peerId, msg);
        }
        break;
      }
      case "ice-answer": {
        if (msg.targetPeerId !== SERVER_PEER_ID) this.relay(room, from.peerId, msg);
        break;
      }
      case "ice-candidate": {
        if (msg.targetPeerId === SERVER_PEER_ID) {
          if (msg.candidate) {
            room.ingest.addRemoteCandidate(
              from.peerId,
              msg.candidate.candidate,
              msg.candidate.sdpMid ?? "0",
            );
          }
        } else {
          this.relay(room, from.peerId, msg);
        }
        break;
      }
      case "take-start": {
        if (from.role !== "desk") {
          this.send(ws, { v: 1, type: "error", code: "not-desk", message: "desk only" });
          return;
        }
        room.activeTake = {
          takeId: msg.takeId,
          startedAt: new Date().toISOString(),
          stoppedAt: null,
          ...(msg.disarmedPeerIds?.length ? { disarmedPeerIds: msg.disarmedPeerIds } : {}),
        };
        room.ingest.noteTake(msg.takeId, msg.wallClockHint);
        this.fanout(room, msg);
        break;
      }
      case "take-stop": {
        if (from.role !== "desk") {
          this.send(ws, { v: 1, type: "error", code: "not-desk", message: "desk only" });
          return;
        }
        if (room.activeTake?.takeId === msg.takeId) room.activeTake = null;
        room.ingest.noteTakeStop(msg.takeId);
        this.fanout(room, msg);
        break;
      }
      case "stream-announce": {
        room.ingest.noteStream(msg.takeId, msg.streamId, from.peerId);
        this.fanout(room, { ...msg, fromPeerId: from.peerId });
        break;
      }
      case "stream-final": {
        room.ingest.setFinalSeq(msg.takeId, msg.streamId, msg.finalSeq);
        this.fanout(room, { ...msg, fromPeerId: from.peerId });
        break;
      }
      case "streams-delete": {
        // Deletion is a desk decision; the archive deletes durably FIRST,
        // then every sink drops its copy on the streams-deleted confirm.
        if (from.role !== "desk") {
          this.send(ws, { v: 1, type: "error", code: "not-desk", message: "desk only" });
          return;
        }
        // Never delete under a live take: inbound chunks would recreate
        // receiver state mid-delete and resurrect half a stream.
        if (msg.streams.some((s) => s.takeId === room.activeTake?.takeId)) {
          this.send(ws, {
            v: 1,
            type: "error",
            code: "take-active",
            message: "cannot delete streams of the active take",
          });
          return;
        }
        try {
          const deletedTakeIds = await room.ingest.deleteStreams(msg.streams);
          this.fanout(room, {
            v: 1,
            type: "streams-deleted",
            streams: msg.streams,
            deletedTakeIds,
          });
        } catch (e) {
          this.send(ws, { v: 1, type: "error", code: "delete-failed", message: String(e) });
        }
        break;
      }
      case "calibration-chirp": {
        if (from.role !== "desk") {
          this.send(ws, { v: 1, type: "error", code: "not-desk", message: "desk only" });
          return;
        }
        await this.archive.recordChirp(room.sessionId, msg.chirpId, msg.emitTsDeskUs, msg.spec);
        this.fanout(room, msg);
        break;
      }
      case "peer-update": {
        // A13 authority: a recorder renames only itself; the desk (session
        // authority) renames anyone.
        if (from.role !== "desk" && msg.peerId !== from.peerId) {
          this.send(ws, {
            v: 1,
            type: "error",
            code: "not-authorized",
            message: "only the desk may rename other peers",
          });
          return;
        }
        const label = msg.label.trim() || undefined; // empty clears
        const target = room.peers.get(msg.peerId);
        const device = [...room.devices.values()].find((d) => d.peerId === msg.peerId);
        if (!target && !device) {
          this.send(ws, { v: 1, type: "error", code: "unknown-peer", message: "no such peer" });
          return;
        }
        if (target) {
          const { label: _drop, ...rest } = target.deviceInfo;
          target.deviceInfo = { ...rest, ...(label ? { label } : {}) };
        }
        if (device) device.label = label;
        await this.archive.updatePeerLabel(msg.peerId, label ?? null);
        this.fanout(room, { v: 1, type: "peer-update", peerId: msg.peerId, label: label ?? "" });
        this.fanoutPeerStatus(room);
        break;
      }
      case "bye": {
        this.leave(conn, room);
        break;
      }
      default:
        break;
    }
  }

  private async handleHello(
    conn: ConnState,
    ws: WSContext,
    room: Room,
    msg: Extract<SignalingMessage, { type: "hello" }>,
  ): Promise<void> {
    const version = negotiateVersion(msg.protocolVersions);
    if (version === null) {
      this.send(ws, {
        v: 1,
        type: "error",
        code: "version-mismatch",
        message: "no common protocol version",
        fatal: true,
      });
      ws.close();
      return;
    }
    if (msg.role !== conn.pathRole) {
      this.send(ws, {
        v: 1,
        type: "error",
        code: "role-mismatch",
        message: `role ${msg.role} on a ${conn.pathRole} endpoint`,
        fatal: true,
      });
      ws.close();
      return;
    }
    await this.archive.ensureSession(conn.sessionId);
    // Identity resume (A12): the same device rejoining with the same role
    // gets its previous peerId back — the desk keeps the lane, the mixer
    // mapping, and the name. No deviceId = anonymous fresh peer, as before.
    const deviceId = msg.deviceInfo.deviceId ?? null;
    const known = deviceId ? room.devices.get(`${msg.role}:${deviceId}`) : undefined;
    const peerId = known?.peerId ?? crypto.randomUUID();
    // Zombie replacement: the previous socket for this identity is still
    // open (the network lost it before we did) — error it out, newest wins.
    const zombie = room.peers.get(peerId);
    if (zombie) {
      this.send(zombie.ws, {
        v: 1,
        type: "error",
        code: "superseded",
        message: "device reconnected on a new connection",
        fatal: true,
      });
      try {
        zombie.ws.close();
      } catch {
        // already gone
      }
      room.peers.delete(peerId);
    }
    // A non-empty hello label wins (the device speaks for itself); a silent
    // reconnect keeps the stored nickname (possibly desk-given).
    const label = msg.deviceInfo.label?.trim() || known?.label;
    const joinedAt = known?.joinedAt ?? new Date().toISOString();
    const epoch = ++this.epochs;
    conn.peerId = peerId;
    conn.epoch = epoch;
    const deviceInfo: DeviceInfo = {
      userAgent: msg.deviceInfo.userAgent,
      ...(label ? { label } : {}),
      ...(deviceId ? { deviceId } : {}),
    };
    room.peers.set(peerId, { peerId, role: msg.role, deviceInfo, joinedAt, epoch, ws });
    if (deviceId) room.devices.set(`${msg.role}:${deviceId}`, { peerId, label, joinedAt });
    await this.archive.upsertPeer({
      peerId,
      sessionId: conn.sessionId,
      role: msg.role,
      userAgent: msg.deviceInfo.userAgent,
      label: label ?? null,
      deviceId,
      joinedAt: new Date(joinedAt),
    });
    this.send(ws, {
      v: 1,
      type: "welcome",
      peerId,
      protocolVersion: version,
      session: this.sessionState(room),
    });
    this.fanoutPeerStatus(room);
  }

  handleClose(conn: ConnState): void {
    const pending = this.rooms.get(conn.sessionId);
    if (!pending) return;
    void pending.then((room) => this.leave(conn, room));
  }

  private leave(conn: ConnState, room: Room): void {
    if (!conn.peerId) return;
    // A superseded socket (A12) must not evict its successor: only the
    // connection generation that owns the peer entry removes it.
    const peer = room.peers.get(conn.peerId);
    if (peer && peer.epoch === conn.epoch) {
      room.peers.delete(conn.peerId);
      room.ingest.closePeer(conn.peerId);
      this.fanoutPeerStatus(room);
    }
    conn.peerId = null;
  }

  private sessionState(room: Room): SessionState {
    const peers: PeerInfo[] = [...room.peers.values()].map((p) => ({
      peerId: p.peerId,
      role: p.role,
      deviceInfo: p.deviceInfo,
      joinedAt: p.joinedAt,
    }));
    return { sessionId: room.sessionId, peers, activeTake: room.activeTake };
  }

  private relay(
    room: Room,
    fromPeerId: string,
    msg: Extract<SignalingMessage, { type: "ice-offer" | "ice-answer" | "ice-candidate" }>,
  ): void {
    this.sendTo(room, msg.targetPeerId, { ...msg, fromPeerId });
  }

  private fanout(room: Room, msg: SignalingMessage): void {
    for (const peer of room.peers.values()) {
      this.send(peer.ws, msg);
    }
  }

  private fanoutPeerStatus(room: Room): void {
    this.fanout(room, { v: 1, type: "peer-status", session: this.sessionState(room) });
  }

  private sendTo(room: Room, peerId: string, msg: SignalingMessage): void {
    const peer = room.peers.get(peerId);
    if (peer) this.send(peer.ws, msg);
  }

  private send(ws: WSContext, msg: SignalingMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Peer went away mid-send; close handling reconciles.
    }
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
        } catch {
          // already gone
        }
      }
      await room.ingest.close();
    }
    this.rooms.clear();
  }
}
