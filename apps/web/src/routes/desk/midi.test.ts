import { describe, expect, it } from "vitest";
import {
  appendMidiEvent,
  decodeMidiDoc,
  loadMidi,
  loadMidiPrefs,
  MIDI_EVENT_CAP,
  type MidiEvent,
  midiDataBytes,
  midiKey,
  normalizeMidiMessage,
  noteSpansOf,
  removeMidi,
  saveMidi,
  saveMidiPrefs,
  sortMidiEvents,
  takeRelativeSeconds,
} from "./midi";

const ev = (atSec: number, status = 0x90, data1 = 60, data2 = 100): MidiEvent => ({
  atSec,
  status,
  data1,
  data2,
});

/** Minimal Storage double for the persistence round-trip tests. */
function memStore(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("normalizeMidiMessage", () => {
  it("accepts the captured channel kinds", () => {
    expect(normalizeMidiMessage([0x90, 60, 100])).toEqual({ status: 0x90, data1: 60, data2: 100 });
    expect(normalizeMidiMessage([0x80, 60, 64])).toEqual({ status: 0x80, data1: 60, data2: 64 });
    expect(normalizeMidiMessage([0xb3, 64, 127])).toEqual({ status: 0xb3, data1: 64, data2: 127 });
    expect(normalizeMidiMessage([0xe0, 0, 96])).toEqual({ status: 0xe0, data1: 0, data2: 96 });
    // Program change carries ONE data byte; data2 normalizes to 0.
    expect(normalizeMidiMessage([0xc5, 12])).toEqual({ status: 0xc5, data1: 12, data2: 0 });
  });

  it("drops sysex, realtime, and aftertouch (v1 scope)", () => {
    expect(normalizeMidiMessage([0xf0, 0x7e, 0xf7])).toBeNull(); // sysex
    expect(normalizeMidiMessage([0xf8, 0])).toBeNull(); // clock
    expect(normalizeMidiMessage([0xa0, 60, 40])).toBeNull(); // poly aftertouch
    expect(normalizeMidiMessage([0xd0, 40])).toBeNull(); // channel pressure
  });

  it("drops malformed lengths and out-of-range data bytes", () => {
    expect(normalizeMidiMessage(null)).toBeNull();
    expect(normalizeMidiMessage([0x90])).toBeNull();
    expect(normalizeMidiMessage([0x90, 60])).toBeNull(); // note-on needs 2 data bytes
    expect(normalizeMidiMessage([0x90, 60, 100, 0])).toBeNull();
    expect(normalizeMidiMessage([0xc0, 12, 0])).toBeNull(); // program change needs 1
    expect(normalizeMidiMessage([0x90, 128, 100])).toBeNull();
    expect(normalizeMidiMessage([0x90, 60, -1])).toBeNull();
    expect(normalizeMidiMessage([0x90, 60.5, 100])).toBeNull();
  });

  it("accepts Uint8Array input (the Web MIDI shape)", () => {
    expect(normalizeMidiMessage(new Uint8Array([0x90, 60, 100]))).toEqual({
      status: 0x90,
      data1: 60,
      data2: 100,
    });
  });
});

describe("timestamp mapping", () => {
  it("maps MIDIMessageEvent.timeStamp to take-relative seconds", () => {
    expect(takeRelativeSeconds(1_500, 1_000)).toBeCloseTo(0.5, 10);
    expect(takeRelativeSeconds(1_000.125, 1_000)).toBeCloseTo(0.000125, 10);
  });

  it("clamps pre-anchor events to the take head", () => {
    // The desk anchors on its take-start echo; a message the stack stamps
    // just before belongs to the head, not to negative time.
    expect(takeRelativeSeconds(995, 1_000)).toBe(0);
  });
});

describe("event buffer", () => {
  it("appendMidiEvent honors the cap, keeping the EARLIEST events", () => {
    const events: MidiEvent[] = [];
    for (let i = 0; i < MIDI_EVENT_CAP; i++) {
      expect(appendMidiEvent(events, ev(i / 1_000))).toBe(true);
    }
    expect(appendMidiEvent(events, ev(999))).toBe(false);
    expect(events).toHaveLength(MIDI_EVENT_CAP);
    expect(events[0]?.atSec).toBe(0); // head intact, newcomer dropped
    expect(events[events.length - 1]?.atSec).not.toBe(999);
  });

  it("appendMidiEvent takes an explicit cap — Infinity on the OPFS path", () => {
    const events: MidiEvent[] = [ev(0), ev(1)];
    expect(appendMidiEvent(events, ev(2), 2)).toBe(false);
    expect(appendMidiEvent(events, ev(2), Number.POSITIVE_INFINITY)).toBe(true);
    expect(events).toHaveLength(3);
  });

  it("sortMidiEvents orders by time, stable for simultaneous events", () => {
    const offThenOn = [ev(1, 0x80, 60, 0), ev(1, 0x90, 60, 100), ev(0.5)];
    const sorted = sortMidiEvents(offThenOn);
    expect(sorted.map((e) => e.atSec)).toEqual([0.5, 1, 1]);
    // Note-off captured before the re-strike stays first.
    expect(sorted[1]?.status).toBe(0x80);
    expect(sorted[2]?.status).toBe(0x90);
  });
});

describe("noteSpansOf", () => {
  it("pairs note-on with note-off per (channel, pitch)", () => {
    const spans = noteSpansOf([
      ev(0, 0x90, 60, 100),
      ev(0.2, 0x90, 64, 90),
      ev(1, 0x80, 60, 0),
      ev(1.5, 0x80, 64, 0),
    ]);
    expect(spans).toEqual([
      { note: 60, channel: 0, startSec: 0, endSec: 1 },
      { note: 64, channel: 0, startSec: 0.2, endSec: 1.5 },
    ]);
  });

  it("treats note-on velocity 0 as note-off (MIDI convention)", () => {
    const spans = noteSpansOf([ev(0, 0x90, 60, 100), ev(2, 0x90, 60, 0)]);
    expect(spans).toEqual([{ note: 60, channel: 0, startSec: 0, endSec: 2 }]);
  });

  it("keeps channels separate and leaves unreleased notes open (null)", () => {
    const spans = noteSpansOf([
      ev(0, 0x91, 60, 80), // channel 1
      ev(0.5, 0x90, 60, 80), // channel 0, never released
      ev(1, 0x81, 60, 0),
    ]);
    expect(spans).toEqual([
      { note: 60, channel: 1, startSec: 0, endSec: 1 },
      { note: 60, channel: 0, startSec: 0.5, endSec: null },
    ]);
  });

  it("a re-struck pitch closes the open span first", () => {
    const spans = noteSpansOf([ev(0, 0x90, 60, 80), ev(1, 0x90, 60, 90), ev(2, 0x80, 60, 0)]);
    expect(spans).toEqual([
      { note: 60, channel: 0, startSec: 0, endSec: 1 },
      { note: 60, channel: 0, startSec: 1, endSec: 2 },
    ]);
  });

  it("ignores non-note events", () => {
    expect(noteSpansOf([ev(0, 0xb0, 64, 127), ev(1, 0xe0, 0, 96), ev(2, 0xc0, 5, 0)])).toEqual([]);
  });
});

describe("persistence", () => {
  it("round-trips through the versioned document, sorted", () => {
    const store = memStore();
    saveMidi("sess", "take", { events: [ev(2), ev(0.5, 0x80, 60, 0)], overflow: true }, store);
    expect(store.map.has(midiKey("sess", "take"))).toBe(true);
    const loaded = loadMidi("sess", "take", store);
    expect(loaded.events.map((e) => e.atSec)).toEqual([0.5, 2]);
    expect(loaded.overflow).toBe(true);
    // Keyed per (session, take): neighbors see nothing.
    expect(loadMidi("sess", "other-take", store).events).toEqual([]);
    expect(loadMidi("other-sess", "take", store).events).toEqual([]);
  });

  it("tolerates malformed JSON, unknown schema versions, and wrong shapes", () => {
    const store = memStore();
    const key = midiKey("s", "t");
    for (const raw of [
      "not json{",
      "null",
      "[]",
      JSON.stringify({ v: 999, events: [ev(1)] }),
      JSON.stringify({ v: 1, events: "nope" }),
      JSON.stringify({ events: [ev(1)] }),
    ]) {
      store.map.set(key, raw);
      expect(loadMidi("s", "t", store)).toEqual({ events: [], overflow: false });
    }
  });

  it("filters invalid entries instead of rejecting the document", () => {
    const store = memStore();
    store.map.set(
      midiKey("s", "t"),
      JSON.stringify({
        v: 1,
        events: [
          ev(5),
          { atSec: -1, status: 0x90, data1: 60, data2: 100 },
          { atSec: Number.NaN, status: 0x90, data1: 60, data2: 100 },
          { atSec: 1, status: 0xf0, data1: 0, data2: 0 }, // sysex kind
          { atSec: 1, status: 0x90, data1: 200, data2: 100 }, // out of range
          { atSec: 1, status: "0x90", data1: 60, data2: 100 },
          null,
          "junk",
        ],
      }),
    );
    expect(loadMidi("s", "t", store).events).toEqual([ev(5)]);
  });

  it("survives a throwing store (private mode) by degrading to empty", () => {
    const throwing: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadMidi("s", "t", throwing)).toEqual({ events: [], overflow: false });
    expect(() => saveMidi("s", "t", { events: [ev(1)], overflow: false }, throwing)).not.toThrow();
    expect(() => removeMidi("s", "t", throwing)).not.toThrow();
  });

  it("removeMidi drops exactly the (session, take) entry", () => {
    const store = memStore();
    saveMidi("s", "t1", { events: [ev(1)], overflow: false }, store);
    saveMidi("s", "t2", { events: [ev(2)], overflow: false }, store);
    removeMidi("s", "t1", store);
    expect(store.map.has(midiKey("s", "t1"))).toBe(false);
    expect(store.map.has(midiKey("s", "t2"))).toBe(true);
  });

  it("decodeMidiDoc reports dropped entries (migration warns on these)", () => {
    const decoded = decodeMidiDoc(JSON.stringify({ v: 1, events: [ev(1), null, "junk"] }));
    expect(decoded?.midi.events).toEqual([ev(1)]);
    expect(decoded?.dropped).toBe(2);
    expect(decodeMidiDoc("not json{")).toBeNull();
    expect(decodeMidiDoc(JSON.stringify({ v: 999, events: [] }))).toBeNull();
  });
});

describe("input prefs (A12 continuity)", () => {
  it("round-trips and rejects junk", () => {
    const store = memStore();
    saveMidiPrefs({ inputId: "port-1", inputLabel: "Stage Piano — Roland" }, store);
    expect(loadMidiPrefs(store)).toEqual({ inputId: "port-1", inputLabel: "Stage Piano — Roland" });
    store.map.set("antiphon:midi-input", "{broken");
    expect(loadMidiPrefs(store)).toBeNull();
    store.map.set("antiphon:midi-input", JSON.stringify({ inputId: 7 }));
    expect(loadMidiPrefs(store)).toBeNull();
  });
});

describe("midiDataBytes", () => {
  it("program change is the one captured single-data-byte kind", () => {
    expect(midiDataBytes(0xc0)).toBe(1);
    expect(midiDataBytes(0xcf)).toBe(1);
    for (const s of [0x80, 0x90, 0xb0, 0xe0]) expect(midiDataBytes(s)).toBe(2);
  });
});
