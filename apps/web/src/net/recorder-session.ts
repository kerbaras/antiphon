// Recorder-side session orchestration: signaling + a DataChannel to every
// reachable sink (server always, desk when ICE allows) + the capture
// pipeline. Transport state NEVER gates capture (§7.1): take-start arms the
// worker immediately; channels catch up whenever they can.

import { SERVER_PEER_ID, type SignalingMessage } from "@antiphon/protocol";
import type { CaptureController, SinkPort } from "../audio/capture-controller";
import { uuidToBytes } from "../audio/capture-controller";
import { getNickname, normalizeNickname, setNickname } from "./device-identity";
import { offerChannel } from "./rtc";
import { type FatalSignalingError, SignalingClient } from "./signaling-client";

export const SINK_SERVER = 0;
export const SINK_DESK = 1;

const HIGH_WATERMARK = 1 << 20;
const LOW_WATERMARK = 256 * 1024;
const TIME_SYNC_INTERVAL_MS = 5_000;
const RECONNECT_DELAY_MS = 2_000;

interface SinkLink {
  sinkId: number;
  targetPeerId: string;
  label: string;
  dispose: (() => void) | null;
  channel: RTCDataChannel | null;
  connecting: boolean;
  wanted: boolean;
}

/** Alternate identity for an embedded recorder (the desk's hardware input,
 * W2-D). Omitted = phone defaults: persisted nickname + browser deviceId. */
export interface RecorderIdentity {
  /** Stable A12 deviceId this recorder joins with. */
  deviceId: string;
  /** Initial lane label (nickname). */
  label: string | null;
  /** Where renames (self- or desk-initiated, A13) persist. */
  persistLabel: (label: string) => void;
}

export interface RecorderSessionState {
  signalingConnected: boolean;
  peerId: string | null;
  /** Our nickname (persisted; the desk may rename us via peer-update). */
  label: string | null;
  serverLink: "connected" | "connecting" | "down";
  deskLink: "connected" | "connecting" | "down" | "absent";
  activeTakeId: string | null;
  streamId: string | null;
  outageUntil: number | null;
  /** A take is rolling but the desk disarmed this lane — we sit it out. */
  sittingOut: boolean;
  /** Terminal control-plane halt (F3): superseded / session-deleted / caps.
   * Capture is stopped and every transport is down; the only exit is a
   * deliberate takeOver() (or leaving the page). */
  fatal: FatalSignalingError | null;
}

type Listener = (state: RecorderSessionState) => void;

export class RecorderSession {
  private readonly signaling: SignalingClient;
  private readonly controller: CaptureController;
  private readonly persistLabel: (label: string) => void;
  private readonly links = new Map<number, SinkLink>();
  private readonly listeners = new Set<Listener>();
  private timeSyncTimer: number | null = null;
  private outageUntil: number | null = null;
  private activeTakeId: string | null = null;
  private streamId: string | null = null;
  private sittingOutTakeId: string | null = null;
  private stoppedForFinal: { takeId: string; streamId: string } | null = null;
  /** Latch so the fatal teardown runs once per halt (state fires often). */
  private fatalHandled = false;

  constructor(sessionId: string, controller: CaptureController, identity?: RecorderIdentity) {
    this.controller = controller;
    this.persistLabel = identity ? identity.persistLabel : setNickname;
    this.signaling = new SignalingClient(
      "recorder",
      sessionId,
      identity ? identity.label : getNickname(),
      identity?.deviceId ?? null,
    );
  }

  start(): void {
    this.signaling.onMessage((msg) => this.onSignal(msg));
    this.signaling.onState(() => {
      if (this.signaling.state.fatal && !this.fatalHandled) {
        this.fatalHandled = true;
        this.haltForFatal();
      }
      if (this.signaling.state.connected) this.ensureLinks();
      this.publish();
    });
    this.signaling.connect();
    this.timeSyncTimer = window.setInterval(() => {
      for (const link of this.links.values()) {
        if (link.channel?.readyState === "open") {
          this.controller.sendTimePing(link.sinkId);
        }
      }
    }, TIME_SYNC_INTERVAL_MS);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): RecorderSessionState {
    const linkState = (sinkId: number): "connected" | "connecting" | "down" => {
      const link = this.links.get(sinkId);
      if (link?.channel?.readyState === "open") return "connected";
      if (link?.connecting) return "connecting";
      return "down";
    };
    return {
      signalingConnected: this.signaling.state.connected,
      peerId: this.signaling.state.peerId,
      label: this.signaling.label,
      serverLink: linkState(SINK_SERVER),
      deskLink: this.deskPeerId() ? linkState(SINK_DESK) : "absent",
      activeTakeId: this.activeTakeId,
      streamId: this.streamId,
      outageUntil: this.outageUntil,
      sittingOut: this.sittingOutTakeId !== null,
      fatal: this.signaling.state.fatal,
    };
  }

