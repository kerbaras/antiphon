// File-format readers for downloaded exports, shared by export.spec.ts and
// markers.spec.ts. Deliberately independent of the app's writers (wav.ts /
// zip.ts): they assert the structural invariants of each format from the
// spec, not from the implementation.

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

/** Reference CRC-32 (IEEE, bitwise) to check a ZIP's stored CRCs. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
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
