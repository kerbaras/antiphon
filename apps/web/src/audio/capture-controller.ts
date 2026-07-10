// Main-thread capture orchestration: getUserMedia (all processing OFF) →
// AudioWorklet → SAB ring → encoder worker. Owns no protocol logic; it moves
// bytes between the worker and attached transports and republishes stats.

import {
  acquireStream,
  type CaptureFlags,
  defaultDeviceDesc,
  flagsOf,
  randomId,
  uuidToBytes,
} from "./capture-media";
import type { RingDiagnostics } from "./sab-ring";
import { createCaptureRing } from "./sab-ring";
import type { FromEncoderWorker, RecorderStats, ToEncoderWorker } from "./worker-protocol";

export { type CaptureFlags, randomId, uuidToBytes };

/** Ring capacity: ~8s of float samples — an encoder stall this long is a
 * fault we surface, not absorb silently. */
const RING_SECONDS = 8;
/** Encoded ring buffer budget: 60s (RFC §9 RECOMMENDED) at a generous
 * ~100 KB/s estimate. A few MB of RAM buys the entire resilience story. */
const ENCODED_RING_BUDGET_BYTES = 6 * 1024 * 1024;

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
  /** A take is open (arm requested → streaming → draining, until the
   * worker reports "stopped"). Latched SYNCHRONOUSLY in arm() — worker
   * stats lag ~250ms and must never gate safety decisions like device
   * switching. */
  takeOpen: boolean;
}

type Listener = (snapshot: CaptureSnapshot) => void;

export interface SinkPort {
  /** Deliver frames the recorder owes this sink (already byte-budgeted). */
  send(frames: ArrayBuffer[]): void;
  /** How many more bytes the transport can absorb right now. */
  budget(): number;
}

export interface ArmOptions {
  takeId: Uint8Array;
  streamId: Uint8Array;
  deviceDesc?: string;
  retainLocal?: boolean;
}

export interface CaptureStartOptions {
  /** Capture a specific input (desk hardware lanes); default = user default mic. */
  deviceId?: string;
  /** Screen wake lock (phone backgrounding UX); the desk skips it. Default true. */
  wakeLock?: boolean;
}

