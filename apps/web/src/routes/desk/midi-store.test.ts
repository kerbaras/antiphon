// The MidiStore seam (W5-D): the JSONL codec, the REAL OpfsMidiStore run
// against a scripted OPFS handle tree, and the migration orchestration.
// QA F1 taught the lesson the hard way: the first cut used a hand-rolled
// in-memory store whose failed save left NO file — masking the zero-byte
// husk getFileHandle(create:true) leaves behind in real OPFS. So the fake
// here models the handle API's actual materialization semantics (create
// puts an empty entry on disk before a byte is written; close() commits
// the swap buffer) and every "opfs" test exercises the shipped class.
// Real navigator.storage.getDirectory() is covered by the chromium e2e
// (midi-opfs.spec.ts) — jsdom has none.

import { afterEach, describe, expect, it, vi } from "vitest";
import { type KVStore, type MidiEvent, midiKey, saveMidi, type TakeMidi } from "./midi";
import {
  decodeMidiJsonl,
  encodeMidiJsonl,
  LocalStorageMidiStore,
  loadTakeMidi,
  MIDI_FILE_MAX_BYTES,
  MIDI_JSONL_VERSION,
  OPFS_MIDI_DIR,
  OpfsMidiStore,
} from "./midi-store";

const ev = (atSec: number, status = 0x90, data1 = 60, data2 = 100): MidiEvent => ({
  atSec,
  status,
  data1,
  data2,
});

function memKV(): KVStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** Scripted OPFS: nested handle API over a flat path→text map, mirroring
 * the semantics OpfsMidiStore relies on — getFileHandle(create:true)
 * materializes an EMPTY entry immediately (the QA F1 husk), writes stage
 * into a buffer that only close() commits (swap-file), and reads observe
 * whatever is committed. `failNextWrite` makes writable.write throw the
 * quota shape (after the handle exists — where quota actually bites). */
function fakeOpfs(): {
  root: FileSystemDirectoryHandle;
  files: Map<string, string>;
  state: { failNextWrite: boolean };
  /** Seed a file as if committed earlier (registers its parent dirs). */
  plant: (path: string, text: string) => void;
} {
  const files = new Map<string, string>();
  const dirs = new Set<string>([""]);
  const state = { failNextWrite: false };
  const notFound = () => new DOMException("not found", "NotFoundError");
  function dirHandle(prefix: string): FileSystemDirectoryHandle {
    const child = (name: string) => (prefix ? `${prefix}/${name}` : name);
    return {
      async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
        const p = child(name);
        if (!dirs.has(p)) {
          if (!opts?.create) throw notFound();
          dirs.add(p);
        }
        return dirHandle(p);
      },
      async getFileHandle(name: string, opts?: { create?: boolean }) {
        const p = child(name);
        if (!files.has(p)) {
          if (!opts?.create) throw notFound();
          files.set(p, ""); // materializes empty BEFORE any byte lands
        }
        return {
          async getFile() {
            const text = files.get(p);
            if (text === undefined) throw notFound();
            return { size: text.length, text: async () => text } as File;
          },
          async createWritable() {
            let buf = "";
            return {
              async write(chunk: string) {
                if (state.failNextWrite) {
                  state.failNextWrite = false;
                  throw new DOMException("quota exceeded", "QuotaExceededError");
                }
                buf += chunk;
              },
              async close() {
                files.set(p, buf); // swap-commit: all or previous
              },
              async abort() {},
            };
          },
        } as unknown as FileSystemFileHandle;
      },
      async removeEntry(name: string) {
        if (!files.delete(child(name))) throw notFound();
      },
    } as unknown as FileSystemDirectoryHandle;
  }
  function plant(path: string, text: string): void {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    files.set(path, text);
  }
  return { root: dirHandle(""), files, state, plant };
}

