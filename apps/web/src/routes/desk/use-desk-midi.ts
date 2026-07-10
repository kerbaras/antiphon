// Desk MIDI capture: Web MIDI is desk-local by design (the wire protocol
// stays audio-only). While a take rolls, channel messages are timestamped
// against the take and persisted per take; playback renders nothing
// audible — the audio lanes already carry the piano. One manager per desk
// page, bridged into React, with the __antiphonDeskMidi e2e hook.

import { useCallback, useSyncExternalStore } from "react";
import { getDeskSession } from "./desk-state";
import {
  appendMidiEvent,
  loadMidiPrefs,
  type MidiEvent,
  type MidiInputPrefs,
  normalizeMidiMessage,
  saveMidiPrefs,
  type TakeMidi,
  takeRelativeSeconds,
} from "./midi";
import {
  type MidiAccessFactory,
  type MidiAccessLike,
  type MidiInputLike,
  type MidiInputOption,
  type MidiMessageLike,
  midiAccess,
  midiInputOption,
} from "./midi-access";
import { defaultMidiStore, type MidiStore } from "./midi-store";
import { TakeMidiLibrary } from "./midi-take-library";

export type {
  MidiAccessFactory,
  MidiAccessLike,
  MidiInputLike,
  MidiInputOption,
  MidiMessageLike,
} from "./midi-access";

/** Mid-take write debounce. The in-memory event list is the source of
 * truth and the store trails it, so this window is the accepted loss bound
 * when the tab dies without firing its lifecycle flush points. */
export const MIDI_SAVE_DEBOUNCE_MS = 2_000;

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
  /** Persisted input from a previous visit — one-click resume. */
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
  /** Stored take MIDI: hydration, serialized writes, capture cap. */
  private readonly library: TakeMidiLibrary;
  /** Debounced mid-take write; doubles as the dirty flag. */
  private saveTimer: number | null = null;

  constructor(
    readonly sessionId: string,
    private readonly requestAccess: MidiAccessFactory = midiAccess,
    storePromise: Promise<MidiStore> = defaultMidiStore(),
  ) {
    this.library = new TakeMidiLibrary(sessionId, storePromise, {
      onRevision: (error) =>
        this.patch({ revision: this.state.revision + 1, ...(error ? { error } : {}) }),
      onSaveError: (error) => this.patch({ error }),
    });
    // Take lifecycle rides the desk session (fires synchronously on patch,
    // so the anchor is sampled the instant the desk learns of take-start).
    const session = getDeskSession(sessionId);
    this.knownTakeId = session.snapshot().activeTakeId; // pre-rolling take: never capture a partial tail
    session.subscribe((s) => this.onTake(s.activeTakeId));
    // A take deleted from every sink takes its MIDI with it — the desk is
    // this data's only home; a dangling file would be an orphan forever.
    session.onStreamsDeleted((_streamIds, deletedTakeIds) => {
      for (const takeId of deletedTakeIds) this.deleteTakeMidi(takeId);
    });
    // Flush points: an unflushed tail must not ride on the tab surviving
    // the next debounce window. pagehide's async write is best-effort.
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
   * persisted document (hydrated in the background — `revision` bumps
   * when the real events land). */
  takeMidi(takeId: string): TakeMidi {
    return this.library.takeMidi(takeId);
  }

  /** Flush the pending debounced write NOW — visibilitychange/pagehide and
   * take stop. */
  private flushCapture(): void {
    if (this.saveTimer === null) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const capture = this.capture;
    if (capture) {
      this.library.persist(capture.takeId, {
        events: capture.events,
        overflow: this.state.overflowed,
      });
    }
  }

  /** Take-level cleanup: cache, stored file, any legacy localStorage key. */
  deleteTakeMidi(takeId: string): void {
    // A pending debounced write for THIS take would queue behind the
    // remove and resurrect the file — cancel it. Another take's pending
    // write (the rolling capture) is not ours to drop.
    if (this.capture?.takeId === takeId && this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.library.remove(takeId);
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

  /** One click after a reload: re-arm the persisted input. */
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
      inputs.push(midiInputOption(input));
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
    this.library.setFinished(done.takeId, midi);
    if (midi.events.length > 0) this.library.persist(done.takeId, midi); // take-stop flush point
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
    if (appendMidiEvent(capture.events, event, this.library.cap())) {
      this.countFlush ??= window.setTimeout(() => {
        this.countFlush = null;
        this.patch({ liveEventCount: this.capture?.events.length ?? this.state.liveEventCount });
      }, 120);
      // Coalesced mid-take write: schedule-once, not trailing-reset —
      // continuous input must not postpone the write forever.
      this.saveTimer ??= window.setTimeout(() => {
        this.saveTimer = null;
        const c = this.capture;
        if (c) {
          this.library.persist(c.takeId, { events: c.events, overflow: this.state.overflowed });
        }
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
