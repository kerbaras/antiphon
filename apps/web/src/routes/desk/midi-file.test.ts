import { describe, expect, it } from "vitest";
import type { MidiEvent } from "./midi";
import {
  encodeMidiFile,
  encodeVlq,
  MIDI_TEMPO_US_PER_QUARTER,
  MIDI_TICKS_PER_SECOND,
  MIDI_TPQN,
  secondsToTicks,
} from "./midi-file";

const ev = (atSec: number, status: number, data1: number, data2 = 0): MidiEvent => ({
  atSec,
  status,
  data1,
  data2,
});

// ---- reference decoder (independent of the writer's internals) ---------------

function decodeVlq(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  let i = at;
  for (;;) {
    const b = bytes[i] as number;
    value = (value << 7) | (b & 0x7f);
    i++;
    if ((b & 0x80) === 0) return { value, next: i };
  }
}

interface DecodedEvent {
  tick: number;
  status: number;
  data: number[];
}

/** Walk the single MTrk, asserting structure; returns channel events. */
function decodeTrack(bytes: Uint8Array): DecodedEvent[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trackLen = view.getUint32(18);
  expect(22 + trackLen).toBe(bytes.length);
  const events: DecodedEvent[] = [];
  let tick = 0;
  let i = 22;
  while (i < bytes.length) {
    const delta = decodeVlq(bytes, i);
    expect(delta.value).toBeGreaterThanOrEqual(0);
    tick += delta.value;
    i = delta.next;
    const status = bytes[i] as number;
    expect(status).toBeGreaterThanOrEqual(0x80); // no running status by design
    i++;
    if (status === 0xff) {
      const type = bytes[i] as number;
      const len = decodeVlq(bytes, i + 1);
      i = len.next + len.value;
      if (type === 0x2f) {
        expect(i).toBe(bytes.length); // end-of-track is last
        return events;
      }
      continue;
    }
    const dataBytes = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2;
    const data = [...bytes.slice(i, i + dataBytes)];
    i += dataBytes;
    events.push({ tick, status, data });
  }
  throw new Error("no end-of-track");
}

describe("VLQ encoding", () => {
  it("matches the SMF spec vectors", () => {
    expect(encodeVlq(0x00)).toEqual([0x00]);
    expect(encodeVlq(0x40)).toEqual([0x40]);
    expect(encodeVlq(0x7f)).toEqual([0x7f]);
    expect(encodeVlq(0x80)).toEqual([0x81, 0x00]);
    expect(encodeVlq(0x2000)).toEqual([0xc0, 0x00]);
    expect(encodeVlq(0x3fff)).toEqual([0xff, 0x7f]);
    expect(encodeVlq(0x4000)).toEqual([0x81, 0x80, 0x00]);
    expect(encodeVlq(0x0fffffff)).toEqual([0xff, 0xff, 0xff, 0x7f]);
  });

  it("round-trips across the range boundaries", () => {
    for (const n of [0, 1, 127, 128, 8191, 8192, 16383, 16384, 2097151, 2097152, 0x0fffffff]) {
      const enc = encodeVlq(n);
      expect(enc.length).toBeLessThanOrEqual(4);
      expect(decodeVlq(new Uint8Array(enc), 0)).toEqual({ value: n, next: enc.length });
    }
  });

  it("rejects out-of-range values", () => {
    expect(() => encodeVlq(-1)).toThrow();
    expect(() => encodeVlq(0x10000000)).toThrow();
    expect(() => encodeVlq(1.5)).toThrow();
  });
});

describe("seconds → ticks", () => {
  it("uses the documented 960 ticks/second (480 TPQN at 120 BPM), exactly", () => {
    expect(MIDI_TICKS_PER_SECOND).toBe(960);
    expect(secondsToTicks(0)).toBe(0);
    expect(secondsToTicks(0.5)).toBe(480); // one quarter note
    expect(secondsToTicks(1)).toBe(960);
    expect(secondsToTicks(60)).toBe(57_600);
    expect(secondsToTicks(0.0005)).toBe(0); // sub-tick rounds
    expect(secondsToTicks(0.00053)).toBe(1);
  });
});

