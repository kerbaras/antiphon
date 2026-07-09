import { describe, expect, it } from "vitest";
import type { ChannelStrip } from "./player";
import {
  buildProjectManifest,
  type ManifestInput,
  PROJECT_MANIFEST_FORMAT,
  PROJECT_MANIFEST_VERSION,
  parseProjectManifest,
} from "./project-manifest";

const strip = (key: string, over: Partial<ChannelStrip> = {}): ChannelStrip => ({
  key,
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  eq: { lowDb: 0, midDb: 0, midHz: 1_000, highDb: 0, bypassed: false },
  ...over,
});

function input(): ManifestInput {
  return {
    sessionId: "sess-1",
    takeId: "take-1",
    sampleRate: 48_000,
    bitDepth: 24,
    range: { startSec: 0, endSec: 12.5 },
    takeDurationSec: 12.5,
    masterFile: "master.wav",
    masterDb: -1.5,
    masterPan: 0.1,
    masterEq: { lowDb: 2, midDb: 0, midHz: 640, highDb: -3, bypassed: false },
    stems: [
      {
        file: "stems/Alto-0a1b2c3d.wav",
        streamId: "0a1b2c3d-stream",
        channelKey: "peer-alto",
        timing: { headSec: 0.42, ratio: 1.000021, clipDelaySec: 0, bufferDurationSec: 13.1 },
        alignment: { lagSamples: 20_160, confidence: 9.4, applied: true },
        drift: {
          ratio: 1.000021,
          ppm: 21,
          initialOffsetSamples: 3,
          confidence: 0.9,
          windowsUsed: 8,
          applied: true,
          isReference: false,
        },
      },
      {
        file: "stems/Tenor-4e5f6a7b.wav",
        streamId: "4e5f6a7b-stream",
        channelKey: "peer-tenor",
        timing: { headSec: 0, ratio: 1, clipDelaySec: 0, bufferDurationSec: 13 },
        // Content-aligned lane (W4-B): the method must ride the manifest.
        alignment: { lagSamples: 19_800, confidence: 8.8, applied: true, method: "content" },
        drift: null,
      },
    ],
    channels: [
      strip("peer-alto", { gainDb: -4.5, pan: -0.3, muted: true }),
      strip("peer-tenor", {
        soloed: true,
        eq: { lowDb: -2, midDb: 4, midHz: 2_400, highDb: 1, bypassed: true },
      }),
    ],
    lanes: [
      { key: "peer-alto", name: "Alto", peerId: "peer-alto" },
      { key: "peer-tenor", name: "Tenor", peerId: "peer-tenor" },
    ],
    markers: [
      { id: "m2", name: "Gloria", atSec: 7.25 },
      { id: "m1", name: "Kyrie", atSec: 0 },
    ],
    comments: [
      {
        id: "c1",
        atSec: 2.5,
        streamId: "0a1b2c3d-stream",
        text: "alto flat at 2:31",
        author: "Desk",
        createdAtMs: 1_700_000_000_000,
        resolvedAtMs: null,
      },
    ],
    createdAt: "2026-07-08T12:00:00.000Z",
  };
}

