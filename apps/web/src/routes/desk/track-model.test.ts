// Pure halves of the track-model helpers:
// QA #14 grapheme-safe initials + fileSafe (wave-2 G4) · F8 stable lane
// order · F9 orphan-stream detection · W4-C click-to-seek take resolution
// · positional song display names (wave-2 G2).

import { describe, expect, it } from "vitest";
import type { DeskStreamStatus } from "../../audio/sink-worker-protocol";
import {
  type ClipSpan,
  fileSafe,
  initialsOf,
  type LaneCandidate,
  orphanCandidate,
  stableLaneOrder,
  takeAtSec,
  withPositionalSongNames,
} from "./track-model";

// ---- QA #14 — initialsOf ---------------------------------------------------------

// QA #14: initialsOf took `word[0]` — a bare UTF-16 code unit — so any
// nickname starting with a non-BMP character (emoji, rare CJK) yielded a
// lone surrogate, rendered as U+FFFD in the avatar. Initials must be
// whole graphemes (Intl.Segmenter; whole code points as fallback).
describe("initialsOf", () => {
  it("takes the first letters of the first two words", () => {
    expect(initialsOf("Alto Maria")).toBe("AM");
    expect(initialsOf("  soprano  ")).toBe("S");
    expect(initialsOf("one two three")).toBe("OT");
  });

  it("is null for empty/undefined labels", () => {
    expect(initialsOf(undefined)).toBeNull();
    expect(initialsOf("")).toBeNull();
    expect(initialsOf("   ")).toBeNull();
  });

  it('keeps surrogate-pair emoji whole: "🎤 Zoë" → "🎤Z"', () => {
    const initials = initialsOf("🎤 Zoë");
    expect(initials).toBe("🎤Z");
    // No unpaired surrogate (with /u a surrogate range only matches lone
    // surrogates — valid pairs are single code points).
    expect(/[\uD800-\uDFFF]/u.test(initials ?? "")).toBe(false);
  });

  it("keeps ZWJ-joined graphemes whole where the segmenter exists", () => {
    // Node ≥ 16 and all target browsers ship Intl.Segmenter.
    expect(initialsOf("👨‍👩‍👧 choir")).toBe("👨‍👩‍👧C");
  });

  it("handles a single emoji word", () => {
    expect(initialsOf("🎹")).toBe("🎹");
  });
});

describe("fileSafe", () => {
  it("stays filesystem-safe for unicode names", () => {
    expect(fileSafe("🎤 Zoë")).toBe("Zoë");
    expect(fileSafe("---")).toBe("track");
  });
});

// ---- F8 — stableLaneOrder -------------------------------------------------------

function lane(key: string, joinedAtMs: number | null = null, aliases?: string[]): LaneCandidate {
  return { key, joinedAtMs, ...(aliases ? { aliases } : {}) };
}

