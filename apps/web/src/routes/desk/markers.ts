// Song markers: named points on the take's room timeline (the
// player.position() domain); a "song" spans marker→next marker. Source of
// truth is the shared doc; loadMarkers/saveMarkers are its local shadow.

import { dedupeById } from "../../net/collab-doc";

export interface Marker {
  /** Stable identity — rename/delete target, survives re-sorting. */
  id: string;
  name: string;
  /** Seconds on the take's room timeline (player.position() domain). */
  atSec: number;
}

/** A song derived from consecutive markers. `endSec === null` means "to
 * the take end" — exports omit the bound so resolveRange picks the true
 * render-time duration. */
export interface Song {
  /** The starting marker's id. */
  id: string;
  /** 1-based position in timeline order — the NN in "NN <name>.wav". */
  index: number;
  name: string;
  startSec: number;
  endSec: number | null;
}

/** Adds closer than this to an existing marker are rejected: a double
 * keypress or dblclick jitter must not stack two markers on one spot. */
export const MIN_MARKER_GAP_SEC = 0.25;

/** Timeline order: by position, id as a deterministic tie-break. */
export function sortMarkers(markers: readonly Marker[]): Marker[] {
  return [...markers].sort((a, b) => a.atSec - b.atSec || a.id.localeCompare(b.id));
}

/** Add a marker at `atSec` (clamped to ≥ 0). Returns the new sorted list
 * and the marker, or `added: null` (list unchanged) when another marker
 * already sits within MIN_MARKER_GAP_SEC. */
export function addMarker(
  markers: readonly Marker[],
  atSec: number,
  name?: string,
): { markers: Marker[]; added: Marker | null } {
  const at = Math.max(0, atSec);
  if (markers.some((m) => Math.abs(m.atSec - at) < MIN_MARKER_GAP_SEC)) {
    return { markers: sortMarkers(markers), added: null };
  }
  const added: Marker = {
    id: crypto.randomUUID(),
    name: name?.trim() || `Song ${markers.length + 1}`,
    atSec: at,
  };
  return { markers: sortMarkers([...markers, added]), added };
}

/** Rename a marker (trimmed; an empty result keeps the old name). */
export function renameMarker(markers: readonly Marker[], id: string, name: string): Marker[] {
  const next = name.trim().slice(0, 64);
  return markers.map((m) => (m.id === id && next ? { ...m, name: next } : m));
}

export function removeMarker(markers: readonly Marker[], id: string): Marker[] {
  return markers.filter((m) => m.id !== id);
}

/** Derive song spans: marker N runs to marker N+1, the last to the take
 * end (null). Audio before the first marker belongs to no song — the
 * operator bookmarks song *starts*. */
export function songsOf(markers: readonly Marker[]): Song[] {
  const sorted = sortMarkers(markers);
  return sorted.map((m, i) => ({
    id: m.id,
    index: i + 1,
    name: m.name,
    startSec: m.atSec,
    endSec: sorted[i + 1]?.atSec ?? null,
  }));
}

/** `NN <name>`, filesystem-safe on macOS/Windows/Linux: keep letters,
 * numbers and tame punctuation; collapse whitespace; no edge dots; bounded
 * length. The shared stem of every per-song export name. */
export function songSlug(index: number, name: string): string {
  const safe = name
    .replace(/[^\p{L}\p{N}\s'&()[\].,+#@!_-]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 64)
    .trim();
  return `${String(index).padStart(2, "0")} ${safe || "song"}`;
}

/** `NN <name>.wav` — the per-song WAV entry name inside song ZIPs. */
export function songFileName(index: number, name: string): string {
  return `${songSlug(index, name)}.wav`;
}

// ---- persistence (localStorage shadow of the shared doc) -----------------------

const SCHEMA_VERSION = 1;

interface MarkerDoc {
  v: number;
  markers: Marker[];
}

type KVStore = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): KVStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // private mode / storage disabled: markers become per-load
  }
}

export function markersKey(sessionId: string, takeId: string): string {
  return `antiphon:markers:${sessionId}:${takeId}`;
}

/** Load a take's markers. Malformed JSON, unknown schema versions and
 * invalid entries all degrade to "no markers" — never a throw: a marker
 * store must not be able to take the desk down. */
export function loadMarkers(
  sessionId: string,
  takeId: string,
  store: KVStore | null = defaultStore(),
): Marker[] {
  let raw: string | null = null;
  try {
    raw = store?.getItem(markersKey(sessionId, takeId)) ?? null;
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const doc = JSON.parse(raw) as Partial<MarkerDoc> | null;
    if (doc?.v !== SCHEMA_VERSION || !Array.isArray(doc.markers)) return [];
    const valid = doc.markers.filter(
      (m): m is Marker =>
        typeof m === "object" &&
        m !== null &&
        typeof m.id === "string" &&
        m.id.length > 0 &&
        typeof m.name === "string" &&
        typeof m.atSec === "number" &&
        Number.isFinite(m.atSec) &&
        m.atSec >= 0,
    );
    // Same-id entries collapse to the last occurrence — the same winner
    // rule as the doc read path, and this list may seed the doc.
    return sortMarkers(dedupeById(valid).map((m) => ({ id: m.id, name: m.name, atSec: m.atSec })));
  } catch {
    return [];
  }
}

export function saveMarkers(
  sessionId: string,
  takeId: string,
  markers: readonly Marker[],
  store: KVStore | null = defaultStore(),
): void {
  const doc: MarkerDoc = { v: SCHEMA_VERSION, markers: sortMarkers(markers) };
  try {
    store?.setItem(markersKey(sessionId, takeId), JSON.stringify(doc));
  } catch {
    // quota / private mode: the in-memory state still serves this page load
  }
}