const filePath = (sessionId: string, takeId: string) =>
  `${OPFS_MIDI_DIR}/${sessionId}/${takeId}.jsonl`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("JSONL codec", () => {
  it("round-trips events + overflow flag, sorted", () => {
    const midi: TakeMidi = { events: [ev(2), ev(0.5, 0x80, 60, 0)], overflow: true };
    const decoded = decodeMidiJsonl(encodeMidiJsonl(midi));
    expect(decoded?.events.map((e) => e.atSec)).toEqual([0.5, 2]);
    expect(decoded?.overflow).toBe(true);
  });

  it("first line is a schema-versioned header; events follow one per line", () => {
    const text = encodeMidiJsonl({ events: [ev(1), ev(2)], overflow: false });
    const lines = text.split("\n");
    expect(JSON.parse(lines[0] as string)).toEqual({
      antiphonMidiJsonl: MIDI_JSONL_VERSION,
      overflow: false,
    });
    expect(lines).toHaveLength(4); // header + 2 events + trailing newline
    expect(JSON.parse(lines[1] as string)).toEqual(ev(1));
  });

  it("an empty capture encodes to just the header", () => {
    const decoded = decodeMidiJsonl(encodeMidiJsonl({ events: [], overflow: false }));
    expect(decoded).toEqual({ events: [], overflow: false });
  });

  it("keeps what parses: junk and truncated lines cost only themselves", () => {
    const good = encodeMidiJsonl({ events: [ev(1), ev(2), ev(3)], overflow: false });
    const lines = good.trimEnd().split("\n");
    lines[2] = '{"atSec":2,"status":144,"da'; // truncated mid-write
    lines.push("not json at all", JSON.stringify({ atSec: -5, status: 0x90, data1: 60, data2: 1 }));
    const decoded = decodeMidiJsonl(lines.join("\n"));
    expect(decoded?.events.map((e) => e.atSec)).toEqual([1, 3]);
  });

  it("refuses unusable or future headers (null — semantics unknown)", () => {
    expect(decodeMidiJsonl("")).toBeNull();
    expect(decodeMidiJsonl("garbage\n")).toBeNull();
    expect(decodeMidiJsonl('{"somethingElse":true}\n')).toBeNull();
    expect(decodeMidiJsonl(`{"antiphonMidiJsonl":${MIDI_JSONL_VERSION + 1}}\n`)).toBeNull();
  });

  it("blank lines are ignored (tolerant of editor round-trips)", () => {
    const text = `${encodeMidiJsonl({ events: [ev(1)], overflow: false })}\n\n`;
    expect(decodeMidiJsonl(text)?.events).toHaveLength(1);
  });
});

