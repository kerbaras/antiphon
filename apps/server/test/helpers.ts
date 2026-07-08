// Integration harness: a fake recorder that is real everywhere it matters —
// real WS signaling, real WebRTC DataChannels (node-datachannel), the real
// WASM RecorderEngine. Only the microphone is synthetic.

import { init as initWasm, RecorderEngine } from "@antiphon/core-wasm";
import {
  parseSignalingMessage,
  SERVER_PEER_ID,
  type SessionState,
  type SignalingMessage,
} from "@antiphon/protocol";
import { serve } from "@hono/node-server";
import nodeDataChannel from "node-datachannel";
import type { ServerConfig } from "../src/config.ts";
import { createServer } from "../src/index.ts";

const { PeerConnection } = nodeDataChannel;

export const SERVER_SINK = 0;

export interface TestServer {
  port: number;
  baseUrl: string;
  stop(): Promise<void>;
}

/** Test overrides on top of generous defaults (rate limits are effectively
 * off unless a test opts in — the harness joins fast from one IP). */
export type TestConfigOverrides = {
  limits?: Partial<ServerConfig["limits"]>;
  retention?: Partial<ServerConfig["retention"]>;
};

export async function startTestServer(
  dbUrl: string,
  blobRoot: string,
  overrides: TestConfigOverrides = {},
): Promise<TestServer> {
  const { app, injectWebSocket, close } = await createServer({
    databaseUrl: dbUrl,
    blob: { driver: "fs", root: blobRoot },
    port: 0,
    logLevel: "error",
    corsOrigins: null,
    trustProxy: false,
    limits: {
      joinRatePerMin: 6_000,
      joinBurst: 1_000,
      msgRatePerSec: 1_000,
      msgBurst: 2_000,
      maxPeersPerSession: 32,
      maxActiveSessions: 200,
      ...overrides.limits,
    },
    retention: {
      sessionTtlHours: 720,
      sweepIntervalMs: 600_000,
      ...overrides.retention,
    },
  });
  return await new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({
        port: info.port,
        baseUrl: `http://localhost:${info.port}`,
        stop: async () => {
          await close();
          // Sever WS upgrade sockets too, or close() waits forever.
          (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
    injectWebSocket(server);
  });
}

export function sine(seconds: number, rate = 48_000): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.sin((i * 523.25 * 2 * Math.PI) / rate) * 0.6;
  }
  return out;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Identity extras for `hello.deviceInfo` (A12/A13). */
export interface FakeDeviceInfo {
  deviceId?: string;
  label?: string;
}

export class FakeRecorder {
  ws!: WebSocket;
  peerId: string | null = null;
  session: SessionState | null = null;
  wsClosed = false;
  engine: RecorderEngine | null = null;
  readonly received: SignalingMessage[] = [];
  private pc: InstanceType<typeof PeerConnection> | null = null;
  private dc: nodeDataChannel.DataChannel | null = null;
  private takeStartListeners: Array<(takeId: string) => void> = [];
  readonly sentFrames: Uint8Array[] = [];
  private readonly baseUrl: string;
  private readonly sessionId: string;
  private readonly deviceInfo: FakeDeviceInfo;

  constructor(baseUrl: string, sessionId: string, deviceInfo: FakeDeviceInfo = {}) {
    this.baseUrl = baseUrl;
    this.sessionId = sessionId;
    this.deviceInfo = deviceInfo;
  }

  /** Connect signaling and complete hello/welcome. */
  async join(): Promise<void> {
    await initWasm();
    const wsUrl = `${this.baseUrl.replace("http", "ws")}/join/${this.sessionId}/ws`;
    this.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
      this.ws.addEventListener("open", () => resolve(), { once: true });
    });
    this.ws.addEventListener("message", (ev) => this.onSignal(String(ev.data)));
    this.ws.addEventListener("close", () => {
      this.wsClosed = true;
    });
    this.send({
      v: 1,
      type: "hello",
      role: "recorder",
      deviceInfo: { userAgent: "fake-recorder", ...this.deviceInfo },
      protocolVersions: [1],
    });
    await this.waitFor(() => this.peerId !== null, "welcome");
  }

  /** A13 rename (self, unless the server lets us do more). */
  rename(peerId: string, label: string): void {
    this.send({ v: 1, type: "peer-update", peerId, label });
  }

  /** Next already-received (or future) message of the given type. */
  async waitForMessage<T extends SignalingMessage["type"]>(
    type: T,
    timeoutMs = 10_000,
  ): Promise<Extract<SignalingMessage, { type: T }>> {
    const start = Date.now();
    for (;;) {
      const found = this.received.find((m) => m.type === type);
      if (found) return found as Extract<SignalingMessage, { type: T }>;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${type}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Open (or re-open) the DataChannel leg toward the server sink. */
  async connectDataChannel(): Promise<void> {
    this.teardownPeerConnection();
    const pc = new PeerConnection(`fake-${Math.random().toString(36).slice(2, 8)}`, {
      iceServers: [],
    });
    this.pc = pc;
    pc.onLocalDescription((sdp, type) => {
      if (type === "offer") {
        this.send({ v: 1, type: "ice-offer", targetPeerId: SERVER_PEER_ID, sdp });
      }
    });
    pc.onLocalCandidate((candidate, mid) => {
      this.send({
        v: 1,
        type: "ice-candidate",
        targetPeerId: SERVER_PEER_ID,
        candidate: { candidate, sdpMid: mid },
      });
    });
    const dc = pc.createDataChannel("antiphon/1");
    this.dc = dc;
    dc.onMessage((msg) => {
      if (typeof msg === "string" || !this.engine) return;
      const bytes =
        msg instanceof ArrayBuffer
          ? new Uint8Array(msg)
          : new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
      const reply = this.engine.handle_frame(SERVER_SINK, bytes, nowUs());
      if (reply) dc.sendMessageBinary(reply);
      this.drain();
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("dc open timeout")), 10_000);
      dc.onOpen(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.engine?.set_sink_connected(SERVER_SINK, true);
    this.drain();
  }

  /** Simulate a network death: the transport dies, capture does not. */
  dropNetwork(): void {
    this.engine?.set_sink_connected(SERVER_SINK, false);
    this.teardownPeerConnection();
  }

  /** Arm a stream for a take (called on take-start). */
  arm(takeId: string, streamId: string): void {
    this.engine = new RecorderEngine(
      uuidToBytes(takeId),
      uuidToBytes(streamId),
      48_000,
      24,
      "fake-recorder",
      1_000_000,
      Date.now(),
      32 * 1024 * 1024,
    );
    this.engine.add_sink(SERVER_SINK);
    if (this.dc?.isOpen()) this.engine.set_sink_connected(SERVER_SINK, true);
    this.send({ v: 1, type: "stream-announce", takeId, streamId });
  }

  pushAudio(samples: Float32Array): void {
    if (!this.engine) throw new Error("not armed");
    this.engine.push_samples(samples);
    this.drain();
  }

  /** take-stop: finish the stream and tell sinks the final seq. */
  finish(takeId: string, streamId: string): number {
    if (!this.engine) throw new Error("not armed");
    this.engine.finish();
    const finalSeq = this.engine.final_seq();
    if (finalSeq === undefined) throw new Error("no final seq");
    this.send({ v: 1, type: "stream-final", takeId, streamId, finalSeq });
    this.drain();
    return finalSeq;
  }

  drain(): void {
    if (!this.engine || !this.dc?.isOpen()) return;
    for (;;) {
      const frame = this.engine.pop_frame(SERVER_SINK);
      if (!frame) return;
      this.sentFrames.push(frame);
      this.dc.sendMessageBinary(frame);
    }
  }

  /** Re-send previously sent frames verbatim (duplicate-spam attack). */
  replayFrames(times: number): void {
    if (!this.dc?.isOpen()) throw new Error("dc closed");
    for (let i = 0; i < times; i++) {
      for (const frame of this.sentFrames) {
        this.dc.sendMessageBinary(frame);
      }
    }
  }

  onTakeStart(listener: (takeId: string) => void): void {
    this.takeStartListeners.push(listener);
  }

  async waitDrained(timeoutMs = 15_000): Promise<void> {
    await this.waitFor(() => this.engine?.drained_all() ?? false, "drained", timeoutMs);
  }

  async close(): Promise<void> {
    this.teardownPeerConnection();
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
  }

  private teardownPeerConnection(): void {
    try {
      this.dc?.close();
      this.pc?.close();
    } catch {
      // teardown races
    }
    this.dc = null;
    this.pc = null;
  }

  private onSignal(raw: string): void {
    let msg: SignalingMessage | null = null;
    try {
      msg = parseSignalingMessage(raw);
    } catch {
      return;
    }
    if (!msg) return;
    this.received.push(msg);
    switch (msg.type) {
      case "welcome":
        this.peerId = msg.peerId;
        this.session = msg.session;
        break;
      case "peer-status":
        this.session = msg.session;
        break;
      case "ice-answer":
        this.pc?.setRemoteDescription(msg.sdp, "answer");
        break;
      case "ice-candidate":
        if (msg.candidate && msg.fromPeerId === SERVER_PEER_ID) {
          try {
            this.pc?.addRemoteCandidate(msg.candidate.candidate, msg.candidate.sdpMid ?? "0");
          } catch {
            // candidates for a torn-down pc
          }
        }
        break;
      case "take-start":
        for (const l of this.takeStartListeners) l(msg.takeId);
        break;
      default:
        break;
    }
  }

  private send(msg: SignalingMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  private async waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

export class FakeDesk {
  ws!: WebSocket;
  peerId: string | null = null;
  session: SessionState | null = null;
  readonly received: SignalingMessage[] = [];
  private readonly baseUrl: string;
  private readonly sessionId: string;
  private readonly deviceInfo: FakeDeviceInfo;

  constructor(baseUrl: string, sessionId: string, deviceInfo: FakeDeviceInfo = {}) {
    this.baseUrl = baseUrl;
    this.sessionId = sessionId;
    this.deviceInfo = deviceInfo;
  }

  async join(): Promise<void> {
    const wsUrl = `${this.baseUrl.replace("http", "ws")}/session/${this.sessionId}/ws`;
    this.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
      this.ws.addEventListener("open", () => resolve(), { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = safeParse(String(ev.data));
      if (!msg) return;
      this.received.push(msg);
      if (msg.type === "welcome") {
        this.peerId = msg.peerId;
        this.session = msg.session;
      }
      if (msg.type === "peer-status") this.session = msg.session;
    });
    this.ws.send(
      JSON.stringify({
        v: 1,
        type: "hello",
        role: "desk",
        deviceInfo: { userAgent: "fake-desk", ...this.deviceInfo },
        protocolVersions: [1],
      }),
    );
    const start = Date.now();
    while (this.peerId === null) {
      if (Date.now() - start > 5_000) throw new Error("desk welcome timeout");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** A13: the desk (session authority) renames any peer. */
  renamePeer(peerId: string, label: string): void {
    this.ws.send(JSON.stringify({ v: 1, type: "peer-update", peerId, label }));
  }

  takeStart(takeId: string): void {
    this.ws.send(
      JSON.stringify({
        v: 1,
        type: "take-start",
        takeId,
        wallClockHint: new Date().toISOString(),
      }),
    );
  }

  takeStop(takeId: string): void {
    this.ws.send(JSON.stringify({ v: 1, type: "take-stop", takeId }));
  }

  deleteStreams(streams: Array<{ takeId: string; streamId: string }>): void {
    this.ws.send(JSON.stringify({ v: 1, type: "streams-delete", streams }));
  }

  /** Next already-received (or future) message of the given type. */
  async waitForMessage<T extends SignalingMessage["type"]>(
    type: T,
    timeoutMs = 10_000,
  ): Promise<Extract<SignalingMessage, { type: T }>> {
    const start = Date.now();
    for (;;) {
      const found = this.received.find((m) => m.type === type);
      if (found) return found as Extract<SignalingMessage, { type: T }>;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${type}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  close(): void {
    this.ws?.close();
  }
}

function safeParse(raw: string): SignalingMessage | null {
  try {
    return parseSignalingMessage(raw);
  } catch {
    return null;
  }
}

export function nowUs(): number {
  return performance.now() * 1_000;
}

export interface StreamSummary {
  streamId: string;
  finalSeq: number | null;
  chunkCount: number;
  chwm: number | null;
  holes: Array<[number, number]>;
  gaps: Array<[number, number]>;
  complete: boolean;
  settled: boolean;
  flagged: boolean;
  digest: string;
}

export async function takeSummary(
  baseUrl: string,
  sessionId: string,
  takeId: string,
): Promise<StreamSummary[]> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/takes/${takeId}`);
  const body = (await res.json()) as { streams: StreamSummary[] };
  return body.streams;
}

export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${what}: ${JSON.stringify(value)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