export class CaptureController {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
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
    takeOpen: false,
  };
  private exportWaiters: Array<(flac: ArrayBuffer | null) => void> = [];
  /** Arm intent queued while the encoder worker boots (see arm()). */
  private pendingArm: ArmOptions | null = null;
  /** Bumped by teardown(): async paths (switchDevice's in-flight
   * getUserMedia) re-check it after every await — a stale fulfillment
   * against a torn-down pipeline must never repopulate a hot mic. */
  private pipelineEpoch = 0;
  /** One device switch at a time; concurrent calls fail fast. */
  private switchInFlight = false;
  /** Take identity for the takeOpen latch: bumped synchronously per arm().
   * The worker's "stopped" report releases the latch ONLY when no arm
   * happened after the stop it answers (stopTake records the generation it
   * closes). */
  private armGeneration = 0;
  /** Generation the pending worker "stop" closes; -1 = no stop in flight. */
  private stopForGeneration = -1;

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

  /** The live input track (unplug detection: 'ended' fires when the device
   * goes away; the graph then feeds silence, keeping the sample domain
   * contiguous — take integrity over dead air). */
  get audioTrack(): MediaStreamTrack | null {
    return this.stream?.getAudioTracks()[0] ?? null;
  }

  /** Ask for the mic with every processing flag OFF and start the pipeline.
   * Must be called from a user gesture (iOS). Multichannel inputs downmix
   * to mono in the worklet node (channelCount 1, explicit): stereo becomes
   * (L+R)/2 per Web Audio up/down-mix rules — protocol v1 is mono (§6.2). */
  async start(options: CaptureStartOptions = {}): Promise<void> {
    if (this.context) return;
    try {
      const stream = await acquireStream(options.deviceId);
      this.stream = stream;
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
      this.source = source;
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
        flags: flagsOf(stream),
        error: null,
      });
      if (options.wakeLock !== false) await this.acquireWakeLock();
    } catch (e) {
      this.publish({ error: `capture start failed: ${String(e)}` });
      throw e;
    }
  }

  /** Swap the live input without touching the rest of the pipeline: only
   * the MediaStream source node is replaced; the next arm() stamps the new
   * device into its stream header.
   *
   * Refused while a take is open: a mid-take source swap would put a
   * foreign device inside one contiguous sample domain with no gap
   * declared. The gate is the SYNCHRONOUS takeOpen latch (never lagged
   * worker stats), checked before acquiring and AGAIN after the awaited
   * getUserMedia — an arm() or teardown() landing mid-acquisition wins and
   * the fresh tracks are stopped, never swapped in. On failure the old
   * stream keeps running untouched. */
  async switchDevice(deviceId: string): Promise<void> {
    if (!this.context || !this.node) throw new Error("capture pipeline is not running");
    if (this.snapshot.takeOpen) throw new Error("cannot switch input while a take is open");
    if (this.switchInFlight) throw new Error("a device switch is already in flight");
    this.switchInFlight = true;
    try {
      const epoch = this.pipelineEpoch;
      let stream: MediaStream;
      try {
        stream = await acquireStream(deviceId);
      } catch (e) {
        this.publish({ error: `input switch failed: ${String(e)}` });
        throw e;
      }
      // Post-await re-checks: the world may have moved while getUserMedia
      // was in flight. Either way the new stream is retired on the spot —
      // a rejected switch must never leave a hot mic behind.
      const context = this.context;
      const node = this.node;
      if (this.pipelineEpoch !== epoch || !context || !node) {
        for (const track of stream.getTracks()) track.stop();
        throw new Error("capture pipeline closed during the switch");
      }
      if (this.snapshot.takeOpen) {
        for (const track of stream.getTracks()) track.stop();
        throw new Error("a take opened during the switch — input unchanged");
      }
      // New stream first, then retire the old: if the OS kills the old
      // track on re-acquisition (iOS allows one live capture), the swap is
      // already in flight. The worklet counts the (at most) one silent
      // quantum between disconnect and connect; nothing is armed.
      this.source?.disconnect();
      for (const track of this.stream?.getTracks() ?? []) track.stop();
      const source = context.createMediaStreamSource(stream);
      source.connect(node);
      this.source = source;
      this.stream = stream;
      this.publish({ flags: flagsOf(stream), error: null });
    } finally {
      this.switchInFlight = false;
    }
  }

  /** Arm a take: sample index 0 is the next captured sample. Arming never
   * gates on the network (§7.1) but DOES gate on the pipeline: a welcome or
   * take-start reliably beats the encoder worker's wasm boot, so the intent
   * is remembered and fires the moment the worker reports ready. */
  arm(options: ArmOptions): void {
    // Latch take intent SYNCHRONOUSLY, before any queueing or posting:
    // switchDevice() and the picker UI gate on this bit, and worker stats
    // arrive ~250ms too late to close the race. The generation bump makes
    // any already-in-flight "stopped" (previous take) stale.
    this.armGeneration += 1;
    this.publish({ takeOpen: true });
    if (!this.workerReady) {
      this.pendingArm = options;
      return;
    }
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
    if (this.pendingArm) {
      // Stopped before the pipeline ever armed: nothing was captured.
      this.pendingArm = null;
      this.publish({ takeOpen: false });
      return;
    }
    // takeOpen stays latched through DRAINING; the worker's "stopped"
    // report releases it — but only for THIS take: record the generation
    // this stop closes, so a stopped arriving after a newer arm() is
    // recognized as stale and ignored.
    this.stopForGeneration = this.armGeneration;
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

  /** Release the mic and tear the pipeline down (leaving a session, or a
   * fatal control halt). Publishes the reset so the UI never renders a
   * stale "capturing" state over a released mic. */
  async teardown(): Promise<void> {
    // Invalidate in-flight async work (switchDevice) FIRST: anything that
    // fulfills after this line sees a new epoch and retires itself.
    this.pipelineEpoch += 1;
    this.node?.disconnect();
    this.node = null;
    this.source?.disconnect();
    this.source = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    this.pendingArm = null;
    await this.context?.close();
    this.context = null;
    await this.wakeLock?.release();
    this.wakeLock = null;
    this.publish({
      contextSampleRate: null,
      contextState: null,
      flags: null,
      stats: null,
      ring: null,
      peak: 0,
      localChunks: 0,
      finalSeq: null,
      takeOpen: false,
    });
  }

  private onWorker(msg: FromEncoderWorker) {
    switch (msg.type) {
      case "ready": {
        this.workerReady = true;
        const queued = this.pendingArm;
        this.pendingArm = null;
        if (queued) this.arm(queued);
        break;
      }
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
        // Release the takeOpen latch only when this report answers the
        // CURRENT generation's stop — a stop(N)+arm(N+1) pair inside the
        // worker's stop round-trip must not let take N's stopped wipe take
        // N+1's latch. finalSeq publishes regardless: the session dedupes
        // it per (takeId, streamId, finalSeq).
        this.publish({
          finalSeq: msg.finalSeq,
          ...(this.stopForGeneration === this.armGeneration ? { takeOpen: false } : {}),
        });
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
