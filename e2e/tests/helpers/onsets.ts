// Beep-onset analysis shared by the signal-level playback specs (W4-A's
// playback-gapless pattern, extracted for W6-B's session-playback spec).
// The fake mic emits ~200 ms clipped pulse bursts every ~500 ms; onsets
// make any dropped, duplicated or mis-placed span a measurable error.

import { expect } from "@playwright/test";
import { parseWav } from "./files";

/** Beep onsets (sample indices) of a mono signal. Two passes: a 10 ms peak
 * envelope finds blocks where a beep starts after ≥240 ms of quiet, then
 * the onset refines to the first sample exceeding 0.35 — sample-precise
 * and deterministic. Kept as source text so page and Node analyses run the
 * IDENTICAL algorithm. */
export const ONSETS_SRC = `(data) => {
  const B = 480;
  const blocks = Math.floor(data.length / B);
  const env = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let peak = 0;
    for (let i = b * B; i < (b + 1) * B; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    env[b] = peak;
  }
  const onsets = [];
  for (let b = 1; b < blocks; b++) {
    if (env[b] <= 0.35 || env[b - 1] > 0.35) continue;
    let quiet = true;
    for (let k = Math.max(0, b - 25); k < b - 1; k++) {
      if (env[k] >= 0.05) { quiet = false; break; }
    }
    if (!quiet) continue;
    for (let i = (b - 1) * B; i < (b + 1) * B; i++) {
      if (Math.abs(data[i]) > 0.35) { onsets.push(i); break; }
    }
  }
  return onsets;
}`;

/** The same detector, callable in Node (exported WAV analysis). */
export const findOnsets = new Function(`return ${ONSETS_SRC}`)() as (
  data: Float32Array | number[],
) => number[];

/** Channel-0 float samples of a 24-bit integer PCM WAV. */
export function wavChannel0(bytes: Buffer): number[] {
  const info = parseWav(bytes);
  expect(info.bitDepth).toBe(24);
  const frameBytes = info.channels * 3;
  const frames = (bytes.length - 44) / frameBytes;
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    const at = 44 + i * frameBytes;
    let v =
      (bytes[at] as number) | ((bytes[at + 1] as number) << 8) | ((bytes[at + 2] as number) << 16);
    if (v >= 1 << 23) v -= 1 << 24;
    out.push(v / (1 << 23));
  }
  return out;
}
