// FLAC download filename rules (F14 + the wave-2 unlabeled-peer fallback):
// nickname > device family > full uuid, with the RFC 6266/5987 encoding
// path for anything the plain quoted-string can't carry.

import { describe, expect, it } from "vitest";
import { deviceName, flacContentDisposition } from "../src/download-name.ts";

const STREAM_ID = "3f2a1b8c-9d4e-4f6a-8b7c-0123456789ab";
const ID8 = "3f2a1b8c";

describe("deviceName (desk track-model.ts mirror)", () => {
  it("extracts the device family the desk titles lanes with", () => {
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)")).toBe("iPhone");
    expect(deviceName("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)")).toBe("iPad");
    expect(deviceName("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("Android");
    expect(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Macintosh");
    expect(deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows");
    expect(deviceName("fake-recorder")).toBe("Browser");
    expect(deviceName("")).toBe("Browser");
  });
});

describe("flacContentDisposition", () => {
  it("labeled peer: fileSafe nickname + short id (F14, unchanged)", () => {
    expect(flacContentDisposition(STREAM_ID, { label: "Alto Sax!", userAgent: "x" })).toBe(
      `attachment; filename="Alto-Sax-${ID8}.flac"`,
    );
  });

  it("non-ASCII label: RFC 6266/5987 filename* path (F14, unchanged)", () => {
    expect(flacContentDisposition(STREAM_ID, { label: "Zoë 🎤", userAgent: "x" })).toBe(
      `attachment; filename="Zo-${ID8}.flac"; filename*=UTF-8''Zo%C3%AB-${ID8}.flac`,
    );
  });

  it("unlabeled peer: device family + short id, not a raw uuid", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1";
    expect(flacContentDisposition(STREAM_ID, { label: null, userAgent: ua })).toBe(
      `attachment; filename="iPhone-${ID8}.flac"`,
    );
    // Whitespace-only labels count as unlabeled, like the desk's lane title.
    expect(flacContentDisposition(STREAM_ID, { label: "   ", userAgent: ua })).toBe(
      `attachment; filename="iPhone-${ID8}.flac"`,
    );
    // Unrecognized userAgent still beats a raw uuid.
    expect(flacContentDisposition(STREAM_ID, { label: null, userAgent: "curl/8.0" })).toBe(
      `attachment; filename="Browser-${ID8}.flac"`,
    );
  });

  it("no peer attribution at all: the historical full-uuid name", () => {
    expect(flacContentDisposition(STREAM_ID, null)).toBe(
      `attachment; filename="${STREAM_ID}.flac"`,
    );
  });
});