  /** Fatal control error (F3): this connection is terminally dead — most
   * likely our own deviceId reconnected in another tab (A12 supersede).
   * STOP everything: no reconnect (the SignalingClient already halted), no
   * data-plane trickle from still-open channels, and no hot mic in a tab
   * that can no longer deliver audio anywhere — release it (and the wake
   * lock) so the successor tab can grab the hardware. */
  private haltForFatal(): void {
    this.activeTakeId = null;
    this.streamId = null;
    this.sittingOutTakeId = null;
    this.stoppedForFinal = null;
    for (const link of this.links.values()) this.teardownLink(link);
    // Links are rebuilt (and their sinks re-attached to the fresh worker)
    // from scratch on takeOver(); stale entries would skip attachSink.
    this.links.clear();
    void this.controller.teardown();
  }

  /** Deliberate re-join after a fatal supersede ("Take over in this tab"):
   * reopens signaling under the same device identity, which supersedes the
   * OTHER tab — exactly what the user asked for. The caller must restart
   * the capture pipeline first (mic re-acquisition needs the user gesture). */
  takeOver(): void {
    if (!this.signaling.state.fatal) return;
    this.fatalHandled = false;
    this.signaling.reopen();
    this.publish();
  }

  /** Rename ourselves (A13): persist locally, carry on future hellos, and
   * tell the room when connected. Empty clears back to the device name.
   * Normalized at THIS commit point (48-char cap, surrogate-safe) so
   * paste/programmatic paths can't outrun the input's maxLength. */
  rename(label: string): void {
    const trimmed = normalizeNickname(label);
    this.persistLabel(trimmed);
    this.signaling.label = trimmed || null;
    const me = this.signaling.state.peerId;
    if (this.signaling.state.connected && me) {
      this.signaling.send({ v: 1, type: "peer-update", peerId: me, label: trimmed });
    }
    this.publish();
  }

  /** Demo/testing hook: kill every transport for `ms`. Capture continues;
   * reconnect + backfill happen automatically afterwards (the M1 story). */
  simulateOutage(ms: number): void {
    this.outageUntil = Date.now() + ms;
    for (const link of this.links.values()) this.teardownLink(link);
    this.publish();
    window.setTimeout(() => {
      this.outageUntil = null;
      this.ensureLinks();
      this.publish();
    }, ms);
  }

  private deskPeerId(): string | null {
    const peers = this.signaling.state.session?.peers ?? [];
    return peers.find((p) => p.role === "desk")?.peerId ?? null;
  }

  private onSignal(msg: SignalingMessage): void {
    switch (msg.type) {
      case "welcome": {
        this.ensureLinks();
        const active = msg.session.activeTake;
        if (active && this.activeTakeId !== active.takeId) {
          if (this.isDisarmed(active.disarmedPeerIds)) this.sittingOutTakeId = active.takeId;
          else this.armForTake(active.takeId);
        }
        break;
      }
      case "peer-status":
        this.ensureLinks();
        break;
      case "peer-update":
        // The desk renamed us: adopt + persist so the name survives reloads.
        // Normalized on adoption too — the wire allows 256 (A13), the UI
        // norm is 48, and every commit path must agree.
        if (msg.peerId === this.signaling.state.peerId) {
          const adopted = normalizeNickname(msg.label);
          this.persistLabel(adopted);
          this.signaling.label = adopted || null;
        }
        break;
      case "take-start":
        if (this.activeTakeId === msg.takeId) break;
        // Desk disarmed this lane: capture stays idle for this take, but
        // the session keeps flowing (next take re-arms normally).
        if (this.isDisarmed(msg.disarmedPeerIds)) this.sittingOutTakeId = msg.takeId;
        else this.armForTake(msg.takeId);
        break;
      case "take-stop":
        if (this.sittingOutTakeId === msg.takeId) this.sittingOutTakeId = null;
        if (this.activeTakeId === msg.takeId) this.stopTake();
        break;
      default:
        break;
    }
    this.publish();
  }

  private isDisarmed(disarmedPeerIds: string[] | undefined): boolean {
    const me = this.signaling.state.peerId;
    return me !== null && (disarmedPeerIds?.includes(me) ?? false);
  }

  private armForTake(takeId: string): void {
    const streamId = crypto.randomUUID();
    this.sittingOutTakeId = null;
    this.activeTakeId = takeId;
    this.streamId = streamId;
    // The worker replays registered sinks + connectivity into each fresh
    // per-take engine, so links registered before arm are already wired.
    this.controller.arm({
      takeId: uuidToBytes(takeId),
      streamId: uuidToBytes(streamId),
      retainLocal: false,
    });
    this.signaling.send({ v: 1, type: "stream-announce", takeId, streamId });
    this.publish();
  }

