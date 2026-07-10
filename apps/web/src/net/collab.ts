// W3-A collab provider: owns the session's Y.Doc + awareness and keeps them
// synced over the /session/:uuid/collab WSS route (same origin as the
// signaling socket; vite proxies in dev/preview). Doc SHAPE and mutation
// rules live in collab-doc.ts; desk bindings (player/markers/comments/
// arrange/presence) live in routes/desk/use-collab.ts.
//
// Wire protocol — mirror of apps/server/src/collab (1-byte tag + payload):
//   0x00 sync-step-1  payload = Y.encodeStateVector   "what do you have?"
//   0x01 update       payload = Y update              step-2 reply / live edit
//   0x02 awareness    payload = awareness update      presence
// On open both sides send their step-1 and answer the other's with a diff
// update. Outgoing doc updates are coalesced (~30 Hz, Y.mergeUpdates) and
// awareness sends are throttled (~5 Hz) so a fader/clip drag can never trip
// the server's per-connection flood guard.
//
// OFFLINE FALLBACK: the doc is local-first — with no server reachable every
// read/write works against the in-memory doc, the desk behaves exactly as a
// single-operator desk, and localStorage shadow writes (see use-desk.ts
// hooks) keep persistence at single-desk parity. Reconnects re-run the full
// step-1/step-2 exchange, so nothing buffered is ever lost to a dropout.
//
// AUTHORITY BOUNDARY (W3-A, documented): this doc carries mix state,
// markers, comments and clip arrangement ONLY. Transport control
// (record/stop/chirp/delete/disarm) stays on the signaling protocol — any
// desk may issue them, last write wins exactly as with a single desk, and
// A14 re-assert semantics are unchanged. Multi-desk take authority needs a
// server-side room epoch: the documented v2 follow-up, out of scope here.

import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { authToken } from "./auth-token";

const MSG_SYNC_STEP1 = 0;
const MSG_UPDATE = 1;
const MSG_AWARENESS = 2;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 8_000;
/** Outgoing doc updates coalesce into ≤ ~30 frames/s. */
const UPDATE_FLUSH_MS = 33;
/** Outgoing presence coalesces into ≤ ~5 frames/s. */
const AWARENESS_FLUSH_MS = 200;
/** An `editing` presence mark decays this long after the last touch. */
const EDITING_DECAY_MS = 2_500;

export type CollabStatus = "connecting" | "connected" | "offline";

/** What each desk publishes about itself (awareness; never in the doc). */
export interface PresenceState {
  /** Operator label (the comment-author preference; "Desk" by default). */
  name: string;
  /** Track-palette hex, derived from the clientID. */
  color: string;
  /** Ghost-cursor position on the shared arrangement timeline. */
  playheadSec: number | null;
  activeTakeId: string | null;
  /** What the desk is touching: "mix:<channelKey>" | "markers" | "comments". */
  editing: string | null;
}

export interface CollabPeer extends PresenceState {
  clientId: number;
}

export interface CollabSnapshot {
  status: CollabStatus;
  synced: boolean;
  /** OTHER desks in the room (never includes this client). */
  peers: CollabPeer[];
}

export class CollabClient {
  readonly sessionId: string;
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  /** Transaction origin for every local write — the loop guard: updates
   * applied FROM the wire use REMOTE and are never relayed back. */
  readonly origin: object = {};
  private static readonly REMOTE = "collab-remote";

  private ws: WebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private status: CollabStatus = "connecting";
  private synced = false;
  private snapshotCache: CollabSnapshot | null = null;
  private readonly listeners = new Set<(snap: CollabSnapshot) => void>();
  private readonly syncedWaiters = new Set<() => void>();

