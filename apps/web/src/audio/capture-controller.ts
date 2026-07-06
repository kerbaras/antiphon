// Main-thread capture orchestration: getUserMedia (all processing OFF) →
// AudioWorklet → SAB ring → encoder worker. Owns no protocol logic; it moves
// bytes between the worker and whatever transports are attached, and
// republishes worker stats for the UI.

import type { RingDiagnostics } from "./sab-ring";
import { createCaptureRing } from "./sab-ring";
import type { FromEncoderWorker, RecorderStats, ToEncoderWorker } from "./worker-protocol";

/** Ring capacity: ~8s of float samples — an encoder stall this long is a
 * fault we surface, not absorb silently. */
const RING_SECONDS = 8;
/** Encoded ring buffer budget: 60s (RFC §9 RECOMMENDED) at a generous
 * ~100 KB/s estimate. A few MB of RAM buys the entire resilience story. */
const ENCODED_RING_BUDGET_BYTES = 6 * 1024 * 1024;

export interface CaptureFlags {
  // Newer specs allow string modes (e.g. echoCancellation: "browser").
  echoCancellation: boolean | string | undefined;
  noiseSuppression: boolean | string | undefined;
  autoGainControl: boolean | string | undefined;
  sampleRate: number | undefined;
  channelCount: number | undefined;
  deviceLabel: string;
}

export interface CaptureSnapshot {
  contextSampleRate: number | null;
  contextState: string | null;
  flags: CaptureFlags | null;
  stats: RecorderStats | null;
  ring: RingDiagnostics | null;
  peak: number;
  localChunks: number;
  finalSeq: number | null;
  error: string | null;
}

type Listener = (snapshot: CaptureSnapshot) => void;

export interface SinkPort {
  /** Deliver frames the recorder owes this sink (already byte-budgeted). */
  send(frames: ArrayBuffer[]): void;
  /** How many more bytes the transport can absorb right now. */
  budget(): number;
}

export class CaptureController {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private workerReady = false;
  private node: AudioWorkletNode | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private listeners = new Set<Listener>();
  private sinks = new Map<number, SinkPort>();
  private snapshot: CaptureSnapshot = {
    contextSampleRate: null,
    contextState: null,
    flags: null,
    stats: null,
    ring: null,
    peak: 0,
    localChunks: 0,
    finalSeq: null,
    error: null,
  };
  private exportWaiters: Array<(flac: ArrayBuffer | null) => void> = [];

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private publish(patch: Partial<CaptureSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l(this.snapshot);
  }

  get sampleRate(): number | null {
    return this.context?.sampleRate ?? null;
  }

