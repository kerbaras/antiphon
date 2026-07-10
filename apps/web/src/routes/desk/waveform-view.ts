// Per-clip waveform VIEW gain: decoded peaks draw peak-normalized per clip
// (shape is real, only vertical scale changes) and the boost is declared
// with a "×N" chip. Playback/alignment/export amplitudes are untouched.

/** Peaks at/below this (−54 dBFS) are treated as silence: no view gain —
 * room hiss must still read as silence, not amplified-to-full noise. */
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