describe("stableLaneOrder (F8)", () => {
  it("orders first-seen candidates by joinedAt, unknown joins last in observed order", () => {
    const ranks = new Map<string, number>();
    expect(stableLaneOrder(ranks, [lane("c"), lane("b", 200), lane("a", 100), lane("d")])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("freezes ranks: status-order churn between polls never reorders rows", () => {
    const ranks = new Map<string, number>();
    stableLaneOrder(ranks, [lane("a", 100), lane("b", 200)]);
    // Same lanes arrive shuffled (Rust HashMap iteration) — order holds.
    expect(stableLaneOrder(ranks, [lane("b", 200), lane("a", 100)])).toEqual(["a", "b"]);
  });

  it("freezes ranks even against a LATER joinedAt claim for a known lane", () => {
    const ranks = new Map<string, number>();
    stableLaneOrder(ranks, [lane("a"), lane("b")]); // observed order, no dates
    // Attribution lands late and says b joined first: too late — b is on
    // screen, a mid-session reorder is exactly the QA-1 #19 bug.
    expect(stableLaneOrder(ranks, [lane("a", 500), lane("b", 100)])).toEqual(["a", "b"]);
  });

  it("appends new lanes after every existing lane regardless of joinedAt", () => {
    const ranks = new Map<string, number>();
    stableLaneOrder(ranks, [lane("a", 300)]);
    // c joined before a but appears later (e.g. it only now streams):
    // it appends — existing rows never shift.
    expect(stableLaneOrder(ranks, [lane("a", 300), lane("c", 100)])).toEqual(["a", "c"]);
  });

  it("a departed lane keeps its rank for when it returns (A12 resume)", () => {
    const ranks = new Map<string, number>();
    stableLaneOrder(ranks, [lane("a", 100), lane("b", 200), lane("c", 300)]);
    expect(stableLaneOrder(ranks, [lane("a", 100), lane("c", 300)])).toEqual(["a", "c"]);
    expect(stableLaneOrder(ranks, [lane("a", 100), lane("c", 300), lane("b", 200)])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("late attribution re-keys a fallback lane in place via aliases", () => {
    const ranks = new Map<string, number>();
    // Server away: nothing is attributed, lanes rank in observed order.
    stableLaneOrder(ranks, [lane("stream-1"), lane("stream-2")]);
    // Attribution lands: stream-1's lane is really peer-x. The peer lane
    // inherits rank 0 — it must not jump to the end as a "new" lane.
    expect(stableLaneOrder(ranks, [lane("peer-x", 50, ["stream-1"]), lane("stream-2")])).toEqual([
      "peer-x",
      "stream-2",
    ]);
  });
});

// ---- F9 — orphanCandidate --------------------------------------------------------

function deskStream(over: Partial<DeskStreamStatus>): DeskStreamStatus {
  return {
    takeId: "take-1",
    streamId: "stream-1",
    chwm: 5,
    heldCount: 6,
    holes: [],
    gaps: [],
    finalSeq: null,
    complete: false,
    settled: false,
    flagged: false,
    digest: "d",
    totalSamples: 48_000,
    energy: [],
    ...over,
  };
}

describe("orphanCandidate (F9)", () => {
  const server = { finalSeq: null, complete: false };

  it("marks a stopped-take stream with no final seq at either sink", () => {
    expect(orphanCandidate(deskStream({}), server, null)).toBe(true);
    expect(orphanCandidate(deskStream({}), server, "other-take")).toBe(true);
  });

  it("never marks the rolling take (every live stream has finalSeq null)", () => {
    expect(orphanCandidate(deskStream({}), server, "take-1")).toBe(false);
  });

  it("never marks a stream either sink saw a final seq for", () => {
    expect(orphanCandidate(deskStream({ finalSeq: 41 }), server, null)).toBe(false);
    expect(orphanCandidate(deskStream({}), { finalSeq: 41, complete: false }, null)).toBe(false);
    expect(orphanCandidate(deskStream({}), { finalSeq: 41, complete: true }, null)).toBe(false);
  });

  it("withholds the verdict while the server view is unknown", () => {
    expect(orphanCandidate(deskStream({}), undefined, null)).toBe(false);
  });
});

// ---- W4-C — takeAtSec --------------------------------------------------------------

const span = (takeId: string, startSec: number, durationSec: number, live = false): ClipSpan => ({
  takeId,
  startSec,
  durationSec,
  live,
});

describe("takeAtSec (W4-C click-to-seek)", () => {
  // Two takes on the arrangement: take-1 at 1..4, take-2 at 6..9.
  const clips = [span("take-1", 1, 3), span("take-2", 6, 3)];

  it("resolves the take under a clip span, on x only", () => {
    expect(takeAtSec(clips, 2.5, null)).toBe("take-1");
    expect(takeAtSec(clips, 7, "take-1")).toBe("take-2");
  });

  it("is null on bare surface: before, between, and after the takes", () => {
    expect(takeAtSec(clips, 0.5, null)).toBeNull();
    expect(takeAtSec(clips, 5, null)).toBeNull(); // the inter-take gap
    expect(takeAtSec(clips, 30, null)).toBeNull();
  });

  it("prefers the selected take when dragged clips overlap", () => {
    const overlapping = [...clips, span("take-2", 2, 3)]; // dragged onto take-1
    expect(takeAtSec(overlapping, 2.5, "take-2")).toBe("take-2");
    expect(takeAtSec(overlapping, 2.5, null)).toBe("take-1"); // first in row order
  });

  it("never matches the live take (transport-owned while recording)", () => {
    expect(takeAtSec([span("take-live", 1, 3, true)], 2, null)).toBeNull();
  });
});

// ---- song display names -----------------------------------------------------------

const marker = (id: string, name: string, atSec: number) => ({ id, name, atSec });

describe("withPositionalSongNames", () => {
  it("renumbers auto-named markers by timeline position", () => {
    expect(
      withPositionalSongNames([
        marker("m2", "Song 2", 10),
        marker("m4", "Song 4", 20), // "Song 3" was deleted
      ]).map((m) => m.name),
    ).toEqual(["Song 1", "Song 2"]);
  });

  it("leaves user-typed names alone, numbering around them", () => {
    expect(
      withPositionalSongNames([
        marker("m1", "Kyrie", 0),
        marker("m2", "Song 5", 10),
        marker("m3", "Song 7 (reprise)", 20), // not the auto pattern
      ]).map((m) => m.name),
    ).toEqual(["Kyrie", "Song 2", "Song 7 (reprise)"]);
  });

  it("sorts by position before numbering (same order songsOf derives)", () => {
    expect(
      withPositionalSongNames([marker("m9", "Song 9", 30), marker("m1", "Song 1", 5)]).map(
        (m) => `${m.atSec}:${m.name}`,
      ),
    ).toEqual(["5:Song 1", "30:Song 2"]);
  });

  it("keeps ids/positions intact — rename and seek still target the model", () => {
    const out = withPositionalSongNames([marker("m2", "Song 2", 10)]);
    expect(out).toEqual([{ id: "m2", name: "Song 1", atSec: 10 }]);
  });
});
