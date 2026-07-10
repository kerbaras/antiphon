// MidiStore-backed per-take MIDI library for the DeskMidi manager:
// background hydration of stored takes, serialized whole-file writes, and
// the OPFS-vs-localStorage capture cap.

import { MIDI_EVENT_CAP, removeMidi, type TakeMidi } from "./midi";
import { loadTakeMidi, type MidiStore } from "./midi-store";

export interface MidiLibraryEvents {
  /** Stored events changed (UI re-reads); `error` carries a storage
   * refusal for the MIDI error strip. */
  onRevision(error?: string): void;
  /** A queued write failed — events ride memory until one lands. */
  onSaveError(error: string): void;
}

export class TakeMidiLibrary {
  /** Loaded/finished takes' events, by takeId. */
  private readonly takes = new Map<string, TakeMidi>();
  /** The page's MidiStore (feature detection is async — awaited per op). */
  private readonly storeReady: Promise<MidiStore>;
  /** Capture cap: none on OPFS; the localStorage fallback keeps the cap.
   * Starts capped — flips only after the store proves to be OPFS. */
  private capValue: number = MIDI_EVENT_CAP;
  /** Serializes writes: whole-file rewrites must land in schedule order or
   * an older debounced write could outlive a newer one. */
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionId: string,
    storePromise: Promise<MidiStore>,
    private readonly events: MidiLibraryEvents,
  ) {
    this.storeReady = storePromise;
    void storePromise.then((store) => {
      if (store.kind === "opfs") this.capValue = Number.POSITIVE_INFINITY;
    });
  }

  cap(): number {
    return this.capValue;
  }

  /** A take's stored MIDI: finished captures this page load, else the
   * persisted document. Storage reads are async (OPFS), so a first touch
   * returns an empty placeholder, hydrates in the background, and signals
   * a revision when the real events land. */
  takeMidi(takeId: string): TakeMidi {
    let midi = this.takes.get(takeId);
    if (!midi) {
      midi = { events: [], overflow: false };
      this.takes.set(takeId, midi);
      void this.hydrate(takeId, midi);
    }
    return midi;
  }

  /** A capture just finished — it owns the take's entry now. */
  setFinished(takeId: string, midi: TakeMidi): void {
    this.takes.set(takeId, midi);
  }

  private async hydrate(takeId: string, placeholder: TakeMidi): Promise<void> {
    try {
      const store = await this.storeReady;
      const loaded = await loadTakeMidi(store, this.sessionId, takeId);
      // A capture that finished while we read owns the entry now — keep it.
      if (this.takes.get(takeId) !== placeholder) return;
      this.takes.set(takeId, loaded.midi);
      this.events.onRevision(
        loaded.oversize
          ? "a take's stored MIDI exceeds the 64 MB guard — not loaded (see console)"
          : loaded.unreadable
            ? "a take's stored MIDI is unreadable — kept on disk, not loaded (see console)"
            : undefined,
      );
    } catch (e) {
      // A side-store must not take the desk down.
      console.warn(`antiphon: MIDI load failed for take ${takeId}: ${String(e)}`);
    }
  }

  /** Queue a write. The chain serializes whole-file rewrites; the store
   * serializes the events synchronously at write time, so passing the live
   * capture buffer is sound (newer events only make the write fresher). */
  persist(takeId: string, midi: TakeMidi): void {
    this.saveChain = this.saveChain.then(async () => {
      const store = await this.storeReady;
      try {
        await store.save(this.sessionId, takeId, midi);
      } catch (e) {
        // Visible, not console-only: the operator should know the
        // performance data is riding memory until a write lands.
        console.warn(`antiphon: MIDI save failed for take ${takeId}: ${String(e)}`);
        this.events.onSaveError(
          "MIDI save failed — events held in memory this page load (see console)",
        );
      }
    });
  }

  /** Take-level cleanup: cache, stored file, and any legacy localStorage
   * key. Chained behind pending saves so a debounced write can't
   * resurrect the file; the caller cancels its own pending debounce. */
  remove(takeId: string): void {
    this.takes.delete(takeId);
    this.saveChain = this.saveChain.then(async () => {
      const store = await this.storeReady;
      await store.remove(this.sessionId, takeId);
    });
    removeMidi(this.sessionId, takeId); // pre-migration copies, either store kind
    this.events.onRevision();
  }
}
