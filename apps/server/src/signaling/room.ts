// Signaling room state and wire helpers shared by the signaling modules.

import {
  type DeviceInfo,
  type PeerInfo,
  type PeerRole,
  SERVER_PEER_ID,
  type SessionState,
  type SignalingMessage,
  type TakeInfo,
} from "@antiphon/protocol";
import type { WSContext } from "hono/ws";
import type { Archive } from "../archive/index.ts";
import { SessionIngest } from "../ingest/index.ts";
import { createLogger } from "../logger.ts";
import type { TokenBucket } from "../ratelimit.ts";

const log = createLogger({ module: "signaling" });

export interface RoomPeer {
  peerId: string;
  role: PeerRole;
  deviceInfo: DeviceInfo;
  joinedAt: string;
  /** Connection generation: leave() from a superseded socket must not
   * evict the peer that adopted a newer one (A12). */
  epoch: number;
  ws: WSContext;
}

/** Resumable identity (A12): what survives a peer's disconnect. */
export interface DeviceRecord {
  peerId: string;
  label: string | undefined;
  avatarUrl: string | undefined;
  joinedAt: string;
}

export interface Room {
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
  /** Message flood guard (RFC §12), created lazily on first message. */
  msgBucket?: TokenBucket;
}

/** Abuse/capacity limits enforced on the control plane (RFC §12). */
export interface SignalingLimits {
  msgRatePerSec: number;
  msgBurst: number;
  maxPeersPerSession: number;
  maxActiveSessions: number;
}

/** Judges a desk hello BEFORE any session state attaches — the browser
 * cannot set WS headers, so the desk carries its auth token in the hello
 * (A15). Recorder hellos never pass through: mic join is a public bearer
 * capability (RFC §12) in both auth modes. null = keyless mode. */
export type DeskHelloAuth = (
  sessionId: string,
  authToken: string | undefined,
) => Promise<{ ok: true } | { ok: false; message: string }>;

export const DEFAULT_LIMITS: SignalingLimits = {
  msgRatePerSec: 100,
  msgBurst: 200,
  maxPeersPerSession: 32,
  maxActiveSessions: 200,
};

/** Build a room: ingest wired to the control plane (local candidates and
 * fatal errors travel over signaling), engine rebuilt from the archive, and
 * the device→peer index restored so identity resume (A12) survives a
 * server restart. */
export async function createRoom(sessionId: string, archive: Archive): Promise<Room> {
  const room: Room = {
    sessionId,
    peers: new Map(),
    devices: new Map(),
    activeTake: null,
    ingest: new SessionIngest(sessionId, archive, {
      onLocalCandidate: (peerId, candidate, mid) => {
        sendTo(room, peerId, {
          v: 1,
          type: "ice-candidate",
          targetPeerId: peerId,
          fromPeerId: SERVER_PEER_ID,
          candidate: { candidate, sdpMid: mid },
        });
      },
      onFatal: (peerId, code, message) => {
        const msg: SignalingMessage = { v: 1, type: "error", code, message, fatal: true };
        sendTo(room, peerId, msg);
        for (const peer of room.peers.values()) {
          if (peer.role === "desk") sendTo(room, peer.peerId, msg);
        }
      },
    }),
  };
  await room.ingest.init();
  for (const row of await archive.loadPeers(sessionId)) {
    if (!row.deviceId) continue;
    room.devices.set(`${row.role}:${row.deviceId}`, {
      peerId: row.id,
      label: row.label ?? undefined,
      avatarUrl: row.avatarUrl ?? undefined,
      joinedAt: row.joinedAt.toISOString(),
    });
  }
  return room;
}

export function sessionState(room: Room): SessionState {
  const peers: PeerInfo[] = [...room.peers.values()].map((p) => ({
    peerId: p.peerId,
    role: p.role,
    deviceInfo: p.deviceInfo,
    joinedAt: p.joinedAt,
  }));
  return { sessionId: room.sessionId, peers, activeTake: room.activeTake };
}

export function send(ws: WSContext, msg: SignalingMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch (error) {
    // Peer went away mid-send; close handling reconciles.
    log.debug("ws send failed; peer gone", { msgType: msg.type, error });
  }
}

export function sendTo(room: Room, peerId: string, msg: SignalingMessage): void {
  const peer = room.peers.get(peerId);
  if (peer) send(peer.ws, msg);
}

export function fanout(room: Room, msg: SignalingMessage): void {
  for (const peer of room.peers.values()) {
    send(peer.ws, msg);
  }
}

export function fanoutPeerStatus(room: Room): void {
  fanout(room, { v: 1, type: "peer-status", session: sessionState(room) });
}

export function leave(conn: ConnState, room: Room): void {
  if (!conn.peerId) return;
  // A superseded socket (A12) must not evict its successor: only the
  // connection generation that owns the peer entry removes it.
  const peer = room.peers.get(conn.peerId);
  if (peer && peer.epoch === conn.epoch) {
    room.peers.delete(conn.peerId);
    room.ingest.closePeer(conn.peerId);
    fanoutPeerStatus(room);
  }
  conn.peerId = null;
}
