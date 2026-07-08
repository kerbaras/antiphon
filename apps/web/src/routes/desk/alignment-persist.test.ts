// F7b alignment persistence: validation (untrusted doc/localStorage
// payloads), the two storage layers, newest-wins reconciliation (the
// reload-vs-unsynced-doc race), and the collab binding's loop guards — all
// against plain Y.Docs and in-memory stores, per the collab-doc.ts testing
// convention.

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  alignmentEntriesOf,
  alignmentKey,
  bindAlignmentToCollab,
  loadLocalAlignment,
  parseTakeAlignment,
  parseTakeAlignmentRecord,
  persistTakeAlignment,
  readDocAlignment,
  restoreTakeAlignment,
  saveLocalAlignment,
  type TakeAlignment,
  type TakeAlignmentRecord,
  writeDocAlignmentIfChanged,
} from "./alignment-persist";
import type { PlayerSnapshot, StoredTrackAlignment } from "./player";

function memoryStore(): Pick<Storage, "getItem" | "setItem"> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

function verdict(lag: number, applied = true): StoredTrackAlignment {
  return {
    alignment: { lagSamples: lag, confidence: applied ? 5 : 0.3, applied },
    drift: null,
  };
}

function record(at: number, lag: number, applied = true): TakeAlignmentRecord {
  return { at, entries: { s1: verdict(lag, applied) } };
}

const TAKE = "take-1";
const SESSION = "session-1";

/** Minimal AlignmentPlayerPort double recording restore calls. */
function fakePlayer(loadedTakeId: string | null = TAKE) {
  const restores: Array<{ takeId: string; entries: TakeAlignment }> = [];
  let settled: ((takeId: string) => void) | null = null;
  const snapshot = { loadedTakeId, tracks: [] } as unknown as PlayerSnapshot;
  return {
    restores,
    fireSettled: (takeId: string) => settled?.(takeId),
    setSnapshot: (snap: PlayerSnapshot) => Object.assign(snapshot, snap),
    port: {
      snapshot: () => snapshot,
      restoreAlignment: (takeId: string, entries: TakeAlignment) => {
        restores.push({ takeId, entries });
        return true;
      },
      onAlignmentSettled: (listener: (takeId: string) => void) => {
        settled = listener;
        return () => {
          settled = null;
        };
      },
    },
  };
}

describe("parseTakeAlignment", () => {
  it("accepts a valid verdict and rebuilds exact shapes (no extra keys)", () => {
    const parsed = parseTakeAlignment({
      s1: { ...verdict(0), rogue: "extra" },
      s2: {
        alignment: { lagSamples: 10, confidence: 3, applied: true },
        drift: {
          ratio: 1.0001,
          ppm: 100,
          initialOffsetSamples: 5,
          confidence: 1,
          windowsUsed: 4,
          applied: true,
          isReference: false,
          rogue: true,
        },
      },
    });
    expect(parsed).toEqual({
      s1: verdict(0),
      s2: {
        alignment: { lagSamples: 10, confidence: 3, applied: true },
        drift: {
          ratio: 1.0001,
          ppm: 100,
          initialOffsetSamples: 5,
          confidence: 1,
          windowsUsed: 4,
          applied: true,
          isReference: false,
        },
      },
    });
  });

  it("drops malformed entries individually and nulls out empty results", () => {
    expect(
      parseTakeAlignment({
        good: verdict(3),
        noAlignment: { drift: null },
        badLag: { alignment: { lagSamples: "12", confidence: 1, applied: true }, drift: null },
        badDrift: { alignment: verdict(0).alignment, drift: { ratio: "x" } },
      }),
    ).toEqual({ good: verdict(3) });
    expect(parseTakeAlignment(null)).toBeNull();
    expect(parseTakeAlignment("junk")).toBeNull();
    expect(parseTakeAlignment({ all: { bad: true } })).toBeNull();
  });

  it("record wrapper requires a finite `at` and valid entries", () => {
    expect(parseTakeAlignmentRecord(record(7, 3))).toEqual(record(7, 3));
    expect(parseTakeAlignmentRecord({ at: "now", entries: { s1: verdict(0) } })).toBeNull();
    expect(parseTakeAlignmentRecord({ at: 7, entries: {} })).toBeNull();
    expect(parseTakeAlignmentRecord(null)).toBeNull();
  });
});

