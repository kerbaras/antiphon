import { describe, expect, it } from "vitest";
import {
  applyEqPatch,
  defaultEq,
  EQ_DB_RANGE,
  EQ_MID_HZ_DEFAULT,
  EQ_MID_HZ_MAX,
  EQ_MID_HZ_MIN,
  formatEqDb,
  formatEqHz,
  midHzToNorm,
  normToMidHz,
} from "./eq";

describe("defaultEq", () => {
  it("is flat, centered, and engaged", () => {
    expect(defaultEq()).toEqual({
      lowDb: 0,
      midDb: 0,
      midHz: EQ_MID_HZ_DEFAULT,
      highDb: 0,
      bypassed: false,
    });
  });

  it("returns a fresh object per call (strips must not share state)", () => {
    expect(defaultEq()).not.toBe(defaultEq());
  });
});

describe("applyEqPatch", () => {
  it("merges partial patches without touching other params", () => {
    const eq = applyEqPatch(defaultEq(), { midDb: -4.5 });
    expect(eq).toEqual({ ...defaultEq(), midDb: -4.5 });
  });

  it("clamps band gains to ±12 dB and midHz to 200–8000 Hz", () => {
    const eq = applyEqPatch(defaultEq(), { lowDb: 99, midDb: -99, midHz: 5, highDb: 12.5 });
    expect(eq.lowDb).toBe(EQ_DB_RANGE);
    expect(eq.midDb).toBe(-EQ_DB_RANGE);
    expect(eq.midHz).toBe(EQ_MID_HZ_MIN);
    expect(eq.highDb).toBe(EQ_DB_RANGE);
    expect(applyEqPatch(defaultEq(), { midHz: 1e9 }).midHz).toBe(EQ_MID_HZ_MAX);
  });

  it("never mutates its input and round-trips through snapshots", () => {
    const original = defaultEq();
    const patched = applyEqPatch(original, { lowDb: 6, midHz: 400 });
    expect(original).toEqual(defaultEq());
    // Re-applying the stored state as a patch reproduces it exactly.
    expect(applyEqPatch(defaultEq(), patched)).toEqual(patched);
  });

  it("preserves bypass through band edits (bypass is a routing flag)", () => {
    const bypassed = { ...defaultEq(), bypassed: true };
    expect(applyEqPatch(bypassed, { highDb: 3 }).bypassed).toBe(true);
  });
});

describe("mid-frequency log mapping", () => {
  it("maps the endpoints to 0 and 1", () => {
    expect(midHzToNorm(EQ_MID_HZ_MIN)).toBe(0);
    expect(midHzToNorm(EQ_MID_HZ_MAX)).toBe(1);
    expect(normToMidHz(0)).toBeCloseTo(EQ_MID_HZ_MIN, 9);
    expect(normToMidHz(1)).toBeCloseTo(EQ_MID_HZ_MAX, 9);
  });

  it("is log-scaled: equal norm steps are equal frequency ratios", () => {
    const r1 = normToMidHz(0.5) / normToMidHz(0.25);
    const r2 = normToMidHz(0.75) / normToMidHz(0.5);
    expect(r1).toBeCloseTo(r2, 9);
  });

  it("round-trips across the sweep range", () => {
    for (const hz of [200, 397, 1_000, 2_500, 8_000]) {
      expect(normToMidHz(midHzToNorm(hz))).toBeCloseTo(hz, 6);
    }
  });

  it("clamps out-of-range inputs instead of extrapolating", () => {
    expect(normToMidHz(-1)).toBe(EQ_MID_HZ_MIN);
    expect(normToMidHz(2)).toBe(EQ_MID_HZ_MAX);
    expect(midHzToNorm(1)).toBe(0);
    expect(midHzToNorm(1e6)).toBe(1);
  });
});

describe("readout formatting", () => {
  it("signs dB with a typographic minus and one decimal", () => {
    expect(formatEqDb(0)).toBe("0.0");
    expect(formatEqDb(4.5)).toBe("+4.5");
    expect(formatEqDb(-12)).toBe("−12.0");
  });

  it("abbreviates kilohertz", () => {
    expect(formatEqHz(200)).toBe("200");
    expect(formatEqHz(397.4)).toBe("397");
    expect(formatEqHz(1_000)).toBe("1.0k");
    expect(formatEqHz(8_000)).toBe("8.0k");
  });
});

// ---- transparency at 0 dB ---------------------------------------------------
// The EQ inserts its biquads even at flat settings (only bypass reroutes the
// signal path), so "0 dB is transparent" must hold EXACTLY. The Web Audio
// spec's shelf/peaking coefficients (RBJ cookbook) collapse at A = 1 to
// numerator === denominator, term for term, in exact IEEE arithmetic — which
// makes the normalized filter y[n] = x[n] by induction. This test documents
// and pins that expectation; e2e/tests/eq.spec.ts verifies it byte-for-byte
// against real Chromium renders.

