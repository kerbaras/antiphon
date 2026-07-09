// Boundary smoke for the one-shot mono FLAC encode (W5-C desk stem
// exports): sample-exact decode is proven in Rust via claxon
// (packages/codec/src/encoder.rs); this verifies the JS↔wasm contract —
// floats in, a structurally complete `.flac` out — with an independent
// STREAMINFO bit-read (FLAC spec, not the implementation).

import { beforeAll, describe, expect, it } from "vitest";
import { encode_flac_mono, init } from "../src/index.ts";

const RATE = 48_000;

interface StreamInfo {
  minBlockSize: number;
  maxBlockSize: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
}

/** `fLaC` magic + metadata block header + the STREAMINFO fields this
 * export must get right (sample rate 20 bits / channels 3 / bps 5 /
 * total-samples 36, big-endian bit packing per the spec). */
function readStreamInfo(bytes: Uint8Array): StreamInfo {
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("fLaC");
  expect((bytes[4] as number) & 0x7f).toBe(0); // block type 0: STREAMINFO
  const len = ((bytes[5] as number) << 16) | ((bytes[6] as number) << 8) | (bytes[7] as number);
  expect(len).toBe(34);
  const b = (i: number) => bytes[8 + i] as number;
  return {
    minBlockSize: (b(0) << 8) | b(1),
    maxBlockSize: (b(2) << 8) | b(3),
    sampleRate: (b(10) << 12) | (b(11) << 4) | (b(12) >> 4),
    channels: ((b(12) >> 1) & 0x07) + 1,
    bitsPerSample: (((b(12) & 0x01) << 4) | (b(13) >> 4)) + 1,
    totalSamples:
      (b(13) & 0x0f) * 2 ** 32 + b(14) * 2 ** 24 + b(15) * 2 ** 16 + b(16) * 2 ** 8 + b(17),
  };
}

describe("encode_flac_mono (one-shot desk export)", () => {
  beforeAll(async () => {
    await init();
  });

  it("emits a complete mono 24-bit stream with finalized total samples", () => {
    // Not block-aligned: the final short frame must be flushed too.
    const n = RATE + 4_321;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / RATE) * 0.7;

    const flac = encode_flac_mono(samples, RATE, 24);
    const info = readStreamInfo(flac);
    expect(info.sampleRate).toBe(RATE);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(24);
    expect(info.totalSamples).toBe(n); // known up front — never 0/unknown
    // Audio frames follow the header: FLAC frame sync code.
    expect(flac.length).toBeGreaterThan(42);
    expect(flac[42]).toBe(0xff);
    expect((flac[43] as number) & 0xfc).toBe(0xf8);
  });

  it("rejects a bit depth the capture pipeline doesn't speak", () => {
    expect(() => encode_flac_mono(new Float32Array(8), RATE, 12)).toThrow(/bit depth/);
  });
});
