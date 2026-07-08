// F4 idle-drain math: with the reader draining every pump — armed or not —
// the worklet never overflows (drop counter stays 0) and the meter keeps
// updating; arm discards the (near-empty) remainder so a take's sample 0 is
// the arm point. The writer below mirrors public/worklets/capture.js
// byte-for-byte (drop-new-on-overflow, wrapping u32 cursors).

import { describe, expect, it } from "vitest";
import { CaptureRingReader, createCaptureRing, decayedPeak, RING_HEADER_BYTES } from "./sab-ring";

/** The worklet's process() write path (keep in sync with capture.js). */
function workletWrite(sab: SharedArrayBuffer, quantum: Float32Array): boolean {
  const header = new Int32Array(sab, 0, 8);
  const data = new Float32Array(sab, RING_HEADER_BYTES);
  const capacity = data.length;
  const write = Atomics.load(header, 0) >>> 0;
  const read = Atomics.load(header, 1) >>> 0;
  const used = (write - read) >>> 0;
  if (used + quantum.length > capacity) {
    Atomics.add(header, 2, quantum.length);
    return false;
  }
  const pos = write % capacity;
  const first = Math.min(quantum.length, capacity - pos);
  for (let i = 0; i < first; i++) data[pos + i] = quantum[i] as number;
  for (let i = first; i < quantum.length; i++) data[i - first] = quantum[i] as number;
  Atomics.store(header, 0, (write + quantum.length) | 0);
  Atomics.add(header, 4, 1);
  return true;
}

function quantum(fill: number, n = 128): Float32Array {
  return new Float32Array(n).fill(fill);
}

describe("capture ring idle drain (F4)", () => {
  it("continuous read-and-drop keeps the ring near-empty and drops at 0", () => {
    const sab = createCaptureRing(1_024); // deliberately tiny: 8 quanta
    const reader = new CaptureRingReader(sab);
    // Simulate 100 pump intervals: ~37 quanta in per drain (4.7k samples at
    // 48k/100ms scaled down), one bounded read out.
    for (let pumpTick = 0; pumpTick < 100; pumpTick++) {
      for (let q = 0; q < 6; q++) workletWrite(sab, quantum(0.25));
      const slab = reader.read(2_048);
      expect(slab.length).toBeGreaterThan(0);
      expect(decayedPeak(0, slab)).toBeCloseTo(0.25);
    }
    const diag = reader.diagnostics();
    expect(diag.droppedSamples).toBe(0);
    expect(diag.depth).toBe(0);
    expect(diag.quantaWritten).toBe(600);
  });

  it("WITHOUT the drain the worklet drops loudly — the F4 failure mode", () => {
    const sab = createCaptureRing(1_024);
    const reader = new CaptureRingReader(sab);
    for (let q = 0; q < 12; q++) workletWrite(sab, quantum(0.5));
    const diag = reader.diagnostics();
    expect(diag.depth).toBe(1_024); // full
    expect(diag.droppedSamples).toBe(4 * 128); // everything past capacity
  });

  it("snapToWrite + resetDropped: a take starts at the arm point with a clean ledger", () => {
    const sab = createCaptureRing(1_024);
    const reader = new CaptureRingReader(sab);
    // Pre-arm room audio, including overflow drops.
    for (let q = 0; q < 12; q++) workletWrite(sab, quantum(0.9));
    expect(reader.diagnostics().droppedSamples).toBeGreaterThan(0);

    // Arm: discard the backlog, zero the counter (doArm's exact sequence).
    reader.snapToWrite();
    reader.resetDropped();
    expect(reader.diagnostics().depth).toBe(0);
    expect(reader.diagnostics().droppedSamples).toBe(0);

    // Only post-arm samples ever reach the take.
    workletWrite(sab, quantum(0.125));
    const slab = reader.read(2_048);
    expect(slab.length).toBe(128);
    expect(Array.from(slab).every((v) => v === 0.125)).toBe(true);
  });

  it("survives cursor wraparound across the ring boundary", () => {
    const sab = createCaptureRing(300); // NOT a multiple of the quantum
    const reader = new CaptureRingReader(sab);
    for (let round = 0; round < 50; round++) {
      workletWrite(sab, quantum(round / 100, 128));
      const slab = reader.read(1_000);
      expect(slab.length).toBe(128);
      expect(slab[0]).toBeCloseTo(round / 100);
    }
    expect(reader.diagnostics().droppedSamples).toBe(0);
  });
});

describe("decayedPeak (VU ballistics)", () => {
  it("attacks to the slab peak and releases exponentially", () => {
    const loud = new Float32Array([0.1, -0.8, 0.3]);
    expect(decayedPeak(0, loud)).toBeCloseTo(0.8);
    // Quiet slabs: release at 0.6/pump, never below the new content.
    const quiet = new Float32Array([0.01, -0.02]);
    expect(decayedPeak(0.8, quiet)).toBeCloseTo(0.48);
    expect(decayedPeak(0.05, quiet)).toBeCloseTo(0.03);
    // Empty slab (no input quanta): pure release.
    expect(decayedPeak(0.5, new Float32Array(0))).toBeCloseTo(0.3);
  });
});
