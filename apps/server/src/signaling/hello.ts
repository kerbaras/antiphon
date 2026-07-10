// hello → welcome handshake: version negotiation, capacity caps, identity
// resume (A12), zombie-socket replacement.

import { type DeviceInfo, negotiateVersion, type SignalingMessage } from "@antiphon/protocol";
import type { WSContext } from "hono/ws";
import type { Archive } from "../archive/index.ts";
import type { Logger } from "../logger.ts";
import {
  type ConnState,
  fanoutPeerStatus,
  type Room,
  type SignalingLimits,
  send,
  sessionState,
} from "./room.ts";

export interface HelloHost {
  readonly archive: Archive;
  readonly limits: SignalingLimits;
  readonly log: Logger;
  nextEpoch(): number;
  activeSessionCount(): number;
}

export async function handleHello(
  host: HelloHost,
  conn: ConnState,
  ws: WSContext,
  room: Room,
  msg: Extract<SignalingMessage, { type: "hello" }>,
): Promise<void> {
  const version = negotiateVersion(msg.protocolVersions);
  if (version === null) {
    send(ws, {
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
    send(ws, {
      v: 1,
      type: "error",
      code: "role-mismatch",
      message: `role ${msg.role} on a ${conn.pathRole} endpoint`,
      fatal: true,
    });
    ws.close();
    return;
  }
  // Caps (RFC §12), checked before any identity/room state changes. A
  // deviceId resume superseding its own zombie socket does not raise
  // occupancy, so it is exempt from the peer cap.
  const resumedPeerId = msg.deviceInfo.deviceId
    ? room.devices.get(`${msg.role}:${msg.deviceInfo.deviceId}`)?.peerId
    : undefined;
  const supersedesZombie = resumedPeerId !== undefined && room.peers.has(resumedPeerId);
  const occupancy = room.peers.size - (supersedesZombie ? 1 : 0);
  if (occupancy >= host.limits.maxPeersPerSession) {
    host.log.warn("session peer cap reached; rejecting join", {
      sessionId: room.sessionId,
      cap: host.limits.maxPeersPerSession,
    });
    send(ws, {
      v: 1,
      type: "error",
      code: "session-full",
      message: `session peer cap (${host.limits.maxPeersPerSession}) reached`,
      fatal: true,
    });
    ws.close();
    return;
  }
  if (room.peers.size === 0 && host.activeSessionCount() >= host.limits.maxActiveSessions) {
    host.log.warn("active session cap reached; rejecting join", {
      sessionId: room.sessionId,
      cap: host.limits.maxActiveSessions,
    });
    send(ws, {
      v: 1,
      type: "error",
      code: "server-full",
      message: `active session cap (${host.limits.maxActiveSessions}) reached`,
      fatal: true,
    });
    ws.close();
    return;
  }
  await host.archive.ensureSession(conn.sessionId);
  // Identity resume (A12): the same device rejoining with the same role
  // gets its previous peerId back — lane, mixer mapping, and name survive.
  // No deviceId = anonymous fresh peer.
  const deviceId = msg.deviceInfo.deviceId ?? null;
  const known = deviceId ? room.devices.get(`${msg.role}:${deviceId}`) : undefined;
  const peerId = known?.peerId ?? crypto.randomUUID();
  // Zombie replacement: the previous socket for this identity is still open
  // (the network lost it before we did) — error it out, newest wins.
  const zombie = room.peers.get(peerId);
  if (zombie) {
    send(zombie.ws, {
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
  // reconnect keeps the stored nickname (possibly desk-given). The avatar
  // (A16) follows the same rule.
  const label = msg.deviceInfo.label?.trim() || known?.label;
  const avatarUrl = msg.deviceInfo.avatarUrl?.trim() || known?.avatarUrl;
  const joinedAt = known?.joinedAt ?? new Date().toISOString();
  const epoch = host.nextEpoch();
  conn.peerId = peerId;
  conn.epoch = epoch;
  const deviceInfo: DeviceInfo = {
    userAgent: msg.deviceInfo.userAgent,
    ...(label ? { label } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
  room.peers.set(peerId, { peerId, role: msg.role, deviceInfo, joinedAt, epoch, ws });
  if (deviceId) {
    room.devices.set(`${msg.role}:${deviceId}`, { peerId, label, avatarUrl, joinedAt });
  }
  await host.archive.upsertPeer({
    peerId,
    sessionId: conn.sessionId,
    role: msg.role,
    userAgent: msg.deviceInfo.userAgent,
    label: label ?? null,
    deviceId,
    avatarUrl: avatarUrl ?? null,
    joinedAt: new Date(joinedAt),
  });
  await host.archive.touchSession(room.sessionId);
  host.log.info("peer joined", { sessionId: room.sessionId, peerId, role: msg.role });
  send(ws, {
    v: 1,
    type: "welcome",
    peerId,
    protocolVersion: version,
    session: sessionState(room),
  });
  fanoutPeerStatus(room);
}
