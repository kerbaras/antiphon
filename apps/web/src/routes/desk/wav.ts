// Dependency-free PCM WAV writer: canonical 44-byte RIFF/WAVE header +
// interleaved little-endian integer samples. 24-bit is the deliverable
// (mastering-grade, matches the 48 kHz render); 16-bit kept as an option.

export type WavBitDepth = 16 | 24;

/** Encode deinterleaved float channels (equal length, −1..1, clamped) into
 * a complete WAV file. */
export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: WavBitDepth = 24,
): ArrayBuffer {
  const first = channels[0];
  if (!first) throw new Error("encodeWav: no channels");
  const frames = first.length;
  if (channels.some((c) => c.length !== frames)) {
    throw new Error("encodeWav: channel lengths differ");
  }
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels.length * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // audio format: integer PCM
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Symmetric full-scale (±(2^(n−1)−1)): clipping clamps, silence is 0.
  const peak = bitDepth === 24 ? 8_388_607 : 32_767;
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (const channel of channels) {
      const sample = Math.round(Math.max(-1, Math.min(1, channel[i] as number)) * peak);
      if (bitDepth === 24) {
        view.setUint8(offset, sample & 0xff);
        view.setUint8(offset + 1, (sample >> 8) & 0xff);
        view.setUint8(offset + 2, (sample >> 16) & 0xff);
        offset += 3;
      } else {
        view.setInt16(offset, sample, true);
        offset += 2;
      }
    }
  }
  return buffer;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
