// W3-A doc-shape helpers: convergence, seed-once, loop-guard (origin
// filtering + no-echo writes), and the offline display fallback — all with
// plain Y.Docs, no transport.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  dedupeById,
  defaultMixStripState,
  deleteArrangeKeys,
  displayTakeList,
  HEAL_ORIGIN,
  hasTakeList,
  healTakeListDuplicates,
  type MixStripState,
  readArrange,
  readMix,
  readTakeList,
  seedTakeListOnce,
  writeArrange,
  writeMixIfChanged,
  writeTakeList,
} from "./collab-doc";

const REMOTE = "remote";
const LOCAL = "local";

/** Wire two docs the way the provider does: relay any update whose origin
 * is not the remote marker; apply inbound updates AS the remote marker. */
function connect(a: Y.Doc, b: Y.Doc): { aSent: () => number; bSent: () => number } {
  let aSent = 0;
  let bSent = 0;
  a.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) {
      aSent++;
      Y.applyUpdate(b, update, REMOTE);
    }
  });
  b.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) {
      bSent++;
      Y.applyUpdate(a, update, REMOTE);
    }
  });
  return { aSent: () => aSent, bSent: () => bSent };
}

function strip(overrides: Partial<MixStripState> = {}): MixStripState {
  return { ...defaultMixStripState(), ...overrides };
}

describe("mix map", () => {
  it("writes only real changes and skips untouched defaults", () => {
    const doc = new Y.Doc();
    // A default strip with no doc entry: nothing to say.
    expect(writeMixIfChanged(doc, "lane-1", strip(), LOCAL)).toBe(false);
    expect(readMix(doc).size).toBe(0);

    expect(writeMixIfChanged(doc, "lane-1", strip({ gainDb: -6 }), LOCAL)).toBe(true);
    expect(readMix(doc).get("lane-1")?.gainDb).toBe(-6);
    // Same value again: no write (this is what breaks the apply loop).
    expect(writeMixIfChanged(doc, "lane-1", strip({ gainDb: -6 }), LOCAL)).toBe(false);
    // Back to defaults WITH a doc entry present: that is a real change.
    expect(writeMixIfChanged(doc, "lane-1", strip(), LOCAL)).toBe(true);
  });

  it("loop-guard: a remote edit is not echoed back to the wire", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const wire = connect(a, b);

    writeMixIfChanged(a, "lane-1", strip({ gainDb: -6, muted: true }), LOCAL);
    expect(readMix(b).get("lane-1")).toEqual(strip({ gainDb: -6, muted: true }));
    // A sent exactly its own edit; B (pure receiver) sent nothing.
    expect(wire.aSent()).toBe(1);
    expect(wire.bSent()).toBe(0);
    // B applying the received state to its player and diffing back is a
    // no-op write — the doc already holds it.
    expect(writeMixIfChanged(b, "lane-1", strip({ gainDb: -6, muted: true }), LOCAL)).toBe(false);
    expect(wire.bSent()).toBe(0);
  });
});

describe("arrange map", () => {
  it("converges overrides and drops removed keys", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    connect(a, b);

    expect(writeArrange(a, { "stream-1": 3.5, "stream-2": 7 }, LOCAL)).toBe(true);
    expect(readArrange(b)).toEqual({ "stream-1": 3.5, "stream-2": 7 });
    // Unchanged map: no transaction at all.
    expect(writeArrange(a, { "stream-1": 3.5, "stream-2": 7 }, LOCAL)).toBe(false);

    deleteArrangeKeys(b, ["stream-2", "never-there"], LOCAL);
    expect(readArrange(a)).toEqual({ "stream-1": 3.5 });
  });
});

interface FakeMarker {
  id: string;
  name: string;
  atSec: number;
}

const m = (id: string, name: string, atSec: number): FakeMarker => ({ id, name, atSec });

