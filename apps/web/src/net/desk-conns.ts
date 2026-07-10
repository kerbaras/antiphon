// DeskSession's data-plane connections: answering recorder P2P offers
// (LAN path) and the desk→server sync channel, plus channel backpressure.

import { SERVER_PEER_ID } from "@antiphon/protocol";
import { offerChannel, RTC_CONFIG, wireIce } from "./rtc";
import type { SignalingClient } from "./signaling-client";

export interface Conn {
  id: number;
  channel: RTCDataChannel;
  dispose(): void;
}

/** Answer a recorder's `antiphon/1` offer. The resulting conn registers
 * itself in `conns` when the data channel arrives and removes itself on
 * close/failure. */
export async function answerRecorderOffer(opts: {
  signaling: SignalingClient;
  fromPeerId: string;
  sdp: string;
  connId: number;
  conns: Map<number, Conn>;
  onFrame(connId: number, bytes: ArrayBuffer): void;
}): Promise<void> {
  const { signaling, fromPeerId, sdp, connId, conns, onFrame } = opts;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const unwire = wireIce(pc, signaling, fromPeerId);
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
    conns.set(connId, conn);
    channel.addEventListener("message", (mev) => {
      if (mev.data instanceof ArrayBuffer) onFrame(connId, mev.data);
    });
    channel.addEventListener("close", () => {
      conns.delete(connId);
      conn.dispose();
    });
  });
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed") {
      conns.get(connId)?.dispose();
      conns.delete(connId);
    }
  });
  await pc.setRemoteDescription({ type: "offer", sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signaling.send({
    v: 1,
    type: "ice-answer",
    targetPeerId: fromPeerId,
    sdp: answer.sdp ?? "",
  });
}

/** Open the desk→server sync channel (antiphon-sync/1). `onDown` fires at
 * most per close/failure event with the conn it belongs to. */
export async function openServerSync(
  signaling: SignalingClient,
  connId: number,
  onFrame: (bytes: ArrayBuffer, connId: number) => void,
  onDown: (conn: Conn) => void,
): Promise<Conn> {
  const { pc, channel, dispose } = await offerChannel(signaling, SERVER_PEER_ID, "antiphon-sync/1");
  const conn: Conn = { id: connId, channel, dispose };
  channel.addEventListener("message", (ev) => {
    if (ev.data instanceof ArrayBuffer) onFrame(ev.data, connId);
  });
  channel.addEventListener("close", () => onDown(conn));
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") onDown(conn);
  });
  return conn;
}

/** Send frames respecting the channel's buffered-amount watermark; resumes
 * on bufferedamountlow. A dead channel aborts silently — reconciliation
 * re-plans the push on reconnect. */
export function pumpFramesToChannel(
  channel: RTCDataChannel,
  frames: ArrayBuffer[],
  highWatermark: number,
): void {
  let i = 0;
  const pump = () => {
    while (i < frames.length && channel.bufferedAmount < highWatermark) {
      const frame = frames[i++];
      if (!frame) break;
      try {
        channel.send(frame);
      } catch {
        return; // channel died mid-push
      }
    }
    if (i < frames.length) {
      channel.addEventListener("bufferedamountlow", pump, { once: true });
    }
  };
  channel.bufferedAmountLowThreshold = highWatermark / 4;
  pump();
}
