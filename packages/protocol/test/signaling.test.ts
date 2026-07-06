import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHIRP_SPEC,
  negotiateVersion,
  parseSignalingMessage,
  type SignalingMessage,
} from "../src/index";

const SESSION = "0b54d4e8-7c1a-4f7e-9f3a-1a2b3c4d5e6f";
const PEER = "1c65e5f9-8d2b-4a8f-af4b-2b3c4d5e6f70";

describe("parseSignalingMessage", () => {
  it("round-trips every message type", () => {
    const messages: SignalingMessage[] = [
      {
        v: 1,
        type: "hello",
        role: "recorder",
        deviceInfo: { userAgent: "test" },
        protocolVersions: [1],
      },
      { v: 1, type: "bye" },
      { v: 1, type: "ice-offer", targetPeerId: PEER, sdp: "v=0..." },
      { v: 1, type: "ice-answer", targetPeerId: PEER, fromPeerId: PEER, sdp: "v=0..." },
      {
        v: 1,
        type: "ice-candidate",
        targetPeerId: PEER,
        candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
      },
      { v: 1, type: "ice-candidate", targetPeerId: PEER, candidate: null },
      { v: 1, type: "take-start", takeId: SESSION, wallClockHint: "2026-07-05T12:00:00Z" },
      { v: 1, type: "take-stop", takeId: SESSION },
      { v: 1, type: "stream-announce", takeId: SESSION, streamId: PEER },
      { v: 1, type: "stream-final", takeId: SESSION, streamId: PEER, finalSeq: 42 },
      {
        v: 1,
        type: "calibration-chirp",
        chirpId: SESSION,
        emitTsDeskUs: 123,
        spec: DEFAULT_CHIRP_SPEC,
      },
      {
        v: 1,
        type: "welcome",
        peerId: PEER,
        protocolVersion: 1,
        session: { sessionId: SESSION, peers: [], activeTake: null },
      },
      {
        v: 1,
        type: "peer-status",
        session: {
          sessionId: SESSION,
          peers: [
            {
              peerId: PEER,
              role: "desk",
              deviceInfo: { userAgent: "x" },
              joinedAt: "2026-07-05T12:00:00Z",
            },
          ],
          activeTake: { takeId: SESSION, startedAt: "2026-07-05T12:00:00Z", stoppedAt: null },
        },
      },
      { v: 1, type: "error", code: "nope", message: "broken", fatal: true },
    ];
    for (const msg of messages) {
      expect(parseSignalingMessage(JSON.stringify(msg)), msg.type).toEqual(msg);
    }
  });

  it("ignores unknown types (forward compatibility, RFC §5)", () => {
    expect(parseSignalingMessage(JSON.stringify({ v: 1, type: "hologram" }))).toBeNull();
  });

  it("ignores future versions", () => {
    expect(parseSignalingMessage(JSON.stringify({ v: 9, type: "bye" }))).toBeNull();
  });

  it("throws on malformed known messages", () => {
    expect(() =>
      parseSignalingMessage(JSON.stringify({ v: 1, type: "take-start", takeId: "not-a-uuid" })),
    ).toThrow();
  });
});

describe("negotiateVersion", () => {
  it("picks the highest common version", () => {
    expect(negotiateVersion([1])).toBe(1);
    expect(negotiateVersion([1, 2, 9])).toBe(1);
  });
  it("fails cleanly with no overlap", () => {
    expect(negotiateVersion([2, 3])).toBeNull();
  });
});
