// SharedArrayBuffer ring shared by the capture worklet (writer, plain JS in
// public/worklets/capture.js — keep layouts in sync) and the encoder worker
// (reader). Atomics on the header give release/acquire visibility for the
// plain Float32 sample writes. Requires cross-origin isolation (COOP/COEP,
// enforced in vite.config.ts and public/_headers).

export const RING_HEADER_BYTES = 32;

// Int32Array header slots (u32-wrapping semantics via >>> 0):
const WRITE_IDX = 0; // worklet-owned: absolute samples written
const READ_IDX = 1; // worker-owned: absolute samples consumed
const DROPPED = 2; // worklet: samples dropped on overflow (encoder stall)
const EMPTY_QUANTA = 3; // worklet: process() calls with no input
const QUANTA = 4; // worklet: quanta written

export function createCaptureRing(capacitySamples: number): SharedArrayBuffer {
  return new SharedArrayBuffer(RING_HEADER_BYTES + capacitySamples * 4);
}

export interface RingDiagnostics {
  depth: number;
  capacity: number;
  droppedSamples: number;
  emptyQuanta: number;
  quantaWritten: number;
}

/** Reader side. Single consumer — the encoder worker. */
export class CaptureRingReader {
  private readonly header: Int32Array;
  private readonly data: Float32Array;
  private readonly capacity: number;

  constructor(sab: SharedArrayBuffer) {
    this.header = new Int32Array(sab, 0, 8);
    this.data = new Float32Array(sab, RING_HEADER_BYTES);
    this.capacity = this.data.length;
  }

  available(): number {
    const write = Atomics.load(this.header, WRITE_IDX) >>> 0;
    const read = Atomics.load(this.header, READ_IDX) >>> 0;
    return (write - read) >>> 0;
  }

  /**
   * Snap the read cursor to "now": everything already in the ring is
   * discarded. Sample index 0 of a take is the first sample read after this.
   */
  snapToWrite(): void {
    const write = Atomics.load(this.header, WRITE_IDX);
    Atomics.store(this.header, READ_IDX, write);
  }

  /**
   * Zero the worklet's overflow counter (called on arm: each take starts
   * with a clean fault ledger, F4). The worklet only `Atomics.add`s this
   * slot while the ring is FULL — which the idle drain prevents — so a
   * plain store cannot race away a meaningful count.
   */
  resetDropped(): void {
    Atomics.store(this.header, DROPPED, 0);
  }

  /** Copy up to `max` available samples into a fresh array. */
  read(max: number): Float32Array {
    const n = Math.min(this.available(), max);
    const out = new Float32Array(n);
    if (n === 0) return out;
    const read = Atomics.load(this.header, READ_IDX) >>> 0;
    const pos = read % this.capacity;
    const first = Math.min(n, this.capacity - pos);
    out.set(this.data.subarray(pos, pos + first), 0);
    if (n > first) out.set(this.data.subarray(0, n - first), first);
    Atomics.store(this.header, READ_IDX, (read + n) | 0);
    return out;
  }

  diagnostics(): RingDiagnostics {
    return {
      depth: this.available(),
      capacity: this.capacity,
      droppedSamples: Atomics.load(this.header, DROPPED) >>> 0,
      emptyQuanta: Atomics.load(this.header, EMPTY_QUANTA) >>> 0,
      quantaWritten: Atomics.load(this.header, QUANTA) >>> 0,
    };
  }
}

/**
 * VU ballistics shared by the armed and idle drain paths (F4: the meter is
 * live whenever the mic is, not only while a take rolls): fast attack to
 * the slab's absolute peak, exponential release at 0.6/pump.
 */
export function decayedPeak(previous: number, slab: Float32Array): number {
  let slabPeak = 0;
  for (let i = 0; i < slab.length; i++) {
    const v = Math.abs(slab[i] as number);
    if (v > slabPeak) slabPeak = v;
  }
  return Math.max(previous * 0.6, slabPeak);
}
