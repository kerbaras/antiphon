// Timeline model shared across the desk modules: performer lanes (rows),
// take slots, and the identity/naming helpers they draw from.

import { useEffect, useRef, useState } from "react";
import type { DeskStreamStatus } from "../../audio/sink-worker-protocol";
import { type Marker, sortMarkers } from "./markers";

export const TRACK_COLORS = [
  "#4fb8a8",
  "#d9a441",
  "#d96c7b",
  "#d97e4a",
  "#5b8dd9",
  "#9a7bd9",
  "#55aec8",
  "#7bb661",
];

export const SAMPLE_RATE = 48_000;
export const TAKE_GAP_SECONDS = 2;

export interface TrackRow {
  key: string;
  index: number;
  /** Renameable lane ⇔ it maps to a known peer (peer-update target). */
  peerId: string | null;
  name: string;
  color: string;
  peerInitials: string;
  /** Account profile picture: live roster first, archive fallback. */
  avatarUrl: string | null;
  peerLabel: string | null;
  streams: DeskStreamStatus[];
  receiving: boolean;
  armed: boolean;
}

export interface TakeSlot {
  takeId: string;
  offsetSec: number;
  durationSec: number;
  live: boolean;
}

export function useReceiving(deskStatus: DeskStreamStatus[]): Set<string> {
  const heldRef = useRef(new Map<string, { count: number; at: number }>());
  const receiving = new Set<string>();
  const now = Date.now();
  for (const s of deskStatus) {
    const prev = heldRef.current.get(s.streamId);
    if (!prev || prev.count !== s.heldCount) {
      heldRef.current.set(s.streamId, { count: s.heldCount, at: now });
      if (prev) receiving.add(s.streamId);
    } else if (now - prev.at < 2_500) {
      receiving.add(s.streamId);
    }
  }
  return receiving;
}

export function deviceName(userAgent: string): string {
  const m = /iPhone|iPad|Android|Macintosh|Windows/.exec(userAgent);
  return m ? m[0] : "Browser";
}

/** Grapheme-aware first "letter": `word[0]` is a bare UTF-16 code unit and
 * cuts surrogate pairs in half. Intl.Segmenter yields whole graphemes incl.
 * ZWJ sequences; the fallback takes a whole code point (never splits a pair). */
const graphemeSegmenter: Intl.Segmenter | null =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function firstGrapheme(word: string): string {
  if (graphemeSegmenter) {
    for (const { segment } of graphemeSegmenter.segment(word)) return segment;
    return "";
  }
  const first = word.codePointAt(0);
  return first === undefined ? "" : String.fromCodePoint(first);
}

/** Avatar initials from a nickname: first letters of the first two words. */
export function initialsOf(label: string | undefined): string | null {
  const words = label?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length === 0) return null;
  return words
    .slice(0, 2)
    .map((w) => firstGrapheme(w).toUpperCase())
    .join("");
}

/** Filesystem-safe lane name for export filenames. */
export function fileSafe(name: string): string {
  return name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "track";
}

