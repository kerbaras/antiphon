import { describe, expect, it } from "vitest";
import {
  addMarker,
  loadMarkers,
  type Marker,
  MIN_MARKER_GAP_SEC,
  markersKey,
  removeMarker,
  renameMarker,
  saveMarkers,
  songFileName,
  songsOf,
  sortMarkers,
} from "./markers";

const m = (id: string, atSec: number, name = id): Marker => ({ id, name, atSec });

/** Minimal Storage double for the persistence round-trip tests. */
function memStore(): Pick<Storage, "getItem" | "setItem"> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("marker model", () => {
  it("addMarker keeps the list sorted regardless of insertion order", () => {
    let list: Marker[] = [];
    for (const at of [30, 5, 90, 12]) {
      list = addMarker(list, at).markers;
    }
    expect(list.map((x) => x.atSec)).toEqual([5, 12, 30, 90]);
  });

  it("addMarker names default sequentially and clamps to ≥ 0", () => {
    const first = addMarker([], -3);
    expect(first.added?.atSec).toBe(0);
    expect(first.added?.name).toBe("Song 1");
    const second = addMarker(first.markers, 10);
    expect(second.added?.name).toBe("Song 2");
  });

  it("addMarker rejects positions within the stacking guard", () => {
    const { markers } = addMarker([], 10);
    const dup = addMarker(markers, 10 + MIN_MARKER_GAP_SEC / 2);
    expect(dup.added).toBeNull();
    expect(dup.markers).toHaveLength(1);
    // Just outside the guard is allowed.
    expect(addMarker(markers, 10 + MIN_MARKER_GAP_SEC).added).not.toBeNull();
  });

  it("sortMarkers ties on atSec break deterministically by id", () => {
    const sorted = sortMarkers([m("b", 4), m("a", 4), m("c", 1)]);
    expect(sorted.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("renameMarker trims and ignores empty results; removeMarker deletes by id", () => {
    const list = [m("a", 0), m("b", 10)];
    expect(renameMarker(list, "a", "  Kyrie  ")[0]?.name).toBe("Kyrie");
    expect(renameMarker(list, "a", "   ")[0]?.name).toBe("a");
    expect(removeMarker(list, "a").map((x) => x.id)).toEqual(["b"]);
  });
});

describe("song derivation", () => {
  it("spans run marker→next-marker, the last marker→take end (null)", () => {
    const songs = songsOf([m("intro", 12), m("kyrie", 130), m("gloria", 400)]);
    expect(songs).toEqual([
      { id: "intro", index: 1, name: "intro", startSec: 12, endSec: 130 },
      { id: "kyrie", index: 2, name: "kyrie", startSec: 130, endSec: 400 },
      { id: "gloria", index: 3, name: "gloria", startSec: 400, endSec: null },
    ]);
  });

  it("derives from timeline order, not insertion order", () => {
    const songs = songsOf([m("late", 300), m("early", 8)]);
    expect(songs.map((s) => s.id)).toEqual(["early", "late"]);
    expect(songs[0]?.endSec).toBe(300);
    expect(songs[1]?.endSec).toBeNull();
  });

  it("no markers → no songs", () => {
    expect(songsOf([])).toEqual([]);
  });
});

describe("songFileName", () => {
  it("pads the index and keeps human names", () => {
    expect(songFileName(1, "Kyrie")).toBe("01 Kyrie.wav");
    expect(songFileName(12, "Agnus Dei (reprise)")).toBe("12 Agnus Dei (reprise).wav");
  });

  it("strips filesystem-hostile characters and collapses whitespace", () => {
    expect(songFileName(2, 'Agnus / Dei: "final"?')).toBe("02 Agnus Dei final.wav");
    expect(songFileName(3, "a\\b*c|d<e>f")).toBe("03 abcdef.wav");
    expect(songFileName(4, "  spaced\t\nout  ")).toBe("04 spaced out.wav");
  });

  it("never yields hidden files, trailing dots, or an empty stem", () => {
    expect(songFileName(5, "...")).toBe("05 song.wav");
    expect(songFileName(6, ".Sanctus.")).toBe("06 Sanctus.wav");
    expect(songFileName(7, "///???")).toBe("07 song.wav");
  });

  it("bounds the name length", () => {
    const long = songFileName(8, "x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(2 + 1 + 64 + 4);
    expect(long.endsWith(".wav")).toBe(true);
  });
});

describe("persistence", () => {
  it("round-trips through the versioned document, sorted", () => {
    const store = memStore();
    saveMarkers("sess", "take", [m("b", 20, "Gloria"), m("a", 3, "Kyrie")], store);
    expect(store.map.has(markersKey("sess", "take"))).toBe(true);
    expect(loadMarkers("sess", "take", store)).toEqual([
      { id: "a", name: "Kyrie", atSec: 3 },
      { id: "b", name: "Gloria", atSec: 20 },
    ]);
    // Keyed per (session, take): neighbors see nothing.
    expect(loadMarkers("sess", "other-take", store)).toEqual([]);
    expect(loadMarkers("other-sess", "take", store)).toEqual([]);
  });

  it("tolerates malformed JSON, unknown schema versions, and wrong shapes", () => {
    const store = memStore();
    const key = markersKey("s", "t");
    for (const raw of [
      "not json{",
      "null",
      "[]",
      JSON.stringify({ v: 999, markers: [m("a", 1)] }),
      JSON.stringify({ v: 1, markers: "nope" }),
      JSON.stringify({ markers: [m("a", 1)] }),
    ]) {
      store.map.set(key, raw);
      expect(loadMarkers("s", "t", store)).toEqual([]);
    }
  });

  it("filters invalid entries instead of rejecting the document", () => {
    const store = memStore();
    store.map.set(
      markersKey("s", "t"),
      JSON.stringify({
        v: 1,
        markers: [
          m("good", 5),
          { id: "", name: "no id", atSec: 1 },
          { id: "nan", name: "bad pos", atSec: Number.NaN },
          { id: "neg", name: "negative", atSec: -4 },
          { id: "str", name: "stringy", atSec: "7" },
          null,
          "junk",
        ],
      }),
    );
    expect(loadMarkers("s", "t", store)).toEqual([{ id: "good", name: "good", atSec: 5 }]);
  });

  it("survives a throwing store (private mode) by degrading to empty", () => {
    const throwing: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadMarkers("s", "t", throwing)).toEqual([]);
    expect(() => saveMarkers("s", "t", [m("a", 1)], throwing)).not.toThrow();
  });
});