describe("buildProjectManifest", () => {
  it("joins lanes, strips, timing, and alignment per stem", () => {
    const m = buildProjectManifest(input());
    expect(m.format).toBe(PROJECT_MANIFEST_FORMAT);
    expect(m.version).toBe(PROJECT_MANIFEST_VERSION);
    expect(m.stems).toHaveLength(2);
    const alto = m.stems[0];
    expect(alto?.lane).toEqual({ key: "peer-alto", name: "Alto", peerId: "peer-alto" });
    expect(alto?.mixer.gainDb).toBe(-4.5);
    expect(alto?.mixer.muted).toBe(true);
    expect(alto?.chirp?.lagSamples).toBe(20_160);
    expect(alto?.drift?.ppm).toBe(21);
    expect(alto?.baked.headSec).toBe(0.42);
    const tenor = m.stems[1];
    expect(tenor?.mixer.soloed).toBe(true);
    expect(tenor?.mixer.eq.bypassed).toBe(true);
    expect(tenor?.drift).toBeNull();
    // W4-B seam: how the lag was measured rides along; an absent method
    // (legacy chirp verdicts) stays absent — never invented.
    expect(tenor?.chirp?.method).toBe("content");
    expect(m.stems[0]?.chirp?.method).toBeUndefined();
  });

  it("derives songs from markers in timeline order (last one open-ended)", () => {
    const m = buildProjectManifest(input());
    expect(m.songs).toEqual([
      { id: "m1", index: 1, name: "Kyrie", startSec: 0, endSec: 7.25 },
      { id: "m2", index: 2, name: "Gloria", startSec: 7.25, endSec: null },
    ]);
  });

  // W5-C — honest range slicing: a per-song export carries only the events
  // inside its span, rebased onto the exported timeline (0 = range head,
  // matching the WAVs), with `range` declaring the source slice.
  describe("range slicing", () => {
    const song2 = (): ManifestInput => ({
      ...input(),
      // Song 2's span: the Gloria marker (7.25) to the take end.
      range: { startSec: 7.25, endSec: 12.5 },
    });

    it("keeps only in-range markers/comments, rebased to the range head", () => {
      const m = buildProjectManifest(song2());
      expect(m.range).toEqual({ startSec: 7.25, endSec: 12.5 });
      expect(m.markers).toEqual([{ id: "m2", name: "Gloria", atSec: 0 }]);
      expect(m.comments).toEqual([]); // the 2.5 s note is outside the span
      expect(m.songs).toEqual([{ id: "m2", index: 1, name: "Gloria", startSec: 0, endSec: null }]);
    });

    it("is half-open: an event AT endSec belongs to the next song", () => {
      // Song 1's span: Kyrie (0) → Gloria (7.25). The Gloria marker sits
      // exactly at endSec — it starts the NEXT song, so it must not ride
      // along as a zero-length tail.
      const m = buildProjectManifest({ ...input(), range: { startSec: 0, endSec: 7.25 } });
      expect(m.markers).toEqual([{ id: "m1", name: "Kyrie", atSec: 0 }]);
      expect(m.comments).toHaveLength(1);
      expect(m.comments[0]?.atSec).toBe(2.5);
      expect(m.songs).toEqual([{ id: "m1", index: 1, name: "Kyrie", startSec: 0, endSec: null }]);
    });

    it("whole-take ranges pass every event through unchanged", () => {
      const m = buildProjectManifest(input());
      expect(m.markers.map((x) => [x.id, x.atSec])).toEqual([
        ["m2", 7.25],
        ["m1", 0],
      ]);
      expect(m.comments[0]?.atSec).toBe(2.5);
    });

    it("take-end events survive: the end turns inclusive when the range runs to the take's true end (QA M-1)", () => {
      // A comment parked exactly at the take end (comments.ts clamps ≥ 0
      // only) — pre-slicing exports carried it, so these must too.
      const parked = {
        id: "c-end",
        atSec: 12.5,
        streamId: null,
        text: "hold the last chord longer",
        author: "Desk",
        createdAtMs: 1_700_000_000_001,
        resolvedAtMs: null,
      };
      const base = input();
      const withParked = { ...base, comments: [...base.comments, parked] };
      // Whole take {0, duration}: passes through, position unchanged.
      const whole = buildProjectManifest(withParked);
      expect(whole.comments.map((c) => [c.id, c.atSec])).toEqual([
        ["c1", 2.5],
        ["c-end", 12.5],
      ]);
      // Final-song range (7.25 → take end): kept, rebased to the range head.
      const last = buildProjectManifest({
        ...withParked,
        range: { startSec: 7.25, endSec: 12.5 },
      });
      expect(last.comments).toEqual([{ ...parked, atSec: 5.25 }]);
      // Interior song boundary (0 → 7.25): an event AT the boundary still
      // belongs to the next song — the half-open rule is untouched there.
      const boundary = { ...parked, id: "c-boundary", atSec: 7.25 };
      const song1 = buildProjectManifest({
        ...withParked,
        comments: [...withParked.comments, boundary],
        range: { startSec: 0, endSec: 7.25 },
      });
      expect(song1.comments.map((c) => c.id)).toEqual(["c1"]);
    });

    it("never touches the measurement blocks: chirp/content alignment, drift and baked timing stay take-absolute", () => {
      // lagSamples (chirp or W4-B content) live in the stream's own sample
      // domain and `baked` on the take's room clock — raw measurements,
      // not exported-timeline events. Slicing rebases events ONLY; the
      // declared `range` is what situates the WAVs against these.
      const whole = buildProjectManifest(input());
      const sliced = buildProjectManifest(song2());
      expect(sliced.stems.map((s) => s.chirp)).toEqual(whole.stems.map((s) => s.chirp));
      expect(sliced.stems.map((s) => s.drift)).toEqual(whole.stems.map((s) => s.drift));
      expect(sliced.stems.map((s) => s.baked)).toEqual(whole.stems.map((s) => s.baked));
      expect(sliced.stems[1]?.chirp?.method).toBe("content");
    });
  });

  it("survives a JSON round trip byte-for-byte", () => {
    const m = buildProjectManifest(input());
    const parsed = parseProjectManifest(JSON.stringify(m));
    expect(parsed).toEqual(m);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(m));
  });

  it("snapshots its inputs (no aliasing of live mixer state)", () => {
    const source = input();
    const m = buildProjectManifest(source);
    (source.channels[0] as ChannelStrip).gainDb = 6;
    (source.markers[0] as { name: string }).name = "mutated";
    expect(m.stems[0]?.mixer.gainDb).toBe(-4.5);
    expect(m.markers.find((x) => x.id === "m2")?.name).toBe("Gloria");
  });
});

describe("parseProjectManifest", () => {
  it("rejects foreign formats and future versions", () => {
    const good = buildProjectManifest(input());
    expect(() => parseProjectManifest(JSON.stringify({ ...good, format: "other" }))).toThrow(
      /unknown format/,
    );
    expect(() => parseProjectManifest(JSON.stringify({ ...good, version: 2 }))).toThrow(
      /unsupported version/,
    );
    expect(() => parseProjectManifest("null")).toThrow(/not an object/);
    expect(() => parseProjectManifest(JSON.stringify({ ...good, stems: "nope" }))).toThrow(
      /malformed/,
    );
  });
});
