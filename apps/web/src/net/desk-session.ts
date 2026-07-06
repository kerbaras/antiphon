// Desk-side session orchestration: the desk is a sink AND the control
// authority. It answers recorder P2P offers (LAN path), keeps a sync
// channel to the server (HAVE-diff replication, §6.8), persists every chunk
// to OPFS via the sink worker, and drives take lifecycle + calibration.

import { generate_chirp, init as initWasm } from "@antiphon/core-wasm";
import {
  DEFAULT_CHIRP_SPEC,
  SERVER_PEER_ID,
  type SessionState,
  type SignalingMessage,
} from "@antiphon/protocol";
import type { DeskStreamStatus, FromSinkWorker, ToSinkWorker } from "../audio/sink-worker-protocol";
import { offerChannel, RTC_CONFIG, wireIce } from "./rtc";
import { SignalingClient } from "./signaling-client";

const ACK_INTERVAL_MS = 2_000;
const HAVE_INTERVAL_MS = 5_000;
const STATUS_INTERVAL_MS = 1_000;
const RECONNECT_DELAY_MS = 2_000;
const HIGH_WATERMARK = 1 << 20;

export interface StreamMeta {
  takeId: string;
  streamId: string;
  peerId: string | null;
  finalSeq: number | null;
}

export interface DeskSessionState {
  signalingConnected: boolean;
  peerId: string | null;
  session: SessionState | null;
  serverSync: "connected" | "connecting" | "down";
  activeTakeId: string | null;
  takeStartedAt: number | null;
  streams: StreamMeta[];
  deskStatus: DeskStreamStatus[];
  rebuiltChunks: number;
  lastChirpAt: number | null;
  errors: string[];
}

type Listener = (state: DeskSessionState) => void;

interface Conn {
  id: number;
  channel: RTCDataChannel;
  dispose(): void;
}

export class DeskSession {
  private readonly signaling: SignalingClient;
  private readonly worker: Worker;
  private readonly listeners = new Set<Listener>();
  private readonly conns = new Map<number, Conn>();
  private nextConnId = 1;
  private serverConn: Conn | null = null;
  private serverConnecting = false;
  private state: DeskSessionState = {
    signalingConnected: false,
    peerId: null,
    session: null,
    serverSync: "down",
    activeTakeId: null,
    takeStartedAt: null,
    streams: [],
    deskStatus: [],
    rebuiltChunks: 0,
    lastChirpAt: null,
    errors: [],
  };
  private timers: number[] = [];
  private waiters: {
    acks: Array<(f: ArrayBuffer[]) => void>;
    haves: Array<(f: ArrayBuffer[]) => void>;
    frames: Array<(f: ArrayBuffer[]) => void>;
  } = { acks: [], haves: [], frames: [] };
  private audioContext: AudioContext | null = null;

