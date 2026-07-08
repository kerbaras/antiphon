// .als writer invariants (W3-B). No Ableton Live in this environment, so
// these tests assert the STRUCTURE the format research pinned down —
// well-formed XML, the Live 12 header, one arrangement AudioTrack per
// stem, project-relative sample refs, beat math at the fixed 120 BPM,
// locator placement — plus a gzip round trip of the finished .als file.
// "Opens in Live" itself is a manual verification step (see als.ts).

import { describe, expect, it } from "vitest";
import { ALS_SAMPLES_DIR, ALS_TEMPO_BPM, type AlsSet, buildAls, buildAlsXml } from "./als";

// ---- tiny hand-rolled XML reader --------------------------------------------
// Deliberately independent of xml.ts (the writer under test): parses the
// attribute-only element subset .als uses into a walkable tree, throwing
// on anything unbalanced or unquoted — a well-formedness check with
// teeth, not a regex sniff.

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}

function parseXml(doc: string): Node {
  let src = doc.trim();
  if (src.startsWith("<?xml")) {
    const end = src.indexOf("?>");
    expect(end).toBeGreaterThan(0);
    src = src.slice(end + 2);
  }
  let pos = 0;
  const skipWs = () => {
    while (pos < src.length && /\s/.test(src[pos] as string)) pos++;
  };
  function parseElement(): Node {
    skipWs();
    if (src[pos] !== "<") throw new Error(`expected < at ${pos}`);
    pos++;
    const tagMatch = /^[A-Za-z_][A-Za-z0-9._-]*/.exec(src.slice(pos));
    if (!tagMatch) throw new Error(`bad tag at ${pos}`);
    const tag = tagMatch[0];
    pos += tag.length;
    const attrs: Record<string, string> = {};
    for (;;) {
      skipWs();
      if (src.startsWith("/>", pos)) {
        pos += 2;
        return { tag, attrs, children: [] };
      }
      if (src[pos] === ">") {
        pos++;
        break;
      }
      const attrMatch = /^([A-Za-z_][A-Za-z0-9._-]*)="([^"<>]*)"/.exec(src.slice(pos));
      if (!attrMatch) throw new Error(`bad attribute at ${pos}: ${src.slice(pos, pos + 40)}`);
      attrs[attrMatch[1] as string] = unescapeXml(attrMatch[2] as string);
      pos += attrMatch[0].length;
    }
    const children: Node[] = [];
    for (;;) {
      skipWs();
      if (src.startsWith(`</${tag}>`, pos)) {
        pos += tag.length + 3;
        return { tag, attrs, children };
      }
      if (pos >= src.length) throw new Error(`unclosed <${tag}>`);
      children.push(parseElement());
    }
  }
  function unescapeXml(s: string): string {
    return s
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&");
  }
  const root = parseElement();
  skipWs();
  expect(pos).toBe(src.length); // nothing trailing — one root element
  return root;
}

const find = (node: Node, tag: string): Node | undefined =>
  node.children.find((c) => c.tag === tag);
const get = (node: Node, ...path: string[]): Node =>
  path.reduce((n, tag) => {
    const next = find(n, tag);
    if (!next) throw new Error(`missing <${tag}> under <${n.tag}>`);
    return next;
  }, node);
const value = (node: Node, ...path: string[]): string => {
  const target = get(node, ...path);
  const v = target.attrs.Value;
  if (v === undefined) throw new Error(`<${target.tag}> has no Value`);
  return v;
};

// ---- fixtures -----------------------------------------------------------------

function twoStemSet(): AlsSet {
  return {
    stems: [
      {
        name: 'Alto & "Friends" <3',
        fileName: "Alto-0a1b2c3d.wav",
        durationSec: 12.5,
        frames: 600_000,
        sampleRate: 48_000,
        fileSizeBytes: 1_800_044,
        gainLinear: 0.7079457843841379,
        pan: -0.25,
        muted: false,
      },
      {
        name: "Tenor",
        fileName: "Tenor-4e5f6a7b.wav",
        durationSec: 12.5,
        frames: 600_000,
        sampleRate: 48_000,
        fileSizeBytes: 1_800_044,
        gainLinear: 1,
        pan: 0,
        muted: true,
      },
    ],
    locators: [
      { name: "Kyrie", atSec: 0 },
      { name: "Gloria <reprise>", atSec: 7.25 },
    ],
    masterGainLinear: 0.8912509381337456,
    masterPan: 0.1,
  };
}

// ---- tests ----------------------------------------------------------------------

