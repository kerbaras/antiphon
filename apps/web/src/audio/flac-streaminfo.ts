// STREAMINFO finalization for locally-exported rehearse FLACs. The streaming
// codec bootstrap writes total-samples = 0 ("unknown"); the local export is
// assembled client-side, so its header copy can carry the real count.

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
