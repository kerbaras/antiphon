// STREAMINFO finalization for server-assembled FLACs (QA #27, server side).
//
// The streaming encoder's codec bootstrap (packages/codec codec_header())
// necessarily writes total-samples = 0 ("unknown" per the FLAC spec) — no
// frame exists yet when it is emitted. Without a real count, players show
// no duration and ffprobe estimates a wrong one from bitrate.
//
// RFC 0001 §13 rules that sinks MUST NOT transcode or resample stored
// chunks — and this does neither: chunk blobs are immutable protocol bytes
// and stay byte-identical in the store. Only the ASSEMBLED download copy
// (reconstructFlac output) has its header field set to the length the
// served file truly has. A metadata field describing the audio is not an
// audio transform: no sample is decoded, re-encoded, or touched.
//
// Byte-for-byte mirror of the web's local-export finalization
// (apps/web/src/audio/flac-streaminfo.ts, read-only reference).

/** `fLaC` magic (4) + metadata block header (4) + STREAMINFO body (34). */
const STREAMINFO_HEADER_BYTES = 42;

/**
 * Return a copy of `header` with the STREAMINFO total-samples field (36
 * bits: low nibble of body byte 13, then bytes 14..17) set. Unknown layouts
 * or out-of-range counts return the header untouched — a wrong length would
 * be worse than an unknown one.
 */
export function withTotalSamples(header: Uint8Array, totalSamples: number): Uint8Array {
  if (
    header.byteLength !== STREAMINFO_HEADER_BYTES ||
    !Number.isInteger(totalSamples) ||
    totalSamples < 0 ||
    totalSamples >= 2 ** 36
  ) {
    return header;
  }
  const out = header.slice();
  const hi = Math.floor(totalSamples / 2 ** 32); // bits 35..32
  const lo = totalSamples % 2 ** 32; // bits 31..0
  out[21] = ((out[21] as number) & 0xf0) | hi; // body byte 13: bps low nibble kept
  out[22] = (lo >>> 24) & 0xff;
  out[23] = (lo >>> 16) & 0xff;
  out[24] = (lo >>> 8) & 0xff;
  out[25] = lo & 0xff;
  return out;
}
