// File-format readers for downloaded exports, shared by export.spec.ts,
// markers.spec.ts and daw-export.spec.ts. Deliberately independent of the
// app's writers (wav.ts / zip.ts / xml.ts / als.ts): they assert the
// structural invariants of each format from the spec, not from the
// implementation.

import { gunzipSync } from "node:zlib";
import { expect } from "@playwright/test";

export interface WavInfo {
  channels: number;
  sampleRate: number;
  bitDepth: number;
  durationSec: number;
  /** True when at least one PCM byte is nonzero (audio actually landed). */
  hasSignal: boolean;
}

export function parseWav(bytes: Buffer): WavInfo {
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
  expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
  expect(bytes.subarray(8, 12).toString("latin1")).toBe("WAVE");
  expect(bytes.subarray(12, 16).toString("latin1")).toBe("fmt ");
  expect(bytes.readUInt16LE(20)).toBe(1); // integer PCM
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const bitDepth = bytes.readUInt16LE(34);
  expect(bytes.subarray(36, 40).toString("latin1")).toBe("data");
  const dataSize = bytes.readUInt32LE(40);
  expect(bytes.length).toBe(44 + dataSize);
  const blockAlign = channels * (bitDepth / 8);
  expect(bytes.readUInt16LE(32)).toBe(blockAlign);
  const data = bytes.subarray(44);
  return {
    channels,
    sampleRate,
    bitDepth,
    durationSec: dataSize / blockAlign / sampleRate,
    hasSignal: data.some((b) => b !== 0),
  };
}

// ---- FLAC (W5-C stem exports) --------------------------------------------------

export interface FlacInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** 0 in STREAMINFO means "unknown"; desk exports always finalize it. */
  totalSamples: number;
  durationSec: number;
}

/** Read a FLAC file's STREAMINFO from the spec's bit layout (sample rate
 * 20 bits / channels 3 / bits-per-sample 5 / total-samples 36), walk the
 * metadata blocks, and check real audio frames follow (sync code). */
export function parseFlacHeader(bytes: Buffer): FlacInfo {
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("fLaC");
  expect((bytes[4] as number) & 0x7f).toBe(0); // first block: STREAMINFO
  const infoLen = bytes.readUIntBE(5, 3);
  expect(infoLen).toBe(34);
  const b = (i: number) => bytes[8 + i] as number;
  const sampleRate = (b(10) << 12) | (b(11) << 4) | (b(12) >> 4);
  const channels = ((b(12) >> 1) & 0x07) + 1;
  const bitsPerSample = (((b(12) & 0x01) << 4) | (b(13) >> 4)) + 1;
  const totalSamples =
    (b(13) & 0x0f) * 2 ** 32 + b(14) * 2 ** 24 + b(15) * 2 ** 16 + b(16) * 2 ** 8 + b(17);
  // Walk metadata blocks (bit 7 of the block header = last-metadata flag).
  let at = 4;
  for (;;) {
    const header = bytes[at] as number;
    at += 4 + bytes.readUIntBE(at + 1, 3);
    if (header & 0x80) break;
  }
  // Audio frames follow: FLAC frame sync code (11111111 111110xx).
  expect(bytes[at]).toBe(0xff);
  expect((bytes[at + 1] as number) & 0xfc).toBe(0xf8);
  expect(sampleRate).toBeGreaterThan(0);
  return {
    channels,
    sampleRate,
    bitsPerSample,
    totalSamples,
    durationSec: totalSamples / sampleRate,
  };
}

/** Reference CRC-32 (IEEE, bitwise) to check a ZIP's stored CRCs. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- Standard MIDI File (W3-C export) -----------------------------------------

export interface MidiChannelEvent {
  /** Absolute tick (accumulated deltas — monotone by construction). */
  tick: number;
  status: number;
  data: number[];
}

export interface MidiFileInfo {
  format: number;
  trackCount: number;
  /** Ticks per quarter note (division). */
  tpqn: number;
  /** From the set-tempo meta event, when present. */
  tempoUsPerQuarter: number | null;
  events: MidiChannelEvent[];
}

function readVlq(bytes: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let i = at;
  for (;;) {
    const b = bytes[i] as number;
    value = (value << 7) | (b & 0x7f);
    i++;
    if ((b & 0x80) === 0) return { value, next: i };
    expect(i - at).toBeLessThan(4); // VLQ is at most 4 bytes
  }
}

/** Parse a format-0 .mid from the spec's structure (independent of the
 * app's writer): header chunk, one track, VLQ deltas, meta/channel events.
 * Delta-time non-negativity is inherent to VLQ; ticks accumulate monotone. */
