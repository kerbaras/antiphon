// Song markers (W2-B) — pure model + interim persistence.
//
// A marker is a named POINT on the loaded take's room timeline (the exact
// domain of player.position()/seek(): 0 = take head). A "song" is the span
// from one marker to the next marker — or the take end for the last one —
// which gives bookmarking AND per-song render ranges (W2-A RenderRange)
// with no range-editing UI at all.
//
// PERSISTENCE BOUNDARY (W3-A landed): the source of truth is the shared
// project doc — a Y.Array of {id,name,atSec} per takeId (net/collab-doc.ts,
// wired in use-desk.ts). Exactly as documented, ONLY the load/save layer
// changed: the pure model above this line is untouched. loadMarkers/
// saveMarkers remain as the doc's localStorage SHADOW — the seed source
// (once per take), the display fallback while the doc has no entry
// (offline single-desk parity), and cheap offline insurance on every
// change.

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

/** `NN <name>.wav`, filesystem-safe on macOS/Windows/Linux: keep letters,
 * numbers and tame punctuation; collapse whitespace; no edge dots (hidden
 * files / Windows trailing-dot stripping); bounded length. */
export function songFileName(index: number, name: string): string {
  const safe = name
    .replace(/[^\p{L}\p{N}\s'&()[\].,+#@!_-]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 64)
    .trim();
  return `${String(index).padStart(2, "0")} ${safe || "song"}.wav`;
}

// ---- persistence (doc shadow — see the W3-A boundary note up top) -------------

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
    return sortMarkers(valid.map((m) => ({ id: m.id, name: m.name, atSec: m.atSec })));
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
