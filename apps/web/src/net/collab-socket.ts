// Low-level socket for the collab wire (mirror of apps/server/src/collab):
// binary frames of 1-byte tag + payload. On open both sides send their
// sync step-1 and answer the other's with a diff update.

export const MSG_SYNC_STEP1 = 0; // payload = Y.encodeStateVector — "what do you have?"
export const MSG_UPDATE = 1; // payload = Y update — step-2 reply / live edit
export const MSG_AWARENESS = 2; // payload = awareness update — presence

/** Upgrade answered within this or the attempt is aborted (see below). */
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface CollabSocketHandlers {
  onOpen(): void;
  onFrame(tag: number, payload: Uint8Array): void;
  /** Fired once per socket, with the socket that closed. */
  onClose(ws: WebSocket): void;
}

/** Open a collab socket with tag/payload framing and a handshake deadline:
 * a proxy that never answers leaves the socket in CONNECTING forever, and
 * the browser serializes WS handshakes per host (RFC 6455 §4.1) — one hung
 * handshake would dam every later WebSocket to this origin. */
export function openCollabSocket(url: string, handlers: CollabSocketHandlers): WebSocket {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const deadline = window.setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) ws.close();
  }, HANDSHAKE_TIMEOUT_MS);
  ws.addEventListener("open", () => {
    window.clearTimeout(deadline);
    handlers.onOpen();
  });
  ws.addEventListener("message", (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(ev.data);
    if (bytes.length < 1) return;
    handlers.onFrame(bytes[0] as number, bytes.subarray(1));
  });
  ws.addEventListener("close", () => {
    window.clearTimeout(deadline);
    handlers.onClose(ws);
  });
  ws.addEventListener("error", () => ws.close());
  return ws;
}

/** Frame + send; a socket that died mid-send is left to its close handler. */
export function sendFrame(ws: WebSocket | null, tag: number, payload: Uint8Array): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const framed = new Uint8Array(1 + payload.length);
  framed[0] = tag;
  framed.set(payload, 1);
  try {
    ws.send(framed);
  } catch {
    // socket died mid-send; the close handler reconnects
  }
}
