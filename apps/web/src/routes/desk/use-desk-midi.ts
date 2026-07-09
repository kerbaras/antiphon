// Desk MIDI input (W3-C): a keyboard/piano at the desk gets its performance
// data kept alongside the audio. Web MIDI is desk-local by design — the wire
// protocol stays audio-only; nothing here touches packets/streams. While a
// take rolls, incoming channel messages are timestamped against the take
// (anchor = performance.now() at the desk's take-start observation; mapping
// + precision documented in midi.ts) and persisted per take.
//
// PERSISTENCE (W5-D): the in-memory event list is the source of truth; the
// MidiStore (midi-store.ts — OPFS, or localStorage where OPFS is missing)
// trails it. Mid-take writes are debounced ~2s and flushed when the tab
// hides/unloads and on take stop — so the ACCEPTED LOSS BOUND is an
// unflushed tail younger than the debounce window, and only if the tab
// dies without firing its lifecycle events (pagehide's async OPFS write is
// itself best-effort). On the OPFS path capture is UNCAPPED; the 50k cap
// applies only on the localStorage fallback.
//
// Playback renders NOTHING audible on purpose: the piano was audible in the
// room, so the audio lanes already carry it — this is a data lane, exported
// to the operator's DAW as .mid (midi-file.ts). No synth in v1.
//
// One manager per desk page, bridged into React via useSyncExternalStore,
// mirroring use-desk-input.ts (including the __antiphonDeskMidi e2e hook).

import { useCallback, useSyncExternalStore } from "react";
import {
  appendMidiEvent,
  loadMidiPrefs,
  MIDI_EVENT_CAP,
  type MidiEvent,
  type MidiInputPrefs,
  normalizeMidiMessage,
  removeMidi,
  saveMidiPrefs,
  type TakeMidi,
  takeRelativeSeconds,
} from "./midi";
import { defaultMidiStore, loadTakeMidi, type MidiStore } from "./midi-store";
import { getDeskSession } from "./use-desk";

/** Mid-take write debounce — the codebase's debounce scale. Also the loss
 * bound (see the persistence note above). */
export const MIDI_SAVE_DEBOUNCE_MS = 2_000;

// Structural slices of the Web MIDI API (the manager's working types).
// Real MIDIAccess/MIDIInput satisfy them; tests inject scripted doubles —
// the markers-KVStore pattern, needed here because Chromium has no
// fake-MIDI-device launch flag (see midiAccess below).

export interface MidiMessageLike {
  data: Uint8Array | null;
  timeStamp: number;
}

export interface MidiInputLike {
  id: string;
  name: string | null;
  manufacturer: string | null;
  state?: string;
  addEventListener(type: "midimessage", listener: (e: MidiMessageLike) => void): void;
  removeEventListener(type: "midimessage", listener: (e: MidiMessageLike) => void): void;
}

export interface MidiAccessLike {
  inputs: { forEach(cb: (input: MidiInputLike) => void): void };
  addEventListener(type: "statechange", listener: () => void): void;
  removeEventListener(type: "statechange", listener: () => void): void;
}

export type MidiAccessFactory = () => Promise<MidiAccessLike>;

/** Web MIDI access, test-overridable. Chromium offers NO fake-MIDI-device
 * launch flag (its fake MIDI managers exist only in browser-internal unit
 * tests — nothing like --use-fake-device-for-media-stream), so e2e installs
 * a scripted access object on __antiphonFakeMidi before the app boots. */
function midiAccess(): Promise<MidiAccessLike> {
  const fake = (globalThis as { __antiphonFakeMidi?: MidiAccessLike }).__antiphonFakeMidi;
  if (fake) return Promise.resolve(fake);
  if (!("requestMIDIAccess" in navigator)) {
    return Promise.reject(new Error("Web MIDI unavailable in this browser"));
  }
  return navigator.requestMIDIAccess({ sysex: false });
}

export interface MidiInputOption {
  id: string;
  /** "name — manufacturer" when the port reports both. */
  label: string;
}

export interface DeskMidiState {
  phase: "off" | "picking" | "live";
  /** Enumerated MIDI inputs (empty picker = nothing connected). */
  inputs: MidiInputOption[];
  /** The armed input, when phase = live. */
  input: MidiInputOption | null;
  /** A take is rolling and this lane is writing events into it. */
  capturing: boolean;
  /** Events captured into the rolling take so far (live readout). */
  liveEventCount: number;
  /** The current/last capture hit MIDI_EVENT_CAP — earliest kept. */
  overflowed: boolean;
  /** The armed input vanished; events stop until it returns. */
  unplugged: boolean;
  /** Persisted input from a previous visit — one-click resume (A12). */
  resumeLabel: string | null;
  error: string | null;
  /** Bumped when any take's stored events change (UI re-reads). */
  revision: number;
}

