// WS handlers for one desk connection to /session/:uuid/collab.

import type { WSContext } from "hono/ws";
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import type { Logger } from "../logger.ts";
import type { TokenBucket } from "../ratelimit.ts";
import {
  type CollabConn,
  type CollabRoom,
  frame,
  MSG_AWARENESS,
  MSG_SYNC_STEP1,
  MSG_UPDATE,
  send,
} from "./room.ts";

export interface ConnectionHost {
  readonly log: Logger;
  newMsgBucket(): TokenBucket;
  attachRoom(sessionId: string, conn: CollabConn): Promise<CollabRoom>;
  getRoom(sessionId: string): Promise<CollabRoom>;
  /** The cached room promise, if any — onClose must never CREATE a room. */
  pendingRoom(sessionId: string): Promise<CollabRoom> | undefined;
  releaseRoom(room: CollabRoom): Promise<void>;
}

export function handleConnection(
  host: ConnectionHost,
  sessionId: string,
): {
  onOpen: (ws: WSContext) => void;
  onMessage: (data: unknown, ws: WSContext) => void;
  onClose: () => void;
} {
  const conn: CollabConn = {
    // Filled on open; messages before open cannot happen (ws semantics).
    ws: null as unknown as WSContext,
    controlledIds: new Set(),
    msgBucket: host.newMsgBucket(),
  };
  return {
    onOpen: (ws) => {
      conn.ws = ws;
      void host
        .attachRoom(sessionId, conn)
        .then((room) => {
          // Server speaks first: its step-1 (so the desk sends what the
          // room lacks) plus the room's current presence roster.
          send(conn, frame(MSG_SYNC_STEP1, Y.encodeStateVector(room.doc)));
          const clients = [...room.awareness.getStates().keys()];
          if (clients.length > 0) {
            send(conn, frame(MSG_AWARENESS, encodeAwarenessUpdate(room.awareness, clients)));
          }
        })
        .catch((error: unknown) => {
          host.log.error("collab room open failed", { sessionId, error });
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
        host.log.warn("collab message flood; disconnecting", { sessionId });
        ws.close();
        return;
      }
      const bytes = new Uint8Array(data);
      if (bytes.length < 1) return;
      void host
        .getRoom(sessionId)
        .then((room) => dispatch(room, conn, bytes))
        .catch((error: unknown) => {
          host.log.warn("collab message failed", { sessionId, error });
        });
    },
    onClose: () => {
      // After shutdown/session-delete the rooms map is empty and this must
      // be a no-op (the pool is gone).
      const pending = host.pendingRoom(sessionId);
      if (!pending) return;
      void pending
        .then((room) => {
          room.conns.delete(conn);
          if (conn.controlledIds.size > 0) {
            removeAwarenessStates(room.awareness, [...conn.controlledIds], "closed");
          }
          if (room.conns.size === 0) return host.releaseRoom(room);
          return undefined;
        })
        .catch((error: unknown) => {
          host.log.debug("collab close handling failed", { sessionId, error });
        });
    },
  };
}

function dispatch(room: CollabRoom, conn: CollabConn, bytes: Uint8Array): void {
  const payload = bytes.subarray(1);
  switch (bytes[0]) {
    case MSG_SYNC_STEP1:
      // The desk asks for what it lacks: answer with the diff update.
      send(conn, frame(MSG_UPDATE, Y.encodeStateAsUpdate(room.doc, payload)));
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