export function parseMidi(bytes: Buffer): MidiFileInfo {
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("MThd");
  expect(bytes.readUInt32BE(4)).toBe(6);
  const format = bytes.readUInt16BE(8);
  const trackCount = bytes.readUInt16BE(10);
  const tpqn = bytes.readUInt16BE(12);
  expect(tpqn & 0x8000).toBe(0); // ticks-per-quarter, not SMPTE
  expect(bytes.subarray(14, 18).toString("latin1")).toBe("MTrk");
  const trackLen = bytes.readUInt32BE(18);
  expect(22 + trackLen).toBe(bytes.length);

  let tempoUsPerQuarter: number | null = null;
  const events: MidiChannelEvent[] = [];
  let tick = 0;
  let i = 22;
  let ended = false;
  while (i < bytes.length && !ended) {
    const delta = readVlq(bytes, i);
    tick += delta.value;
    i = delta.next;
    const status = bytes[i] as number;
    expect(status).toBeGreaterThanOrEqual(0x80); // running status not used
    i++;
    if (status === 0xff) {
      const type = bytes[i] as number;
      const len = readVlq(bytes, i + 1);
      if (type === 0x51) {
        expect(len.value).toBe(3);
        tempoUsPerQuarter =
          ((bytes[len.next] as number) << 16) |
          ((bytes[len.next + 1] as number) << 8) |
          (bytes[len.next + 2] as number);
      }
      if (type === 0x2f) ended = true;
      i = len.next + len.value;
    } else if (status === 0xf0 || status === 0xf7) {
      const len = readVlq(bytes, i);
      i = len.next + len.value;
    } else {
      const dataBytes = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2;
      const data = [...bytes.subarray(i, i + dataBytes)];
      for (const d of data) expect(d).toBeLessThan(0x80);
      events.push({ tick, status, data });
      i += dataBytes;
    }
  }
  expect(ended).toBe(true); // end-of-track present…
  expect(i).toBe(bytes.length); // …and nothing after it
  return { format, trackCount, tpqn, tempoUsPerQuarter, events };
}

/** Walk EOCD → central directory → local headers of a STORE-only ZIP,
 * asserting the structural invariants along the way. */
export function parseZip(zip: Buffer): Array<{ name: string; data: Buffer }> {
  const eocd = zip.length - 22; // single disk, no archive comment
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  expect(centralOffset + centralSize).toBe(eocd);

  const entries: Array<{ name: string; data: Buffer }> = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    expect(zip.readUInt16LE(cursor + 10)).toBe(0); // STORE
    const crc = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 24);
    expect(zip.readUInt32LE(cursor + 20)).toBe(size); // stored === raw
    const nameLen = zip.readUInt16LE(cursor + 28);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");

    // The central directory must point at a matching local header.
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(zip.readUInt32LE(localOffset + 14)).toBe(crc);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = zip.subarray(dataStart, dataStart + size);
    expect(crc32(data)).toBe(crc);
    entries.push({ name, data });
    cursor += 46 + nameLen;
  }
  expect(cursor).toBe(centralOffset + centralSize);
  return entries;
}

// ---- .als (gzipped XML) readers — W3-B DAW project exports --------------------

/** An .als is a gzip member wrapping UTF-8 XML; node's zlib is the
 * independent decompressor here (the app writes via CompressionStream). */
export function gunzipAls(als: Buffer): string {
  expect(als[0]).toBe(0x1f); // gzip magic
  expect(als[1]).toBe(0x8b);
  return gunzipSync(als).toString("utf8");
}

/** Attribute-only XML element tree — the subset a Live set document uses
 * (all scalar state lives in attributes; no text nodes). */
export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

/** Minimal hand-rolled XML reader with real well-formedness teeth:
 * unbalanced tags, unquoted attributes or trailing garbage all throw. */
export function parseXmlTree(doc: string): XmlNode {
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
  const unescapeXml = (s: string): string =>
    s
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&");
  function parseElement(): XmlNode {
    skipWs();
    if (src[pos] !== "<") throw new Error(`xml: expected < at ${pos}`);
    pos++;
    const tagMatch = /^[A-Za-z_][A-Za-z0-9._-]*/.exec(src.slice(pos));
    if (!tagMatch) throw new Error(`xml: bad tag at ${pos}`);
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
      if (!attrMatch) throw new Error(`xml: bad attribute at ${pos}: ${src.slice(pos, pos + 40)}`);
      attrs[attrMatch[1] as string] = unescapeXml(attrMatch[2] as string);
      pos += attrMatch[0].length;
    }
    const children: XmlNode[] = [];
    for (;;) {
      skipWs();
      if (src.startsWith(`</${tag}>`, pos)) {
        pos += tag.length + 3;
        return { tag, attrs, children };
      }
      if (pos >= src.length) throw new Error(`xml: unclosed <${tag}>`);
      children.push(parseElement());
    }
  }
  const root = parseElement();
  skipWs();
  expect(pos).toBe(src.length); // exactly one root element
  return root;
}

/** Walk a fixed child path, asserting each hop exists. */
export function xmlGet(node: XmlNode, ...path: string[]): XmlNode {
  return path.reduce((n, tag) => {
    const next = n.children.find((c) => c.tag === tag);
    if (!next) throw new Error(`xml: missing <${tag}> under <${n.tag}>`);
    return next;
  }, node);
}

/** Read the Live "Value" attribute idiom at a child path. */
export function xmlValue(node: XmlNode, ...path: string[]): string {
  const target = xmlGet(node, ...path);
  const v = target.attrs.Value;
  if (v === undefined) throw new Error(`xml: <${target.tag}> has no Value`);
  return v;
}
