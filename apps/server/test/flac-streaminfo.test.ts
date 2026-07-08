// QA #27 server side: served FLAC reconstructions get their STREAMINFO
// finalized with the served sample count. Layout under test is the 42-byte
// bootstrap emitted by packages/codec codec_header(): fLaC + metadata block
// header + 34-byte STREAMINFO, total-samples = 36 bits at body offset 13.4.
// Mirror of the web's unit suite (apps/web/src/audio/flac-streaminfo.test.ts)
// — the two implementations must stay bit-identical.

import { describe, expect, it } from "vitest";
import { withTotalSamples } from "../src/flac-streaminfo.ts";

/** Mirror of codec_header() for rate 48000 / 24-bit / mono. */
function bootstrapHeader(): Uint8Array {
  const out: number[] = [];
  out.push(0x66, 0x4c, 0x61, 0x43); // fLaC
  out.push(0x80, 0x00, 0x00, 0x22); // last block, type 0, len 34
  out.push(0x10, 0x00, 0x10, 0x00); // min/max block size 4096
  out.push(0, 0, 0, 0, 0, 0); // min/max frame size unknown
  const rate = 48_000;
  const bpsM1 = 23;
  out.push((rate >> 12) & 0xff, (rate >> 4) & 0xff);
  out.push(((rate & 0xf) << 4) | (0 << 1) | (bpsM1 >> 4));
  out.push((bpsM1 & 0xf) << 4); // + total-samples top 4 bits = 0
  out.push(0, 0, 0, 0); // total samples unknown
  for (let i = 0; i < 16; i++) out.push(0); // md5 unknown
  return new Uint8Array(out);
}

function readTotalSamples(header: Uint8Array): number {
  const hi = (header[21] as number) & 0x0f;
  return (
    hi * 2 ** 32 +
    ((header[22] as number) * 2 ** 24 +
      (header[23] as number) * 2 ** 16 +
      (header[24] as number) * 2 ** 8 +
      (header[25] as number))
  );
}

describe("withTotalSamples (QA #27, server mirror)", () => {
  it("patches only the 36-bit total-samples field", () => {
    const original = bootstrapHeader();
    const patched = withTotalSamples(original, 115_200); // 2.4s at 48k
    expect(readTotalSamples(patched)).toBe(115_200);
    // Everything else — magic, block sizes, rate/bps packing, md5 — intact.
    for (let i = 0; i < 42; i++) {
      if (i === 21) {
        expect((patched[i] as number) & 0xf0).toBe((original[i] as number) & 0xf0);
      } else if (i < 22 || i > 25) {
        expect(patched[i]).toBe(original[i]);
      }
    }
    // Input untouched (the caller may hold shared bytes).
    expect(readTotalSamples(original)).toBe(0);
  });

  it("handles counts above 2^32 (36-bit field)", () => {
    const patched = withTotalSamples(bootstrapHeader(), 5 * 2 ** 32 + 7);
    expect(readTotalSamples(patched)).toBe(5 * 2 ** 32 + 7);
  });

  it("refuses rather than corrupts: bad layout or out-of-range counts", () => {
    const short = new Uint8Array(10);
    expect(withTotalSamples(short, 100)).toBe(short);
    const header = bootstrapHeader();
    expect(withTotalSamples(header, -1)).toBe(header);
    expect(withTotalSamples(header, 2 ** 36)).toBe(header);
    expect(withTotalSamples(header, 1.5)).toBe(header);
  });
});
