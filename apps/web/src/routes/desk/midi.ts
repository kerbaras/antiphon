// MIDI capture — pure model + persistence codecs. Deliberately NOT in the
// shared Yjs doc: event lists are big and append-only — every CRDT update
// would replicate the whole history to every desk forever.

export interface MidiEvent {
  /** Seconds on the take's room timeline (player.position() domain). */
  atSec: number;
  /** Status byte incl. channel — one of the captured kinds below. */
  status: number;
  /** First data byte (0..127). */
  data1: number;
  /** Second data byte (0..127); 0 where the message carries only one. */
  data2: number;
}

/** Captured status high-nibbles: note off/on, control change, program
 * change, pitch bend. Sysex, realtime, aftertouch are dropped in v1. */
const CAPTURED_KINDS = new Set([0x80, 0x90, 0xb0, 0xc0, 0xe0]);

/** Program change is the only captured kind with a single data byte. */
export function midiDataBytes(status: number): 1 | 2 {
  return (status & 0xf0) === 0xc0 ? 1 : 2;
}

/** Per-take event cap FOR THE LOCALSTORAGE PATH (~3.2 MB of JSON — inside
 * the usual 5 MB/origin budget). On overflow the EARLIEST events are kept
 * (a tail-biased buffer would silently rewrite the performance's head).
 * The OPFS store has no cap — captures there pass Infinity. */
export const MIDI_EVENT_CAP = 50_000;

/** Validate + normalize one Web MIDI message. Null for anything outside
 * the captured kinds or with malformed lengths/values — a hostile or
 * glitchy device must not corrupt the take. */
export function normalizeMidiMessage(
  data: Uint8Array | readonly number[] | null,
): Pick<MidiEvent, "status" | "data1" | "data2"> | null {
  if (!data || data.length < 2) return null;
  const status = data[0] as number;
  if (!CAPTURED_KINDS.has(status & 0xf0)) return null;
  if (data.length !== 1 + midiDataBytes(status)) return null;
  const data1 = data[1] as number;
  const data2 = midiDataBytes(status) === 2 ? (data[2] as number) : 0;
  const byteOk = (b: number) => Number.isInteger(b) && b >= 0 && b <= 127;
  if (!byteOk(data1) || !byteOk(data2)) return null;
  return { status, data1, data2 };
}

/** MIDIMessageEvent.timeStamp → take-relative seconds. timeStamp shares
 * performance.now()'s clock (Web MIDI spec); the anchor is sampled at the
 * desk's take-start observation. Pre-anchor events clamp to the head. */
export function takeRelativeSeconds(timeStampMs: number, anchorMs: number): number {
  return Math.max(0, (timeStampMs - anchorMs) / 1_000);
}

/** Append in place (event lists are big — no copying per event) honoring
 * the cap. Returns false when the event was dropped (cap reached). */
export function appendMidiEvent(
  events: MidiEvent[],
  event: MidiEvent,
  cap: number = MIDI_EVENT_CAP,
): boolean {
  if (events.length >= cap) return false;
  events.push(event);
  return true;
}

/** Timeline order. Array.sort is stable, so simultaneous events keep their
 * arrival order — note-off before the re-struck note-on stays that way. */
export function sortMidiEvents(events: readonly MidiEvent[]): MidiEvent[] {
  return [...events].sort((a, b) => a.atSec - b.atSec);
}

// ---- lane derivation ---------------------------------------------------------

/** A note-on..note-off span for the piano-roll-lite lane. `endSec === null`
 * means the note was never released before the take ended. */
export interface NoteSpan {
  note: number;
  channel: number;
  startSec: number;
  endSec: number | null;
}

/** Pair note-ons with their note-offs per (channel, pitch). A note-on with
 * velocity 0 is a note-off (MIDI convention); a re-struck pitch closes the
 * open span first. Non-note events don't draw — density over fidelity. */
export function noteSpansOf(events: readonly MidiEvent[]): NoteSpan[] {
  const spans: NoteSpan[] = [];
  const open = new Map<number, NoteSpan>();
  for (const e of sortMidiEvents(events)) {
    const kind = e.status & 0xf0;
    if (kind !== 0x80 && kind !== 0x90) continue;
    const key = ((e.status & 0x0f) << 7) | e.data1;
    const isOff = kind === 0x80 || e.data2 === 0;
    const prior = open.get(key);
    if (prior) {
      prior.endSec = e.atSec;
      open.delete(key);
    }
    if (!isOff) {
      const span: NoteSpan = {
        note: e.data1,
        channel: e.status & 0x0f,
        startSec: e.atSec,
        endSec: null,
      };
      open.set(key, span);
      spans.push(span);
    }
  }
  return spans;
}

// ---- persistence (see the storage boundary note up top) -----------------------

const SCHEMA_VERSION = 1;