describe("OpfsMidiStore against the handle API", () => {
  it("save → load round-trips through a committed JSONL file", async () => {
    const fx = fakeOpfs();
    const store = new OpfsMidiStore(fx.root);
    await store.save("s", "t", { events: [ev(2), ev(1)], overflow: true });
    expect(fx.files.get(filePath("s", "t"))?.startsWith('{"antiphonMidiJsonl"')).toBe(true);
    const loaded = await store.load("s", "t");
    expect(loaded?.midi.events.map((e) => e.atSec)).toEqual([1, 2]);
    expect(loaded?.midi.overflow).toBe(true);
    expect(loaded).toMatchObject({ oversize: false, unreadable: false });
  });

  it("no file = null; remove is idempotent", async () => {
    const fx = fakeOpfs();
    const store = new OpfsMidiStore(fx.root);
    expect(await store.load("s", "t")).toBeNull();
    await store.save("s", "t", { events: [ev(1)], overflow: false });
    await store.remove("s", "t");
    await store.remove("s", "t"); // second delete must not throw
    expect(await store.load("s", "t")).toBeNull();
  });

  it("QA F1, load end: a zero-byte file is ABSENT, not an empty document", async () => {
    const fx = fakeOpfs();
    fx.plant(filePath("s", "t"), ""); // the husk, planted directly
    expect(await new OpfsMidiStore(fx.root).load("s", "t")).toBeNull();
  });

  it("QA F1, save end: a failed write cleans up its husk and rejects", async () => {
    const fx = fakeOpfs();
    const store = new OpfsMidiStore(fx.root);
    fx.state.failNextWrite = true;
    await expect(store.save("s", "t", { events: [ev(1)], overflow: false })).rejects.toThrow(
      /quota/,
    );
    expect(fx.files.has(filePath("s", "t"))).toBe(false); // no shadow left behind
  });

  it("QA F1: a failed REWRITE keeps the previous document (never deletes real bytes)", async () => {
    const fx = fakeOpfs();
    const store = new OpfsMidiStore(fx.root);
    await store.save("s", "t", { events: [ev(1)], overflow: false });
    fx.state.failNextWrite = true;
    await expect(store.save("s", "t", { events: [ev(1), ev(2)], overflow: false })).rejects.toThrow(
      /quota/,
    );
    const loaded = await store.load("s", "t");
    expect(loaded?.midi.events).toEqual([ev(1)]); // swap-file semantics: old bytes intact
  });

  it("corrupt header: served empty + unreadable (file kept, migration never invited)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fx = fakeOpfs();
    fx.plant(filePath("s", "t"), "not a header\n");
    const loaded = await new OpfsMidiStore(fx.root).load("s", "t");
    expect(loaded).toEqual({
      midi: { events: [], overflow: false },
      oversize: false,
      unreadable: true,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("oversize guard: a monster file is refused, not read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fx = fakeOpfs();
    fx.plant(filePath("s", "t"), "x".repeat(MIDI_FILE_MAX_BYTES + 1));
    const loaded = await new OpfsMidiStore(fx.root).load("s", "t");
    expect(loaded).toEqual({
      midi: { events: [], overflow: false },
      oversize: true,
      unreadable: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("LocalStorageMidiStore (the capped fallback)", () => {
  it("wraps the W3-C localStorage behavior: load/save/remove per (session, take)", async () => {
    const kv = memKV();
    const store = new LocalStorageMidiStore(kv);
    expect(store.kind).toBe("local");
    expect(await store.load("s", "t")).toBeNull(); // no key = no document
    await store.save("s", "t", { events: [ev(1)], overflow: false });
    expect((await store.load("s", "t"))?.midi.events).toEqual([ev(1)]);
    await store.remove("s", "t");
    expect(await store.load("s", "t")).toBeNull();
  });

  it("a present-but-corrupt key is a document (empty), not null — never invites re-migration", async () => {
    const kv = memKV();
    kv.map.set(midiKey("s", "t"), "corrupt{");
    const loaded = await new LocalStorageMidiStore(kv).load("s", "t");
    expect(loaded).toEqual({
      midi: { events: [], overflow: false },
      oversize: false,
      unreadable: false,
    });
  });
});

describe("loadTakeMidi migration (localStorage → OPFS)", () => {
  it("first load of a legacy take: read → write OPFS → delete the key", async () => {
    const kv = memKV();
    const fx = fakeOpfs();
    const store = new OpfsMidiStore(fx.root);
    saveMidi("s", "t", { events: [ev(1), ev(2)], overflow: true }, kv);
    const loaded = await loadTakeMidi(store, "s", "t", kv);
    expect(loaded.midi.events.map((e) => e.atSec)).toEqual([1, 2]);
    expect(loaded.midi.overflow).toBe(true); // capped history stays marked
    expect((await store.load("s", "t"))?.midi.events).toHaveLength(2);
    expect(kv.map.has(midiKey("s", "t"))).toBe(false);
  });

  it("an existing OPFS document wins — no migration, key untouched", async () => {
    const kv = memKV();
    const fx = fakeOpfs();
    const store = new OpfsMidiStore(fx.root);
    await store.save("s", "t", { events: [ev(9)], overflow: false });
    saveMidi("s", "t", { events: [ev(1)], overflow: false }, kv); // stale legacy copy
    const loaded = await loadTakeMidi(store, "s", "t", kv);
    expect(loaded.midi.events).toEqual([ev(9)]);
    expect(kv.map.has(midiKey("s", "t"))).toBe(true);
  });

  it("no document anywhere = empty", async () => {
    const loaded = await loadTakeMidi(new OpfsMidiStore(fakeOpfs().root), "s", "t", memKV());
    expect(loaded).toEqual({
      midi: { events: [], overflow: false },
      oversize: false,
      unreadable: false,
    });
  });

  it("partially corrupt legacy doc: keeps what parses, warns once, migrates the survivors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = memKV();
    const fx = fakeOpfs();
    const store = new OpfsMidiStore(fx.root);
    kv.map.set(midiKey("s", "t"), JSON.stringify({ v: 1, events: [ev(1), "junk", null] }));
    const loaded = await loadTakeMidi(store, "s", "t", kv);
    expect(loaded.midi.events).toEqual([ev(1)]);
    expect((await store.load("s", "t"))?.midi.events).toEqual([ev(1)]);
    expect(kv.map.has(midiKey("s", "t"))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("wholly corrupt legacy doc: warns, drops the key, nothing written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = memKV();
    const fx = fakeOpfs();
    kv.map.set(midiKey("s", "t"), "not a doc{");
    const loaded = await loadTakeMidi(new OpfsMidiStore(fx.root), "s", "t", kv);
    expect(loaded.midi.events).toEqual([]);
    expect(fx.files.size).toBe(0);
    expect(kv.map.has(midiKey("s", "t"))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("QA C6 regression: a failed migration write never shadows the legacy doc — served now, retried next visit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = memKV();
    const fx = fakeOpfs();
    const store = new OpfsMidiStore(fx.root);
    saveMidi("s", "t", { events: [ev(1)], overflow: false }, kv);

    // Visit 1: quota bites at write time — AFTER getFileHandle(create)
    // has already materialized the zero-byte husk (the real OPFS shape
    // the first test double failed to model).
    fx.state.failNextWrite = true;
    const firstVisit = await loadTakeMidi(store, "s", "t", kv);
    expect(firstVisit.midi.events).toEqual([ev(1)]); // served from localStorage
    expect(kv.map.has(midiKey("s", "t"))).toBe(true); // key kept for the retry
    expect(await store.load("s", "t")).toBeNull(); // and NO husk shadows it
    expect(warn).toHaveBeenCalledTimes(1);

    // Visit 2: storage recovered — migration completes exactly as if the
    // failure never happened.
    const secondVisit = await loadTakeMidi(store, "s", "t", kv);
    expect(secondVisit.midi.events).toEqual([ev(1)]);
    expect((await store.load("s", "t"))?.midi.events).toEqual([ev(1)]);
    expect(kv.map.has(midiKey("s", "t"))).toBe(false);
  });

  it("on the localStorage fallback store there is nothing to migrate — load is the answer", async () => {
    const kv = memKV();
    const store = new LocalStorageMidiStore(kv);
    saveMidi("s", "t", { events: [ev(1)], overflow: false }, kv);
    const loaded = await loadTakeMidi(store, "s", "t", kv);
    expect(loaded.midi.events).toEqual([ev(1)]);
    expect(kv.map.has(midiKey("s", "t"))).toBe(true); // key stays — it IS the store
  });
});