  /** Ask for the mic with every processing flag OFF and start the pipeline.
   * Must be called from a user gesture (iOS). */
  async start(): Promise<void> {
    if (this.context) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
      this.stream = stream;
      const track = stream.getAudioTracks()[0];
      const settings = track?.getSettings() ?? {};
      const context = new AudioContext();
      this.context = context;
      await context.resume();

      const sab = createCaptureRing(Math.round(context.sampleRate * RING_SECONDS));
      await context.audioWorklet.addModule("/worklets/capture.js");
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "antiphon-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: { sab },
      });
      source.connect(node);
      this.node = node;

      const worker = new Worker(new URL("./encoder.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (e: MessageEvent<FromEncoderWorker>) => this.onWorker(e.data);
      this.worker = worker;
      this.post({ type: "configure", sab, sampleRate: context.sampleRate });

      this.publish({
        contextSampleRate: context.sampleRate,
        contextState: context.state,
        flags: {
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl,
          sampleRate: settings.sampleRate,
          channelCount: settings.channelCount,
          deviceLabel: track?.label ?? "unknown input",
        },
        error: null,
      });
      await this.acquireWakeLock();
    } catch (e) {
      this.publish({ error: `capture start failed: ${String(e)}` });
      throw e;
    }
  }

  /** Arm a take: sample index 0 is the next captured sample. */
  arm(options: {
    takeId: Uint8Array;
    streamId: Uint8Array;
    deviceDesc?: string;
    retainLocal?: boolean;
  }): void {
    if (!this.workerReady) throw new Error("capture pipeline not ready");
    this.post({
      type: "arm",
      takeId: options.takeId,
      streamId: options.streamId,
      bitsPerSample: 24,
      deviceDesc: options.deviceDesc ?? defaultDeviceDesc(this.snapshot.flags),
      wallClockHintMs: Date.now(),
      ringBudgetBytes: ENCODED_RING_BUDGET_BYTES,
      retainLocal: options.retainLocal ?? false,
    });
  }

  stopTake(): void {
    this.post({ type: "stop" });
  }

  /** Attach a transport for a sink id; the controller drains frames into it
   * respecting its byte budget. */
  attachSink(sinkId: number, port: SinkPort): void {
    this.sinks.set(sinkId, port);
    this.post({ type: "sink-add", sinkId });
  }

  setSinkConnected(sinkId: number, connected: boolean): void {
    this.post({ type: "sink-connected", sinkId, connected });
  }

  detachSink(sinkId: number): void {
    this.sinks.delete(sinkId);
    this.post({ type: "sink-remove", sinkId });
  }

  /** Deliver an inbound data-plane frame from a sink's transport. */
  deliverFrame(sinkId: number, bytes: ArrayBuffer): void {
    this.post({ type: "frame", sinkId, bytes }, [bytes]);
  }

  /** The transport has room again — pull more frames for this sink. */
  requestDrain(sinkId: number): void {
    const port = this.sinks.get(sinkId);
    if (!port) return;
    const budget = port.budget();
    if (budget > 0) this.post({ type: "drain", sinkId, maxBytes: budget });
  }

  sendTimePing(sinkId: number): void {
    this.post({ type: "time-ping", sinkId });
  }

  /** Local .flac (retainLocal takes only). */
  exportLocalFlac(): Promise<ArrayBuffer | null> {
    return new Promise((resolve) => {
      this.exportWaiters.push(resolve);
      this.post({ type: "export" });
    });
  }

  /** Release the mic and tear the pipeline down (leaving a session). */
  async teardown(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    await this.context?.close();
    this.context = null;
    await this.wakeLock?.release();
    this.wakeLock = null;
  }

  private onWorker(msg: FromEncoderWorker) {
    switch (msg.type) {
      case "ready":
        this.workerReady = true;
        break;
      case "armed":
        this.publish({ finalSeq: null });
        break;
      case "stats":
        this.publish({
          stats: msg.stats,
          ring: msg.ring,
          peak: msg.peak,
          localChunks: msg.localChunks,
          contextState: this.context?.state ?? null,
        });
        break;
      case "pending":
        for (const sinkId of msg.sinkIds) this.requestDrain(sinkId);
        break;
      case "frames": {
        const port = this.sinks.get(msg.sinkId);
        port?.send(msg.frames);
        break;
      }
      case "reply": {
        const port = this.sinks.get(msg.sinkId);
        port?.send([msg.bytes]);
        break;
      }
      case "meter": {
        // Fire-and-forget telemetry to every sink with headroom; meters are
        // worthless stale, so never queue behind audio.
        for (const port of this.sinks.values()) {
          if (port.budget() > msg.frame.byteLength) port.send([msg.frame]);
        }
        break;
      }
      case "stopped":
        this.publish({ finalSeq: msg.finalSeq });
        break;
      case "export-result": {
        const waiters = this.exportWaiters.splice(0);
        for (const w of waiters) w(msg.flac);
        break;
      }
      case "error":
        this.publish({ error: msg.message });
        break;
    }
  }

  private post(msg: ToEncoderWorker, transfer: Transferable[] = []) {
    this.worker?.postMessage(msg, transfer);
  }

  private async acquireWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        this.wakeLock = await navigator.wakeLock.request("screen");
        document.addEventListener("visibilitychange", async () => {
          if (document.visibilityState === "visible" && this.wakeLock?.released) {
            this.wakeLock = await navigator.wakeLock.request("screen");
          }
        });
      }
    } catch {
      // Wake lock is best-effort; the runbook covers screen-on guidance.
    }
  }
}

function defaultDeviceDesc(flags: CaptureFlags | null): string {
  const ua = navigator.userAgent;
  const device = /iPhone|iPad|Android/.exec(ua)?.[0] ?? "browser";
  return `${device} · ${flags?.deviceLabel ?? "mic"}`;
}

export function randomId(): Uint8Array {
  const id = new Uint8Array(16);
  crypto.getRandomValues(id);
  // UUIDv4 bits so the ids read as valid UUIDs everywhere.
  id[6] = ((id[6] as number) & 0x0f) | 0x40;
  id[8] = ((id[8] as number) & 0x3f) | 0x80;
  return id;
}

export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  if (hex.length !== 32) throw new Error(`bad uuid: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
