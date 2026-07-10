// A recorder's DataChannel to one sink (server or desk): the SinkPort the
// capture controller drains into, channel wiring, and teardown.

import type { CaptureController, SinkPort } from "../audio/capture-controller";

const HIGH_WATERMARK = 1 << 20;
const LOW_WATERMARK = 256 * 1024;

export interface SinkLink {
  sinkId: number;
  targetPeerId: string;
  label: string;
  dispose: (() => void) | null;
  channel: RTCDataChannel | null;
  connecting: boolean;
}

export function newSinkLink(sinkId: number, targetPeerId: string, label: string): SinkLink {
  return { sinkId, targetPeerId, label, dispose: null, channel: null, connecting: false };
}

/** The transport port the capture controller drains frames into. */
export function createSinkPort(link: SinkLink, controller: CaptureController): SinkPort {
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
        controller.requestDrain(link.sinkId);
      }
    },
    budget: () => {
      const channel = link.channel;
      if (channel?.readyState !== "open") return 0;
      return Math.max(0, HIGH_WATERMARK - channel.bufferedAmount);
    },
  };
}

/** Adopt a freshly opened channel into the link: wire drain/inbound-frame
 * handlers and down detection, then tell the controller the sink is live. */
export function adoptSinkChannel(opts: {
  link: SinkLink;
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  dispose: () => void;
  controller: CaptureController;
  onDown: () => void;
}): void {
  const { link, pc, channel, dispose, controller, onDown } = opts;
  link.dispose = dispose;
  link.channel = channel;
  link.connecting = false;
  channel.bufferedAmountLowThreshold = LOW_WATERMARK;
  channel.addEventListener("bufferedamountlow", () => {
    controller.requestDrain(link.sinkId);
  });
  channel.addEventListener("message", (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      controller.deliverFrame(link.sinkId, ev.data);
    }
  });
  const down = () => {
    if (link.channel === channel) onDown();
  };
  channel.addEventListener("close", down);
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") down();
  });
  controller.setSinkConnected(link.sinkId, true);
  controller.requestDrain(link.sinkId);
}

export function teardownSinkLink(link: SinkLink, controller: CaptureController): void {
  controller.setSinkConnected(link.sinkId, false);
  link.dispose?.();
  link.dispose = null;
  link.channel = null;
  link.connecting = false;
}