interface MidiDoc {
  v: number;
  events: MidiEvent[];
  /** The capture hit MIDI_EVENT_CAP; later events were dropped. */
  overflow: boolean;
}

export interface TakeMidi {
  events: MidiEvent[];
  overflow: boolean;
}

/** Exported for midi-store.ts (migration reads/deletes localStorage keys). */
export type KVStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function defaultMidiKV(): KVStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // private mode / storage disabled: MIDI becomes per-load
  }
}

export function midiKey(sessionId: string, takeId: string): string {
  return `antiphon:midi:${sessionId}:${takeId}`;
}

const EMPTY: TakeMidi = { events: [], overflow: false };

/** Validate one persisted entry back into a MidiEvent, or null. Shared by
 * the localStorage doc decoder and the OPFS JSONL decoder (midi-store.ts) —
 * one gate for what counts as a storable event. */
export function decodeMidiEventEntry(entry: unknown): MidiEvent | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.atSec !== "number" || !Number.isFinite(e.atSec) || e.atSec < 0) return null;
  if (typeof e.status !== "number" || typeof e.data1 !== "number") return null;
  const data2 = typeof e.data2 === "number" ? e.data2 : 0;
  const norm = normalizeMidiMessage(
    midiDataBytes(e.status) === 2 ? [e.status, e.data1, data2] : [e.status, e.data1],
  );
  return norm ? { atSec: e.atSec, ...norm } : null;
}

/** Decode a raw localStorage document. `null` = nothing usable (malformed
 * JSON, unknown schema version, wrong shape); otherwise keep what parses,
 * reporting how many entries were dropped so migration can warn honestly. */
export function decodeMidiDoc(raw: string): { midi: TakeMidi; dropped: number } | null {
  try {
    const doc = JSON.parse(raw) as Partial<MidiDoc> | null;
    if (doc?.v !== SCHEMA_VERSION || !Array.isArray(doc.events)) return null;
    const valid: MidiEvent[] = [];
    for (const entry of doc.events as unknown[]) {
      const e = decodeMidiEventEntry(entry);
      if (e) valid.push(e);
    }
    return {
      midi: { events: sortMidiEvents(valid), overflow: doc.overflow === true },
      dropped: doc.events.length - valid.length,
    };
  } catch {
    return null;
  }
}

/** Load a take's MIDI. Malformed JSON, unknown schema versions and invalid
 * entries all degrade to "no events" — never a throw (markers.ts rule: a
 * side-store must not be able to take the desk down). */
export function loadMidi(
  sessionId: string,
  takeId: string,
  store: KVStore | null = defaultMidiKV(),
): TakeMidi {
  let raw: string | null = null;
  try {
    raw = store?.getItem(midiKey(sessionId, takeId)) ?? null;
  } catch {
    return { ...EMPTY };
  }
  if (!raw) return { ...EMPTY };
  return decodeMidiDoc(raw)?.midi ?? { ...EMPTY };
}

export function saveMidi(
  sessionId: string,
  takeId: string,
  midi: TakeMidi,
  store: KVStore | null = defaultMidiKV(),
): void {
  const doc: MidiDoc = {
    v: SCHEMA_VERSION,
    events: sortMidiEvents(midi.events),
    overflow: midi.overflow,
  };
  try {
    store?.setItem(midiKey(sessionId, takeId), JSON.stringify(doc));
  } catch {
    // quota / private mode: the in-memory events still serve this page load
  }
}

/** Drop a take's localStorage entry — after OPFS migration and on take
 * deletion. Same never-throw rule as load/save. */
export function removeMidi(
  sessionId: string,
  takeId: string,
  store: KVStore | null = defaultMidiKV(),
): void {
  try {
    store?.removeItem(midiKey(sessionId, takeId));
  } catch {
    // storage denied: nothing to remove that could have been stored
  }
}

// ---- input preferences (one-click resume after a reload) -----------------------

export const MIDI_PREFS_KEY = "antiphon:midi-input";

export interface MidiInputPrefs {
  /** MIDIPort.id of the chosen input (per-origin stable in practice). */
  inputId: string;
  /** Human name at selection time (resume display + id-drift fallback). */
  inputLabel: string;
}

export function loadMidiPrefs(store: KVStore | null = defaultMidiKV()): MidiInputPrefs | null {
  try {
    const raw = store?.getItem(MIDI_PREFS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.inputId !== "string" || typeof p.inputLabel !== "string") return null;
    return { inputId: p.inputId, inputLabel: p.inputLabel };
  } catch {
    return null;
  }
}

export function saveMidiPrefs(
  prefs: MidiInputPrefs,
  store: KVStore | null = defaultMidiKV(),
): void {
  try {
    store?.setItem(MIDI_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // quota / private mode: prefs then live for this page load only
  }
}