/** Re-render at `ms` cadence while `active` (live timecode + growing clip). */
export function useTick(active: boolean, ms: number): void {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => force((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [active, ms]);
}

// ---- stable lane order ----------------------------------------------------------
// A lane's position is assigned ONCE per desk session and FROZEN: new lanes
// append after existing ones, ordered by the peer's joinedAt (identical on
// every desk), unknown joins keeping observed order. Nothing that happens
// later (renames, reconnects, status churn, late attribution) moves a lane.

export interface LaneCandidate {
  /** Lane key: peerId when attributed, else the streamId fallback. */
  key: string;
  /** Join time (epoch ms) when known — the canonical ordering key. */
  joinedAtMs: number | null;
  /** Former keys this lane subsumes (streamId fallbacks re-keyed by late
   * attribution): the lane inherits the earliest frozen rank. */
  aliases?: readonly string[];
}

/** Assign frozen ranks to first-seen candidates (mutates `ranks`) and
 * return the candidate keys in canonical order. Idempotent per key. */
export function stableLaneOrder(ranks: Map<string, number>, candidates: LaneCandidate[]): string[] {
  let nextRank = ranks.size === 0 ? 0 : Math.max(...ranks.values()) + 1;
  const fresh = candidates
    .map((candidate, observedAt) => ({ candidate, observedAt }))
    .filter(({ candidate }) => !ranks.has(candidate.key));
  // A re-keyed lane (streamId fallback → attributed peer) takes over the
  // earliest rank it already occupied — attribution must not move rows.
  for (const { candidate } of fresh) {
    const inherited = (candidate.aliases ?? [])
      .map((alias) => ranks.get(alias))
      .filter((rank): rank is number => rank !== undefined);
    if (inherited.length > 0) ranks.set(candidate.key, Math.min(...inherited));
  }
  const newcomers = fresh
    .filter(({ candidate }) => !ranks.has(candidate.key))
    .sort(
      (a, b) =>
        (a.candidate.joinedAtMs ?? Number.POSITIVE_INFINITY) -
          (b.candidate.joinedAtMs ?? Number.POSITIVE_INFINITY) || a.observedAt - b.observedAt,
    );
  for (const { candidate } of newcomers) {
    ranks.set(candidate.key, nextRank);
    nextRank += 1;
  }
  return [...candidates]
    .map((c) => c.key)
    .sort((a, b) => (ranks.get(a) as number) - (ranks.get(b) as number));
}

// ---- deliberate lane moves --------------------------------------------------------
// Move up/down is the one sanctioned reorder; ordinals live in the shared
// doc ('laneOrder'). Ranks stay frozen underneath: colors and default names
// key off the rank, so a moved lane keeps its identity.

/** Layer deliberate move ordinals over the frozen-rank order. Unknown lanes
 * append after every moved lane, frozen order among themselves; ordinal
 * ties (concurrent LWW merges) fall back to frozen order alike on every desk. */
export function applyLaneMoves(
  frozenOrder: readonly string[],
  ordinalOf: (key: string) => number | undefined,
): string[] {
  return frozenOrder
    .map((key, base) => ({ key, base, ordinal: ordinalOf(key) }))
    .sort((a, b) => {
      if (a.ordinal === undefined && b.ordinal === undefined) return a.base - b.base;
      if (a.ordinal === undefined || b.ordinal === undefined) {
        return a.ordinal === undefined ? 1 : -1;
      }
      return a.ordinal - b.ordinal || a.base - b.base;
    })
    .map((entry) => entry.key);
}

// ---- orphaned mid-take-reload streams ---------------------------------------------
// A phone reloading mid-take arms a FRESH stream; the truncated original
// never gets a stream-final, so finalSeq stays null at both sinks forever.
// A normally-stopped stream looks identical for a second or two, so the
// verdict only turns terminal after the condition holds for ORPHAN_HOLD_MS.

export const ORPHAN_HOLD_MS = 5_000;

export interface OrphanServerView {
  finalSeq: number | null;
  complete: boolean;
}

/** The instantaneous condition — exported for tests; the hook adds time. */
export function orphanCandidate(
  desk: DeskStreamStatus,
  server: OrphanServerView | undefined,
  activeTakeId: string | null,
): boolean {
  return (
    desk.takeId !== activeTakeId &&
    desk.finalSeq === null &&
    server !== undefined &&
    server.finalSeq === null &&
    !server.complete
  );
}

/** Streams to present as terminally incomplete: the orphan condition has
 * held for ORPHAN_HOLD_MS. Self-healing — a final seq arriving later
 * (however unlikely) drops the stream out of the set. */
export function useOrphanedStreams(
  deskStatus: DeskStreamStatus[],
  serverStatus: ReadonlyMap<string, OrphanServerView>,
  activeTakeId: string | null,
): Set<string> {
  const sinceRef = useRef(new Map<string, number>());
  const now = Date.now();
  const orphaned = new Set<string>();
  const candidates = new Set<string>();
  for (const desk of deskStatus) {
    if (!orphanCandidate(desk, serverStatus.get(desk.streamId), activeTakeId)) continue;
    candidates.add(desk.streamId);
    const since = sinceRef.current.get(desk.streamId) ?? now;
    sinceRef.current.set(desk.streamId, since);
    if (now - since >= ORPHAN_HOLD_MS) orphaned.add(desk.streamId);
  }
  for (const key of sinceRef.current.keys()) {
    if (!candidates.has(key)) sinceRef.current.delete(key);
  }
  return orphaned;
}

// ---- click-to-seek take resolution -------------------------------------------------
// The pure "which take is under arrangement-second `sec`?" half of a
// timeline-click seek (index.tsx seekTimeline retargets onto that take).

export interface ClipSpan {
  takeId: string;
  /** Arrangement position (overrides included) — clip.x / pxPerSec. */
  startSec: number;
  durationSec: number;
  live: boolean;
}

/** The take under arrangement-second `sec`, matched on x ONLY (a click on
 * bare lane still means that clip's take-time). Overlaps prefer
 * `selectedTakeId`, then row order; the live take never matches. */
export function takeAtSec(
  clips: readonly ClipSpan[],
  sec: number,
  selectedTakeId: string | null,
): string | null {
  let hit: string | null = null;
  for (const clip of clips) {
    if (clip.live || sec < clip.startSec || sec >= clip.startSec + clip.durationSec) continue;
    if (clip.takeId === selectedTakeId) return clip.takeId;
    hit ??= clip.takeId;
  }
  return hit;
}

// ---- song display names --------------------------------------------------------
// Auto-assigned `Song N` names are a display DEFAULT, renumbered by timeline
// position at render time; user-typed names are untouched. Display-level by
// design: the stored marker model never mutates under a viewer.

const AUTO_SONG_NAME = /^Song \d+$/;

/** Positional display names for auto-named markers ("Song N" → position). */
export function withPositionalSongNames(markers: readonly Marker[]): Marker[] {
  return sortMarkers(markers).map((marker, i) =>
    AUTO_SONG_NAME.test(marker.name) ? { ...marker, name: `Song ${i + 1}` } : marker,
  );
}
