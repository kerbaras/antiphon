// F18 — waveform view-gain math. The invariants that keep the normalized
// clip drawing honest: silence is never amplified, the boost is capped,
// full-scale audio is untouched, and the ×N chip only appears (and always
// appears) when the boost is significant.

import { describe, expect, it } from "vitest";
import {
  WAVEFORM_GAIN_CHIP_MIN,
  WAVEFORM_SILENCE_FLOOR,
  WAVEFORM_VIEW_MAX_GAIN,
  waveformGainChip,
  waveformViewGain,
} from "./waveform-view";

describe("waveformViewGain", () => {
  it("leaves full-scale audio untouched", () => {
    expect(waveformViewGain([0.2, 1, 0.4])).toBe(1);
    expect(waveformViewGain([0.9, 1.0])).toBe(1);
  });

  it("normalizes a quiet clip to its peak", () => {
    // −20 dBFS take: gain ×10, so the peak bar draws full-height.
    expect(waveformViewGain([0.02, 0.1, 0.05])).toBeCloseTo(10, 10);
    // Barely-quiet audio gets a barely-there gain, not a jump.
    expect(waveformViewGain([0.8])).toBeCloseTo(1.25, 10);
  });

  it("never amplifies silence (floor)", () => {
    expect(waveformViewGain([])).toBe(1);
    expect(waveformViewGain([0, 0, 0])).toBe(1);
    expect(waveformViewGain([WAVEFORM_SILENCE_FLOOR])).toBe(1);
    expect(waveformViewGain([0.001, 0.0015])).toBe(1);
  });

  it("caps the boost so tiny signal stays visibly tiny", () => {
    // Just above the floor: uncapped gain would be ×400.
    expect(waveformViewGain([0.0025])).toBe(WAVEFORM_VIEW_MAX_GAIN);
    expect(waveformViewGain([0.01])).toBe(WAVEFORM_VIEW_MAX_GAIN);
    // 0.05 → ×20, inside the cap.
    expect(waveformViewGain([0.05])).toBeCloseTo(20, 10);
  });
});

describe("waveformGainChip", () => {
  it("stays quiet below the declaration threshold", () => {
    expect(waveformGainChip(1)).toBeNull();
    expect(waveformGainChip(1.9)).toBeNull();
  });

  it("declares significant view gain, rounded for the mono chip", () => {
    expect(waveformGainChip(WAVEFORM_GAIN_CHIP_MIN)).toBe(2);
    expect(waveformGainChip(3.7)).toBe(4);
    expect(waveformGainChip(WAVEFORM_VIEW_MAX_GAIN)).toBe(24);
  });
});