  private pendingUpdates: Uint8Array[] = [];
  private updateFlushTimer: number | null = null;
  private awarenessFlushTimer: number | null = null;
  private awarenessDirty = false;
  private editingDecayTimer: number | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalState(null); // published once the desk names itself
    // Every local (non-wire) doc change goes out, coalesced.
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === CollabClient.REMOTE) return;
      this.pendingUpdates.push(update);
      if (this.updateFlushTimer === null) {
        this.updateFlushTimer = window.setTimeout(() => this.flushUpdates(), UPDATE_FLUSH_MS);
      }
    });
    // Local presence changes go out, throttled; any awareness change
    // (local or remote) invalidates the snapshot for subscribers.
    this.awareness.on("update", (_delta: unknown, origin: unknown) => {
      if (origin === "local") {
        this.awarenessDirty = true;
        if (this.awarenessFlushTimer === null) {
          this.awarenessFlushTimer = window.setTimeout(
            () => this.flushAwareness(),
            AWARENESS_FLUSH_MS,
          );
        }
      }
      this.invalidate();
    });
  }

  connect(): void {
    if (this.closed) return;
    // W8-A: collab is desk surface. The Yjs wire has no message-level
    // handshake to carry a token, so it rides an `auth_token` query param
    // and the server judges the UPGRADE. Keyless resolves null → today's
    // bare URL byte-for-byte. A rejected upgrade lands in the ordinary
    // close/backoff path: the desk shows "offline" while the signaling
    // socket's fatal `unauthorized` carries the honest message.
    void authToken().then((token) => {
      if (this.closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const query = token ? `?auth_token=${encodeURIComponent(token)}` : "";
      this.open(`${proto}://${location.host}/session/${this.sessionId}/collab${query}`);
    });
  }

  private open(url: string): void {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.attempts = 0;
      this.setStatus("connected");
      // Full sync handshake: anything queued while offline is covered by
      // the step-1/step-2 exchange, so the pending buffer can drop.
      this.pendingUpdates = [];
      this.send(MSG_SYNC_STEP1, Y.encodeStateVector(this.doc));
      if (this.awareness.getLocalState() !== null) {
        this.send(MSG_AWARENESS, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
      }
    });
    ws.addEventListener("message", (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(ev.data);
      if (bytes.length < 1) return;
      const payload = bytes.subarray(1);
      switch (bytes[0]) {
        case MSG_SYNC_STEP1:
          this.send(MSG_UPDATE, Y.encodeStateAsUpdate(this.doc, payload));
          break;
        case MSG_UPDATE:
          Y.applyUpdate(this.doc, payload, CollabClient.REMOTE);
          if (!this.synced) {
            this.synced = true;
            this.invalidate();
            for (const waiter of this.syncedWaiters) waiter();
            this.syncedWaiters.clear();
          }
          break;
        case MSG_AWARENESS:
          applyAwarenessUpdate(this.awareness, payload, CollabClient.REMOTE);
          break;
        default:
          break; // unknown tag from a future version: ignore
      }
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return; // an old socket superseded by reconnect
      this.ws = null;
      this.setStatus("offline");
      if (!this.closed) {
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempts++);
        window.setTimeout(() => this.connect(), delay);
      }
    });
    ws.addEventListener("error", () => ws.close());
  }

  // ---- presence -------------------------------------------------------------

  /** Merge fields into this desk's presence (missing fields default). */
  setPresence(fields: Partial<PresenceState>): void {
    const current = (this.awareness.getLocalState() as PresenceState | null) ?? {
      name: "Desk",
      color: "#c8c9cb",
      playheadSec: null,
      activeTakeId: null,
      editing: null,
    };
    const next = { ...current, ...fields };
    if (JSON.stringify(current) === JSON.stringify(next) && this.awareness.getLocalState()) {
      return;
    }
    this.awareness.setLocalState(next);
  }

  /** Mark what this desk is touching; decays after a quiet moment. */
  markEditing(what: string): void {
    this.setPresence({ editing: what });
    if (this.editingDecayTimer !== null) window.clearTimeout(this.editingDecayTimer);
    this.editingDecayTimer = window.setTimeout(() => {
      this.editingDecayTimer = null;
      this.setPresence({ editing: null });
    }, EDITING_DECAY_MS);
  }

  // ---- subscriptions -----------------------------------------------------------

  subscribe(listener: (snap: CollabSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): CollabSnapshot {
    if (!this.snapshotCache) {
      const peers: CollabPeer[] = [];
      for (const [clientId, state] of this.awareness.getStates()) {
        if (clientId === this.doc.clientID || !state) continue;
        const p = state as Partial<PresenceState>;
        peers.push({
          clientId,
          name: typeof p.name === "string" && p.name ? p.name : "Desk",
          color: typeof p.color === "string" ? p.color : "#c8c9cb",
          playheadSec: typeof p.playheadSec === "number" ? p.playheadSec : null,
          activeTakeId: typeof p.activeTakeId === "string" ? p.activeTakeId : null,
          editing: typeof p.editing === "string" ? p.editing : null,
        });
      }
      peers.sort((a, b) => a.clientId - b.clientId);
      this.snapshotCache = { status: this.status, synced: this.synced, peers };
    }
    return this.snapshotCache;
  }

  /** Run once the first sync completes (immediately when already synced;
   * never when the server stays unreachable — the offline path). */
  onSynced(cb: () => void): () => void {
    if (this.synced) {
      cb();
      return () => undefined;
    }
    this.syncedWaiters.add(cb);
    return () => this.syncedWaiters.delete(cb);
  }

  get isSynced(): boolean {
    return this.synced;
  }

  close(): void {
    this.closed = true;
    if (this.updateFlushTimer !== null) window.clearTimeout(this.updateFlushTimer);
    if (this.awarenessFlushTimer !== null) window.clearTimeout(this.awarenessFlushTimer);
    if (this.editingDecayTimer !== null) window.clearTimeout(this.editingDecayTimer);
    try {
      this.ws?.close();
    } catch {
      // already gone
    }
    this.awareness.destroy();
    this.doc.destroy();
  }

  // ---- internals -------------------------------------------------------------

  private flushUpdates(): void {
    this.updateFlushTimer = null;
    if (this.pendingUpdates.length === 0) return;
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Offline: drop — the reconnect handshake re-syncs everything.
      this.pendingUpdates = [];
      return;
    }
    const merged =
      this.pendingUpdates.length === 1
        ? (this.pendingUpdates[0] as Uint8Array)
        : Y.mergeUpdates(this.pendingUpdates);
    this.pendingUpdates = [];
    this.send(MSG_UPDATE, merged);
  }

  private flushAwareness(): void {
    this.awarenessFlushTimer = null;
    if (!this.awarenessDirty) return;
    this.awarenessDirty = false;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send(MSG_AWARENESS, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
  }

  private send(tag: number, payload: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const framed = new Uint8Array(1 + payload.length);
    framed[0] = tag;
    framed.set(payload, 1);
    try {
      this.ws.send(framed);
    } catch {
      // socket died mid-send; the close handler reconnects
    }
  }

  private setStatus(status: CollabStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.invalidate();
  }

  private invalidate(): void {
    this.snapshotCache = null;
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }
}

// ---- page singleton (one session's collab per page, like DeskSession) --------

let client: CollabClient | null = null;

export function getCollab(sessionId: string): CollabClient {
  if (!client || client.sessionId !== sessionId) {
    client?.close();
    client = new CollabClient(sessionId);
    client.connect();
  }
  return client;
}
