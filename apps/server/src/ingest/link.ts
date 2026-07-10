// Per-peer WebRTC transport: connection/channel setup, sink→sink push
// queues with backpressure, and live tees toward sync peers.

import { type SinkEngine, TimeSyncSession } from "@antiphon/core-wasm";
import nodeDataChannel from "node-datachannel";
import { createLogger, type Logger } from "../logger.ts";
import type { ChunkMetaJson, RangeListJson } from "./frames.ts";
import { CHANNEL_LABELS } from "./util.ts";

const { PeerConnection } = nodeDataChannel;
type DataChannel = nodeDataChannel.DataChannel;

const moduleLog = createLogger({ module: "ingest" });

/** Stop pushing into a channel above this buffered amount (bytes). */
export const HIGH_WATERMARK = 1 << 20;
export const LOW_WATERMARK = 256 * 1024;

export interface IngestCallbacks {
  /** Relay a local ICE candidate to the peer via the control plane. */
  onLocalCandidate(peerId: string, candidate: string, mid: string): void;
  /** Surface a fatal protocol condition on the control plane (§11). */
  onFatal(peerId: string, code: string, message: string): void;
}

export interface PeerLink {
  pc: nodeDataChannel.PeerConnection;
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

export interface LinkHost {
  readonly peers: Map<string, PeerLink>;
  readonly log: Logger;
  getFrame(takeId: string, streamId: string, seq: number): Promise<Uint8Array>;
}

export interface ChannelHost extends LinkHost {
  readonly callbacks: IngestCallbacks;
  engine(): SinkEngine | null;
  enqueue(task: () => Promise<void>): void;
  processFrame(peerId: string, link: PeerLink, dc: DataChannel, bytes: Uint8Array): Promise<void>;
  closePeer(peerId: string): void;
}

export async function sendAcksTo(engine: SinkEngine | null, dc: DataChannel): Promise<void> {
  if (!engine) return;
  for (const ack of engine.ack_frames()) {
    safeSend(dc, ack as Uint8Array);
  }
}

export function sendHaves(engine: SinkEngine | null, dc: DataChannel): void {
  if (!engine) return;
  for (const have of engine.have_frames()) {
    safeSend(dc, have as Uint8Array);
  }
}

/** Open a peer connection for an SDP offer addressed to the server sink;
 * resolves with the answer SDP. The empty ICE config is deliberate: the
 * server's host candidates are the whole story — node-datachannel exposes
 * no external-address (1:1 NAT) hint, so WEBRTC_PUBLIC_IP cannot be wired
 * here (createServer warns at boot; docs/deploy.md §5). */
export function openPeerLink(
  host: ChannelHost,
  peerId: string,
  sdp: string,
): Promise<{ sdp: string; type: string }> {
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
  host.peers.set(peerId, link);

  pc.onLocalCandidate((candidate, mid) => {
    if (!link.closed) host.callbacks.onLocalCandidate(peerId, candidate, mid);
  });
  pc.onDataChannel((dc) => attachChannel(host, peerId, link, dc));
  pc.onStateChange((state) => {
    if ((state === "closed" || state === "failed") && !link.closed) {
      host.closePeer(peerId);
    }
  });

  const answer = new Promise<{ sdp: string; type: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("answer timeout")), 10_000);
    pc.onLocalDescription((answerSdp, type) => {
      clearTimeout(timeout);
      resolve({ sdp: answerSdp, type });
    });
  });
  pc.setRemoteDescription(sdp, "offer");
  return answer;
}

function attachChannel(host: ChannelHost, peerId: string, link: PeerLink, dc: DataChannel): void {
  const label = dc.getLabel();
  if (label === CHANNEL_LABELS.data) link.dataChannel = dc;
  else if (label === CHANNEL_LABELS.sync) link.syncChannel = dc;
  else {
    dc.close();
    return;
  }
  dc.setBufferedAmountLowThreshold(LOW_WATERMARK);
  dc.onBufferedAmountLow(() => drainPushQueue(host, link));
  dc.onMessage((msg) => {
    const bytes = toBytes(msg);
    if (bytes) host.enqueue(() => host.processFrame(peerId, link, dc, bytes));
  });
  const announce = () => {
    // §6.4: ACK immediately on (re)connect; sinks also announce HAVEs on
    // the sync channel so diff push starts without waiting.
    host.enqueue(async () => {
      await sendAcksTo(host.engine(), dc);
      if (label === CHANNEL_LABELS.sync) sendHaves(host.engine(), dc);
    });
  };
  dc.onOpen(announce);
  // node-datachannel may deliver onDataChannel after the channel is
  // already open; fire the open path once explicitly if so.
  if (dc.isOpen()) announce();
}

/** Best-effort raw tee (telemetry): dropped without retry under pressure. */
export function teeRawToSyncPeers(host: LinkHost, sourcePeerId: string, bytes: Uint8Array): void {
  for (const [peerId, link] of host.peers) {
    if (peerId === sourcePeerId) continue;
    const dc = link.syncChannel;
    if (dc?.isOpen() && dc.bufferedAmount() < LOW_WATERMARK) safeSend(dc, bytes);
  }
}

export function teeToSyncPeers(
  host: LinkHost,
  sourcePeerId: string,
  meta: ChunkMetaJson,
  bytes: Uint8Array,
): void {
  for (const [peerId, link] of host.peers) {
    if (peerId === sourcePeerId) continue;
    const dc = link.syncChannel;
    if (!dc?.isOpen()) continue;
    if (dc.bufferedAmount() > HIGH_WATERMARK) {
      // Skip the live tee under pressure; HAVE reconciliation fills in.
      link.pushQueue.push({ takeId: meta.takeId, streamId: meta.streamId, seq: meta.seq });
      drainPushQueue(host, link);
      continue;
    }
    safeSend(dc, bytes);
  }
}

export function queuePush(host: LinkHost, link: PeerLink, plan: RangeListJson): void {
  for (const [start, end] of plan.ranges) {
    for (let seq = start; seq <= end; seq++) {
      link.pushQueue.push({ takeId: plan.takeId, streamId: plan.streamId, seq });
    }
  }
  drainPushQueue(host, link);
}

export function drainPushQueue(host: LinkHost, link: PeerLink): void {
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
          const frame = await host.getFrame(next.takeId, next.streamId, next.seq);
          safeSend(dc, frame);
        } catch (error) {
          // Blob missing (e.g. gap seq requested): nothing to push.
          host.log.debug("push skipped; frame blob unavailable", { ...next, error });
        }
      }
    } finally {
      link.pushing = false;
    }
  })();
}

export function toBytes(msg: string | Buffer | ArrayBuffer): Uint8Array | null {
  if (typeof msg === "string") return null; // data plane is binary-only
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
  return new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
}

export function safeSend(dc: DataChannel, bytes: Uint8Array): void {
  try {
    if (dc.isOpen()) dc.sendMessageBinary(bytes);
  } catch (error) {
    // Channel died mid-send; reconnection reconciles.
    moduleLog.debug("datachannel send failed", { bytes: bytes.byteLength, error });
  }
}

export function nowUs(): number {
  return performance.now() * 1_000;
}