  private stopTake(): void {
    if (!this.activeTakeId || !this.streamId) return;
    this.stoppedForFinal = { takeId: this.activeTakeId, streamId: this.streamId };
    this.controller.stopTake();
    this.activeTakeId = null;
    this.publish();
  }

  /** Called by the page when the worker reports the final seq. */
  notifyFinal(finalSeq: number): void {
    if (!this.stoppedForFinal) return;
    this.signaling.send({
      v: 1,
      type: "stream-final",
      takeId: this.stoppedForFinal.takeId,
      streamId: this.stoppedForFinal.streamId,
      finalSeq,
    });
    this.stoppedForFinal = null;
  }

  private ensureLinks(): void {
    if (this.outageUntil && Date.now() < this.outageUntil) return;
    if (!this.signaling.state.connected) return;
    this.ensureLink(SINK_SERVER, SERVER_PEER_ID, "antiphon/1");
    const deskId = this.deskPeerId();
    if (deskId) {
      const existing = this.links.get(SINK_DESK);
      if (existing && existing.targetPeerId !== deskId) {
        // Desk reconnected under a new peer id.
        this.teardownLink(existing);
        this.links.delete(SINK_DESK);
      }
      this.ensureLink(SINK_DESK, deskId, "antiphon/1");
    }
  }

  private ensureLink(sinkId: number, targetPeerId: string, label: string): void {
    let link = this.links.get(sinkId);
    if (!link) {
      link = {
        sinkId,
        targetPeerId,
        label,
        dispose: null,
        channel: null,
        connecting: false,
        wanted: true,
      };
      this.links.set(sinkId, link);
      this.controller.attachSink(sinkId, this.portFor(link));
    }
    if (link.connecting || link.channel?.readyState === "open") return;
    link.connecting = true;
    this.publish();
    void offerChannel(this.signaling, targetPeerId, label)
      .then(({ pc, channel, dispose }) => {
        link.dispose = dispose;
        link.channel = channel;
        link.connecting = false;
        channel.bufferedAmountLowThreshold = LOW_WATERMARK;
        channel.addEventListener("bufferedamountlow", () => {
          this.controller.requestDrain(sinkId);
        });
        channel.addEventListener("message", (ev) => {
          if (ev.data instanceof ArrayBuffer) {
            this.controller.deliverFrame(sinkId, ev.data);
          }
        });
        const onDown = () => {
          if (link.channel === channel) this.linkDown(link);
        };
        channel.addEventListener("close", onDown);
        pc.addEventListener("connectionstatechange", () => {
          if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
            onDown();
          }
        });
        this.controller.setSinkConnected(sinkId, true);
        this.controller.requestDrain(sinkId);
        this.publish();
      })
      .catch(() => {
        // Silent by design: the link state is surfaced on the phone page
        // (server/desk sink "down") and this retry loop re-offers every
        // ~2 s while the sink is unreachable — logging would just spam.
        link.connecting = false;
        this.controller.setSinkConnected(sinkId, false);
        this.publish();
        window.setTimeout(() => this.ensureLinks(), RECONNECT_DELAY_MS);
      });
  }

  private linkDown(link: SinkLink): void {
    this.teardownLink(link);
    this.publish();
    window.setTimeout(() => this.ensureLinks(), RECONNECT_DELAY_MS);
  }

  private teardownLink(link: SinkLink): void {
    this.controller.setSinkConnected(link.sinkId, false);
    link.dispose?.();
    link.dispose = null;
    link.channel = null;
    link.connecting = false;
  }

  private portFor(link: SinkLink): SinkPort {
    return {
      send: (frames) => {
        const channel = link.channel;
        if (channel?.readyState !== "open") return;
        for (const frame of frames) {
          try {
            channel.send(frame);
          } catch {
            return; // channel died mid-batch; reconnect path handles it
          }
        }
        // More might be waiting if the budget was the limiter.
        if (channel.bufferedAmount < LOW_WATERMARK) {
          this.controller.requestDrain(link.sinkId);
        }
      },
      budget: () => {
        const channel = link.channel;
        if (channel?.readyState !== "open") return 0;
        return Math.max(0, HIGH_WATERMARK - channel.bufferedAmount);
      },
    };
  }

  private publish(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  close(): void {
    if (this.timeSyncTimer !== null) window.clearInterval(this.timeSyncTimer);
    for (const link of this.links.values()) this.teardownLink(link);
    this.signaling.close();
  }
}
