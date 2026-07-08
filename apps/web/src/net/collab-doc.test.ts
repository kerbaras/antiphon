// W3-A doc-shape helpers: convergence, seed-once, loop-guard (origin
// filtering + no-echo writes), and the offline display fallback — all with
// plain Y.Docs, no transport.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  defaultMixStripState,
  deleteArrangeKeys,
  displayTakeList,
  hasTakeList,
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
