// MidiStore seam: OpfsMidiStore (one JSONL file per take, no event cap)
// with LocalStorageMidiStore as the fallback, plus one-shot migration.
// Main-thread createWritable is deliberate: MIDI rates are tiny vs audio.

import {
  decodeMidiDoc,
  defaultMidiKV,
  type KVStore,
  loadMidi,
  midiKey,
  removeMidi,
  saveMidi,
  type TakeMidi,
} from "./midi";
import { decodeMidiJsonl, encodeMidiJsonl } from "./midi-jsonl";

export { decodeMidiJsonl, encodeMidiJsonl, MIDI_JSONL_VERSION } from "./midi-jsonl";

export const OPFS_MIDI_DIR = "antiphon-midi";

/** Load-time sanity guard for the uncapped OPFS path: no honest capture
 * reaches 64 MiB (~a million events an hour), so anything larger is
 * corrupt or hostile and reading it risks OOMing the tab. */
export const MIDI_FILE_MAX_BYTES = 64 * 1024 * 1024;

export interface MidiLoad {
  midi: TakeMidi;
  /** The size guard tripped — the stored file was refused, not read. */
  oversize: boolean;
  /** A file exists but its header is unusable — kept on disk (never
   * overwritten by migration), served as empty, surfaced in the UI. */
  unreadable: boolean;
}

export interface MidiStore {
  readonly kind: "opfs" | "local";
  /** The stored document, or null when this take has none (the distinction
   * migration needs). Never rejects — storage faults degrade to null. */
  load(sessionId: string, takeId: string): Promise<MidiLoad | null>;
  /** Rejects on write failure — callers decide whether that's a warn (the
   * debounced capture path) or a hard stop (migration must not delete the
   * localStorage key unless the OPFS write landed). */
  save(sessionId: string, takeId: string, midi: TakeMidi): Promise<void>;
  /** Idempotent; never rejects. */
  remove(sessionId: string, takeId: string): Promise<void>;
}

// ---- OPFS implementation ---------------------------------------------------------

export class OpfsMidiStore implements MidiStore {
  readonly kind = "opfs" as const;

  constructor(private readonly root: FileSystemDirectoryHandle) {}

  private async dir(sessionId: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    const top = await this.root.getDirectoryHandle(OPFS_MIDI_DIR, { create });
    return await top.getDirectoryHandle(sessionId, { create });
  }

  async load(sessionId: string, takeId: string): Promise<MidiLoad | null> {
    let file: File;
    try {
      const dir = await this.dir(sessionId, false);
      const handle = await dir.getFileHandle(`${takeId}.jsonl`);
      file = await handle.getFile();
    } catch {
      return null; // NotFound (no capture yet) and real faults look alike here — both mean "no stored document"
    }
    if (file.size === 0) {
      // A committed document always has a header line (swap-commit can't
      // tear a file); zero bytes is only the husk a failed save leaves.
      // Absent, not empty: migration must still consult localStorage.
      return null;
    }
    if (file.size > MIDI_FILE_MAX_BYTES) {
      console.warn(
        `antiphon: MIDI file for take ${takeId} is ${file.size} bytes (limit ${MIDI_FILE_MAX_BYTES}) — refusing to load a file this size; it is corrupt or not ours`,
      );
      return { midi: { events: [], overflow: false }, oversize: true, unreadable: false };
    }
    try {
      const decoded = decodeMidiJsonl(await file.text());
      if (!decoded) {
        // A file exists but its header is unusable. Not null — reporting
        // "absent" would invite a migration to overwrite whatever this is.
        console.warn(`antiphon: MIDI file for take ${takeId} has no usable header — no events`);
        return { midi: { events: [], overflow: false }, oversize: false, unreadable: true };
      }
      return { midi: decoded, oversize: false, unreadable: false };
    } catch {
      return { midi: { events: [], overflow: false }, oversize: false, unreadable: false };
    }
  }

  async save(sessionId: string, takeId: string, midi: TakeMidi): Promise<void> {
    // Serialize before any await: the capture buffer mutates between events.
    const text = encodeMidiJsonl(midi);
    const dir = await this.dir(sessionId, true);
    const name = `${takeId}.jsonl`;
    // getFileHandle(create:true) materializes an EMPTY entry before a
    // single byte lands; everything after it can still fail (quota bites
    // at write/close) — see the husk cleanup below.
    const handle = await dir.getFileHandle(name, { create: true });
    try {
      // createWritable stages into a swap file until close() — a crash
      // mid-write leaves the previous version intact, not a torn file.
      const writable = await handle.createWritable();
      try {
        await writable.write(text);
      } catch (e) {
        await writable.abort().catch(() => {});
        throw e;
      }
      await writable.close();
    } catch (e) {
      // Best-effort husk removal — ONLY the zero-byte artifact. A failed
      // rewrite of a real document keeps its previous bytes (swap-file
      // semantics); deleting those would turn a save failure into data loss.
      try {
        if ((await handle.getFile()).size === 0) await dir.removeEntry(name);
      } catch {
        // cleanup is advisory; the load guard carries the invariant
      }
      throw e;
    }
  }