describe("localStorage shadow", () => {
  it("round-trips through a schema-versioned key", () => {
    const store = memoryStore();
    saveLocalAlignment(SESSION, TAKE, record(42, 7), store);
    expect(store.map.has(alignmentKey(SESSION, TAKE))).toBe(true);
    expect(loadLocalAlignment(SESSION, TAKE, store)).toEqual(record(42, 7));
  });

  it("degrades to null on junk, wrong schema, or absent keys", () => {
    const store = memoryStore();
    expect(loadLocalAlignment(SESSION, TAKE, store)).toBeNull();
    store.map.set(alignmentKey(SESSION, TAKE), "not json");
    expect(loadLocalAlignment(SESSION, TAKE, store)).toBeNull();
    store.map.set(alignmentKey(SESSION, TAKE), JSON.stringify({ v: 99, at: 1, entries: {} }));
    expect(loadLocalAlignment(SESSION, TAKE, store)).toBeNull();
  });
});

describe("doc layer", () => {
  it("writes iff changed — equal content never transacts (no echo loops)", () => {
    const doc = new Y.Doc();
    const origin = {};
    expect(writeDocAlignmentIfChanged(doc, TAKE, record(1, 1), origin)).toBe(true);
    expect(writeDocAlignmentIfChanged(doc, TAKE, record(1, 1), origin)).toBe(false);
    expect(writeDocAlignmentIfChanged(doc, TAKE, record(2, 2), origin)).toBe(true);
    expect(readDocAlignment(doc, TAKE)).toEqual(record(2, 2));
    expect(readDocAlignment(doc, "other")).toBeNull();
  });
});

