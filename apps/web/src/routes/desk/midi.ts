// MIDI capture (W3-C) — pure model + interim persistence.
//
// The desk (and only the desk — the wire protocol is audio-only, MIDI stays
// desk-local in v1) timestamps Web MIDI channel messages against the rolling
// take. Events live on the take's room timeline — the exact domain of
// player.position()/seek(): 0 = take head — so lane drawing and seeks need
// no conversion beyond the arrangement offset, like markers.
//
// TIMESTAMP MAPPING & PRECISION (the honest version):
// MIDIMessageEvent.timeStamp is a DOMHighResTimeStamp on the SAME clock as
// performance.now() (Web MIDI spec), so `atSec = (timeStamp − anchor)/1000`
// with `anchor = performance.now()` sampled when the desk observes
// take-start. Event-to-event timing is therefore as good as the platform
// MIDI stack (~1 ms USB-MIDI jitter; the clock itself resolves to ≤5 µs
// under the cross-origin isolation this app already requires). The ANCHOR,
// however, is the desk's receipt of its own take-start echo — one WS round
// trip after the authoritative start, and recorders arm on their own
// schedule with audio re-aligned later by chirp correlation while MIDI is
// not. Net: intra-take MIDI timing ≈ 1 ms; MIDI-to-audio placement is good
// to a few tens of ms worst case. Right for keeping the performance data;
// not sample-accurate audio alignment. A future chirp-style anchor could
// close the gap.
//
// PERSISTENCE BOUNDARY (deliberately NOT the W3-A shared doc): markers and
// comments moved into the Yjs project doc; MIDI event lists must not. They
// are big (up to ~3.2 MB of JSON per take at the cap, see below) and
// append-only — every CRDT update would replicate and persist the whole
// history to every desk forever. The right home is the OPFS/blob path next
// to the audio (parked follow-up); until then: localStorage per take, the
// markers.ts pattern (schema-versioned, tolerant load, injectable store),
// plus a hard event cap.

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

/**
 * Per-take event cap. Measured: one serialized event is ~55–65 bytes of
 * JSON ("{"atSec":123.456789,…}"), so 50k events ≈ 3.2 MB — inside the
 * usual 5 MB/origin localStorage budget with headroom for markers/comments/
 * prefs, but too close to gamble higher. On overflow the EARLIEST events
 * are kept (the take's head is the performance; a tail-biased buffer would
 * silently rewrite history) and the UI warns. OPFS storage is the parked
 * follow-up that removes the cap.
 */
export const MIDI_EVENT_CAP = 50_000;

/**
 * Validate + normalize one Web MIDI message. Returns null for anything
 * outside the captured kinds (sysex, realtime, aftertouch…) or malformed
 * lengths/values — a hostile or glitchy device must not corrupt the take.
 */
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

/** MIDIMessageEvent.timeStamp → take-relative seconds. Events the stack
 * delivers from just before the desk's anchor clamp to the take head. */
export function takeRelativeSeconds(timeStampMs: number, anchorMs: number): number {
  return Math.max(0, (timeStampMs - anchorMs) / 1_000);
}

/** Append in place (event lists are big — no copying per event) honoring
 * the cap. Returns false when the event was dropped (cap reached). */
export function appendMidiEvent(events: MidiEvent[], event: MidiEvent): boolean {
  if (events.length >= MIDI_EVENT_CAP) return false;
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

type KVStore = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): KVStore | null {
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

/** Load a take's MIDI. Malformed JSON, unknown schema versions and invalid
 * entries all degrade to "no events" — never a throw (markers.ts rule: a
 * side-store must not be able to take the desk down). */
export function loadMidi(
  sessionId: string,
  takeId: string,
  store: KVStore | null = defaultStore(),
): TakeMidi {
  let raw: string | null = null;
  try {
    raw = store?.getItem(midiKey(sessionId, takeId)) ?? null;
  } catch {
    return { ...EMPTY };
  }
  if (!raw) return { ...EMPTY };
  try {
    const doc = JSON.parse(raw) as Partial<MidiDoc> | null;
    if (doc?.v !== SCHEMA_VERSION || !Array.isArray(doc.events)) return { ...EMPTY };
    const valid: MidiEvent[] = [];
    for (const entry of doc.events as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.atSec !== "number" || !Number.isFinite(e.atSec) || e.atSec < 0) continue;
      if (typeof e.status !== "number" || typeof e.data1 !== "number") continue;
      const data2 = typeof e.data2 === "number" ? e.data2 : 0;
      const norm = normalizeMidiMessage(
        midiDataBytes(e.status) === 2 ? [e.status, e.data1, data2] : [e.status, e.data1],
      );
      if (norm) valid.push({ atSec: e.atSec, ...norm });
    }
    return { events: sortMidiEvents(valid), overflow: doc.overflow === true };
  } catch {
    return { ...EMPTY };
  }
}

export function saveMidi(
  sessionId: string,
  takeId: string,
  midi: TakeMidi,
  store: KVStore | null = defaultStore(),
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

// ---- input preferences (A12 continuity, the desk-input-identity pattern) -------

export const MIDI_PREFS_KEY = "antiphon:midi-input";

export interface MidiInputPrefs {
  /** MIDIPort.id of the chosen input (per-origin stable in practice). */
  inputId: string;
  /** Human name at selection time (resume display + id-drift fallback). */
  inputLabel: string;
}

export function loadMidiPrefs(store: KVStore | null = defaultStore()): MidiInputPrefs | null {
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

export function saveMidiPrefs(prefs: MidiInputPrefs, store: KVStore | null = defaultStore()): void {
  try {
    store?.setItem(MIDI_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // quota / private mode: prefs then live for this page load only
  }
}
