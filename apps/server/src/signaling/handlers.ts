// Post-hello message dispatch: ICE relay + server-sink ingest offers, take
// lifecycle fanout, stream deletion, renames.

import { SERVER_PEER_ID, type SignalingMessage } from "@antiphon/protocol";
import type { WSContext } from "hono/ws";
import type { Archive } from "../archive/index.ts";
import type { Logger } from "../logger.ts";
import {
  type ConnState,
  fanout,
  fanoutPeerStatus,
  leave,
  type Room,
  type RoomPeer,
  send,
  sendTo,
} from "./room.ts";

export interface DispatchHost {
  readonly archive: Archive;
  readonly log: Logger;
}

function relay(
  room: Room,
  fromPeerId: string,
  msg: Extract<SignalingMessage, { type: "ice-offer" | "ice-answer" | "ice-candidate" }>,
): void {
  sendTo(room, msg.targetPeerId, { ...msg, fromPeerId });
}

function requireDesk(from: RoomPeer, ws: WSContext): boolean {
  if (from.role === "desk") return true;
  send(ws, { v: 1, type: "error", code: "not-desk", message: "desk only" });
  return false;
}

export async function dispatchMessage(
  host: DispatchHost,
  room: Room,
  conn: ConnState,
  ws: WSContext,
  from: RoomPeer,
  msg: SignalingMessage,
): Promise<void> {
  switch (msg.type) {
    case "ice-offer": {
      if (msg.targetPeerId !== SERVER_PEER_ID) {
        relay(room, from.peerId, msg);
        return;
      }
      try {
        const answer = await room.ingest.handleOffer(from.peerId, msg.sdp);
        sendTo(room, from.peerId, {
          v: 1,
          type: "ice-answer",
          targetPeerId: from.peerId,
          fromPeerId: SERVER_PEER_ID,
          sdp: answer.sdp,
        });
      } catch (e) {
        host.log.warn("ingest offer failed", {
          sessionId: room.sessionId,
          peerId: from.peerId,
          error: e,
        });
        send(ws, { v: 1, type: "error", code: "ingest-offer-failed", message: String(e) });
      }
      return;
    }
    case "ice-answer": {
      if (msg.targetPeerId !== SERVER_PEER_ID) relay(room, from.peerId, msg);
      return;
    }
    case "ice-candidate": {
      if (msg.targetPeerId !== SERVER_PEER_ID) {
        relay(room, from.peerId, msg);
        return;
      }
      if (msg.candidate) {
        room.ingest.addRemoteCandidate(
          from.peerId,
          msg.candidate.candidate,
          msg.candidate.sdpMid ?? "0",
        );
      }
      return;
    }
    case "take-start": {
      if (!requireDesk(from, ws)) return;
      room.activeTake = {
        takeId: msg.takeId,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        ...(msg.disarmedPeerIds?.length ? { disarmedPeerIds: msg.disarmedPeerIds } : {}),
      };
      room.ingest.noteTake(msg.takeId, msg.wallClockHint);
      await host.archive.touchSession(room.sessionId);
      fanout(room, msg);
      return;
    }
    case "take-stop": {
      if (!requireDesk(from, ws)) return;
      if (room.activeTake?.takeId === msg.takeId) room.activeTake = null;
      room.ingest.noteTakeStop(msg.takeId);
      await host.archive.touchSession(room.sessionId);
      fanout(room, msg);
      return;
    }
    case "stream-announce": {
      room.ingest.noteStream(msg.takeId, msg.streamId, from.peerId);
      fanout(room, { ...msg, fromPeerId: from.peerId });
      return;
    }
    case "stream-final": {
      room.ingest.setFinalSeq(msg.takeId, msg.streamId, msg.finalSeq);
      fanout(room, { ...msg, fromPeerId: from.peerId });
      return;
    }
    case "streams-delete": {
      // Deletion is a desk decision; the archive deletes durably FIRST,
      // then every sink drops its copy on the streams-deleted confirm.
      if (!requireDesk(from, ws)) return;
      // Never delete under a live take: inbound chunks would recreate
      // receiver state mid-delete and resurrect half a stream.
      if (msg.streams.some((s) => s.takeId === room.activeTake?.takeId)) {
        send(ws, {
          v: 1,
          type: "error",
          code: "take-active",
          message: "cannot delete streams of the active take",
        });
        return;
      }
      try {
        const deletedTakeIds = await room.ingest.deleteStreams(msg.streams);
        fanout(room, { v: 1, type: "streams-deleted", streams: msg.streams, deletedTakeIds });
      } catch (e) {
        host.log.error("stream deletion failed", {
          sessionId: room.sessionId,
          peerId: from.peerId,
          error: e,
        });
        send(ws, { v: 1, type: "error", code: "delete-failed", message: String(e) });
      }
      return;
    }
    case "calibration-chirp": {
      if (!requireDesk(from, ws)) return;
      await host.archive.recordChirp(room.sessionId, msg.chirpId, msg.emitTsDeskUs, msg.spec);
      fanout(room, msg);
      return;
    }
    case "peer-update": {
      // A13 authority: a recorder renames only itself; the desk renames anyone.
      if (from.role !== "desk" && msg.peerId !== from.peerId) {
        send(ws, {
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
        send(ws, { v: 1, type: "error", code: "unknown-peer", message: "no such peer" });
        return;
      }
      if (target) {
        const { label: _drop, ...rest } = target.deviceInfo;
        target.deviceInfo = { ...rest, ...(label ? { label } : {}) };
      }
      if (device) device.label = label;
      await host.archive.updatePeerLabel(msg.peerId, label ?? null);
      fanout(room, { v: 1, type: "peer-update", peerId: msg.peerId, label: label ?? "" });
      fanoutPeerStatus(room);
      return;
    }
    case "bye": {
      leave(conn, room);
      return;
    }
    default:
      return;
  }
}
