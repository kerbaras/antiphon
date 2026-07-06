// Ingest: the server's sink. node-datachannel (libdatachannel underneath)
// terminates DTLS/SCTP; the WASM SinkEngine (the same one the desk runs)
// makes every protocol decision; the Archive persists.
//
// KEEP ISOLATED. This module is the designated extraction candidate for
// Axum + webrtc-rs if hosted-product scale ever demands it. It speaks only
// the idempotent chunk protocol and the Archive interface — no reaching
// into signaling or HTTP. (docs/ARCHITECTURE.md §2.3, §7)
//
// Durability contract: an ACK is a claim that a chunk is persisted. All
// ingest work is serialized on a per-session promise chain, and ACKs join
// the same chain — an ACK can never overtake the persistence of a chunk it
// covers. A persistence failure poisons the session: channels drop, the
// engine rebuilds from the database (RFC §8 crash recovery), reconnection
// resumes normally. Fail-stop, never fail-silent.

import {
  init as initWasm,
  SinkEngine,
  stream_header_json,
  TimeSyncSession,
} from "@antiphon/core-wasm";
import nodeDataChannel from "node-datachannel";
import type { Archive } from "../archive/index.ts";
import { CHANNEL_LABELS, uuidBytes } from "./util.ts";

const { PeerConnection } = nodeDataChannel;
type DataChannel = nodeDataChannel.DataChannel;
type NdcPeerConnection = nodeDataChannel.PeerConnection;

if (process.env.ANTIPHON_RTC_LOG) {
  nodeDataChannel.initLogger(
    (process.env.ANTIPHON_RTC_LOG as nodeDataChannel.LogLevel) ?? "Info",
    (level, message) => console.error(`[rtc:${level}] ${message}`),
  );
}

const ACK_INTERVAL_MS = 2_000;
const TIME_SYNC_INTERVAL_MS = 5_000;
/** Stop pushing into a channel above this buffered amount (bytes). */
const HIGH_WATERMARK = 1 << 20;
const LOW_WATERMARK = 256 * 1024;

export interface IngestCallbacks {
  /** Relay a local ICE candidate to the peer via the control plane. */
  onLocalCandidate(peerId: string, candidate: string, mid: string): void;
  /** Surface a fatal protocol condition on the control plane (§11). */
  onFatal(peerId: string, code: string, message: string): void;
}

interface PeerLink {
  pc: NdcPeerConnection;
  /** Recorder data channel (antiphon/1) once open. */
  dataChannel: DataChannel | null;
  /** Desk sync channel (antiphon-sync/1) once open. */
  syncChannel: DataChannel | null;
  timeSync: TimeSyncSession;
  /** Chunk keys queued for sink→sink push, oldest first. */
  pushQueue: Array<{ takeId: string; streamId: string; seq: number }>;
  pushing: boolean;
  closed: boolean;
}

interface ChunkMetaJson {
  takeId: string;
  streamId: string;
  seq: number;
  firstSampleIndex: number;
  sampleCount: number;
  captureTsUs: number;
  crc32c: number;
  payloadLen: number;
  chwm: number;
  detail?: Record<string, number>;
}

interface RangeListJson {
  takeId: string;
  streamId: string;
  ranges: Array<[number, number]>;
}

export class SessionIngest {
  private engine: SinkEngine | null = null;
  private readonly peers = new Map<string, PeerLink>();
  private chain: Promise<void> = Promise.resolve();
  private ackTimer: NodeJS.Timeout | null = null;
  private timeSyncTimer: NodeJS.Timeout | null = null;
  private closed = false;
  /** Streams whose seq-0 header has been applied to the streams table. */
  private readonly headerApplied = new Set<string>();
  private readonly knownTakes = new Set<string>();
  private readonly knownStreams = new Set<string>();

  readonly sessionId: string;
  private readonly archive: Archive;
  private readonly callbacks: IngestCallbacks;

  constructor(sessionId: string, archive: Archive, callbacks: IngestCallbacks) {
    this.sessionId = sessionId;
    this.archive = archive;
    this.callbacks = callbacks;
  }

