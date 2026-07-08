import { describe, expect, it } from "vitest";
import { encodeWav } from "./wav";

describe("encodeWav", () => {
  it("emits golden bytes for a 24-bit 48 kHz stereo file", () => {
    const wav = encodeWav([new Float32Array([0, 0.5]), new Float32Array([-0.5, 1])], 48_000, 24);
    // Canonical RIFF/WAVE, hand-computed byte for byte.
    expect([...new Uint8Array(wav)]).toEqual([
      // "RIFF", riff size = 36 + data(12) = 48, "WAVE"
      0x52, 0x49, 0x46, 0x46, 48, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
      // "fmt ", size 16, PCM(1), 2 channels
      0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 2, 0,
      // 48 000 Hz, byte rate 288 000, block align 6, 24 bits
      0x80, 0xbb, 0, 0, 0x00, 0x65, 0x04, 0, 6, 0, 24, 0,
      // "data", size 12
      0x64, 0x61, 0x74, 0x61, 12, 0, 0, 0,
      // frame 0: L 0 → 0x000000, R −0.5 → −4 194 303 = 0xC00001 (LE)
      0, 0, 0, 0x01, 0x00, 0xc0,
      // frame 1: L 0.5 → 4 194 304 = 0x400000, R 1 → 8 388 607 = 0x7FFFFF
      0x00, 0x00, 0x40, 0xff, 0xff, 0x7f,
    ]);
  });

  it("supports the optional 16-bit depth", () => {
    const wav = new Uint8Array(encodeWav([new Float32Array([-1, 0.25])], 44_100, 16));
    const view = new DataView(wav.buffer);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4); // data size
    expect(view.getInt16(44, true)).toBe(-32_767);
    expect(view.getInt16(46, true)).toBe(8_192);
  });

  it("clamps out-of-range samples instead of wrapping", () => {
    const wav = new Uint8Array(encodeWav([new Float32Array([2, -2])], 48_000, 16));
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(32_767);
    expect(view.getInt16(46, true)).toBe(-32_767);
  });

  it("rejects empty or ragged channel sets", () => {
    expect(() => encodeWav([], 48_000)).toThrow(/no channels/);
    expect(() => encodeWav([new Float32Array(2), new Float32Array(3)], 48_000)).toThrow(
      /lengths differ/,
    );
  });
});
