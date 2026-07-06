// WebRTC helpers: ICE plumbing between an RTCPeerConnection and the
// signaling relay. ICE does the routing — host > srflx > relay — we never
// second-guess it (architecture §3).

import type { SignalingMessage } from "@antiphon/protocol";
import type { SignalingClient } from "./signaling-client";

export const RTC_CONFIG: RTCConfiguration = {
  // One public STUN server helps the desk↔phone P2P leg across NATs; the
  // phone→server leg works without it (the server has host candidates).
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

/** Wire pc's candidates/answers to a signaling target peer. Remote
 * candidates routinely arrive BEFORE the answer SDP (the server gathers
 * fast); they are buffered until the remote description is set. Returns an
 * unsubscribe function. */
export function wireIce(
  pc: RTCPeerConnection,
  signaling: SignalingClient,
  targetPeerId: string,
): () => void {
  const pendingCandidates: RTCIceCandidateInit[] = [];
  let haveRemoteDescription = false;

  const onLocalCandidate = (ev: RTCPeerConnectionIceEvent) => {
    if (ev.candidate) {
      signaling.send({
        v: 1,
        type: "ice-candidate",
        targetPeerId,
        candidate: {
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
        },
      });
    }
  };
  pc.addEventListener("icecandidate", onLocalCandidate);

  const addCandidate = (init: RTCIceCandidateInit) => {
    void pc.addIceCandidate(init).catch(() => {});
  };

  const flushPending = () => {
    if (pc.remoteDescription) {
      haveRemoteDescription = true;
      for (const c of pendingCandidates.splice(0)) addCandidate(c);
    }
  };
  // Answerer path: the remote OFFER is set outside this helper; flush the
  // buffer as soon as any remote description lands.
  pc.addEventListener("signalingstatechange", flushPending);

  const unsubscribe = signaling.onMessage((msg: SignalingMessage) => {
    if (msg.type === "ice-answer" && msg.fromPeerId === targetPeerId) {
      void pc
        .setRemoteDescription({ type: "answer", sdp: msg.sdp })
        .then(flushPending)
        .catch(() => {});
    }
    if (msg.type === "ice-candidate" && msg.fromPeerId === targetPeerId && msg.candidate) {
      const init: RTCIceCandidateInit = {
        candidate: msg.candidate.candidate,
        sdpMid: msg.candidate.sdpMid ?? null,
        sdpMLineIndex: msg.candidate.sdpMLineIndex ?? null,
      };
      if (haveRemoteDescription || pc.remoteDescription) addCandidate(init);
      else pendingCandidates.push(init);
    }
  });

  return () => {
    pc.removeEventListener("icecandidate", onLocalCandidate);
    pc.removeEventListener("signalingstatechange", flushPending);
    unsubscribe();
  };
}

/** Offer a data channel toward a peer; resolves when the channel opens. */
export async function offerChannel(
  signaling: SignalingClient,
  targetPeerId: string,
  label: string,
  timeoutMs = 15_000,
): Promise<{ pc: RTCPeerConnection; channel: RTCDataChannel; dispose(): void }> {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channel = pc.createDataChannel(label, { ordered: true });
  channel.binaryType = "arraybuffer";
  const unwire = wireIce(pc, signaling, targetPeerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signaling.send({
    v: 1,
    type: "ice-offer",
    targetPeerId,
    sdp: offer.sdp ?? "",
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} open timeout`)), timeoutMs);
    channel.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") {
        clearTimeout(timer);
        reject(new Error(`${label} connection failed`));
      }
    });
  });
  return {
    pc,
    channel,
    dispose: () => {
      unwire();
      try {
        channel.close();
        pc.close();
      } catch {
        // teardown races
      }
    },
  };
}