  async remove(sessionId: string, takeId: string): Promise<void> {
    try {
      const dir = await this.dir(sessionId, false);
      await dir.removeEntry(`${takeId}.jsonl`);
    } catch {
      // absent already — deletion is idempotent
    }
  }
}

// ---- localStorage fallback -------------------------------------------------------

export class LocalStorageMidiStore implements MidiStore {
  readonly kind = "local" as const;

  constructor(private readonly kv: KVStore | null = defaultMidiKV()) {}

  async load(sessionId: string, takeId: string): Promise<MidiLoad | null> {
    let raw: string | null = null;
    try {
      raw = this.kv?.getItem(midiKey(sessionId, takeId)) ?? null;
    } catch {
      return null;
    }
    if (raw === null) return null;
    // Corrupt raw degrades to empty (loadMidi's tolerant rule), but the
    // key EXISTS — report a document, not null.
    return { midi: loadMidi(sessionId, takeId, this.kv), oversize: false, unreadable: false };
  }

  async save(sessionId: string, takeId: string, midi: TakeMidi): Promise<void> {
    saveMidi(sessionId, takeId, midi, this.kv); // swallows quota errors, as before
  }

  async remove(sessionId: string, takeId: string): Promise<void> {
    removeMidi(sessionId, takeId, this.kv);
  }
}

// ---- feature detection + migration ---------------------------------------------------

let defaultStorePromise: Promise<MidiStore> | null = null;

/** The page's MIDI store, decided ONCE: OPFS when getDirectory() actually
 * yields a root (not merely when the method exists — private modes can
 * reject), else the localStorage fallback, said out loud. */
export function defaultMidiStore(): Promise<MidiStore> {
  defaultStorePromise ??= (async () => {
    try {
      if (typeof navigator.storage?.getDirectory !== "function") {
        throw new Error("navigator.storage.getDirectory missing");
      }
      return new OpfsMidiStore(await navigator.storage.getDirectory());
    } catch (e) {
      console.info(
        `antiphon: OPFS unavailable (${String(e)}) — MIDI persists to localStorage with the 50k-event cap`,
      );
      return new LocalStorageMidiStore();
    }
  })();
  return defaultStorePromise;
}

/** Load a take's MIDI through the store, migrating any legacy localStorage
 * document into OPFS on first touch: read → write OPFS → only then delete
 * the key (a failed write must not orphan the data). */
export async function loadTakeMidi(
  store: MidiStore,
  sessionId: string,
  takeId: string,
  kv: KVStore | null = defaultMidiKV(),
): Promise<MidiLoad> {
  const stored = await store.load(sessionId, takeId);
  if (stored) return stored;
  const none: MidiLoad = {
    midi: { events: [], overflow: false },
    oversize: false,
    unreadable: false,
  };
  if (store.kind === "local") return none; // the store IS localStorage — nothing else to consult
  let raw: string | null = null;
  try {
    raw = kv?.getItem(midiKey(sessionId, takeId)) ?? null;
  } catch {
    return none;
  }
  if (raw === null) return none;
  const decoded = decodeMidiDoc(raw);
  if (!decoded) {
    console.warn(
      `antiphon: legacy MIDI for take ${takeId} is corrupt beyond parsing — nothing to migrate, dropping the localStorage entry`,
    );
    removeMidi(sessionId, takeId, kv);
    return none;
  }
  if (decoded.dropped > 0) {
    console.warn(
      `antiphon: migrating MIDI for take ${takeId} to OPFS — kept ${decoded.midi.events.length} events, dropped ${decoded.dropped} corrupt entries`,
    );
  }
  try {
    await store.save(sessionId, takeId, decoded.midi);
  } catch (e) {
    // OPFS write failed: keep the localStorage copy, serve the decoded
    // events for this page load, retry migration next visit.
    console.warn(`antiphon: MIDI migration write failed (${String(e)}) — keeping localStorage`);
    return { midi: decoded.midi, oversize: false, unreadable: false };
  }
  removeMidi(sessionId, takeId, kv);
  return { midi: decoded.midi, oversize: false, unreadable: false };
}
