import { describe, expect, it } from "vitest";
import { gzip } from "./gzip";

// Node ≥ 18 ships the same CompressionStream/DecompressionStream globals
// the browser has, so the round trip here runs the real implementation.

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("gzip", () => {
  it("emits a gzip member (magic + deflate method)", async () => {
    const out = await gzip(new TextEncoder().encode("<xml />"));
    expect(out[0]).toBe(0x1f);
    expect(out[1]).toBe(0x8b);
    expect(out[2]).toBe(0x08); // CM = deflate
  });

  it("round-trips bytes exactly", async () => {
    const original = new TextEncoder().encode(
      `<?xml version="1.0"?>\n<Ableton>\n\t<LiveSet />\n</Ableton>\n`.repeat(100),
    );
    const back = await gunzip(await gzip(original));
    expect(back).toEqual(original);
  });

  it("handles empty input", async () => {
    expect(await gunzip(await gzip(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });
});
