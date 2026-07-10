// Calibration chirp playback (RFC §10): synthesize via wasm, schedule the
// repeats on the desk's output, and announce the emit timestamp to the room.

import { generate_chirp, init as initWasm } from "@antiphon/core-wasm";
import { DEFAULT_CHIRP_SPEC } from "@antiphon/protocol";
import type { SignalingClient } from "./signaling-client";

export async function playCalibrationChirp(
  getContext: () => AudioContext,
  signaling: SignalingClient,
): Promise<void> {
  await initWasm();
  const spec = DEFAULT_CHIRP_SPEC;
  const context = getContext();
  await context.resume();
  const samples = generate_chirp(
    context.sampleRate,
    spec.startHz,
    spec.endHz,
    spec.durationMs,
    spec.gainDbfs,
  );
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(new Float32Array(samples), 0);
  const startAt = context.currentTime + 0.15;
  for (let i = 0; i < spec.repeats; i++) {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(startAt + (i * (spec.durationMs + spec.gapMs)) / 1_000);
  }
  signaling.send({
    v: 1,
    type: "calibration-chirp",
    chirpId: crypto.randomUUID(),
    emitTsDeskUs: Math.round((performance.timeOrigin + performance.now()) * 1_000),
    spec,
  });
}
