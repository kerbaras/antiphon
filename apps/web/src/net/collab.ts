// Collab provider: owns the session's Y.Doc + awareness and keeps them
// synced over the /session/:uuid/collab WSS route. Local-first: offline,
// every read/write hits the in-memory doc; a reconnect re-runs the full
// sync handshake, so nothing buffered is ever lost to a dropout.

import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { authToken } from "./auth-token";
import { createArrangementUndo } from "./collab-doc";
import {
  type CollabPeer,
  type CollabSnapshot,
  type CollabStatus,
  defaultPresence,
  type PresenceState,
  readPeers,
} from "./collab-presence";
import {
  MSG_AWARENESS,
  MSG_SYNC_STEP1,
  MSG_UPDATE,
  openCollabSocket,
  sendFrame,
} from "./collab-socket";

export type { CollabPeer, CollabSnapshot, CollabStatus, PresenceState };

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 8_000;
/** Outgoing doc updates coalesce into ≤ ~30 frames/s so a fader/clip drag
 * can never trip the server's per-connection flood guard. */
const UPDATE_FLUSH_MS = 33;
/** Outgoing presence coalesces into ≤ ~5 frames/s. */
const AWARENESS_FLUSH_MS = 200;
/** An `editing` presence mark decays this long after the last touch. */
const EDITING_DECAY_MS = 2_500;

export class CollabClient {
  readonly sessionId: string;
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  /** Transaction origin for every local write — the loop guard: updates
   * applied FROM the wire use REMOTE and are never relayed back. */
  readonly origin: object = {};
  /** Origin for SYSTEM writes (server-confirmed deletion cleanup): synced
   * to the wire like `origin`, but excluded from the undo ledger — Ctrl+Z
   * must never resurrect doc keys for durably deleted streams. */
  readonly systemOrigin: object = {};
  /** Arrangement undo ledger: this desk's own regions/arrange edits,
   * undoable in gesture-sized steps. */
  private readonly undoManager: Y.UndoManager;
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
    this.undoManager = createArrangementUndo(this.doc, this.origin);
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
    // The Yjs wire has no message-level handshake to carry a token, so it
    // rides an `auth_token` query param and the server judges the UPGRADE.
    // Keyless resolves null → bare URL; a rejected upgrade lands in the
    // ordinary close/backoff path.
    void authToken().then((token) => {
      if (this.closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const query = token ? `?auth_token=${encodeURIComponent(token)}` : "";
      this.open(`${proto}://${location.host}/session/${this.sessionId}/collab${query}`);
    });
  }

  private open(url: string): void {
    this.ws = openCollabSocket(url, {
      onOpen: () => {
        this.attempts = 0;
        this.setStatus("connected");
        // Full sync handshake: anything queued while offline is covered by
        // the step-1/step-2 exchange, so the pending buffer can drop.
        this.pendingUpdates = [];
        this.send(MSG_SYNC_STEP1, Y.encodeStateVector(this.doc));
        if (this.awareness.getLocalState() !== null) {
          this.send(MSG_AWARENESS, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
        }
      },
      onFrame: (tag, payload) => this.onFrame(tag, payload),
      onClose: (ws) => {
        if (this.ws !== ws) return; // an old socket superseded by reconnect
        this.ws = null;
        this.setStatus("offline");
        if (!this.closed) {
          const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempts++);
          window.setTimeout(() => this.connect(), delay);
        }
      },
    });
  }

  private onFrame(tag: number, payload: Uint8Array): void {
    switch (tag) {
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
  }

  // ---- arrangement undo ---------------------------------------------------

  /** Undo the last local arrangement edit (split/drag/trim/delete/align
   * reset). Returns whether anything was reverted. */
  undoArrangement(): boolean {
    return this.undoManager.undo() !== null;
  }

  /** Re-apply the last undone edit. */
  redoArrangement(): boolean {
    return this.undoManager.redo() !== null;
  }

  /** Seal the current undo step: called at the START of every gesture so a
   * new edit never merges into the previous one (UNDO_CAPTURE_MS covers
   * the writes WITHIN a gesture). */
  sealUndo(): void {
    this.undoManager.stopCapturing();
  }

  // ---- presence -------------------------------------------------------------

  /** Merge fields into this desk's presence (missing fields default). */
  setPresence(fields: Partial<PresenceState>): void {
    const current = (this.awareness.getLocalState() as PresenceState | null) ?? defaultPresence();
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
      this.snapshotCache = {
        status: this.status,
        synced: this.synced,
        peers: readPeers(this.awareness, this.doc.clientID),
      };
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
    sendFrame(this.ws, tag, payload);
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