  constructor(readonly sessionId: string) {
    this.signaling = new SignalingClient("desk", sessionId);
    this.worker = new Worker(new URL("../audio/sink.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (e: MessageEvent<FromSinkWorker>) => this.onWorker(e.data);
  }

  start(): void {
    this.post({ type: "configure", sessionId: this.sessionId });
    this.signaling.onMessage((msg) => this.onSignal(msg));
    this.signaling.onState(() => {
      this.patch({
        signalingConnected: this.signaling.state.connected,
        peerId: this.signaling.state.peerId,
        session: this.signaling.state.session,
      });
      if (this.signaling.state.connected) this.ensureServerSync();
    });
    this.signaling.connect();
    this.timers.push(
      window.setInterval(() => this.broadcastAcks(), ACK_INTERVAL_MS),
      window.setInterval(() => this.exchangeHaves(), HAVE_INTERVAL_MS),
      window.setInterval(() => this.post({ type: "status" }), STATUS_INTERVAL_MS),
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
    });
    return takeId;
  }

  stopTake(): void {
    if (!this.state.activeTakeId) return;
    this.signaling.send({ v: 1, type: "take-stop", takeId: this.state.activeTakeId });
  }

  /** Play the calibration chirp (RFC §10) and announce it. */
  async playChirp(): Promise<void> {
    await initWasm();
    const spec = DEFAULT_CHIRP_SPEC;
    if (!this.audioContext) this.audioContext = new AudioContext();
    const context = this.audioContext;
    await context.resume();
    const samples = generate_chirp(
      context.sampleRate,
      spec.startHz,
      spec.endHz,
      spec.durationMs,
      spec.gainDbfs,
    );
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const startAt = context.currentTime + 0.15;
    for (let i = 0; i < spec.repeats; i++) {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start(startAt + (i * (spec.durationMs + spec.gapMs)) / 1_000);
    }
    this.signaling.send({
      v: 1,
      type: "calibration-chirp",
      chirpId: crypto.randomUUID(),
      emitTsDeskUs: Math.round((performance.timeOrigin + performance.now()) * 1_000),
      spec,
    });
    this.patch({ lastChirpAt: Date.now() });
  }

  // ---- signaling ------------------------------------------------------------

  private onSignal(msg: SignalingMessage): void {
    switch (msg.type) {
      case "welcome": {
        this.patch({ activeTakeId: msg.session.activeTake?.takeId ?? null });
        this.ensureServerSync();
        break;
      }
      case "take-start":
        this.patch({ activeTakeId: msg.takeId, takeStartedAt: Date.now() });
        break;
      case "take-stop":
        this.patch({ activeTakeId: null });
        // §6.4: ack immediately on take close + reconcile with the server.
        this.broadcastAcks();
        this.exchangeHaves();
        break;
      case "stream-announce": {
        const streams = this.state.streams.filter((s) => s.streamId !== msg.streamId);
        streams.push({
          takeId: msg.takeId,
          streamId: msg.streamId,
          peerId: msg.fromPeerId ?? null,
          finalSeq: null,
        });
        this.patch({ streams });
        break;
      }
      case "stream-final": {
        this.post({
          type: "set-final",
          takeId: msg.takeId,
          streamId: msg.streamId,
          finalSeq: msg.finalSeq,
        });
        this.patch({
          streams: this.state.streams.map((s) =>
            s.streamId === msg.streamId ? { ...s, finalSeq: msg.finalSeq } : s,
          ),
        });
        break;
      }
      case "ice-offer": {
        if (msg.fromPeerId && msg.fromPeerId !== SERVER_PEER_ID) {
          void this.answerRecorderOffer(msg.fromPeerId, msg.sdp);
        }
        break;
      }
      case "error":
        this.patch({ errors: [...this.state.errors.slice(-4), `${msg.code}: ${msg.message}`] });
        break;
      default:
        break;
    }
  }

  // ---- transports ------------------------------------------------------------

  /** Recorders offer `antiphon/1` directly to the desk (LAN path). */
  private async answerRecorderOffer(fromPeerId: string, sdp: string): Promise<void> {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const unwire = wireIce(pc, this.signaling, fromPeerId);
    const connId = this.nextConnId++;
    pc.addEventListener("datachannel", (ev) => {
      const channel = ev.channel;
      channel.binaryType = "arraybuffer";
      const conn: Conn = {
        id: connId,
        channel,
        dispose: () => {
          unwire();
          try {
            channel.close();
            pc.close();
          } catch {
            // teardown race
          }
        },
      };
      this.conns.set(connId, conn);
      channel.addEventListener("message", (mev) => {
        if (mev.data instanceof ArrayBuffer) {
          this.post({ type: "frame", connId, bytes: mev.data }, [mev.data]);
        }
      });
      channel.addEventListener("close", () => {
        this.conns.delete(connId);
        conn.dispose();
      });
    });
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") {
        this.conns.get(connId)?.dispose();
        this.conns.delete(connId);
      }
    });
    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.signaling.send({
      v: 1,
      type: "ice-answer",
      targetPeerId: fromPeerId,
      sdp: answer.sdp ?? "",
    });
  }

  /** Desk→server sync channel (antiphon-sync/1). */
  private ensureServerSync(): void {
    if (this.serverConnecting || this.serverConn?.channel.readyState === "open") return;
    if (!this.signaling.state.connected) return;
    this.serverConnecting = true;
    this.patch({ serverSync: "connecting" });
    void offerChannel(this.signaling, SERVER_PEER_ID, "antiphon-sync/1")
      .then(({ pc, channel, dispose }) => {
        const connId = this.nextConnId++;
        const conn: Conn = { id: connId, channel, dispose };
        this.serverConn = conn;
        this.conns.set(connId, conn);
        this.serverConnecting = false;
        this.patch({ serverSync: "connected" });
        channel.addEventListener("message", (ev) => {
          if (ev.data instanceof ArrayBuffer) {
            this.onServerSyncFrame(ev.data, connId);
          }
        });
        const onDown = () => {
          if (this.serverConn === conn) {
            this.serverConn = null;
            this.conns.delete(connId);
            conn.dispose();
            this.patch({ serverSync: "down" });
            window.setTimeout(() => this.ensureServerSync(), RECONNECT_DELAY_MS);
          }
        };
        channel.addEventListener("close", onDown);
        pc.addEventListener("connectionstatechange", () => {
          if (pc.connectionState === "failed" || pc.connectionState === "disconnected") onDown();
        });
        // Announce our HAVEs immediately (§6.8).
        this.exchangeHaves();
      })
      .catch(() => {
        this.serverConnecting = false;
        this.patch({ serverSync: "down" });
        window.setTimeout(() => this.ensureServerSync(), RECONNECT_DELAY_MS);
      });
  }

  private onServerSyncFrame(bytes: ArrayBuffer, connId: number): void {
    // Frame type dispatch happens in the worker for chunks/gaps; HAVEs from
    // the server additionally trigger a push plan from OUR store.
    const view = new Uint8Array(bytes);
    const isHave = view.length >= 4 && view[3] === 0x07;
    if (isHave) {
      const copy = bytes.slice(0);
      this.requestPushPlan(copy);
    }
    this.post({ type: "frame", connId, bytes }, [bytes]);
  }

  private requestPushPlan(haveBytes: ArrayBuffer): void {
    this.post({ type: "plan-push", haveBytes }, [haveBytes]);
  }

  // ---- reconciliation loops ----------------------------------------------

  private broadcastAcks(): void {
    this.requestFromWorker("acks", (frames) => {
      for (const conn of this.conns.values()) {
        if (conn.channel.readyState !== "open") continue;
        for (const frame of frames) {
          try {
            conn.channel.send(frame);
          } catch {
            break;
          }
        }
      }
    });
  }

  private exchangeHaves(): void {
    const server = this.serverConn;
    if (server?.channel.readyState !== "open") return;
    this.requestFromWorker("haves", (frames) => {
      for (const frame of frames) {
        try {
          server.channel.send(frame);
        } catch {
          break;
        }
      }
    });
  }

  private requestFromWorker(
    kind: "acks" | "haves",
    handler: (frames: ArrayBuffer[]) => void,
  ): void {
    this.waiters[kind].push(handler);
    this.post({ type: kind });
  }

  private onWorker(msg: FromSinkWorker): void {
    switch (msg.type) {
      case "ready":
        this.patch({ rebuiltChunks: msg.rebuiltChunks });
        break;
      case "reply": {
        const conn = this.conns.get(msg.connId);
        if (conn?.channel.readyState === "open") {
          try {
            conn.channel.send(msg.bytes);
          } catch {
            // dead channel
          }
        }
        break;
      }
      case "acks-result":
        this.waiters.acks.shift()?.(msg.frames);
        break;
      case "haves-result":
        this.waiters.haves.shift()?.(msg.frames);
        break;
      case "push-plan": {
        if (msg.ranges.length === 0) break;
        this.waiters.frames.push((frames) => this.pushFramesToServer(frames));
        this.post({
          type: "get-frames",
          takeId: msg.takeId,
          streamId: msg.streamId,
          ranges: msg.ranges,
        });
        break;
      }
      case "frames-result":
        this.waiters.frames.shift()?.(msg.frames);
        break;
      case "status-result":
        this.patch({ deskStatus: msg.streams });
        break;
      case "error":
        this.patch({ errors: [...this.state.errors.slice(-4), msg.message] });
        break;
    }
  }

  private pushFramesToServer(frames: ArrayBuffer[]): void {
    const channel = this.serverConn?.channel;
    if (channel?.readyState !== "open") return;
    let i = 0;
    const pump = () => {
      while (i < frames.length && channel.bufferedAmount < HIGH_WATERMARK) {
        const frame = frames[i++];
        if (!frame) break;
        try {
          channel.send(frame);
        } catch {
          return;
        }
      }
      if (i < frames.length) {
        channel.addEventListener("bufferedamountlow", pump, { once: true });
      }
    };
    channel.bufferedAmountLowThreshold = HIGH_WATERMARK / 4;
    pump();
  }

  private post(msg: ToSinkWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer);
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
