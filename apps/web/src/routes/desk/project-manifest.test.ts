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
        alignment: { lagSamples: 19_800, confidence: 8.8, applied: true },
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
  });

  it("derives songs from markers in timeline order (last one open-ended)", () => {
    const m = buildProjectManifest(input());
    expect(m.songs).toEqual([
      { id: "m1", index: 1, name: "Kyrie", startSec: 0, endSec: 7.25 },
      { id: "m2", index: 2, name: "Gloria", startSec: 7.25, endSec: null },
    ]);
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
