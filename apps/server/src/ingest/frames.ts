// Inbound data-plane frame processing: one engine.ingest() result → the
// matching persistence / reply / tee action.

import { type SinkEngine, stream_header_json } from "@antiphon/core-wasm";
import type nodeDataChannel from "node-datachannel";
import type { Archive } from "../archive/index.ts";
import {
  type IngestCallbacks,
  type LinkHost,
  nowUs,
  type PeerLink,
  queuePush,
  safeSend,
  teeRawToSyncPeers,
  teeToSyncPeers,
} from "./link.ts";

type DataChannel = nodeDataChannel.DataChannel;

export interface ChunkMetaJson {
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

export interface RangeListJson {
  takeId: string;
  streamId: string;
  ranges: Array<[number, number]>;
}

export interface FrameHost extends LinkHost {
  readonly sessionId: string;
  readonly archive: Archive;
  readonly callbacks: IngestCallbacks;
  readonly knownTakes: Set<string>;
  readonly knownStreams: Set<string>;
  /** Streams whose seq-0 header has been applied to the streams table. */
  readonly headerApplied: Set<string>;
}

export async function ensureStreamPersisted(
  host: FrameHost,
  takeId: string,
  streamId: string,
  peerId?: string,
): Promise<void> {
  if (!host.knownTakes.has(takeId)) {
    await host.archive.ensureTake(host.sessionId, takeId);
    host.knownTakes.add(takeId);
  }
  if (!host.knownStreams.has(streamId) || peerId) {
    await host.archive.ensureStream(takeId, streamId, peerId);
    host.knownStreams.add(streamId);
  }
}

async function applyHeader(host: FrameHost, streamId: string, frameBytes: Uint8Array) {
  if (host.headerApplied.has(streamId)) return;
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
    await host.archive.applyStreamHeader(streamId, header);
    host.headerApplied.add(streamId);
  } catch (error) {
    // A malformed header payload is a recorder bug; the chunk itself is
    // still archived verbatim.
    host.log.warn("malformed seq-0 stream header; chunk archived verbatim", { streamId, error });
  }
}

export async function processFrame(
  host: FrameHost,
  engine: SinkEngine,
  peerId: string,
  link: PeerLink,
  dc: DataChannel,
  bytes: Uint8Array,
): Promise<void> {
  const result = engine.ingest(bytes, nowUs());
  const kind = result.kind;
  try {
    switch (kind) {
      case "stored":
      case "continuity": {
        const meta = JSON.parse(result.json) as ChunkMetaJson;
        await ensureStreamPersisted(host, meta.takeId, meta.streamId);
        if (meta.seq === 0) await applyHeader(host, meta.streamId, bytes);
        await host.archive.persistChunk(meta, bytes);
        if (kind === "continuity") {
          await host.archive.flagStream(meta.streamId);
          host.callbacks.onFatal(
            peerId,
            "stream-discontinuity",
            `stream ${meta.streamId} seq ${meta.seq}: first_sample_index mismatch`,
          );
        }
        // Live tee toward the other sink(s): the desk gets recorder chunks
        // as they land; recorders never receive tees.
        teeToSyncPeers(host, peerId, meta, bytes);
        break;
      }
      case "duplicate":
        break;
      case "gap-report": {
        const list = JSON.parse(result.json) as RangeListJson;
        await ensureStreamPersisted(host, list.takeId, list.streamId);
        await host.archive.persistGaps(list.streamId, list.ranges);
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
        queuePush(host, link, plan);
        break;
      }
      case "backfill": {
        const list = JSON.parse(result.json) as RangeListJson;
        queuePush(host, link, list);
        break;
      }
      case "fatal-crc": {
        const meta = JSON.parse(result.json) as ChunkMetaJson;
        await host.archive.flagStream(meta.streamId);
        host.callbacks.onFatal(
          peerId,
          "chunk-key-conflict",
          `stream ${meta.streamId} seq ${meta.seq}: duplicate key with different payload`,
        );
        break;
      }
      case "ignored": {
        // Experimental frames (0x80–0xFF, e.g. live METER telemetry) are not
        // protocol state, but the desk wants them even when its P2P leg to
        // the recorder failed: tee recorder→sync, fire-and-forget.
        if (link.dataChannel === dc) teeRawToSyncPeers(host, peerId, bytes);
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