describe("take lists (markers/comments)", () => {
  it("reconciles by id: edit + remove here merge with a concurrent add there", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const one = m("id-1", "Kyrie", 0);
    const two = m("id-2", "Gloria", 10);
    writeTakeList(a, "markers", "take-1", [one, two], LOCAL);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), REMOTE);

    // OFFLINE from each other: A renames one marker and removes the other,
    // B appends a third. Then the wire comes back and both merge.
    writeTakeList(a, "markers", "take-1", [m("id-1", "Kyrie eleison", 0)], LOCAL);
    writeTakeList(b, "markers", "take-1", [one, two, m("id-3", "Credo", 20)], LOCAL);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), REMOTE);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), REMOTE);

    const ids = (doc: Y.Doc) =>
      readTakeList<FakeMarker>(doc, "markers", "take-1")
        .map((x) => `${x.id}:${x.name}`)
        .sort();
    expect(ids(a)).toEqual(ids(b));
    expect(ids(a)).toEqual(["id-1:Kyrie eleison", "id-3:Credo"].sort());
  });

  it("seeds once per (kind, take) and never over an existing entry", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    connect(a, b);

    expect(seedTakeListOnce(a, "markers", "take-1", [m("id-1", "Kyrie", 0)], LOCAL)).toBe(true);
    // B's localStorage has stale copies of the same take: the flag wins.
    expect(seedTakeListOnce(b, "markers", "take-1", [m("id-9", "Stale", 5)], LOCAL)).toBe(false);
    // Re-seeding on A (reload path) is a no-op too.
    expect(seedTakeListOnce(a, "markers", "take-1", [m("id-1", "Kyrie", 0)], LOCAL)).toBe(false);
    expect(readTakeList(a, "markers", "take-1")).toHaveLength(1);
    expect(readTakeList(b, "markers", "take-1")).toHaveLength(1);
    // Empty local data never seeds (and never plants the flag).
    expect(seedTakeListOnce(a, "comments", "take-1", [], LOCAL)).toBe(false);
    expect(hasTakeList(a, "comments", "take-1")).toBe(false);
  });

  it("offline fallback: localStorage shows until the doc carries the take", () => {
    const doc = new Y.Doc();
    const local = [m("id-1", "Kyrie", 0)];
    // No doc entry (cold start, collab down): the local snapshot displays.
    expect(displayTakeList(doc, "markers", "take-1", local)).toEqual(local);
    // The doc gains an entry (sync or first edit): the doc rules — even
    // when its list is emptier than the stale local copy.
    writeTakeList(doc, "markers", "take-1", [], LOCAL);
    expect(displayTakeList(doc, "markers", "take-1", local)).toEqual([]);
  });
});

// ---- F16: concurrent replace of the SAME element -------------------------------
// Two offline desks rename marker X; both reconnect. The delete+insert
// replace means the stored Y.Array converges — on BOTH docs, same order —
// to TWO elements with the same uuid (the documented bound). The read path
// must still hand the UI exactly one deterministic winner, and the heal
// must collapse the stored array without ping-pong.

/** The raw stored array, dedup-free — the bound itself is asserted on this. */
function rawList(doc: Y.Doc, takeId: string): FakeMarker[] {
  return doc.getMap<Y.Array<FakeMarker>>("markers").get(takeId)?.toArray() ?? [];
}

/** Offline reconnect: exchange exactly the diffs both ways. */
function mergeBoth(a: Y.Doc, b: Y.Doc): void {
  const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, fromA, REMOTE);
  Y.applyUpdate(a, fromB, REMOTE);
}

/** Both desks offline-rename the same marker, then reconnect. Returns the
 * two docs in the post-merge (duplicated) state. */
function duplicatedDocs(): { a: Y.Doc; b: Y.Doc } {
  const a = new Y.Doc();
  const b = new Y.Doc();
  writeTakeList(a, "markers", "take-1", [m("id-x", "Song 1", 0), m("id-2", "Gloria", 10)], LOCAL);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), REMOTE);
  // OFFLINE from each other: both rename id-x (delete+insert replace).
  writeTakeList(
    a,
    "markers",
    "take-1",
    [m("id-x", "Kyrie (desk A)", 0), m("id-2", "Gloria", 10)],
    LOCAL,
  );
  writeTakeList(
    b,
    "markers",
    "take-1",
    [m("id-x", "Kyrie (desk B)", 0), m("id-2", "Gloria", 10)],
    LOCAL,
  );
  mergeBoth(a, b);
  return { a, b };
}

