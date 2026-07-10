// The drift readout tooltip decodes "±ppm · c confidence · off".

import { describe, expect, it } from "vitest";
import type { DriftResult } from "./player";
import { driftTitle } from "./sinks-panel";

const drift = (over: Partial<DriftResult>): DriftResult => ({
  isReference: false,
  ratio: 1,
  ppm: 0,
  initialOffsetSamples: 0,
  confidence: 0,
  windowsUsed: 0,
  applied: false,
  ...over,
});

describe("driftTitle", () => {
  it("explains the reference stream", () => {
    expect(driftTitle(drift({ isReference: true }))).toMatch(/drift reference/);
  });

  it("decodes ppm, confidence and an applied correction", () => {
    const title = driftTitle(drift({ ppm: -3.2, confidence: 0.87, applied: true }));
    expect(title).toContain("-3.2 ppm (parts per million)");
    expect(title).toContain("fit confidence 0.87 of 1");
    expect(title).toContain("correction applied at playback");
  });

  it("explains a bypassed (guard-railed) measurement, signed positive", () => {
    const title = driftTitle(drift({ ppm: 1.5, confidence: 0.12, applied: false }));
    expect(title).toContain("+1.5 ppm");
    expect(title).toContain("played uncorrected");
  });
});