describe("buildAlsXml", () => {
  const root = parseXml(buildAlsXml(twoStemSet()));

  it("is well-formed and carries the Live 12 header", () => {
    expect(root.tag).toBe("Ableton");
    expect(root.attrs.MajorVersion).toBe("5");
    expect(root.attrs.MinorVersion).toBe("12.0_12049");
    expect(root.attrs.SchemaChangeCount).toBe("7");
    expect(root.attrs.Creator).toBe("Antiphon");
  });

  it("declares one arrangement AudioTrack per stem, names escaped intact", () => {
    const tracks = get(root, "LiveSet", "Tracks").children;
    expect(tracks.map((t) => t.tag)).toEqual(["AudioTrack", "AudioTrack"]);
    expect(tracks.map((t) => t.attrs.Id)).toEqual(["10", "11"]);
    const names = tracks.map((t) => value(t, "Name", "EffectiveName"));
    expect(names).toEqual(['Alto & "Friends" <3', "Tenor"]);
  });

  it("mirrors the mixer: linear volume, pan, mute as the track activator", () => {
    const [alto, tenor] = get(root, "LiveSet", "Tracks").children as [Node, Node];
    expect(value(alto, "DeviceChain", "Mixer", "Volume", "Manual")).toBe("0.7079457843841379");
    expect(value(alto, "DeviceChain", "Mixer", "Pan", "Manual")).toBe("-0.25");
    expect(value(alto, "DeviceChain", "Mixer", "Speaker", "Manual")).toBe("true");
    expect(value(tenor, "DeviceChain", "Mixer", "Speaker", "Manual")).toBe("false");
  });

  it("places one unwarped clip per track: beats at 120 BPM, seconds in the loop", () => {
    for (const track of get(root, "LiveSet", "Tracks").children) {
      const events = get(
        track,
        "DeviceChain",
        "MainSequencer",
        "Sample",
        "ArrangerAutomation",
        "Events",
      );
      expect(events.children).toHaveLength(1);
      const clip = events.children[0] as Node;
      expect(clip.tag).toBe("AudioClip");
      expect(clip.attrs.Time).toBe("0"); // aligned stems all start at 0
      expect(value(clip, "CurrentStart")).toBe("0");
      // 12.5 s × (120 BPM / 60) = 25 beats.
      expect(value(clip, "CurrentEnd")).toBe("25");
      expect(value(clip, "IsWarped")).toBe("false");
      // Unwarped clip: loop bounds stay in file seconds.
      expect(value(clip, "Loop", "LoopEnd")).toBe("12.5");
      expect(value(clip, "Loop", "OutMarker")).toBe("12.5");
      expect(value(clip, "Loop", "LoopOn")).toBe("false");
    }
  });

  it("references samples project-relative under Samples/Imported", () => {
    const refs = get(root, "LiveSet", "Tracks").children.map((track) => {
      const clip = get(
        track,
        "DeviceChain",
        "MainSequencer",
        "Sample",
        "ArrangerAutomation",
        "Events",
        "AudioClip",
      );
      return get(clip, "SampleRef", "FileRef");
    });
    expect(refs.map((r) => value(r, "RelativePath"))).toEqual([
      `${ALS_SAMPLES_DIR}/Alto-0a1b2c3d.wav`,
      `${ALS_SAMPLES_DIR}/Tenor-4e5f6a7b.wav`,
    ]);
    for (const ref of refs) {
      expect(value(ref, "RelativePathType")).toBe("3"); // current project
      expect(value(ref, "Path")).toBe(""); // absolute unknowable pre-unzip
      expect(value(ref, "OriginalFileSize")).toBe("1800044");
      expect(value(ref, "OriginalCrc")).toBe("0"); // Live recomputes
    }
    const sampleRef = get(
      get(root, "LiveSet", "Tracks").children[0] as Node,
      "DeviceChain",
      "MainSequencer",
      "Sample",
      "ArrangerAutomation",
      "Events",
      "AudioClip",
      "SampleRef",
    );
    expect(value(sampleRef, "DefaultDuration")).toBe("600000");
    expect(value(sampleRef, "DefaultSampleRate")).toBe("48000");
  });

  it("writes the fixed tempo and master mixer on MainTrack", () => {
    const mixer = get(root, "LiveSet", "MainTrack", "DeviceChain", "Mixer");
    expect(value(mixer, "Tempo", "Manual")).toBe(String(ALS_TEMPO_BPM));
    expect(value(mixer, "Volume", "Manual")).toBe("0.8912509381337456");
    expect(value(mixer, "Pan", "Manual")).toBe("0.1");
  });

  it("maps markers to locators in beats", () => {
    const locators = get(root, "LiveSet", "Locators", "Locators").children;
    expect(locators.map((l) => l.tag)).toEqual(["Locator", "Locator"]);
    expect(locators.map((l) => value(l, "Name"))).toEqual(["Kyrie", "Gloria <reprise>"]);
    // atSec × 2 beats/sec at 120 BPM.
    expect(locators.map((l) => value(l, "Time"))).toEqual(["0", "14.5"]);
  });

  it("handles the empty set (no stems, no locators) without corrupting shape", () => {
    const empty = parseXml(
      buildAlsXml({ stems: [], locators: [], masterGainLinear: 1, masterPan: 0 }),
    );
    expect(get(empty, "LiveSet", "Tracks").children).toEqual([]);
    expect(get(empty, "LiveSet", "Locators", "Locators").children).toEqual([]);
  });
});

describe("buildAls", () => {
  it("gzips to a file that gunzips back to the exact XML", async () => {
    const set = twoStemSet();
    const als = await buildAls(set);
    expect(als[0]).toBe(0x1f); // gzip magic
    expect(als[1]).toBe(0x8b);
    const stream = new Blob([als as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    const xml = await new Response(stream).text();
    expect(xml).toBe(buildAlsXml(set));
    // And the round-tripped document still parses with the invariants.
    expect(parseXml(xml).tag).toBe("Ableton");
  });
});