type Listener = (state: DeskMidiState) => void;

const OFF_STATE: DeskMidiState = {
  phase: "off",
  inputs: [],
  input: null,
  capturing: false,
  liveEventCount: 0,
  overflowed: false,
  unplugged: false,
  resumeLabel: null,
  error: null,
  revision: 0,
};

function optionOf(input: MidiInputLike): MidiInputOption {
  const name = input.name?.trim() || "MIDI input";
  const maker = input.manufacturer?.trim();
  return { id: input.id, label: maker && !name.includes(maker) ? `${name} — ${maker}` : name };
}

export class DeskMidi {
  private access: MidiAccessLike | null = null;
  private port: MidiInputLike | null = null;
  private prefs: MidiInputPrefs | null = loadMidiPrefs();
  private state: DeskMidiState = { ...OFF_STATE, resumeLabel: this.prefs?.inputLabel ?? null };
  private readonly listeners = new Set<Listener>();
  /** Capture context of the rolling take (null between takes). */
  private capture: { takeId: string; anchorMs: number; events: MidiEvent[] } | null = null;
  /** Coalesces liveEventCount patches — a mod-wheel sweep is hundreds of
   * events/s and must not become hundreds of React renders/s. */
  private countFlush: number | null = null;
  private knownTakeId: string | null;
  /** Loaded/finished takes' events, by takeId (MidiStore-backed). */
  private readonly takes = new Map<string, TakeMidi>();
  /** The page's MidiStore (feature detection is async — awaited per op). */
  private readonly storeReady: Promise<MidiStore>;
  /** Capture cap: none on OPFS; the W3-C cap on the localStorage fallback.
   * Starts capped — flips only after the store proves to be OPFS. */
  private cap: number = MIDI_EVENT_CAP;
  /** Debounced mid-take write (see the loss-bound note up top). */
  private saveTimer: number | null = null;
  /** Serializes writes per manager: whole-file rewrites must land in
   * schedule order or an older debounced write could outlive a newer one. */
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    readonly sessionId: string,
    private readonly requestAccess: MidiAccessFactory = midiAccess,
    storePromise: Promise<MidiStore> = defaultMidiStore(),
  ) {
    // Take lifecycle rides the desk session (fires synchronously on patch,
    // so the anchor is sampled the instant the desk learns of take-start).
    const session = getDeskSession(sessionId);
    this.knownTakeId = session.snapshot().activeTakeId; // pre-rolling take: never capture a partial tail
    session.subscribe((s) => this.onTake(s.activeTakeId));
    // A take deleted from every sink takes its MIDI with it — the desk is
    // this data's only home, so a dangling file would be an orphan forever.
    session.onStreamsDeleted((_streamIds, deletedTakeIds) => {
      for (const takeId of deletedTakeIds) this.deleteTakeMidi(takeId);
    });
    this.storeReady = storePromise;
    void storePromise.then((store) => {
      if (store.kind === "opfs") this.cap = Number.POSITIVE_INFINITY;
    });
    // Flush points: an unflushed tail must not ride on the tab surviving
    // the next MIDI_SAVE_DEBOUNCE_MS. pagehide's async write is
    // best-effort by nature — the debounce is the honest loss bound.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") this.flushCapture();
      });
      window.addEventListener("pagehide", () => this.flushCapture());
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  snapshot(): DeskMidiState {
    return this.state;
  }

  private patch(next: Partial<DeskMidiState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l(this.state);
  }

  /** A take's stored MIDI: finished captures this page load, else the
   * persisted document. Storage reads are async now (OPFS), so a first
   * touch returns an empty placeholder, hydrates in the background, and
   * bumps `revision` when the real events land — the UI re-reads, exactly
   * the path a finishing capture already exercises. */
  takeMidi(takeId: string): TakeMidi {
    let midi = this.takes.get(takeId);
    if (!midi) {
      midi = { events: [], overflow: false };
      this.takes.set(takeId, midi);
      void this.hydrate(takeId, midi);
    }
    return midi;
  }

  private async hydrate(takeId: string, placeholder: TakeMidi): Promise<void> {
    try {
      const store = await this.storeReady;
      const loaded = await loadTakeMidi(store, this.sessionId, takeId);
      // A capture that finished while we read owns the entry now — keep it.
      if (this.takes.get(takeId) !== placeholder) return;
      this.takes.set(takeId, loaded.midi);
      // Storage refusals surface on the MIDI error strip (QA F2), not just
      // the console — the store already said WHY there.
      this.patch({
        revision: this.state.revision + 1,
        ...(loaded.oversize
          ? { error: "a take's stored MIDI exceeds the 64 MB guard — not loaded (see console)" }
          : loaded.unreadable
            ? {
                error:
                  "a take's stored MIDI is unreadable — kept on disk, not loaded (see console)",
              }
            : {}),
      });
    } catch (e) {
      // markers.ts rule: a side-store must not take the desk down.
      console.warn(`antiphon: MIDI load failed for take ${takeId}: ${String(e)}`);
    }
  }

  /** Queue a write. The chain serializes whole-file rewrites; the store
   * serializes the events synchronously at write time, so passing the live
   * capture buffer is sound (newer events only make the write fresher). */
  private persist(takeId: string, midi: TakeMidi): void {
    this.saveChain = this.saveChain.then(async () => {
      const store = await this.storeReady;
      try {
        await store.save(this.sessionId, takeId, midi);
      } catch (e) {
        // Visible, not console-only (QA F3): the operator should know the
        // performance data is riding memory until a write lands.
        console.warn(`antiphon: MIDI save failed for take ${takeId}: ${String(e)}`);
        this.patch({
          error: "MIDI save failed — events held in memory this page load (see console)",
        });
      }
    });
  }

  /** Flush the pending debounced write NOW — visibilitychange/pagehide and
   * take stop. `saveTimer` doubles as the dirty flag. */
  private flushCapture(): void {
    if (this.saveTimer === null) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const capture = this.capture;
    if (capture) {
      this.persist(capture.takeId, { events: capture.events, overflow: this.state.overflowed });
    }
  }

  /** Take-level cleanup: a server-confirmed deletion removed the take's
   * last stream, so its MIDI goes too — cache, stored file, and any legacy
   * localStorage key. Chained behind pending saves so a debounced write
   * can't resurrect the file. */
  deleteTakeMidi(takeId: string): void {
    this.takes.delete(takeId);
    // A pending debounced write for THIS take would queue behind the
    // remove and resurrect the file — cancel it (QA F4). Another take's
    // pending write (the rolling capture) is not ours to drop.
    if (this.capture?.takeId === takeId && this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveChain = this.saveChain.then(async () => {
      const store = await this.storeReady;
      await store.remove(this.sessionId, takeId);
    });
    removeMidi(this.sessionId, takeId); // pre-migration copies, either store kind
    this.patch({ revision: this.state.revision + 1 });
  }

  /** Probe permission + enumerate inputs (requestMIDIAccess prompts on
   * first use in some browsers — the picker doubles as the probe). */
  async openPicker(): Promise<void> {
    if (this.state.phase === "live") return;
    this.patch({ phase: "picking", error: null });
    try {
      this.access = await this.requestAccess();
    } catch (e) {
      this.patch({ phase: "off", error: `MIDI permission: ${String(e)}` });
      return;
    }
    this.access.addEventListener("statechange", this.onStateChange);
    this.refreshInputs();
  }

  closePicker(): void {
    if (this.state.phase === "picking") this.patch({ phase: "off" });
  }

  /** Arm the lane on a picked input. Between takes only (UI-gated): a lane
   * must not start mid-take with a partial event list. */
  enable(option: MidiInputOption): void {
    if (this.port || !this.access) return;
    const port = this.findPort(option.id);
    if (!port) {
      this.patch({ error: "input disappeared — pick another" });
      this.refreshInputs();
      return;
    }
    this.port = port;
    port.addEventListener("midimessage", this.onMessage);
    this.prefs = { inputId: option.id, inputLabel: option.label };
    saveMidiPrefs(this.prefs);
    this.patch({
      phase: "live",
      input: option,
      resumeLabel: option.label,
      unplugged: false,
      error: null,
    });
  }

  /** One click after a reload: re-arm the persisted input (A12). */
  async resume(): Promise<void> {
    const prefs = this.prefs;
    if (!prefs) {
      await this.openPicker();
      return;
    }
    await this.openPicker();
    if (this.state.phase !== "picking") return; // permission failed
    // Port ids persist per origin in practice; fall back to the label.
    const match =
      this.state.inputs.find((i) => i.id === prefs.inputId) ??
      this.state.inputs.find((i) => i.label === prefs.inputLabel);
    if (!match) {
      this.patch({ error: `saved input "${prefs.inputLabel}" not found — pick another` });
      return;
    }
    this.enable(match);
  }

  /** Tear the lane down. Between takes only (UI-gated). */
  disable(): void {
    this.port?.removeEventListener("midimessage", this.onMessage);
    this.port = null;
    this.access?.removeEventListener("statechange", this.onStateChange);
    this.access = null;
    this.patch({
      ...OFF_STATE,
      resumeLabel: this.prefs?.inputLabel ?? null,
      revision: this.state.revision,
    });
  }

  private refreshInputs(): void {
    const inputs: MidiInputOption[] = [];
    this.access?.inputs.forEach((input) => {
      inputs.push(optionOf(input));
    });
    this.patch({ inputs });
  }

  private findPort(id: string): MidiInputLike | null {
    let found: MidiInputLike | null = null;
    this.access?.inputs.forEach((input) => {
      if (input.id === id) found = input;
    });
    return found;
  }

  private onTake(takeId: string | null): void {
    if (takeId === this.knownTakeId) return;
    this.knownTakeId = takeId;
    if (takeId !== null) {
      if (this.port === null) return; // no MIDI lane armed for this take
      this.capture = { takeId, anchorMs: performance.now(), events: [] };
      this.patch({ capturing: true, liveEventCount: 0, overflowed: false });
      return;
    }
    const done = this.capture;
    this.capture = null;
    if (!done) return;
    if (this.countFlush !== null) {
      window.clearTimeout(this.countFlush);
      this.countFlush = null;
    }
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const midi: TakeMidi = { events: done.events, overflow: this.state.overflowed };
    this.takes.set(done.takeId, midi);
    if (midi.events.length > 0) this.persist(done.takeId, midi); // take-stop flush point
    this.patch({
      capturing: false,
      liveEventCount: done.events.length,
      revision: this.state.revision + 1,
    });
  }

  private onMessage = (e: MidiMessageLike): void => {
    const capture = this.capture;
    if (!capture) return;
    const norm = normalizeMidiMessage(e.data);
    if (!norm) return; // sysex/realtime/aftertouch — dropped in v1
    const event: MidiEvent = { atSec: takeRelativeSeconds(e.timeStamp, capture.anchorMs), ...norm };
    if (appendMidiEvent(capture.events, event, this.cap)) {
      this.countFlush ??= window.setTimeout(() => {
        this.countFlush = null;
        this.patch({ liveEventCount: this.capture?.events.length ?? this.state.liveEventCount });
      }, 120);
      // Coalesced mid-take write: at most one per MIDI_SAVE_DEBOUNCE_MS
      // (schedule-once, not trailing-reset — continuous input must not
      // postpone the write forever). This window is the loss bound.
      this.saveTimer ??= window.setTimeout(() => {
        this.saveTimer = null;
        const c = this.capture;
        if (c) this.persist(c.takeId, { events: c.events, overflow: this.state.overflowed });
      }, MIDI_SAVE_DEBOUNCE_MS);
    } else if (!this.state.overflowed) {
      this.patch({ overflowed: true }); // localStorage-fallback cap: earliest kept, warn once
    }
  };

  private onStateChange = (): void => {
    const armedId = this.state.input?.id;
    if (this.state.phase === "picking") {
      this.refreshInputs();
      return;
    }
    if (this.state.phase !== "live" || !armedId) return;
    let present = false;
    this.access?.inputs.forEach((input) => {
      if (input.id === armedId && input.state !== "disconnected") present = true;
    });
    this.patch({ unplugged: !present });
  };
}

let manager: DeskMidi | null = null;
let latest: DeskMidiState | null = null;

export function getDeskMidi(sessionId: string): DeskMidi {
  if (!manager || manager.sessionId !== sessionId) {
    manager = new DeskMidi(sessionId);
    manager.subscribe((s) => {
      latest = s;
    });
    (globalThis as Record<string, unknown>).__antiphonDeskMidi = {
      midi: manager,
      snapshot: () => latest,
      takeMidi: (takeId: string) => manager?.takeMidi(takeId) ?? null,
    };
  }
  return manager;
}

export function useDeskMidi(sessionId: string): DeskMidiState {
  const subscribe = useCallback(
    (onChange: () => void) => getDeskMidi(sessionId).subscribe(() => onChange()),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, () => latest ?? getDeskMidi(sessionId).snapshot());
}