  /** Rebuild receiver state from durable storage (RFC §8): the server
   * rejoins its own archive as if it had merely been disconnected. */
  async init(): Promise<void> {
    await initWasm();
    const engine = new SinkEngine();
    const state = await this.archive.loadSessionState(this.sessionId);
    for (const chunk of state.chunks) {
      engine.rebuild_chunk(
        uuidBytes(chunk.takeId),
        uuidBytes(chunk.streamId),
        chunk.seq,
        chunk.crc32c,
        chunk.firstSampleIndex,
        chunk.sampleCount,
        chunk.payloadLen,
      );
      this.knownTakes.add(chunk.takeId);
      this.knownStreams.add(chunk.streamId);
    }
    for (const stream of state.streams) {
      this.knownStreams.add(stream.id);
      this.knownTakes.add(stream.takeId);
      if (stream.finalSeq !== null) {
        engine.set_final_seq(uuidBytes(stream.takeId), uuidBytes(stream.id), stream.finalSeq);
      }
      if (stream.sampleRate !== null) this.headerApplied.add(stream.id);
    }
    for (const gap of state.gaps) {
      const stream = state.streams.find((s) => s.id === gap.streamId);
      if (stream) {
        engine.rebuild_gap(
          uuidBytes(stream.takeId),
          uuidBytes(gap.streamId),
          gap.startSeq,
          gap.endSeq,
        );
      }
    }
    this.engine = engine;
    this.ackTimer = setInterval(() => this.enqueue(() => this.sendAcks()), ACK_INTERVAL_MS);
    this.timeSyncTimer = setInterval(() => this.sendTimePings(), TIME_SYNC_INTERVAL_MS);
  }

  status(): string {
    return this.engine?.status_json() ?? "[]";
  }

  connectedPeerIds(): string[] {
    return [...this.peers.keys()];
  }

  // ---- signaling-driven connection lifecycle ---------------------------

