// Boundary smoke for the pull-driven DriftEstimator: TS slices windows on
// request, wasm measures and fits. Precision is proven in Rust
// (packages/dsp/src/drift.rs); this verifies the JSON contract and that a
// known synthetic drift survives the JS↔wasm round trip.

import { beforeAll, describe, expect, it } from "vitest";
import { DriftEstimator, init } from "../src/index.ts";

const RATE = 16_000;

interface WindowRequest {
  targetStart: number;
  targetLen: number;
  refStart: number;
  refLen: number;
}

interface Estimate {
  ratio: number;
  ppm: number;
  initialOffsetSamples: number;
  confidence: number;
  windowsUsed: number;
  windowsTotal: number;
}

/** Band-limited noise + a tone — smooth enough for linear interpolation. */
function musicLike(len: number, seed: number): Float32Array {
  const out = new Float32Array(len);
  let state = BigInt(seed) | 1n;
  let lp1 = 0;
  let lp2 = 0;
  for (let i = 0; i < len; i++) {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    const noise = Number((state >> 32n) & 0xffffffffn) / 0xffffffff - 0.5;
    lp1 += 0.3 * (noise - lp1);
    lp2 += 0.3 * (lp1 - lp2);
    out[i] = 0.6 * lp2 + 0.08 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  }
  return out;
}

/** y[k] = x((k − offset0)/ratio) by linear interpolation. */
function driftedCopy(src: Float32Array, ratio: number, offset0: number): Float32Array {
  const out = new Float32Array(Math.floor(src.length * ratio));
  for (let k = 0; k < out.length; k++) {
    const pos = (k - offset0) / ratio;
    const i0 = Math.floor(pos);
    if (i0 < 0 || i0 + 1 >= src.length) continue;
    const frac = pos - i0;
    out[k] = (src[i0] as number) * (1 - frac) + (src[i0 + 1] as number) * frac;
  }
  return out;
}

function estimate(reference: Float32Array, target: Float32Array): Estimate {
  const estimator = new DriftEstimator(RATE, reference.length, target.length);
  try {
    for (;;) {
      const reqJson = estimator.next_request_json();
      if (!reqJson) break;
      const req = JSON.parse(reqJson) as WindowRequest;
      estimator.push_window(
        reference.subarray(req.refStart, req.refStart + req.refLen),
        target.subarray(req.targetStart, req.targetStart + req.targetLen),
      );
    }
    return JSON.parse(estimator.estimate_json()) as Estimate;
  } finally {
    estimator.free();
  }
}

beforeAll(async () => {
  await init();
});

describe("DriftEstimator over the wasm boundary", () => {
  it("recovers a synthetic +200 ppm drift", () => {
    const src = musicLike(100 * RATE, 21);
    const tgt = driftedCopy(src, 1 + 200e-6, 5.25);
    const est = estimate(src, tgt);
    expect(Math.abs(est.ppm - 200)).toBeLessThanOrEqual(10);
    expect(Math.abs(est.initialOffsetSamples - 5.25)).toBeLessThanOrEqual(3);
    expect(est.confidence).toBeGreaterThanOrEqual(0.5);
    expect(est.windowsUsed).toBeGreaterThanOrEqual(3);
  });

  it("reports unity for identical streams", () => {
    const src = musicLike(70 * RATE, 33);
    const est = estimate(src, src);
    expect(Math.abs(est.ppm)).toBeLessThan(1);
    expect(est.confidence).toBeGreaterThan(0.9);
  });

  it("rejects window slices that don't match the request", () => {
    const estimator = new DriftEstimator(RATE, 40 * RATE, 40 * RATE);
    try {
      expect(() => estimator.push_window(new Float32Array(8), new Float32Array(8))).toThrow();
    } finally {
      estimator.free();
    }
  });
});
