// Desk-side session orchestration: the desk is a sink AND the control
// authority. It answers recorder P2P offers, keeps a sync channel to the
// server (HAVE-diff replication, §6.8), and drives take lifecycle.

import { decode_meter_frame, init as initWasm } from "@antiphon/core-wasm";
import {
  SERVER_PEER_ID,
  type SessionState,
  type SignalingMessage,
  type TakeStartMessage,
} from "@antiphon/protocol";
import { playCalibrationChirp } from "./desk-chirp";
import { answerRecorderOffer, type Conn } from "./desk-conns";
import { createServerSync, type ServerSyncLink } from "./desk-server-sync";
import {
  type DeskSessionState,
  dropDeletedStreams,
  initialDeskSessionState,
  planStreamSeed,
  type StreamMeta,
  upsertAnnouncedStream,
  withStreamFinal,
} from "./desk-session-state";
import { createSinkWorkerLink, type SinkWorkerLink } from "./desk-sink-worker";
import { normalizeNickname } from "./device-identity";
import { SignalingClient } from "./signaling-client";

export type { DeskSessionState, StreamMeta };

const ACK_INTERVAL_MS = 2_000;
const HAVE_INTERVAL_MS = 5_000;
const STATUS_INTERVAL_MS = 1_000;
/** Non-fatal errors self-expire off the error strip. */
const ERROR_TTL_MS = 30_000;

type Listener = (state: DeskSessionState) => void;

export class DeskSession {
  private readonly signaling: SignalingClient;
  private readonly worker: SinkWorkerLink;
  private readonly serverSync: ServerSyncLink;
  private readonly listeners = new Set<Listener>();
  private readonly conns = new Map<number, Conn>();
  private nextConnId = 1;
  private state: DeskSessionState = initialDeskSessionState();
  private wasmReady = false;
  private timers: number[] = [];
  private audioContext: AudioContext | null = null;
  private readonly deletedListeners = new Set<
    (streamIds: string[], deletedTakeIds: string[]) => void
  >();
  /** The active take exactly as started, kept for re-assertion: a reconnect
   * welcome from a rebooted server carries activeTake=null while recorders
   * keep rolling — the desk (control authority, §3) re-sends this
   * take-start rather than adopt the empty snapshot. */
  private activeTakeStart: Omit<TakeStartMessage, "v" | "type"> | null = null;

  constructor(readonly sessionId: string) {
    this.signaling = new SignalingClient("desk", sessionId);
    this.worker = createSinkWorkerLink({
      onReady: (rebuiltChunks) => this.patch({ rebuiltChunks }),
      onReply: (connId, bytes) => this.sendToConn(connId, bytes),
      onPushPlan: (plan) => {
        if (plan.ranges.length === 0) return;
        this.worker.getFrames(plan.takeId, plan.streamId, plan.ranges, (frames) =>
          this.serverSync.pushFrames(frames),
        );
      },
      onStatus: (streams) => this.patch({ deskStatus: streams }),
      onError: (message) => this.pushError(message),
    });
    this.serverSync = createServerSync({
      signaling: this.signaling,
      worker: this.worker,
      conns: this.conns,
      nextConnId: () => this.nextConnId++,
      interceptMeter: (bytes) => this.interceptMeter(bytes),
      onStatus: (serverSync) => this.patch({ serverSync }),
    });
  }

