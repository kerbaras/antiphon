// F1 — attribution rebuild: payload → lookups, and the chronological
// stable take ordering that keeps numbering steady across reloads.

import { describe, expect, it } from "vitest";
import {
  archivedStreamMetas,
  buildAttribution,
  orderTakeIds,
  type SessionSummaryPayload,
} from "./attribution";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";

function payload(): SessionSummaryPayload {
  return {
    sessionId: "s",
    takes: [
      {
        id: T1,
        startedAt: "2026-07-08T10:00:00.000Z",
        streams: [
          { streamId: "st-a1", peerId: "peer-a", finalSeq: 41 },
          { streamId: "st-b1", peerId: "peer-b", finalSeq: 41 },
        ],
      },
      {
        id: T2,
        startedAt: "2026-07-08T10:05:00.000Z",
        streams: [
          { streamId: "st-a2", peerId: "peer-a", finalSeq: null },
          { streamId: "st-orphan", peerId: null, finalSeq: 7 },
        ],
      },
    ],
    peers: [
      {
        peerId: "peer-a",
        role: "recorder",
        userAgent: "iPhone",
        label: "Maria",
        deviceId: "dev-a",
        joinedAt: "2026-07-08T09:59:00.000Z",
      },
      {
        peerId: "desk-1",
        role: "desk",
        userAgent: "Macintosh",
        label: null,
        deviceId: null,
        joinedAt: "2026-07-08T09:58:00.000Z",
      },
    ],
  };
}

describe("buildAttribution", () => {
  it("maps streams to peers, takes to start times, peers to identity", () => {
    const attr = buildAttribution(payload());
    expect(attr.peerByStream.get("st-a1")).toBe("peer-a");
    expect(attr.peerByStream.get("st-b1")).toBe("peer-b");
    expect(attr.peerByStream.get("st-a2")).toBe("peer-a");
    // Unattributed streams stay unmapped — the desk falls back per-stream.
    expect(attr.peerByStream.has("st-orphan")).toBe(false);
    expect(attr.takeStartedAt.get(T1)).toBe(Date.parse("2026-07-08T10:00:00.000Z"));
    expect(attr.takeStartedAt.get(T2)).toBe(Date.parse("2026-07-08T10:05:00.000Z"));
    expect(attr.peers.get("peer-a")?.label).toBe("Maria");
    expect(attr.peers.get("peer-a")?.deviceId).toBe("dev-a");
    expect(attr.peers.get("desk-1")?.role).toBe("desk");
  });

  it("flattens takes into announce-equivalent stream metas for sink seeding", () => {
    expect(archivedStreamMetas(payload())).toEqual([
      { takeId: T1, streamId: "st-a1", peerId: "peer-a", finalSeq: 41 },
      { takeId: T1, streamId: "st-b1", peerId: "peer-b", finalSeq: 41 },
      { takeId: T2, streamId: "st-a2", peerId: "peer-a", finalSeq: null },
      { takeId: T2, streamId: "st-orphan", peerId: null, finalSeq: 7 },
    ]);
  });

  it("skips unparseable startedAt instead of poisoning the ordering", () => {
    const p = payload();
    (p.takes[0] as { startedAt: string }).startedAt = "not-a-date";
    const attr = buildAttribution(p);
    expect(attr.takeStartedAt.has(T1)).toBe(false);
    expect(attr.takeStartedAt.has(T2)).toBe(true);
  });
});

describe("orderTakeIds", () => {
  const startedAt = new Map<string, number>([
    [T1, 1_000],
    [T2, 2_000],
    [T3, 3_000],
  ]);

  it("orders by archive startedAt regardless of observed order (the reload scramble)", () => {
    // Post-reload observed order: the NEW take's announce lands first,
    // history follows in takeId-byte order — exactly the A2 scramble.
    expect(orderTakeIds([T3, T2, T1], startedAt)).toEqual([T1, T2, T3]);
    expect(orderTakeIds([T2, T3, T1], startedAt)).toEqual([T1, T2, T3]);
  });

  it("keeps undated takes last, in observed order (the just-started take)", () => {
    const dated = new Map<string, number>([
      [T1, 1_000],
      [T2, 2_000],
    ]);
    expect(orderTakeIds([T3, T1, T2], dated)).toEqual([T1, T2, T3]);
    // Two undated takes keep their relative observed order.
    const oneDated = new Map<string, number>([[T1, 1_000]]);
    expect(orderTakeIds([T3, T2, T1], oneDated)).toEqual([T1, T3, T2]);
  });

  it("is stable for equal timestamps", () => {
    const tied = new Map<string, number>([
      [T1, 1_000],
      [T2, 1_000],
    ]);
    expect(orderTakeIds([T2, T1], tied)).toEqual([T2, T1]);
    expect(orderTakeIds([T1, T2], tied)).toEqual([T1, T2]);
  });

  it("returns a new array and leaves the input untouched", () => {
    const observed = [T2, T1];
    const out = orderTakeIds(observed, startedAt);
    expect(out).toEqual([T1, T2]);
    expect(observed).toEqual([T2, T1]);
  });
});