interface Coeffs {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

const SHELF_S = 1;

/** Web Audio spec lowshelf coefficients (S = 1), gain in dB. */
function lowshelf(f: number, fs: number, db: number): Coeffs {
  const A = 10 ** (db / 40);
  const w = (2 * Math.PI * f) / fs;
  const alpha = (Math.sin(w) / 2) * Math.sqrt((A + 1 / A) * (1 / SHELF_S - 1) + 2);
  const cosw = Math.cos(w);
  return {
    b0: A * (A + 1 - (A - 1) * cosw + 2 * Math.sqrt(A) * alpha),
    b1: 2 * A * (A - 1 - (A + 1) * cosw),
    b2: A * (A + 1 - (A - 1) * cosw - 2 * Math.sqrt(A) * alpha),
    a0: A + 1 + (A - 1) * cosw + 2 * Math.sqrt(A) * alpha,
    a1: -2 * (A - 1 + (A + 1) * cosw),
    a2: A + 1 + (A - 1) * cosw - 2 * Math.sqrt(A) * alpha,
  };
}

/** Web Audio spec highshelf coefficients (S = 1), gain in dB. */
function highshelf(f: number, fs: number, db: number): Coeffs {
  const A = 10 ** (db / 40);
  const w = (2 * Math.PI * f) / fs;
  const alpha = (Math.sin(w) / 2) * Math.sqrt((A + 1 / A) * (1 / SHELF_S - 1) + 2);
  const cosw = Math.cos(w);
  return {
    b0: A * (A + 1 + (A - 1) * cosw + 2 * Math.sqrt(A) * alpha),
    b1: -2 * A * (A - 1 + (A + 1) * cosw),
    b2: A * (A + 1 + (A - 1) * cosw - 2 * Math.sqrt(A) * alpha),
    a0: A + 1 - (A - 1) * cosw + 2 * Math.sqrt(A) * alpha,
    a1: 2 * (A - 1 - (A + 1) * cosw),
    a2: A + 1 - (A - 1) * cosw - 2 * Math.sqrt(A) * alpha,
  };
}

/** Web Audio spec peaking coefficients, gain in dB. */
function peaking(f: number, fs: number, q: number, db: number): Coeffs {
  const A = 10 ** (db / 40);
  const w = (2 * Math.PI * f) / fs;
  const alpha = Math.sin(w) / (2 * q);
  const cosw = Math.cos(w);
  return {
    b0: 1 + alpha * A,
    b1: -2 * cosw,
    b2: 1 - alpha * A,
    a0: 1 + alpha / A,
    a1: -2 * cosw,
    a2: 1 - alpha / A,
  };
}

describe("biquad transparency at 0 dB (documented expectation)", () => {
  const fs = 48_000;
  const cases: Array<[string, Coeffs]> = [
    ["lowshelf @120", lowshelf(120, fs, 0)],
    ["highshelf @8k", highshelf(8_000, fs, 0)],
    ["peaking @1k Q1", peaking(1_000, fs, 1, 0)],
    ["peaking @200 Q1", peaking(200, fs, 1, 0)],
    ["peaking @8k Q1", peaking(8_000, fs, 1, 0)],
  ];

  it.each(cases)("%s: numerator equals denominator bit-for-bit", (_name, c) => {
    expect(c.b0).toBe(c.a0);
    expect(c.b1).toBe(c.a1);
    expect(c.b2).toBe(c.a2);
  });

  it.each(cases)("%s: the normalized filter passes float samples bit-exactly", (_name, c) => {
    // Model the real engine: direct form I, double accumulator, float I/O
    // (Blink's biquad). With b=a the accumulator only carries associativity
    // noise (~1e-15, ≪ half a float ulp ≪ one 24-bit LSB), so the float
    // output — and therefore the exported WAV — reproduces the input
    // bit-for-bit. Deterministic seed: this is a pinned example, not fuzz.
    const b0 = c.b0 / c.a0;
    const b1 = c.b1 / c.a0;
    const b2 = c.b2 / c.a0;
    const a1 = c.a1 / c.a0;
    const a2 = c.a2 / c.a0;
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    let seed = 42;
    for (let n = 0; n < 512; n++) {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      const x = Math.fround(seed / 0x40000000 - 1);
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      expect(Math.abs(y - x)).toBeLessThan(1e-12);
      expect(Math.fround(y)).toBe(x);
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
    }
  });

  it("non-zero gain is NOT transparent (the identity is specific to 0 dB)", () => {
    const c = lowshelf(120, fs, 12);
    expect(c.b0).not.toBe(c.a0);
  });
});
