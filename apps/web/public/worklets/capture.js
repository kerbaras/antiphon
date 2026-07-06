// Antiphon capture worklet. This file stays ~50 lines, forever.
//
// Copy input quanta into the SharedArrayBuffer ring, bump the atomic write
// index, nothing else. No allocation after construction, no WASM, no
// encoding on the audio thread. Layout must match src/audio/sab-ring.ts
// (HEADER: 0=write idx, 1=read idx, 2=dropped samples, 3=empty quanta,
// 4=quanta written; all u32-wrapping; data = Float32 after 32-byte header).
//
// Overflow policy: if the encoder worker stalls until the ring fills, new
// samples are DROPPED and counted loudly — never silently overwritten, so
// already-buffered audio stays intact and the fault is visible in the UI.

class AntiphonCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sab = options.processorOptions.sab;
    this.header = new Int32Array(sab, 0, 8);
    this.data = new Float32Array(sab, 32);
    this.capacity = this.data.length;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) {
      Atomics.add(this.header, 3, 1);
      return true;
    }
    const write = Atomics.load(this.header, 0) >>> 0;
    const read = Atomics.load(this.header, 1) >>> 0;
    const used = (write - read) >>> 0;
    if (used + channel.length > this.capacity) {
      Atomics.add(this.header, 2, channel.length);
      return true;
    }
    const pos = write % this.capacity;
    const first = Math.min(channel.length, this.capacity - pos);
    for (let i = 0; i < first; i++) this.data[pos + i] = channel[i];
    for (let i = first; i < channel.length; i++) this.data[i - first] = channel[i];
    Atomics.store(this.header, 0, (write + channel.length) | 0);
    Atomics.add(this.header, 4, 1);
    return true;
  }
}

registerProcessor("antiphon-capture", AntiphonCapture);
