import { describe, expect, it } from "vitest";
import { buildZip, crc32 } from "./zip";

/** Independent reference CRC-32: bitwise, no lookup table — a table-shape
 * bug in the implementation under test cannot hide here. */
function referenceCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ParsedEntry {
  name: string;
  crc: number;
  size: number;
  localOffset: number;
  data: Uint8Array;
}

/** Minimal ZIP reader: EOCD → central directory → local headers → STORE'd
 * bytes, asserting structural invariants along the way. */
function parseZip(zip: Uint8Array): ParsedEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // Single-disk archives without comments end in a fixed-size EOCD.
  const eocdOffset = zip.length - 22;
  expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
  const count = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  expect(centralOffset + centralSize).toBe(eocdOffset);

  const entries: ParsedEntry[] = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    expect(view.getUint16(cursor + 10, true)).toBe(0); // STORE
    const crc = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    expect(compressed).toBe(size); // STORE: stored === raw
    const nameLen = view.getUint16(cursor + 28, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(zip.subarray(cursor + 46, cursor + 46 + nameLen));

    // The central directory must point at a matching local header.
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    expect(view.getUint32(localOffset + 14, true)).toBe(crc);
    expect(view.getUint32(localOffset + 22, true)).toBe(size);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    expect(
      new TextDecoder().decode(zip.subarray(localOffset + 30, localOffset + 30 + localNameLen)),
    ).toBe(name);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    entries.push({ name, crc, size, localOffset, data: zip.subarray(dataStart, dataStart + size) });
    cursor += 46 + nameLen;
  }
  expect(cursor).toBe(centralOffset + centralSize);
  return entries;
}

describe("crc32", () => {
  it("matches the IEEE check vector", () => {
    // The canonical CRC-32 test vector: ASCII "123456789" → 0xCBF43926.
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("agrees with an independent bitwise implementation on random data", () => {
    for (const size of [1, 7, 256, 4_099]) {
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) data[i] = (i * 31 + size * 7) & 0xff;
      expect(crc32(data)).toBe(referenceCrc32(data));
    }
  });
});

describe("buildZip", () => {
  const modified = new Date(2026, 6, 8, 12, 34, 56);

  it("produces an archive Node can walk: offsets, CRCs, STORE'd bytes", () => {
    const alto = new TextEncoder().encode("RIFF-alto-payload");
    const tenor = new Uint8Array(2_048).map((_, i) => i & 0xff);
    const zip = buildZip(
      [
        { name: "Alto-0a1b2c3d.wav", data: alto },
        { name: "Tenor-4e5f6a7b.wav", data: tenor },
      ],
      modified,
    );

    const entries = parseZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["Alto-0a1b2c3d.wav", "Tenor-4e5f6a7b.wav"]);
    expect(entries[0]?.localOffset).toBe(0);
    // Second local header directly after the first (30 + name + data).
    expect(entries[1]?.localOffset).toBe(30 + "Alto-0a1b2c3d.wav".length + alto.length);
    expect([...(entries[0]?.data ?? [])]).toEqual([...alto]);
    expect([...(entries[1]?.data ?? [])]).toEqual([...tenor]);
    for (const entry of entries) {
      expect(entry.crc).toBe(referenceCrc32(entry.data));
    }
  });

  it("stamps DOS date/time and the UTF-8 name flag", () => {
    const zip = buildZip([{ name: "María.wav", data: new Uint8Array([1]) }], modified);
    const view = new DataView(zip.buffer);
    expect(view.getUint16(6, true)).toBe(0x0800); // UTF-8 filenames
    // 12:34:56 → (12<<11)|(34<<5)|(56>>1) — DOS time has 2 s resolution.
    expect(view.getUint16(10, true)).toBe((12 << 11) | (34 << 5) | 28);
    // 2026-07-08 → ((2026−1980)<<9)|(7<<5)|8.
    expect(view.getUint16(12, true)).toBe((46 << 9) | (7 << 5) | 8);
    // Non-ASCII names survive the UTF-8 round trip.
    const nameLen = view.getUint16(26, true);
    expect(new TextDecoder().decode(zip.subarray(30, 30 + nameLen))).toBe("María.wav");
  });

  it("handles the empty archive (EOCD only)", () => {
    const zip = buildZip([], modified);
    expect(zip.length).toBe(22);
    expect(parseZip(zip)).toEqual([]);
  });
});