  start(): void {
    void initWasm().then(() => {
      this.wasmReady = true;
    });
    this.worker.post({ type: "configure", sessionId: this.sessionId });
    this.signaling.onMessage((msg) => this.onSignal(msg));
    this.signaling.onState(() => {
      this.patch({
        signalingConnected: this.signaling.state.connected,
        peerId: this.signaling.state.peerId,
        session: this.signaling.state.session,
        fatal: this.signaling.state.fatal,
      });
      if (this.signaling.state.connected) this.serverSync.ensure();
    });
    this.signaling.connect();
    this.timers.push(
      window.setInterval(() => this.broadcastAcks(), ACK_INTERVAL_MS),
      window.setInterval(() => this.serverSync.exchangeHaves(), HAVE_INTERVAL_MS),
      window.setInterval(() => this.worker.post({ type: "status" }), STATUS_INTERVAL_MS),
    );
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  snapshot(): DeskSessionState {
    return this.state;
  }

  // ---- take lifecycle ------------------------------------------------------

  startTake(): string {
    const takeId = crypto.randomUUID();
    this.signaling.send({
      v: 1,
      type: "take-start",
      takeId,
      wallClockHint: new Date().toISOString(),
      ...(this.state.disarmedPeers.length > 0 ? { disarmedPeerIds: this.state.disarmedPeers } : {}),
    });
    return takeId;
  }

  /** Per-lane record-arm: a disarmed peer sits out subsequent takes until
   * re-armed. Purely control-plane — the rolling take is never interrupted. */
  toggleArm(peerId: string): void {
    const disarmedPeers = this.state.disarmedPeers.includes(peerId)
      ? this.state.disarmedPeers.filter((p) => p !== peerId)
      : [...this.state.disarmedPeers, peerId];
    this.patch({ disarmedPeers });
  }

  stopTake(): void {
    if (!this.state.activeTakeId) return;
    this.signaling.send({ v: 1, type: "take-stop", takeId: this.state.activeTakeId });
  }

  /** Deliberate rejoin after a fatal halt: clears the terminal state and
   * reconnects under this device identity, knowingly superseding whichever
   * tab owns it now. */
  takeOver(): void {
    this.signaling.reopen();
  }

  /** Rename any peer (the desk is the session authority). The server
   * validates, persists, and fans out; our snapshot updates on the echo.
   * Normalized at commit — input maxLength alone doesn't survive paste. */
  renamePeer(peerId: string, label: string): void {
    this.signaling.send({ v: 1, type: "peer-update", peerId, label: normalizeNickname(label) });
  }

  /** Play the calibration chirp (RFC §10) and announce it. */
  async playChirp(): Promise<void> {
    await playCalibrationChirp(() => {
      if (!this.audioContext) this.audioContext = new AudioContext();
      return this.audioContext;
    }, this.signaling);
    this.patch({ lastChirpAt: Date.now() });
  }

  /** Ask the server (the archive authority) to delete streams. Local copies
   * drop only when the `streams-deleted` confirm fans out — a failed delete
   * never leaves the desk disagreeing with the archive. */
  deleteStreams(refs: Array<{ takeId: string; streamId: string }>): void {
    if (refs.length === 0) return;
    if (!this.signaling.state.connected) {
      this.pushError("delete failed: signaling offline");
      return;
    }
    this.signaling.send({ v: 1, type: "streams-delete", streams: refs });
  }

  /** Push a transient error to the strip: capped, self-expiring. */
  private pushError(message: string): void {
    this.patch({ errors: [...this.state.errors.slice(-4), message] });
    window.setTimeout(() => {
      const index = this.state.errors.indexOf(message);
      if (index !== -1) this.dismissError(index);
    }, ERROR_TTL_MS);
  }

  dismissError(index: number): void {
    this.patch({ errors: this.state.errors.filter((_, i) => i !== index) });
  }

  /** Fires after a server-confirmed deletion with the stream ids removed
   * and the take ids the server dropped entirely — the signal for
   * take-scoped side stores (desk MIDI) to clean up too. */
  onStreamsDeleted(listener: (streamIds: string[], deletedTakeIds: string[]) => void): () => void {
    this.deletedListeners.add(listener);
    return () => this.deletedListeners.delete(listener);
  }

  /** Seed streams the archive knows but this desk never saw announced
   * (cold desk/reload); see planStreamSeed. */
  seedArchivedStreams(metas: StreamMeta[]): void {
    const plan = planStreamSeed(this.state.streams, metas);
    for (const entry of plan.setFinal) this.worker.post({ type: "set-final", ...entry });
    if (!plan.streams) return;
    this.patch({ streams: plan.streams });
    // Reconcile immediately: announce our HAVEs (now covering the seeded
    // streams) so the server can start pushing the missing chunks.
    this.serverSync.exchangeHaves();
  }

  /** Reassemble a stream's playable FLAC from the desk's own OPFS store. */
  assembleFlac(takeId: string, streamId: string): Promise<ArrayBuffer | null> {
    return this.worker.assembleFlac(takeId, streamId);
  }

  // ---- signaling ------------------------------------------------------------

  private onSignal(msg: SignalingMessage): void {
    switch (msg.type) {
      case "welcome":
        this.onWelcome(msg.session.activeTake);
        break;
      case "take-start":
        // Remembered verbatim so a post-restart re-assertion replays the
        // exact original message.
        this.activeTakeStart = {
          takeId: msg.takeId,
          wallClockHint: msg.wallClockHint,
          ...(msg.disarmedPeerIds?.length ? { disarmedPeerIds: msg.disarmedPeerIds } : {}),
        };
        // A re-asserted take-start echoes back: don't restart the clock.
        if (msg.takeId !== this.state.activeTakeId) {
          this.patch({ activeTakeId: msg.takeId, takeStartedAt: Date.now() });
        }
        break;
      case "take-stop":
        if (msg.takeId === this.activeTakeStart?.takeId) this.activeTakeStart = null;
        this.patch({ activeTakeId: null });
        // §6.4: ack immediately on take close + reconcile with the server.
        this.broadcastAcks();
        this.serverSync.exchangeHaves();
        break;
      case "stream-announce":
        this.patch({ streams: upsertAnnouncedStream(this.state.streams, msg) });
        break;
      case "stream-final":
        this.worker.post({
          type: "set-final",
          takeId: msg.takeId,
          streamId: msg.streamId,
          finalSeq: msg.finalSeq,
        });
        this.patch({ streams: withStreamFinal(this.state.streams, msg.streamId, msg.finalSeq) });
        break;
      case "streams-deleted": {
        const ids = new Set(msg.streams.map((s) => s.streamId));
        this.worker.post({ type: "delete-streams", streams: msg.streams });
        this.worker.post({ type: "status" }); // worker chain: runs after the delete
        this.patch(dropDeletedStreams(this.state, ids));
        for (const listener of this.deletedListeners) listener([...ids], msg.deletedTakeIds);
        break;
      }
      case "ice-offer":
        if (msg.fromPeerId && msg.fromPeerId !== SERVER_PEER_ID) {
          void answerRecorderOffer({
            signaling: this.signaling,
            fromPeerId: msg.fromPeerId,
            sdp: msg.sdp,
            connId: this.nextConnId++,
            conns: this.conns,
            onFrame: (connId, bytes) => {
              if (this.interceptMeter(bytes)) return;
              this.worker.post({ type: "frame", connId, bytes }, [bytes]);
            },
          });
        }
        break;
      case "error":
        // Fatal errors are terminal state (state.fatal via onState), not
        // strip noise.
        if (msg.fatal) break;
        this.pushError(`${msg.code}: ${msg.message}`);
        break;
      default:
        break;
    }
  }

  private onWelcome(active: SessionState["activeTake"]): void {
    if (active) {
      // Snapshot carries a take: adopt it. A different id than ours means
      // the room genuinely moved on — stale local state loses.
      if (active.takeId !== this.state.activeTakeId) {
        this.activeTakeStart = {
          takeId: active.takeId,
          wallClockHint: active.startedAt,
          ...(active.disarmedPeerIds?.length ? { disarmedPeerIds: active.disarmedPeerIds } : {}),
        };
        this.patch({ activeTakeId: active.takeId, takeStartedAt: Date.parse(active.startedAt) });
      }
    } else if (this.activeTakeStart) {
      // Empty snapshot while OUR take is rolling: the server rebooted
      // mid-take and recorders kept capturing (§7.1). Re-assert the take to
      // the reborn room — idempotent for recorders already rolling it.
      this.signaling.send({ v: 1, type: "take-start", ...this.activeTakeStart });
    } else {
      this.patch({ activeTakeId: null });
    }
    this.serverSync.ensure();
  }

  /** METER frames (experimental 0x80) are UI telemetry, handled here. */
  private interceptMeter(bytes: ArrayBuffer): boolean {
    if (bytes.byteLength !== 40) return false;
    const head = new Uint8Array(bytes, 0, 4);
    if (head[3] !== 0x80) return false;
    if (!this.wasmReady) return true; // it IS a meter frame; just not ready
    const json = decode_meter_frame(new Uint8Array(bytes));
    if (json) {
      const { streamId, peak } = JSON.parse(json) as { streamId: string; peak: number };
      this.patch({
        liveLevels: { ...this.state.liveLevels, [streamId]: { peak, at: Date.now() } },
      });
    }
    return true;
  }

  // ---- reconciliation loops ----------------------------------------------

  private broadcastAcks(): void {
    this.worker.request("acks", (frames) => {
      for (const conn of this.conns.values()) {
        if (conn.channel.readyState !== "open") continue;
        for (const frame of frames) {
          try {
            conn.channel.send(frame);
          } catch {
            break; // channel died mid-burst; the close handler reconnects
          }
        }
      }
    });
  }

  private sendToConn(connId: number, bytes: ArrayBuffer): void {
    const conn = this.conns.get(connId);
    if (conn?.channel.readyState !== "open") return;
    try {
      conn.channel.send(bytes);
    } catch {
      // dead channel
    }
  }

  private patch(patch: Partial<DeskSessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  close(): void {
    for (const t of this.timers) window.clearInterval(t);
    for (const conn of this.conns.values()) conn.dispose();
    this.conns.clear();
    this.signaling.close();
    this.worker.terminate();
  }
}
