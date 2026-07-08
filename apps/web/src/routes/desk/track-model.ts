// Timeline model shared across the desk modules: performer lanes (rows),
// take slots, and the identity/naming helpers they draw from.

import { useEffect, useRef, useState } from "react";
import type { DeskStreamStatus } from "../../audio/sink-worker-protocol";

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

/** Avatar initials from a nickname: first letters of the first two words. */
export function initialsOf(label: string | undefined): string | null {
  const words = label?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length === 0) return null;
  return words
    .slice(0, 2)
    .map((w) => (w[0] as string).toUpperCase())
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