describe("F16: concurrent same-marker rename", () => {
  it("documents the bound: the stored array holds the same uuid twice, same order on both docs", () => {
    const { a, b } = duplicatedDocs();
    const dupA = rawList(a, "take-1").filter((x) => x.id === "id-x");
    // The duplicate exists (this is the accepted convergence bound)…
    expect(dupA).toHaveLength(2);
    // …and Yjs converged both docs to the SAME array (order included).
    expect(rawList(a, "take-1")).toEqual(rawList(b, "take-1"));
  });

  it("read path collapses to ONE deterministic winner (last-in-array) on both docs", () => {
    const { a, b } = duplicatedDocs();
    const winner = rawList(a, "take-1")
      .filter((x) => x.id === "id-x")
      .at(-1);
    for (const doc of [a, b]) {
      const list = readTakeList<FakeMarker>(doc, "markers", "take-1");
      // No duplicate ids reach the UI — ever.
      expect(list.map((x) => x.id).sort()).toEqual(["id-2", "id-x"]);
      // Deterministic winner: the LAST same-id occurrence in array order
      // (identical on both docs because the array itself converged).
      expect(list.find((x) => x.id === "id-x")).toEqual(winner);
    }
    expect(readTakeList(a, "markers", "take-1")).toEqual(readTakeList(b, "markers", "take-1"));
  });

  it("displayTakeList dedupes the localStorage fallback too", () => {
    const doc = new Y.Doc();
    const local = [m("id-x", "old", 0), m("id-2", "Gloria", 10), m("id-x", "new", 0)];
    expect(displayTakeList(doc, "markers", "take-1", local)).toEqual([
      m("id-2", "Gloria", 10),
      m("id-x", "new", 0),
    ]);
  });

  it("heal collapses the STORED array to the read-path winner, idempotently", () => {
    const { a, b } = duplicatedDocs();
    const winner = readTakeList<FakeMarker>(a, "markers", "take-1");
    expect(healTakeListDuplicates(a, "markers", "take-1", HEAL_ORIGIN)).toBe(true);
    // Delete-only collapse: exactly the read-path list remains stored.
    expect(rawList(a, "take-1")).toEqual(winner);
    // Idempotent: a healed array never re-heals (no transaction at all).
    let updates = 0;
    a.on("update", () => updates++);
    expect(healTakeListDuplicates(a, "markers", "take-1", HEAL_ORIGIN)).toBe(false);
    expect(updates).toBe(0);
    // A missing take heals to nothing, not a throw.
    expect(healTakeListDuplicates(a, "markers", "no-such-take", HEAL_ORIGIN)).toBe(false);
    // The other doc converges to the identical stored array after sync.
    mergeBoth(a, b);
    expect(rawList(b, "take-1")).toEqual(winner);
  });

  it("loop safety: BOTH docs heal concurrently, then merge — convergence, no ping-pong", () => {
    const { a, b } = duplicatedDocs();
    // Both desks observe the duplicate and heal before hearing each other.
    expect(healTakeListDuplicates(a, "markers", "take-1", HEAL_ORIGIN)).toBe(true);
    expect(healTakeListDuplicates(b, "markers", "take-1", HEAL_ORIGIN)).toBe(true);
    mergeBoth(a, b);
    // Same single winner survives on both — never zero, never divergent.
    expect(rawList(a, "take-1")).toEqual(rawList(b, "take-1"));
    expect(rawList(a, "take-1").filter((x) => x.id === "id-x")).toHaveLength(1);
    // Fixpoint: after the merge neither doc has anything left to heal.
    expect(healTakeListDuplicates(a, "markers", "take-1", HEAL_ORIGIN)).toBe(false);
    expect(healTakeListDuplicates(b, "markers", "take-1", HEAL_ORIGIN)).toBe(false);
  });

  it("loop safety: observer-driven heals on a LIVE wire terminate (use-desk refresh shape)", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    writeTakeList(a, "markers", "take-1", [m("id-x", "Song 1", 0)], LOCAL);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), REMOTE);
    // Wire each doc the way use-desk.ts does: observeDeep → refresh →
    // displayTakeList (which heals opportunistically). A heal loop here
    // would recurse forever (synchronous relay) — the test would blow the
    // stack rather than pass.
    const reads: FakeMarker[][] = [];
    for (const doc of [a, b]) {
      doc.getMap("markers").observeDeep(() => {
        reads.push(displayTakeList<FakeMarker>(doc, "markers", "take-1", []));
      });
    }
    // Both rename offline, then reconnect (live relay from here on).
    writeTakeList(a, "markers", "take-1", [m("id-x", "Kyrie (desk A)", 0)], LOCAL);
    writeTakeList(b, "markers", "take-1", [m("id-x", "Kyrie (desk B)", 0)], LOCAL);
    const wire = connect(a, b);
    mergeBoth(a, b);
    // The heal ran and settled: both stored arrays hold the one winner…
    expect(rawList(a, "take-1")).toHaveLength(1);
    expect(rawList(a, "take-1")).toEqual(rawList(b, "take-1"));
    // …no observer ever surfaced a duplicate id to the UI…
    for (const list of reads) {
      expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
    }
    // …and the wire went quiet: further reads transact nothing.
    const sentBefore = wire.aSent() + wire.bSent();
    displayTakeList<FakeMarker>(a, "markers", "take-1", []);
    displayTakeList<FakeMarker>(b, "markers", "take-1", []);
    expect(wire.aSent() + wire.bSent()).toBe(sentBefore);
  });

  it("loop safety: partial-view heals (three desks, staggered merges) still converge", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const c = new Y.Doc();
    writeTakeList(a, "markers", "take-1", [m("id-x", "Song 1", 0)], LOCAL);
    for (const doc of [b, c]) Y.applyUpdate(doc, Y.encodeStateAsUpdate(a), REMOTE);
    // Three desks rename the same marker while offline from each other.
    writeTakeList(a, "markers", "take-1", [m("id-x", "from A", 0)], LOCAL);
    writeTakeList(b, "markers", "take-1", [m("id-x", "from B", 0)], LOCAL);
    writeTakeList(c, "markers", "take-1", [m("id-x", "from C", 0)], LOCAL);
    // A and B merge first and A heals on its PARTIAL view (no C yet).
    mergeBoth(a, b);
    healTakeListDuplicates(a, "markers", "take-1", HEAL_ORIGIN);
    // C joins; everyone heals whatever they see; then full re-sync.
    mergeBoth(a, c);
    healTakeListDuplicates(c, "markers", "take-1", HEAL_ORIGIN);
    healTakeListDuplicates(b, "markers", "take-1", HEAL_ORIGIN);
    mergeBoth(a, b);
    mergeBoth(b, c);
    mergeBoth(a, c);
    // One survivor, the same everywhere (the final-order winner is last in
    // every partial view that contains it, so no heal ever killed it).
    const lists = [a, b, c].map((doc) => rawList(doc, "take-1"));
    expect(lists[0]).toHaveLength(1);
    expect(lists[1]).toEqual(lists[0]);
    expect(lists[2]).toEqual(lists[0]);
    expect(readTakeList(a, "markers", "take-1")).toEqual(lists[0]);
  });

  it("seed never re-plants duplicates from a stale shadow", () => {
    const doc = new Y.Doc();
    const stale = [m("id-x", "old", 0), m("id-x", "new", 0)];
    expect(seedTakeListOnce(doc, "markers", "take-1", stale, LOCAL)).toBe(true);
    expect(rawList(doc, "take-1")).toEqual([m("id-x", "new", 0)]);
  });
});

describe("dedupeById", () => {
  it("keeps the last occurrence per id, preserving the order of survivors", () => {
    const items = [m("a", "a1", 0), m("b", "b1", 1), m("a", "a2", 2), m("c", "c1", 3)];
    expect(dedupeById(items)).toEqual([m("b", "b1", 1), m("a", "a2", 2), m("c", "c1", 3)]);
    // Unique input passes through intact (fresh array, same contents).
    const unique = [m("a", "a1", 0), m("b", "b1", 1)];
    expect(dedupeById(unique)).toEqual(unique);
    expect(dedupeById([])).toEqual([]);
  });
});