describe("encodeMidiFile", () => {
  it("writes valid header chunks (format 0, one track, 480 TPQN)", () => {
    const bytes = encodeMidiFile([ev(0, 0x90, 60, 100), ev(1, 0x80, 60, 64)]);
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("MThd");
    expect(view.getUint32(4)).toBe(6);
    expect(view.getUint16(8)).toBe(0);
    expect(view.getUint16(10)).toBe(1);
    expect(view.getUint16(12)).toBe(MIDI_TPQN);
    expect(String.fromCharCode(...bytes.slice(14, 18))).toBe("MTrk");
    expect(view.getUint32(18)).toBe(bytes.length - 22);
  });

  it("golden bytes: tempo meta + one note, byte for byte", () => {
    // Note C4 on at 0.25 s (tick 240 → VLQ 81 70), off at 0.75 s
    // (delta 480 → VLQ 83 60).
    const bytes = encodeMidiFile([ev(0.25, 0x90, 0x3c, 0x64), ev(0.75, 0x80, 0x3c, 0x40)]);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    expect(hex).toBe(
      [
        "4d 54 68 64", // MThd
        "00 00 00 06", // header length 6
        "00 00", // format 0
        "00 01", // one track
        "01 e0", // 480 TPQN
        "4d 54 72 6b", // MTrk
        "00 00 00 15", // track length 21
        "00 ff 51 03 07 a1 20", // Δ0 set-tempo 500000 µs
        "81 70 90 3c 64", // Δ240 note on
        "83 60 80 3c 40", // Δ480 note off
        "00 ff 2f 00", // Δ0 end of track
      ].join(" "),
    );
  });

  it("emits monotone delta times even from unsorted input", () => {
    const bytes = encodeMidiFile([
      ev(2, 0x80, 60, 0),
      ev(0.5, 0x90, 60, 100),
      ev(1.25, 0xb0, 64, 127),
      ev(0.5, 0xe0, 0, 96),
    ]);
    const events = decodeTrack(bytes); // decoder asserts deltas ≥ 0
    expect(events.map((e) => e.tick)).toEqual([480, 480, 1200, 1920]);
  });

  it("writes program change with a single data byte", () => {
    const events = decodeTrack(encodeMidiFile([ev(0, 0xc0, 5), ev(1, 0x90, 60, 100)]));
    expect(events[0]).toEqual({ tick: 0, status: 0xc0, data: [5] });
    expect(events[1]).toEqual({ tick: 960, status: 0x90, data: [60, 100] });
  });

  it("declares the tempo contract in-file (set-tempo meta at tick 0)", () => {
    const bytes = encodeMidiFile([]);
    // Δ0 FF 51 03 <tempo:3>
    expect([...bytes.slice(22, 29)]).toEqual([
      0x00,
      0xff,
      0x51,
      0x03,
      (MIDI_TEMPO_US_PER_QUARTER >> 16) & 0xff,
      (MIDI_TEMPO_US_PER_QUARTER >> 8) & 0xff,
      MIDI_TEMPO_US_PER_QUARTER & 0xff,
    ]);
    expect(decodeTrack(bytes)).toEqual([]); // empty but structurally valid
  });

  it("survives a cap-sized event list (VLQ deltas stay in range)", () => {
    const many: MidiEvent[] = [];
    for (let i = 0; i < 2_000; i++) {
      many.push(ev(i * 0.01, i % 2 === 0 ? 0x90 : 0x80, 60, i % 2 === 0 ? 100 : 0));
    }
    const events = decodeTrack(encodeMidiFile(many));
    expect(events).toHaveLength(2_000);
    expect(events[events.length - 1]?.tick).toBe(secondsToTicks(1_999 * 0.01));
  });
});
