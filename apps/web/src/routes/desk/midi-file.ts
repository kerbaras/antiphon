// Standard MIDI File writer — format 0, one track. 480 TPQN at a fixed
// 500 000 µs/quarter (120 BPM, purely a time base) ⇒ tick = round(atSec × 960).
// Running status deliberately NOT used: every event carries its status byte.

import { type MidiEvent, midiDataBytes, sortMidiEvents } from "./midi";

export const MIDI_TPQN = 480;
export const MIDI_TEMPO_US_PER_QUARTER = 500_000; // 120 BPM
export const MIDI_TICKS_PER_SECOND = (MIDI_TPQN * 1_000_000) / MIDI_TEMPO_US_PER_QUARTER; // 960

export function secondsToTicks(atSec: number): number {
  return Math.round(atSec * MIDI_TICKS_PER_SECOND);
}

/** SMF variable-length quantity: 7 bits per byte, high bit = continuation,
 * big-endian, 1–4 bytes (max 0x0FFFFFFF ≈ 77 hours of delta at 960 t/s). */
export function encodeVlq(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) {
    throw new Error(`VLQ out of range: ${value}`);
  }
  const out = [value & 0x7f];
  let rest = value >> 7;
  while (rest > 0) {
    out.unshift((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return out;
}

/**
 * Encode captured events as a complete .mid file. Events are sorted first,
 * so delta times are non-negative by construction; equal-tick events keep
 * their capture order (stable sort — note-off stays ahead of a re-strike).
 */
export function encodeMidiFile(events: readonly MidiEvent[]): Uint8Array<ArrayBuffer> {
  const track: number[] = [];
  // Set-tempo meta at tick 0 — makes the seconds↔ticks contract explicit
  // in the file instead of relying on the reader's 120 BPM default.
  track.push(0x00, 0xff, 0x51, 0x03);
  track.push(
    (MIDI_TEMPO_US_PER_QUARTER >> 16) & 0xff,
    (MIDI_TEMPO_US_PER_QUARTER >> 8) & 0xff,
    MIDI_TEMPO_US_PER_QUARTER & 0xff,
  );
  let lastTick = 0;
  for (const e of sortMidiEvents(events)) {
    const tick = secondsToTicks(e.atSec);
    track.push(...encodeVlq(tick - lastTick));
    lastTick = tick;
    track.push(e.status, e.data1);
    if (midiDataBytes(e.status) === 2) track.push(e.data2);
  }
  track.push(0x00, 0xff, 0x2f, 0x00); // end of track

  const bytes = new Uint8Array(14 + 8 + track.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x54, 0x68, 0x64], 0); // "MThd"
  view.setUint32(4, 6);
  view.setUint16(8, 0); // format 0
  view.setUint16(10, 1); // one track
  view.setUint16(12, MIDI_TPQN);
  bytes.set([0x4d, 0x54, 0x72, 0x6b], 14); // "MTrk"
  view.setUint32(18, track.length);
  bytes.set(track, 22);
  return bytes;
}