  /** Peer sent an SDP offer addressed to the server sink. Returns the
   * answer SDP once available. */
  async handleOffer(peerId: string, sdp: string): Promise<{ sdp: string; type: string }> {
    this.closePeer(peerId);
    const pc = new PeerConnection(`antiphon-${peerId.slice(0, 8)}`, { iceServers: [] });
    const link: PeerLink = {
      pc,
      dataChannel: null,
      syncChannel: null,
      timeSync: new TimeSyncSession(),
      pushQueue: [],
      pushing: false,
      closed: false,
    };
    this.peers.set(peerId, link);

    pc.onLocalCandidate((candidate, mid) => {
      if (!link.closed) this.callbacks.onLocalCandidate(peerId, candidate, mid);
    });
    pc.onDataChannel((dc) => this.attachChannel(peerId, link, dc));
    pc.onStateChange((state) => {
      if ((state === "closed" || state === "failed") && !link.closed) {
        this.closePeer(peerId);
      }
    });

    const answer = new Promise<{ sdp: string; type: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("answer timeout")), 10_000);
      pc.onLocalDescription((sdp, type) => {
        clearTimeout(timeout);
        resolve({ sdp, type });
      });
    });
    pc.setRemoteDescription(sdp, "offer");
    return await answer;
  }

  addRemoteCandidate(peerId: string, candidate: string, mid: string): void {
    try {
      this.peers.get(peerId)?.pc.addRemoteCandidate(candidate, mid);
    } catch {
      // Late/malformed candidates after close are routine noise.
    }
  }

  closePeer(peerId: string): void {
    const link = this.peers.get(peerId);
    if (!link) return;
    link.closed = true;
    this.peers.delete(peerId);
    try {
      link.dataChannel?.close();
      link.syncChannel?.close();
      link.pc.close();
    } catch {
      // teardown races are fine
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.ackTimer) clearInterval(this.ackTimer);
    if (this.timeSyncTimer) clearInterval(this.timeSyncTimer);
    for (const peerId of [...this.peers.keys()]) this.closePeer(peerId);
    await this.chain.catch(() => {});
  }

  // ---- control-plane inputs --------------------------------------------

  /** take-start seen on the control plane. */
  noteTake(takeId: string, wallClockHint?: string): void {
    this.enqueue(async () => {
      await this.archive.ensureTake(this.sessionId, takeId, wallClockHint);
      this.knownTakes.add(takeId);
    });
  }

  /** take-stop: §6.4 — ACK immediately on take close. */
  noteTakeStop(takeId: string): void {
    this.enqueue(async () => {
      await this.archive.stopTake(takeId);
      await this.sendAcks();
    });
  }

  noteStream(takeId: string, streamId: string, peerId?: string): void {
    this.enqueue(async () => {
      await this.ensureStreamPersisted(takeId, streamId, peerId);
    });
  }

  setFinalSeq(takeId: string, streamId: string, finalSeq: number): void {
    this.enqueue(async () => {
      await this.ensureStreamPersisted(takeId, streamId);
      this.engine?.set_final_seq(uuidBytes(takeId), uuidBytes(streamId), finalSeq);
      await this.archive.setFinalSeq(streamId, finalSeq);
      await this.sendAcks();
    });
  }

  // ---- data plane ---------------------------------------------------------

  private attachChannel(peerId: string, link: PeerLink, dc: DataChannel): void {
    const label = dc.getLabel();
    if (label === CHANNEL_LABELS.data) link.dataChannel = dc;
    else if (label === CHANNEL_LABELS.sync) link.syncChannel = dc;
    else {
      dc.close();
      return;
    }
    dc.setBufferedAmountLowThreshold(LOW_WATERMARK);
    dc.onBufferedAmountLow(() => this.drainPushQueue(link));
    dc.onMessage((msg) => {
      const bytes = toBytes(msg);
      if (bytes) this.enqueue(() => this.processFrame(peerId, link, dc, bytes));
    });
    dc.onOpen(() => {
      // §6.4: ACK immediately on (re)connect; sinks also announce HAVEs on
      // the sync channel so diff push starts without waiting.
      this.enqueue(async () => {
        await this.sendAcksTo(dc);
        if (label === CHANNEL_LABELS.sync) this.sendHaves(dc);
      });
    });
    // node-datachannel may deliver onDataChannel after the channel is
    // already open; fire the open path once explicitly if so.
    if (dc.isOpen()) {
      this.enqueue(async () => {
        await this.sendAcksTo(dc);
        if (label === CHANNEL_LABELS.sync) this.sendHaves(dc);
      });
    }
  }

  private async processFrame(
    peerId: string,
    link: PeerLink,
    dc: DataChannel,
    bytes: Uint8Array,
  ): Promise<void> {
    const engine = this.engine;
    if (!engine || this.closed) return;
    const result = engine.ingest(bytes, nowUs());
    const kind = result.kind;
    try {
      switch (kind) {
        case "stored":
        case "continuity": {
          const meta = JSON.parse(result.json) as ChunkMetaJson;
          await this.ensureStreamPersisted(meta.takeId, meta.streamId);
          if (meta.seq === 0) await this.applyHeader(meta.streamId, bytes);
          await this.archive.persistChunk(meta, bytes);
          if (kind === "continuity") {
            await this.archive.flagStream(meta.streamId);
            this.callbacks.onFatal(
              peerId,
              "stream-discontinuity",
              `stream ${meta.streamId} seq ${meta.seq}: first_sample_index mismatch`,
            );
          }
          // Live tee toward the other sink(s): the desk gets recorder chunks
          // as they land; recorders never receive tees.
          this.teeToSyncPeers(peerId, meta, bytes);
          break;
        }
        case "duplicate":
          break;
        case "gap-report": {
          const list = JSON.parse(result.json) as RangeListJson;
          await this.ensureStreamPersisted(list.takeId, list.streamId);
          await this.archive.persistGaps(list.streamId, list.ranges);
          break;
        }
        case "time-ping": {
          const reply = result.reply;
          if (reply) safeSend(dc, reply);
          break;
        }
        case "time-pong": {
          link.timeSync.handle_pong(bytes, nowUs());
          break;
        }
        case "have": {
          // Sink↔sink: push whatever we hold that they lack (§6.8).
          const plan = JSON.parse(engine.plan_push(bytes)) as RangeListJson;
          this.queuePush(link, plan);
          break;
        }
        case "backfill": {
          const list = JSON.parse(result.json) as RangeListJson;
          this.queuePush(link, list);
          break;
        }
        case "fatal-crc": {
          const meta = JSON.parse(result.json) as ChunkMetaJson;
          await this.archive.flagStream(meta.streamId);
          this.callbacks.onFatal(
            peerId,
            "chunk-key-conflict",
            `stream ${meta.streamId} seq ${meta.seq}: duplicate key with different payload`,
          );
          break;
        }
        case "ignored": {
          // Experimental frames (0x80–0xFF, e.g. live METER telemetry) are
          // not protocol state, but the desk wants them even when its P2P
          // leg to the recorder failed: tee recorder→sync, fire-and-forget.
          if (link.dataChannel === dc) this.teeRawToSyncPeers(peerId, bytes);
          break;
        }
        case "corrupt":
        case "ack":
        case "discard":
          break;
        default:
          break;
      }
    } finally {
      result.free();
    }
  }

  private async applyHeader(streamId: string, frameBytes: Uint8Array): Promise<void> {
    if (this.headerApplied.has(streamId)) return;
    try {
      const { extract_chunk_payload } = await import("@antiphon/core-wasm");
      const header = JSON.parse(stream_header_json(extract_chunk_payload(frameBytes))) as {
        sampleRate: number;
        bitsPerSample: number;
        channels: number;
        deviceDesc: string;
        clockEpochUs: number;
        wallClockHintMs: number;
      };
      await this.archive.applyStreamHeader(streamId, header);
      this.headerApplied.add(streamId);
    } catch {
      // A malformed header payload is a recorder bug; the chunk itself is
      // still archived verbatim.
    }
  }

  private async ensureStreamPersisted(
    takeId: string,
    streamId: string,
    peerId?: string,
  ): Promise<void> {
    if (!this.knownTakes.has(takeId)) {
      await this.archive.ensureTake(this.sessionId, takeId);
      this.knownTakes.add(takeId);
    }
    if (!this.knownStreams.has(streamId) || peerId) {
      await this.archive.ensureStream(takeId, streamId, peerId);
      this.knownStreams.add(streamId);
    }
  }

  // ---- outbound -----------------------------------------------------------

  private async sendAcks(): Promise<void> {
    if (!this.engine || this.closed) return;
    for (const link of this.peers.values()) {
      const dc = link.dataChannel ?? link.syncChannel;
      if (dc?.isOpen()) await this.sendAcksTo(dc);
    }
  }

  private async sendAcksTo(dc: DataChannel): Promise<void> {
    if (!this.engine) return;
    for (const ack of this.engine.ack_frames()) {
      safeSend(dc, ack as Uint8Array);
    }
  }

  private sendHaves(dc: DataChannel): void {
    if (!this.engine) return;
    for (const have of this.engine.have_frames()) {
      safeSend(dc, have as Uint8Array);
    }
  }

  /** Best-effort raw tee (telemetry): dropped without retry under pressure. */
  private teeRawToSyncPeers(sourcePeerId: string, bytes: Uint8Array): void {
    for (const [peerId, link] of this.peers) {
      if (peerId === sourcePeerId) continue;
      const dc = link.syncChannel;
      if (dc?.isOpen() && dc.bufferedAmount() < LOW_WATERMARK) safeSend(dc, bytes);
    }
  }

  private teeToSyncPeers(sourcePeerId: string, meta: ChunkMetaJson, bytes: Uint8Array): void {
    for (const [peerId, link] of this.peers) {
      if (peerId === sourcePeerId) continue;
      const dc = link.syncChannel;
      if (!dc?.isOpen()) continue;
      if (dc.bufferedAmount() > HIGH_WATERMARK) {
        // Skip the live tee under pressure; HAVE reconciliation fills in.
        link.pushQueue.push({ takeId: meta.takeId, streamId: meta.streamId, seq: meta.seq });
        this.drainPushQueue(link);
        continue;
      }
      safeSend(dc, bytes);
    }
  }

  private queuePush(link: PeerLink, plan: RangeListJson): void {
    for (const [start, end] of plan.ranges) {
      for (let seq = start; seq <= end; seq++) {
        link.pushQueue.push({ takeId: plan.takeId, streamId: plan.streamId, seq });
      }
    }
    this.drainPushQueue(link);
  }

  private drainPushQueue(link: PeerLink): void {
    if (link.pushing || link.closed) return;
    link.pushing = true;
    void (async () => {
      try {
        const dc = link.syncChannel ?? link.dataChannel;
        while (dc?.isOpen() && link.pushQueue.length > 0) {
          if (dc.bufferedAmount() > HIGH_WATERMARK) return; // resume on low
          const next = link.pushQueue.shift();
          if (!next) return;
          try {
            const frame = await this.archive.getFrameBytes(next.takeId, next.streamId, next.seq);
            safeSend(dc, frame);
          } catch {
            // Blob missing (e.g. gap seq requested): nothing to push.
          }
        }
      } finally {
        link.pushing = false;
      }
    })();
  }

  private sendTimePings(): void {
    for (const link of this.peers.values()) {
      const dc = link.dataChannel;
      if (dc?.isOpen()) safeSend(dc, link.timeSync.ping(nowUs()));
    }
  }

  /** Serialize ingest work; poison-and-rebuild on persistence failure. */
  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch(async (error) => {
      console.error(`[ingest ${this.sessionId}] persistence failure, rebuilding:`, error);
      for (const peerId of [...this.peers.keys()]) this.closePeer(peerId);
      this.headerApplied.clear();
      this.knownTakes.clear();
      this.knownStreams.clear();
      await this.init().catch((e) => {
        console.error(`[ingest ${this.sessionId}] rebuild failed; ingest offline:`, e);
        this.engine = null;
      });
    });
  }
}

function toBytes(msg: string | Buffer | ArrayBuffer): Uint8Array | null {
  if (typeof msg === "string") return null; // data plane is binary-only
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
  return new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
}

function safeSend(dc: DataChannel, bytes: Uint8Array): void {
  try {
    if (dc.isOpen()) dc.sendMessageBinary(bytes);
  } catch {
    // Channel died mid-send; reconnection reconciles.
  }
}

function nowUs(): number {
  return performance.now() * 1_000;
}
