// Ingest: the server's sink. node-datachannel terminates DTLS/SCTP, the
// WASM SinkEngine makes every protocol decision, the Archive persists.
// Kept isolated: speaks only the chunk protocol + Archive (ARCHITECTURE §7).

import type { SinkEngine } from "@antiphon/core-wasm";
import nodeDataChannel from "node-datachannel";
import type { Archive } from "../archive/index.ts";
import { createLogger, type Logger } from "../logger.ts";
import { ensureStreamPersisted, type FrameHost, processFrame } from "./frames.ts";
import {
  type ChannelHost,
  type IngestCallbacks,
  nowUs,
  openPeerLink,
  type PeerLink,
  safeSend,
  sendAcksTo,
} from "./link.ts";
import { rebuildEngine } from "./rebuild.ts";
import { uuidBytes } from "./util.ts";

export type { IngestCallbacks } from "./link.ts";

type DataChannel = nodeDataChannel.DataChannel;

const moduleLog = createLogger({ module: "ingest" });

if (process.env.ANTIPHON_RTC_LOG) {
  nodeDataChannel.initLogger(
    (process.env.ANTIPHON_RTC_LOG as nodeDataChannel.LogLevel) ?? "Info",
    (level, message) => moduleLog.debug("rtc", { rtcLevel: level, message }),
  );
}

const ACK_INTERVAL_MS = 2_000;
const TIME_SYNC_INTERVAL_MS = 5_000;

export class SessionIngest {
  private engine: SinkEngine | null = null;
  private readonly peers = new Map<string, PeerLink>();
  private chain: Promise<void> = Promise.resolve();
  private ackTimer: NodeJS.Timeout | null = null;
  private timeSyncTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly headerApplied = new Set<string>();
  private readonly knownTakes = new Set<string>();
  private readonly knownStreams = new Set<string>();

  readonly sessionId: string;
  private readonly archive: Archive;
  private readonly callbacks: IngestCallbacks;
  private readonly log: Logger;
  private readonly host: ChannelHost & FrameHost;

  constructor(sessionId: string, archive: Archive, callbacks: IngestCallbacks) {
    this.sessionId = sessionId;
    this.archive = archive;
    this.callbacks = callbacks;
    this.log = moduleLog.child({ sessionId });
    this.host = {
      sessionId,
      peers: this.peers,
      log: this.log,
      archive: this.archive,
      callbacks: this.callbacks,
      knownTakes: this.knownTakes,
      knownStreams: this.knownStreams,
      headerApplied: this.headerApplied,
      engine: () => this.engine,
      getFrame: (takeId, streamId, seq) => this.archive.getFrameBytes(takeId, streamId, seq),
      enqueue: (task) => this.enqueue(task),
      processFrame: (peerId, link, dc, bytes) => this.processFrame(peerId, link, dc, bytes),
      closePeer: (peerId) => this.closePeer(peerId),
    };
  }

  async init(): Promise<void> {
    this.engine = await rebuildEngine(this.archive, this.sessionId, {
      takes: this.knownTakes,
      streams: this.knownStreams,
      headerApplied: this.headerApplied,
    });
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
    return await openPeerLink(this.host, peerId, sdp);
  }

  addRemoteCandidate(peerId: string, candidate: string, mid: string): void {
    try {
      this.peers.get(peerId)?.pc.addRemoteCandidate(candidate, mid);
    } catch (error) {
      // Late/malformed candidates after close are routine noise.
      this.log.debug("remote candidate rejected", { peerId, error });
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
    } catch (error) {
      // teardown races are fine
      this.log.debug("peer teardown race", { peerId, error });
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
      if (await this.archive.deleteTakeIfEmpty(takeId)) this.knownTakes.delete(takeId);
      await this.sendAcks();
    });
  }

  noteStream(takeId: string, streamId: string, peerId?: string): void {
    this.enqueue(async () => {
      await ensureStreamPersisted(this.host, takeId, streamId, peerId);
    });
  }

  setFinalSeq(takeId: string, streamId: string, finalSeq: number): void {
    this.enqueue(async () => {
      await ensureStreamPersisted(this.host, takeId, streamId);
      this.engine?.set_final_seq(uuidBytes(takeId), uuidBytes(streamId), finalSeq);
      await this.archive.setFinalSeq(streamId, finalSeq);
      await this.sendAcks();
    });
  }

  /** Desk-initiated stream deletion. Engine state goes first — the streams
   * vanish from ACK/HAVE traffic, so no peer can re-push them — then the
   * archive rows/blobs. On archive failure the chain poisons and rebuilds
   * from the database, which still holds the rows (nothing lost). */
  deleteStreams(refs: Array<{ takeId: string; streamId: string }>): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.enqueue(async () => {
        try {
          for (const ref of refs) {
            this.engine?.remove_stream(uuidBytes(ref.takeId), uuidBytes(ref.streamId));
            this.knownStreams.delete(ref.streamId);
            this.headerApplied.delete(ref.streamId);
          }
          const doomed = new Set(refs.map((r) => r.streamId));
          for (const link of this.peers.values()) {
            link.pushQueue = link.pushQueue.filter((q) => !doomed.has(q.streamId));
          }
          const deletedTakeIds = await this.archive.deleteStreams(refs);
          for (const takeId of deletedTakeIds) this.knownTakes.delete(takeId);
          resolve(deletedTakeIds);
        } catch (error) {
          reject(error);
          throw error;
        }
      });
    });
  }

  // ---- data plane ---------------------------------------------------------

  private async processFrame(
    peerId: string,
    link: PeerLink,
    dc: DataChannel,
    bytes: Uint8Array,
  ): Promise<void> {
    if (!this.engine || this.closed) return;
    await processFrame(this.host, this.engine, peerId, link, dc, bytes);
  }

  // ---- outbound -----------------------------------------------------------

  private async sendAcks(): Promise<void> {
    if (!this.engine || this.closed) return;
    for (const link of this.peers.values()) {
      const dc = link.dataChannel ?? link.syncChannel;
      if (dc?.isOpen()) await sendAcksTo(this.engine, dc);
    }
  }

  private sendTimePings(): void {
    for (const link of this.peers.values()) {
      const dc = link.dataChannel;
      if (dc?.isOpen()) safeSend(dc, link.timeSync.ping(nowUs()));
    }
  }

  /** Serialize ingest work on one promise chain; ACKs join the same chain,
   * so an ACK can never overtake persistence of a chunk it covers. On
   * failure: poison — drop channels, rebuild from the archive (fail-stop). */
  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch(async (error) => {
      this.log.error("persistence failure; rebuilding engine from archive", { error });
      for (const peerId of [...this.peers.keys()]) this.closePeer(peerId);
      this.headerApplied.clear();
      this.knownTakes.clear();
      this.knownStreams.clear();
      await this.init().catch((e: unknown) => {
        this.log.error("engine rebuild failed; ingest offline", { error: e });
        this.engine = null;
      });
    });
  }
}