describe("restoreTakeAlignment (newest wins)", () => {
  it("doc newer (or ties): restores from the doc and refreshes the shadow", () => {
    const store = memoryStore();
    vi.stubGlobal("localStorage", store);
    try {
      const doc = new Y.Doc();
      const collab = { doc, origin: {} };
      saveLocalAlignment(SESSION, TAKE, record(1_000, 1));
      writeDocAlignmentIfChanged(doc, TAKE, record(2_000, 4), collab.origin);
      const player = fakePlayer();
      expect(restoreTakeAlignment(collab, player.port, SESSION, TAKE)).toBe(true);
      expect(player.restores).toEqual([{ takeId: TAKE, entries: { s1: verdict(4) } }]);
      expect(loadLocalAlignment(SESSION, TAKE)).toEqual(record(2_000, 4)); // shadow refreshed
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shadow newer (measured just before a reload, doc unsynced): shadow wins and re-seeds the doc", () => {
    const store = memoryStore();
    vi.stubGlobal("localStorage", store);
    try {
      const doc = new Y.Doc();
      const collab = { doc, origin: {} };
      writeDocAlignmentIfChanged(doc, TAKE, record(1_000, 1, false), collab.origin);
      saveLocalAlignment(SESSION, TAKE, record(2_000, 9));
      const player = fakePlayer();
      expect(restoreTakeAlignment(collab, player.port, SESSION, TAKE)).toBe(true);
      expect(player.restores).toEqual([{ takeId: TAKE, entries: { s1: verdict(9) } }]);
      expect(readDocAlignment(doc, TAKE)).toEqual(record(2_000, 9)); // pushed back
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("localStorage alone seeds the doc for second desks", () => {
    const store = memoryStore();
    vi.stubGlobal("localStorage", store);
    try {
      saveLocalAlignment(SESSION, TAKE, record(5, 9));
      const doc = new Y.Doc();
      const collab = { doc, origin: {} };
      const player = fakePlayer();
      expect(restoreTakeAlignment(collab, player.port, SESSION, TAKE)).toBe(true);
      expect(readDocAlignment(doc, TAKE)).toEqual(record(5, 9)); // seeded
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("nothing stored → no restore", () => {
    const player = fakePlayer();
    expect(restoreTakeAlignment({ doc: new Y.Doc(), origin: {} }, player.port, SESSION, TAKE)).toBe(
      false,
    );
    expect(player.restores).toEqual([]);
  });
});

describe("bindAlignmentToCollab", () => {
  it("persists settled runs; remote doc updates restore; own writes skipped", () => {
    // Two docs relayed like the wire would (update fan-out both ways).
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.on("update", (u: Uint8Array) => Y.applyUpdate(docB, u, "remote"));
    docB.on("update", (u: Uint8Array) => Y.applyUpdate(docA, u, "remote"));
    const collabA = { doc: docA, origin: {} };
    const collabB = { doc: docB, origin: {} };

    const playerA = fakePlayer();
    const playerB = fakePlayer();
    const unbindA = bindAlignmentToCollab(collabA, playerA.port, SESSION);
    const unbindB = bindAlignmentToCollab(collabB, playerB.port, `${SESSION}-b`);

    // Desk A settles an align() run with a measured verdict.
    playerA.setSnapshot({
      loadedTakeId: TAKE,
      tracks: [
        {
          streamId: "s1",
          alignment: { lagSamples: 0, confidence: 5, applied: true },
          drift: null,
        },
        {
          streamId: "s2",
          alignment: { lagSamples: 4_800, confidence: 5, applied: true },
          drift: null,
        },
      ],
    } as unknown as PlayerSnapshot);
    playerA.fireSettled(TAKE);

    // A's own write never loops back into A's player…
    expect(playerA.restores).toEqual([]);
    // …but B (remote) reapplies it to its loaded take.
    expect(playerB.restores).toHaveLength(1);
    expect(playerB.restores[0]?.takeId).toBe(TAKE);
    expect(playerB.restores[0]?.entries.s2?.alignment.lagSamples).toBe(4_800);
    // And the doc holds the verdict for cold desks.
    expect(readDocAlignment(docA, TAKE)?.entries.s1?.alignment.applied).toBe(true);

    unbindA();
    unbindB();
  });

  it("a stale remote write never stomps a fresher local shadow", () => {
    const store = memoryStore();
    vi.stubGlobal("localStorage", store);
    try {
      const doc = new Y.Doc();
      const collab = { doc, origin: {} };
      const player = fakePlayer();
      saveLocalAlignment(SESSION, TAKE, record(2_000, 9)); // fresher, unsynced
      const unbind = bindAlignmentToCollab(collab, player.port, SESSION);
      // A stale verdict lands from the wire (e.g. late initial sync).
      doc.transact(() => {
        doc.getMap<TakeAlignmentRecord>("alignment").set(TAKE, record(1_000, 1, false));
      }, "remote");
      // The player got the FRESH verdict, and the doc was pushed forward.
      expect(player.restores).toEqual([{ takeId: TAKE, entries: { s1: verdict(9) } }]);
      expect(readDocAlignment(doc, TAKE)).toEqual(record(2_000, 9));
      unbind();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("alignmentEntriesOf ignores foreign takes and unmeasured tracks", () => {
    const snap = {
      loadedTakeId: TAKE,
      tracks: [
        { streamId: "s1", alignment: null, drift: null },
        {
          streamId: "s2",
          alignment: { lagSamples: 1, confidence: 0.2, applied: false },
          drift: null,
        },
      ],
    } as unknown as PlayerSnapshot;
    expect(alignmentEntriesOf(snap, "other")).toBeNull();
    expect(alignmentEntriesOf(snap, TAKE)).toEqual({
      s2: { alignment: { lagSamples: 1, confidence: 0.2, applied: false }, drift: null },
    });
    expect(
      alignmentEntriesOf({ loadedTakeId: TAKE, tracks: [] } as unknown as PlayerSnapshot, TAKE),
    ).toBeNull();
  });

  it("persistTakeAlignment writes both layers with the measurement clock", () => {
    const store = memoryStore();
    vi.stubGlobal("localStorage", store);
    try {
      const doc = new Y.Doc();
      persistTakeAlignment({ doc, origin: {} }, SESSION, TAKE, { s1: verdict(2) }, 1_234);
      expect(readDocAlignment(doc, TAKE)).toEqual(record(1_234, 2));
      expect(loadLocalAlignment(SESSION, TAKE)).toEqual(record(1_234, 2));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
