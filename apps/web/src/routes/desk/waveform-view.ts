// F18 — per-clip waveform VIEW gain. Two waveform sources feed the clips:
// the live take draws the encoder's signal-complexity proxy (self-scaled to
// the clip height by construction — it has no amplitude axis at all), and
// completed streams draw true decoded peaks. Drawing the decoded peaks at
// ABSOLUTE amplitude made every quiet take "collapse" the moment it
// finished: tall proxy → flat dotted strip, which QA read as data loss.
//
// The honest fix (design-system rule: never fake, always say so): draw the
// decoded waveform peak-normalized per clip — the shape is real, only the
// vertical scale changes — and DECLARE the view gain with a dim mono "×N"
// chip once the boost is significant. Two guards keep it truthful:
//   · silence floor: near-silence (≤ −54 dBFS) is NOT normalized — a take
//     of room hiss must still read as silence, not amplified-to-full noise;
//   · gain cap: the boost never exceeds ×24 (+27.6 dB), so genuinely tiny
//     signal stays visibly tiny even in the normalized view.
// Amplitude ground truth remains one hover away (load the take → mixer VU)
// and untouched everywhere it matters: playback, alignment, exports.

/** Peaks at/below this (−54 dBFS) are treated as silence: no view gain. */
export const WAVEFORM_SILENCE_FLOOR = 0.002;

/** View gain never exceeds ×24 (+27.6 dB) — quiet stays visibly quiet. */
export const WAVEFORM_VIEW_MAX_GAIN = 24;

/** The "×N" chip appears once the view gain reaches ×2 (+6 dB). */
export const WAVEFORM_GAIN_CHIP_MIN = 2;

/** Per-clip view gain for a decoded waveform: 1 for silence/empty/already-
 * full-scale data, else min(1/peak, cap). Pure — drawing multiplies each
 * bar by this and clamps to 1. */
export function waveformViewGain(energy: readonly number[]): number {
  let peak = 0;
  for (const v of energy) {
    if (v > peak) peak = v;
  }
  if (peak <= WAVEFORM_SILENCE_FLOOR || peak >= 1) return 1;
  return Math.min(WAVEFORM_VIEW_MAX_GAIN, 1 / peak);
}

/** The chip's integer label for a view gain, or null when the boost is too
 * small to bother declaring (< ×2). */
export function waveformGainChip(gain: number): number | null {
  return gain >= WAVEFORM_GAIN_CHIP_MIN ? Math.round(gain) : null;
}
